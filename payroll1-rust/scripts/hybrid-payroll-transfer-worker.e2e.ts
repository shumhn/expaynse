/**
 * scripts/hybrid-payroll-transfer-worker.e2e.ts
 *
 * Second E2E test for the final hybrid/API private payroll architecture.
 * Final version with auto-auth and instant-start fixes.
 */

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

// -----------------------------------------------------------------------------
// Constants.
// -----------------------------------------------------------------------------

const DEFAULT_PROGRAM_ID = "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6";

const DEFAULT_DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

const DEFAULT_PERMISSION_PROGRAM_ID = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
);

const DEFAULT_DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

const EMPLOYEE_SEED = "employee";
const PAYROLL_SEED = "payroll";

const PERMISSION_SEED = "permission:";
const DELEGATE_BUFFER_TAG = "buffer";
const DELEGATION_RECORD_TAG = "delegation";
const DELEGATION_METADATA_TAG = "delegation-metadata";

// -----------------------------------------------------------------------------
// Basic helpers.
// -----------------------------------------------------------------------------

function env(name: string): string | undefined {
  return process.env[name];
}

function mustEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function envNumber(name: string, fallback: number): number {
  const v = env(name);
  return v ? Number(v) : fallback;
}

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sha256_32(input: string): Buffer {
  return crypto.createHash("sha256").update(input).digest().subarray(0, 32);
}

function hash32Bytes(input: string): number[] {
  return Array.from(crypto.createHash("sha256").update(input).digest());
}

function pk(value: string | undefined, fallback: PublicKey): PublicKey {
  return value ? new PublicKey(value) : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asU64String(value: any): string {
  if (value == null) return "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return JSON.stringify(value);
}

async function getTeeToken(connectionUrl: string, keypair: Keypair): Promise<string> {
  const auth = await getAuthToken(
    connectionUrl,
    keypair.publicKey,
    async (message) => nacl.sign.detached(message, keypair.secretKey)
  );
  return auth.token;
}

async function sendErTx(
  connection: Connection,
  keypair: Keypair,
  instruction: any
) {
  const tx = new Transaction().add(instruction);
  tx.feePayer = keypair.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(keypair);
  
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// -----------------------------------------------------------------------------
// PDA helpers.
// -----------------------------------------------------------------------------

function employeePda(
  programId: PublicKey,
  employer: PublicKey,
  streamId32: Buffer
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(EMPLOYEE_SEED), employer.toBuffer(), streamId32],
    programId
  )[0];
}

function payrollPda(programId: PublicKey, employee: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PAYROLL_SEED), employee.toBuffer()],
    programId
  )[0];
}

// -----------------------------------------------------------------------------
// Payroll state helper.
// -----------------------------------------------------------------------------

async function fetchPayroll(program: Program, payroll: PublicKey): Promise<any> {
  const anyProgram = program as any;
  if (!anyProgram.account?.payrollState) {
    throw new Error("program.account.payrollState not found. Check IDL account name.");
  }

  return anyProgram.account.payrollState.fetch(payroll);
}

function printPayroll(label: string, state: any) {
  console.log(`\n${label}`);
  console.log("  status:", state.status);
  console.log("  accrued_unpaid:", asU64String(state.accruedUnpaid));
  console.log("  total_paid_private:", asU64String(state.totalPaidPrivate));
  console.log("  total_cancelled:", asU64String(state.totalCancelled));
  console.log("  next_claim_id:", asU64String(state.nextClaimId));
  console.log("  pending_claim_id:", asU64String(state.pendingClaimId));
  console.log("  pending_amount:", asU64String(state.pendingAmount));
  console.log("  pending_status:", state.pendingStatus);
}

function assertPendingClaim(state: any) {
  if (Number(state.pendingStatus) !== 1) {
    throw new Error(`Expected pendingStatus=1, got ${state.pendingStatus}`);
  }
}

// -----------------------------------------------------------------------------
// Private Payments API helpers.
// -----------------------------------------------------------------------------

type TransferResponse = {
  kind?: string;
  version?: string;
  transactionBase64: string;
  sendTo?: string;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  instructionCount?: number;
  requiredSigners?: string[];
  validator?: string;
  [key: string]: any;
};

