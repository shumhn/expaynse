import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const PAYROLL_PROGRAM_ID = new PublicKey(
  "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6",
);

const LOCAL_IDL_PATH = path.join(
  process.cwd(),
  "target",
  "idl",
  "payroll.json",
);

type ParityMode = "off" | "warn" | "error";

type NormalizedInstructionAccount = {
  name: string;
  address: string | null;
  signer: boolean;
  writable: boolean;
  optional: boolean;
};

type NormalizedInstruction = {
  name: string;
  discriminator: number[] | null;
  args: unknown[];
  accounts: NormalizedInstructionAccount[];
};

type NormalizedPayrollIdl = {
  address: string | null;
  accounts: Array<{ name: string; discriminator: number[] | null }>;
  instructions: NormalizedInstruction[];
  types: unknown[];
  errors: unknown[];
};

export type PayrollIdlParityResult = {
  ok: boolean;
  mode: ParityMode;
  summary: string;
  diffs: string[];
};

let cachedRemoteIdl: Idl | null = null;
let cachedLocalIdl: Idl | null = null;
let cachedParityResult: PayrollIdlParityResult | null = null;
let parityPromise: Promise<PayrollIdlParityResult> | null = null;
let cachedLocalIdlSignature: string | null = null;

function readLocalIdlSignature() {
  if (!fs.existsSync(LOCAL_IDL_PATH)) {
    return null;
  }

  const stats = fs.statSync(LOCAL_IDL_PATH);
  return `${stats.mtimeMs}:${stats.size}`;
}

function readLocalPayrollIdl(): Idl | null {
  const nextSignature = readLocalIdlSignature();

  if (!nextSignature) {
    cachedLocalIdl = null;
    cachedLocalIdlSignature = null;
    cachedParityResult = null;
    return null;
  }

  if (cachedLocalIdl && cachedLocalIdlSignature === nextSignature) {
    return cachedLocalIdl;
  }

  const raw = fs.readFileSync(LOCAL_IDL_PATH, "utf8");
  cachedLocalIdl = JSON.parse(raw) as Idl;
  cachedLocalIdlSignature = nextSignature;
  cachedParityResult = null;
  return cachedLocalIdl;
}

async function fetchRemotePayrollIdl(
  provider: anchor.AnchorProvider,
): Promise<Idl | null> {
  if (cachedRemoteIdl) {
    return cachedRemoteIdl;
  }

  const fetched = await anchor.Program.fetchIdl(PAYROLL_PROGRAM_ID, provider);
  if (fetched) {
    cachedRemoteIdl = fetched;
  }
  return fetched;
}

function resolveParityMode(): ParityMode {
  const raw = process.env.PAYROLL_IDL_PARITY_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "error" : "warn";
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, stableNormalize(entry)]),
    );
  }

  return value;
}

function normalizeInstructionAccount(
  account: Record<string, unknown>,
): NormalizedInstructionAccount {
  return {
    name: String(account.name ?? ""),
    address:
      typeof account.address === "string" ? account.address : null,
    signer: account.signer === true,
    writable: account.writable === true,
    optional: account.optional === true,
  };
}

function normalizePayrollIdl(idl: Idl): NormalizedPayrollIdl {
  const asRecord = idl as Record<string, unknown>;

  return {
    address:
      typeof asRecord.address === "string" ? (asRecord.address as string) : null,
    accounts: ((asRecord.accounts as Array<Record<string, unknown>> | undefined) ?? [])
      .map((account) => ({
        name: String(account.name ?? ""),
        discriminator: Array.isArray(account.discriminator)
          ? (account.discriminator as number[])
          : null,
      })),
    instructions: (
      (asRecord.instructions as Array<Record<string, unknown>> | undefined) ?? []
    ).map((instruction) => ({
      name: String(instruction.name ?? ""),
      discriminator: Array.isArray(instruction.discriminator)
        ? (instruction.discriminator as number[])
        : null,
      args: stableNormalize(
        (instruction.args as unknown[] | undefined) ?? [],
      ) as unknown[],
      accounts: (
        (instruction.accounts as Array<Record<string, unknown>> | undefined) ?? []
      ).map(normalizeInstructionAccount),
    })),
    types: stableNormalize((asRecord.types as unknown[] | undefined) ?? []) as unknown[],
    errors: stableNormalize((asRecord.errors as unknown[] | undefined) ?? []) as unknown[],
  };
}

