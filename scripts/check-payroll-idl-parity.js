#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { Keypair, Connection, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey("HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6");
const ROOT_DIR = path.resolve(__dirname, "..");
const LOCAL_IDL_PATH = path.join(ROOT_DIR, "contracts", "payroll", "target", "idl", "payroll.json");
const CLUSTER_URL = process.env.PAYROLL_IDL_PARITY_RPC_URL || "https://api.devnet.solana.com";

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableNormalize(entry)]),
    );
  }

  return value;
}

function normalizeInstructionAccount(account) {
  return {
    name: account.name ?? "",
    address: account.address ?? null,
    signer: account.signer === true,
    writable: account.writable === true,
    optional: account.optional === true,
  };
}

function normalizeIdl(idl) {
  return {
    address: idl.address ?? null,
    accounts: (idl.accounts ?? []).map((account) => ({
      name: account.name ?? "",
      discriminator: Array.isArray(account.discriminator) ? account.discriminator : null,
    })),
    instructions: (idl.instructions ?? []).map((instruction) => ({
      name: instruction.name ?? "",
      discriminator: Array.isArray(instruction.discriminator)
        ? instruction.discriminator
        : null,
      args: stableNormalize(instruction.args ?? []),
      accounts: (instruction.accounts ?? []).map(normalizeInstructionAccount),
    })),
    types: stableNormalize(idl.types ?? []),
    errors: stableNormalize(idl.errors ?? []),
  };
}

function compareIdls(localIdl, remoteIdl) {
  const local = normalizeIdl(localIdl);
  const remote = normalizeIdl(remoteIdl);
  const diffs = [];

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

  return diffs;
}

async function main() {
  if (!fs.existsSync(LOCAL_IDL_PATH)) {
    throw new Error(`Local payroll IDL not found: ${LOCAL_IDL_PATH}`);
  }

  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error("ANCHOR_WALLET must be set for IDL parity verification.");
  }

  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(CLUSTER_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const localIdl = JSON.parse(fs.readFileSync(LOCAL_IDL_PATH, "utf8"));
  const remoteIdl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);

  if (!remoteIdl) {
    throw new Error("Failed to fetch on-chain payroll IDL.");
  }

  const diffs = compareIdls(localIdl, remoteIdl);
  if (diffs.length > 0) {
    console.error("Payroll IDL parity check failed:");
    for (const diff of diffs) {
      console.error(`- ${diff}`);
    }
    process.exit(1);
  }

  console.log("Payroll IDL parity check passed.");
  console.log(`Local IDL: ${LOCAL_IDL_PATH}`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`RPC: ${CLUSTER_URL}`);
}

main().catch((error) => {
  console.error("Payroll IDL parity check failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