async function postJson<T>(
  url: string,
  body: any,
  bearerToken?: string
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (bearerToken) {
    headers.Authorization = bearerToken.startsWith("Bearer ")
      ? bearerToken
      : `Bearer ${bearerToken}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `POST ${url} failed ${res.status} ${res.statusText}\n${JSON.stringify(json, null, 2)}`
    );
  }

  return json as T;
}

function decodeUnsignedTransaction(base64: string): Transaction | VersionedTransaction {
  const raw = Buffer.from(base64, "base64");

  try {
    return VersionedTransaction.deserialize(raw);
  } catch (_) {
    return Transaction.from(raw);
  }
}

function signTransactionWithKeypair(
  tx: Transaction | VersionedTransaction,
  signer: Keypair
): Transaction | VersionedTransaction {
  if (tx instanceof VersionedTransaction) {
    tx.sign([signer]);
    return tx;
  }

  tx.partialSign(signer);
  return tx;
}

async function refreshRecentBlockhash(
  conn: Connection,
  tx: Transaction | VersionedTransaction
) {
  const latest = await conn.getLatestBlockhash("confirmed");

  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = latest.blockhash;
    return tx;
  }

  tx.recentBlockhash = latest.blockhash;
  return tx;
}

async function sendSignedApiTransaction(params: {
  baseConnection: Connection;
  erConnection: Connection;
  response: TransferResponse;
  signer: Keypair;
}): Promise<string> {
  if (!params.response.transactionBase64) {
    throw new Error(`API response missing transactionBase64:\n${JSON.stringify(params.response, null, 2)}`);
  }

  const tx = decodeUnsignedTransaction(params.response.transactionBase64);

  const sendTo = String(params.response.sendTo ?? "base").toLowerCase();
  const connection = sendTo.includes("er") || sendTo.includes("ephemeral") || sendTo.includes("magic")
    ? params.erConnection
    : params.baseConnection;

  await refreshRecentBlockhash(connection, tx);

  const required = params.response.requiredSigners ?? [];
  if (required.length > 0) {
    console.log("API requiredSigners:", required.join(", "));
    const needsSigner = required.some((s) => s === params.signer.publicKey.toBase58());
    if (!needsSigner) {
      console.warn(
        `⚠️ payroll treasury ${params.signer.publicKey.toBase58()} not listed in requiredSigners. Continuing anyway.`
      );
    }
  }

  signTransactionWithKeypair(tx, params.signer);

  const raw = tx.serialize();


  let sig = "";
  try {
    sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 5,
    });
  } catch (err: any) {
    if (err.logs) {
      console.error("❌ Transaction Logs:", err.logs);
    }
    throw err;
  }

  await connection.confirmTransaction(sig, "confirmed");

  console.log(`✅ Sent Private Payments tx to ${sendTo}:`, sig);
  return sig;
}

// -----------------------------------------------------------------------------
// Main E2E.
// -----------------------------------------------------------------------------

async function main() {
  const programId = new PublicKey(env("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID);
  const baseRpc = mustEnv("BASE_RPC_URL");
  const erRpc = mustEnv("ER_RPC_URL");
  const apiBase = env("PAYMENTS_API_URL") ?? "https://payments.magicblock.app";
  const bearerToken = mustEnv("PAYMENTS_BEARER_TOKEN");

  const employer = loadKeypair(mustEnv("EMPLOYER_KEYPAIR"));
  const employee = loadKeypair(mustEnv("EMPLOYEE_KEYPAIR"));
  const payrollTreasury = loadKeypair(mustEnv("PAYROLL_TREASURY_KEYPAIR"));

  const settlement = env("SETTLEMENT_KEYPAIR")
    ? loadKeypair(mustEnv("SETTLEMENT_KEYPAIR"))
    : employer;

  const requestAmount = new BN(envNumber("REQUEST_AMOUNT", 1_000_000));

  const streamIdLabel = env("STREAM_ID") ?? "hybrid-payroll-state-002";
  const streamId = sha256_32(streamIdLabel);

  const baseConnection = new Connection(baseRpc, "confirmed");
  
  console.log("🔐 Fetching TEE auth tokens...");
  const employerToken = await getTeeToken(erRpc, employer);
  const employeeToken = await getTeeToken(erRpc, employee);
  const settlementToken = (settlement.publicKey.equals(employer.publicKey)) 
    ? employerToken 
    : await getTeeToken(erRpc, settlement);

  const employerErConnection = new Connection(`${erRpc}?token=${employerToken}`, "confirmed");
  const employeeErConnection = new Connection(`${erRpc}?token=${employeeToken}`, "confirmed");
  const settlementErConnection = new Connection(`${erRpc}?token=${settlementToken}`, "confirmed");

  const employerErProvider = new AnchorProvider(
    employerErConnection,
    new Wallet(employer),
    { commitment: "confirmed", skipPreflight: true }
  );

  const employeeErProvider = new AnchorProvider(
    employeeErConnection,
    new Wallet(employee),
    { commitment: "confirmed", skipPreflight: true }
  );

  const settlementErProvider = new AnchorProvider(
    settlementErConnection,
    new Wallet(settlement),
    { commitment: "confirmed", skipPreflight: true }
  );

  const idlPath = env("IDL_PATH") ?? "target/idl/payroll.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl & { address?: string };
  idl.address = programId.toBase58();

  const employerErProgram = new Program(idl, employerErProvider);
  const employeeErProgram = new Program(idl, employeeErProvider);
  const settlementErProgram = new Program(idl, settlementErProvider);

  let payroll: PublicKey;

  if (env("PAYROLL")) {
    payroll = new PublicKey(mustEnv("PAYROLL"));
  } else {
    const employeeAccount = employeePda(programId, employer.publicKey, streamId);
    payroll = payrollPda(programId, employeeAccount);
  }

  console.log("\nHybrid Payroll Transfer Worker E2E");
  console.log("Program:", programId.toBase58());
  console.log("Payroll:", payroll.toBase58());
  console.log("Employer:", employer.publicKey.toBase58());
  console.log("Employee:", employee.publicKey.toBase58());
  console.log("Payroll treasury signer:", payrollTreasury.publicKey.toBase58());
  console.log("Settlement authority:", settlement.publicKey.toBase58());
  console.log("API:", apiBase);
  console.log("Request amount:", requestAmount.toString());

  let payrollState = await fetchPayroll(employerErProgram, payroll);
  printPayroll("Initial payroll state", payrollState);

  // Verify the payroll state was initialized with the expected treasury.
  const stateTreasury = new PublicKey(payrollState.payrollTreasury);
  if (!stateTreasury.equals(payrollTreasury.publicKey)) {
    throw new Error(
      `PAYROLL_TREASURY_KEYPAIR does not match payroll.payroll_treasury.\n` +
      `State treasury: ${stateTreasury.toBase58()}\n` +
      `Signer:         ${payrollTreasury.publicKey.toBase58()}`
    );
  }

  // If the stream is paused, resume it.
  if (Number(payrollState.status) === 2) {
    const resumeIx = await employerErProgram.methods
      .resumeStream()
      .accounts({
        employer: employer.publicKey,
        payroll,
      })
      .instruction();

    await sendErTx(employerErConnection, employer, resumeIx);

    console.log("✅ resume_stream");
    await sleep(2000);
  }

  // Always checkpoint before requesting.
  const checkpointIx = await employerErProgram.methods
    .checkpointAccrual()
    .accounts({ payroll })
    .instruction();

  await sendErTx(employerErConnection, employer, checkpointIx);

  console.log("✅ checkpoint_accrual");

  payrollState = await fetchPayroll(employerErProgram, payroll);
  printPayroll("After checkpoint", payrollState);

  // If a previous pending exists, cancel it first.
  if (Number(payrollState.pendingStatus) === 1) {
    const pendingClaimId = new BN(asU64String(payrollState.pendingClaimId));

    const cancelOldIx = await settlementErProgram.methods
      .cancelPendingWithdrawal(pendingClaimId)
      .accounts({
        settlementAuthority: settlement.publicKey,
        payroll,
      })
      .instruction();

    await sendErTx(settlementErConnection, settlement, cancelOldIx);

    console.log("✅ cancelled previous pending claim");

    payrollState = await fetchPayroll(settlementErProgram, payroll);
    printPayroll("After previous pending cancel", payrollState);
  }

  const accrued = BigInt(asU64String(payrollState.accruedUnpaid));
  const amount = BigInt(requestAmount.toString());

  if (accrued < amount) {
    console.log("Not enough accrued yet; waiting 3 seconds and checkpointing again...");
    await sleep(3000);

    const checkpointIx2 = await employerErProgram.methods
      .checkpointAccrual()
      .accounts({ payroll })
      .instruction();
    await sendErTx(employerErConnection, employer, checkpointIx2);

    payrollState = await fetchPayroll(employerErProgram, payroll);
    printPayroll("After second checkpoint", payrollState);
  }

  // 1. Employee requests withdrawal.
  const requestIx = await employeeErProgram.methods
    .requestWithdrawal(requestAmount)
    .accounts({
      employeeSigner: employee.publicKey,
      payroll,
    })
    .instruction();

  await sendErTx(employeeErConnection, employee, requestIx);

  console.log("✅ request_withdrawal");
  console.log("⏳ Waiting 5 seconds for ER state to settle...");
  await sleep(5000);

  payrollState = await fetchPayroll(employeeErProgram, payroll);
  printPayroll("After request_withdrawal", payrollState);
  assertPendingClaim(payrollState);

  const claimId = new BN(asU64String(payrollState.pendingClaimId));
  const pendingAmount = new BN(asU64String(payrollState.pendingAmount));
  const mint = new PublicKey(payrollState.mint);
  const employeeWallet = new PublicKey(payrollState.employeeWallet);
  const treasury = new PublicKey(payrollState.payrollTreasury);

  const clientRefId = claimId.toString();

  // 2. Worker calls MagicBlock /v1/spl/transfer.
  const transferBody = {
    from: treasury.toBase58(),
    to: employeeWallet.toBase58(),
    mint: mint.toBase58(),
    amount: Number(pendingAmount.toString()),
    visibility: "private",
    fromBalance: "base",
    toBalance: "base",
    initIfMissing: false,
    initAtasIfMissing: false,
    initVaultIfMissing: false,
    gasless: false,
    clientRefId,
  };

  console.log("\nCalling /v1/spl/transfer with:");
  console.log(JSON.stringify(transferBody, null, 2));

  const transferResponse = await postJson<TransferResponse>(
    `${apiBase}/v1/spl/transfer`,
    transferBody,
    bearerToken
  );

  console.log("\n/v1/spl/transfer response:");
  console.log(JSON.stringify(transferResponse, null, 2));

  // 3. Sign and send returned unsigned transaction with payroll treasury keypair.
  const paymentSig = await sendSignedApiTransaction({
    baseConnection,
    erConnection: employerErConnection, // Use authenticated connection
    response: transferResponse,
    signer: payrollTreasury,
  });

  // 4. Settlement authority marks private transfer paid.
  const paymentRefHash = hash32Bytes(paymentSig);

  const markPaidIx = await settlementErProgram.methods
    .markPrivateTransferPaid(
      claimId,
      pendingAmount,
      paymentRefHash
    )
    .accounts({
      settlementAuthority: settlement.publicKey,
      payroll,
    })
    .instruction();

  await sendErTx(settlementErConnection, settlement, markPaidIx);

  console.log("✅ mark_private_transfer_paid");

  payrollState = await fetchPayroll(settlementErProgram, payroll);
  printPayroll("After mark_private_transfer_paid", payrollState);

  if (Number(payrollState.pendingStatus) !== 0) {
    throw new Error("Expected pending_status=0 after mark_private_transfer_paid");
  }

  const totalPaid = BigInt(asU64String(payrollState.totalPaidPrivate));
  if (totalPaid <= BigInt(0)) {
    throw new Error("Expected total_paid_private > 0");
  }

  console.log("\n🎉 HYBRID PAYROLL TRANSFER WORKER E2E SUCCESS");
  console.log("Payroll state authorized claim, Private Payments API sent transfer, and settlement was recorded.");
}

main().catch((err) => {
  console.error("\n❌ HYBRID PAYROLL TRANSFER WORKER E2E FAILED");
  console.error(err);
  process.exit(1);
});