function comparePayrollIdls(localIdl: Idl, remoteIdl: Idl): PayrollIdlParityResult {
  const mode = resolveParityMode();
  const local = normalizePayrollIdl(localIdl);
  const remote = normalizePayrollIdl(remoteIdl);
  const diffs: string[] = [];

  if (local.address !== remote.address) {
    diffs.push(`Program address mismatch: local=${local.address} remote=${remote.address}`);
  }

  if (JSON.stringify(local.accounts) !== JSON.stringify(remote.accounts)) {
    diffs.push("Top-level account definitions differ.");
  }

  if (JSON.stringify(local.types) !== JSON.stringify(remote.types)) {
    diffs.push("IDL types differ.");
  }

  if (JSON.stringify(local.errors) !== JSON.stringify(remote.errors)) {
    diffs.push("IDL error definitions differ.");
  }

  const localByName = new Map(local.instructions.map((instruction) => [instruction.name, instruction]));
  const remoteByName = new Map(remote.instructions.map((instruction) => [instruction.name, instruction]));

  for (const [name, instruction] of localByName.entries()) {
    const remoteInstruction = remoteByName.get(name);
    if (!remoteInstruction) {
      diffs.push(`Remote IDL is missing instruction: ${name}`);
      continue;
    }

    if (JSON.stringify(instruction.discriminator) !== JSON.stringify(remoteInstruction.discriminator)) {
      diffs.push(`Instruction discriminator mismatch: ${name}`);
    }

    if (JSON.stringify(instruction.args) !== JSON.stringify(remoteInstruction.args)) {
      diffs.push(`Instruction args mismatch: ${name}`);
    }

    if (JSON.stringify(instruction.accounts) !== JSON.stringify(remoteInstruction.accounts)) {
      diffs.push(`Instruction accounts mismatch: ${name}`);
    }
  }

  for (const name of remoteByName.keys()) {
    if (!localByName.has(name)) {
      diffs.push(`Local IDL is missing instruction: ${name}`);
    }
  }

  const ok = diffs.length === 0;
  const summary = ok
    ? "Local payroll IDL matches the fetched on-chain IDL."
    : `Payroll IDL parity failed with ${diffs.length} difference(s).`;

  return { ok, mode, summary, diffs };
}

function formatParityFailure(result: PayrollIdlParityResult): string {
  const details = result.diffs.slice(0, 8).map((diff) => `- ${diff}`).join("\n");
  const suffix =
    result.diffs.length > 8
      ? `\n- ...and ${result.diffs.length - 8} more difference(s)`
      : "";
  return `${result.summary}\n${details}${suffix}`;
}

export async function verifyPayrollIdlParity(
  provider: anchor.AnchorProvider,
): Promise<PayrollIdlParityResult> {
  if (cachedParityResult) {
    return cachedParityResult;
  }

  if (parityPromise) {
    return parityPromise;
  }

  parityPromise = (async () => {
    const mode = resolveParityMode();
    const localIdl = readLocalPayrollIdl();

    if (!localIdl) {
      const result: PayrollIdlParityResult = {
        ok: true,
        mode,
        summary: "Local payroll IDL is unavailable; parity check skipped.",
        diffs: [],
      };
      cachedParityResult = result;
      return result;
    }

    let remoteIdl: Idl | null = null;
    try {
      remoteIdl = await fetchRemotePayrollIdl(provider);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown remote IDL fetch error";
      const result: PayrollIdlParityResult = {
        ok: mode !== "error",
        mode,
        summary: `Unable to fetch on-chain payroll IDL for parity check: ${message}`,
        diffs: [],
      };
      cachedParityResult = result;
      return result;
    }

    if (!remoteIdl) {
      const result: PayrollIdlParityResult = {
        ok: mode !== "error",
        mode,
        summary: "Unable to fetch on-chain payroll IDL for parity check.",
        diffs: [],
      };
      cachedParityResult = result;
      return result;
    }

    const result = comparePayrollIdls(localIdl, remoteIdl);
    cachedParityResult = result;
    return result;
  })();

  try {
    return await parityPromise;
  } finally {
    parityPromise = null;
  }
}

export async function assertPayrollIdlParity(
  provider: anchor.AnchorProvider,
): Promise<void> {
  const result = await verifyPayrollIdlParity(provider);

  if (result.ok) {
    return;
  }

  const message = formatParityFailure(result);
  if (result.mode === "error") {
    throw new Error(message);
  }

  if (result.mode === "warn") {
    console.warn(message);
  }
}

export async function loadPayrollIdl(
  provider: anchor.AnchorProvider,
): Promise<Idl> {
  const localIdl = readLocalPayrollIdl();
  if (localIdl) {
    await assertPayrollIdlParity(provider);
    return localIdl;
  }

  const remoteIdl = await fetchRemotePayrollIdl(provider);
  if (remoteIdl) {
    return remoteIdl;
  }

  throw new Error(
    "Failed to load payroll IDL from the deployed program and no local fallback was found",
  );
}

export function getLocalPayrollIdlPath() {
  return LOCAL_IDL_PATH;
}
