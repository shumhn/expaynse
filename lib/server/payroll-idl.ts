import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const PAYROLL_PROGRAM_ID = new PublicKey(
  "EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR",
);

const LOCAL_IDL_PATH = path.join(
  process.cwd(),
  "payroll1-rust",
  "target",
  "idl",
  "payroll.json",
);

let cachedRemoteIdl: Idl | null = null;
let cachedLocalIdl: Idl | null = null;

function readLocalPayrollIdl(): Idl | null {
  if (cachedLocalIdl) {
    return cachedLocalIdl;
  }

  if (!fs.existsSync(LOCAL_IDL_PATH)) {
    return null;
  }

  const raw = fs.readFileSync(LOCAL_IDL_PATH, "utf8");
  cachedLocalIdl = JSON.parse(raw) as Idl;
  return cachedLocalIdl;
}

export async function loadPayrollIdl(
  provider: anchor.AnchorProvider,
): Promise<Idl> {
  if (cachedRemoteIdl) {
    return cachedRemoteIdl;
  }

  try {
    const fetched = await anchor.Program.fetchIdl(
      PAYROLL_PROGRAM_ID,
      provider,
    );

    if (fetched) {
      cachedRemoteIdl = fetched;
      return fetched;
    }
  } catch {
    // Fall through to local IDL fallback.
  }

  const localIdl = readLocalPayrollIdl();
  if (localIdl) {
    return localIdl;
  }

  throw new Error(
    "Failed to load payroll IDL from the deployed program and no local fallback was found",
  );
}

export function getLocalPayrollIdlPath() {
  return LOCAL_IDL_PATH;
}
