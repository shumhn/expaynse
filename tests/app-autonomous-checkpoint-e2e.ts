// Route-level autonomous checkpoint verification runner
//
// Purpose:
// Prove that the scheduled checkpoint crank mutates on-chain PER payroll state
// without calling the manual payroll tick route.
//
// What this covers:
// 1. Creates an employee via app route handler
// 2. Creates a paused stream via app route handler
// 3. Builds and signs onboarding transactions
// 4. Finalizes onboarding metadata in app storage
// 5. Employee self-initializes their private account
// 6. Reads exact private payroll state from /api/payroll/state
// 7. Resumes the stream and schedules checkpoint crank
// 8. Polls exact on-chain payroll state without calling /api/payroll/tick
// 9. Verifies lastAccrualTimestamp and/or accruedUnpaidMicro advances autonomously
// 10. Pauses the stream and cancels the crank
// 11. Verifies the exact state stops changing after cancellation
//
// Required env:
// - MONGODB_URI=...
//
// Optional env:
// - ANCHOR_WALLET=/path/to/employer-keypair.json
// - TEST_INITIAL_RATE=0.02
// - TEST_CRANK_INTERVAL_MS=1000
// - TEST_AUTONOMOUS_POLL_ATTEMPTS=15
// - TEST_AUTONOMOUS_POLL_DELAY_MS=3000
// - TEST_CANCEL_SETTLE_WAIT_MS=6000

import assert from "assert";
import { randomUUID } from "crypto";
import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { NextRequest } from "next/server.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

import {
  POST as employeePrivateInitBuildPost,
  PATCH as employeePrivateInitFinalizePatch,
} from "../app/api/employee-private-init/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { GET as payrollStateGet } from "../app/api/payroll/state/route.ts";
import {
  PATCH as checkpointCrankFinalizePatch,
  POST as checkpointCrankBuildPost,
} from "../app/api/streams/checkpoint-crank/route.ts";
import {
  PATCH as controlFinalizePatch,
  POST as controlBuildPost,
} from "../app/api/streams/control/route.ts";
import {
  PATCH as onboardFinalizePatch,
  POST as onboardBuildPost,
} from "../app/api/streams/onboard/route.ts";
import { POST as streamsPost } from "../app/api/streams/route.ts";
import { fetchTeeAuthToken, getBalance, signAndSend } from "../lib/magicblock-api.ts";
import { createAnchorNodeWallet } from "../lib/server/anchor-wallet.ts";
import { loadPayrollIdl } from "../lib/server/payroll-idl.ts";
import { makeAuthenticatedJsonRequest } from "./wallet-auth-test-helpers.ts";

const DEFAULT_WALLET_PATH =
  "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";
const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEE_RPC_BASE = "https://devnet-tee.magicblock.app";

type SendableTx = Transaction | VersionedTransaction;
type ControlAction = "update-rate" | "pause" | "resume" | "stop";
type CheckpointCrankMode = "schedule" | "cancel";

type SendSpec = {
  transactionBase64: string;
  sendTo: string;
};

type OnboardBuildResponse = {
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  alreadyOnboarded?: boolean;
  transactions: {
    baseSetup?: SendSpec;
    initializePrivatePayroll?: SendSpec;
  };
};

type EmployeePrivateInitBuildResponse = {
  employeeWallet: string;
  amountMicro: number;
  message: string;
  transaction: SendSpec;
};

type EmployeePrivateInitFinalizeResponse = {
  employeeWallet: string;
  initializedAt: string;
  message: string;
  privateBalance?: {
    address: string;
    mint: string;
    ata: string;
    location: "base" | "ephemeral";
    balance: string;
  } | null;
};

type StreamControlBuildResponse = {
  employerWallet: string;
  streamId: string;
  action: ControlAction;
  employeePda: string;
  privatePayrollPda: string;
  nextStatus: "active" | "paused" | "stopped";
  transactions: {
    control: SendSpec;
    commitEmployee: SendSpec;
  };
};

type CheckpointCrankBuildResponse = {
  employerWallet: string;
  streamId: string;
  mode: CheckpointCrankMode;
  taskId: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  transactions: {
    checkpointCrank: SendSpec;
  };
};

type ExactPrivatePayrollStateResponse = {
  employerWallet: string;
  streamId: string;
  employee: {
    id: string;
    wallet: string;
    name: string;
  };
  stream: {
    id: string;
    status: "active" | "paused" | "stopped";
    ratePerSecond: number;
    employeePda: string | null;
    privatePayrollPda: string | null;
    permissionPda: string | null;
    delegatedAt: string | null;
    lastPaidAt: string | null;
    totalPaid: number;
  };
  state: {
    employeePda: string;
    privatePayrollPda: string;
    employee: string;
    employer: string;
    employeeWallet: string;
    ratePerSecondMicro: string;
    lastAccrualTimestamp: string;
    accruedUnpaidMicro: string;
    totalPaidPrivateMicro: string;
  };
  syncedAt: string;
};

type ExactStateSnapshot = {
  syncedAt: string;
  streamStatus: "active" | "paused" | "stopped";
  ratePerSecond: number;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string | null;
  lastAccrualTimestamp: bigint;
  accruedUnpaidMicro: bigint;
  totalPaidPrivateMicro: bigint;
};

type DirectCheckpointMethods = {
  checkpointAccrual(): {
    accountsPartial(input: {
      employee: PublicKey;
      privatePayroll: PublicKey;
      permission?: PublicKey;
    }): {
      instruction(): Promise<TransactionInstruction>;
    };
  };
};

function assertEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function envNumber(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }
  return parsed;
}

function envInteger(name: string, fallback: number) {
  const parsed = envNumber(name, fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative integer`,
    );
  }
  return parsed;
}

function resolveWalletPath() {
  return process.env.ANCHOR_WALLET || DEFAULT_WALLET_PATH;
}

function loadKeypair(walletPath: string) {
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[],
  );
  return Keypair.fromSecretKey(secret);
}

function toUiAmount(amountMicro: bigint | number) {
  const numeric =
    typeof amountMicro === "bigint" ? Number(amountMicro) : amountMicro;
  return numeric / 1_000_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSection(title: string) {
  console.log(`\n=== ${title} ===`);
}

function makeJsonRequest(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url: string, token?: string) {
  const headers = new Headers();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function fundAccountIfNeeded(args: {
  connection: Connection;
  payer: Keypair;
  recipient: PublicKey;
  minLamports: number;
}) {
  const balance = await args.connection.getBalance(args.recipient, "confirmed");
  if (balance >= args.minLamports) {
    return balance;
  }

  const lamportsNeeded = args.minLamports - balance;
  console.log(
    `Funding ${args.recipient.toBase58()} with ${(lamportsNeeded / 1_000_000_000).toFixed(3)} SOL from employer wallet`,
  );

  const latest = await args.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: args.payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: args.payer.publicKey,
      toPubkey: args.recipient,
      lamports: lamportsNeeded,
    }),
  );

  tx.sign(args.payer);

  const signature = await args.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  await args.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  return args.connection.getBalance(args.recipient, "confirmed");
}

async function fundEmployeeUsdcIfNeeded(args: {
  connection: Connection;
  payer: Keypair;
  recipient: PublicKey;
  minAmountMicro: bigint;
}) {
  const recipientWallet = args.recipient.toBase58();
  const current = await getBalance(recipientWallet);
  const currentMicro = BigInt(current.balance);

  if (currentMicro >= args.minAmountMicro) {
    return currentMicro;
  }

  const mint = new PublicKey(DEVNET_USDC);
  const payerAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.payer,
    mint,
    args.payer.publicKey,
  );
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.payer,
    mint,
    args.recipient,
  );

  const deltaMicro = args.minAmountMicro - currentMicro;
  if (deltaMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "Requested employee USDC top-up exceeds safe integer range",
    );
  }

  console.log(
    `Funding ${recipientWallet} with ${toUiAmount(deltaMicro).toFixed(6)} base USDC for self-init precondition`,
  );

  const latest = await args.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: args.payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    createTransferInstruction(
      payerAta.address,
      recipientAta.address,
      args.payer.publicKey,
      Number(deltaMicro),
    ),
  );

  tx.sign(args.payer);

  const signature = await args.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  await args.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  console.log("Employee base USDC top-up signature:", signature);

  const next = await getBalance(recipientWallet);
  return BigInt(next.balance);
}

function employerSignTransactionFactory(signer: Keypair) {
  return async (tx: SendableTx): Promise<SendableTx> => {
    if (tx instanceof VersionedTransaction) {
      tx.sign([signer]);
      return tx;
    }

    tx.partialSign(signer);
    return tx;
  };
}

function keypairSignMessageFactory(signer: Keypair) {
  return async (message: Uint8Array): Promise<Uint8Array> =>
    nacl.sign.detached(message, signer.secretKey);
}

async function sendBuiltTransaction(args: {
  spec: SendSpec;
  signer: Keypair;
  signerLabel: string;
  teeAuthToken?: string;
  useTeeRpc?: boolean;
  retrySendCount?: number;
  retryDelayMs?: number;
}) {
  console.log(`Sending ${args.signerLabel} tx -> ${args.spec.sendTo}`);
  return signAndSend(
    args.spec.transactionBase64,
    employerSignTransactionFactory(args.signer),
    {
      sendTo: args.spec.sendTo,
      rpcUrl:
        args.useTeeRpc && args.teeAuthToken
          ? `${TEE_RPC_BASE}?token=${encodeURIComponent(args.teeAuthToken)}`
          : undefined,
      signMessage: keypairSignMessageFactory(args.signer),
      publicKey: args.signer.publicKey,
      retrySendCount: args.retrySendCount,
      retryDelayMs: args.retryDelayMs,
    },
  );
}

async function getTeeProgramForEmployer(
  employer: Keypair,
  teeAuthToken: string,
): Promise<{
  connection: Connection;
  program: anchor.Program<Idl>;
}> {
  const connection = new Connection(
    `${TEE_RPC_BASE}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createAnchorNodeWallet(employer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
  return { connection, program };
}

async function serializeUnsignedTransaction(
  connection: Connection,
  feePayer: PublicKey,
  transaction: Transaction,
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = feePayer;
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}

async function buildAndSendDirectCheckpoint(args: {
  employerWallet: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda?: string | null;
  teeAuthToken: string;
  signer: Keypair;
}) {
  const employerPubkey = new PublicKey(args.employerWallet);
  const employeePda = new PublicKey(args.employeePda);
  const privatePayrollPda = new PublicKey(args.privatePayrollPda);
  const permissionPda = args.permissionPda
    ? new PublicKey(args.permissionPda)
    : null;

  const { connection, program } = await getTeeProgramForEmployer(
    args.signer,
    args.teeAuthToken,
  );

  const methods = program.methods as unknown as DirectCheckpointMethods;

  const checkpointIx = await methods
    .checkpointAccrual()
    .accountsPartial({
      employer: employerPubkey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
      ...(permissionPda ? { permission: permissionPda } : {}),
    })
    .instruction();

  const serialized = await serializeUnsignedTransaction(
    connection,
    employerPubkey,
    new Transaction().add(checkpointIx),
  );

  const signature = await sendBuiltTransaction({
    spec: {
      transactionBase64: Buffer.from(serialized).toString("base64"),
      sendTo: "ephemeral",
    },
    signer: args.signer,
    signerLabel: "checkpoint:direct",
    teeAuthToken: args.teeAuthToken,
    useTeeRpc: true,
  });

  return { signature };
}

async function buildCheckpointCrankAndFinalize(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  signer: Keypair;
  mode: CheckpointCrankMode;
  executionIntervalMillis?: number;
  iterations?: number;
}) {
  const buildResponse = await checkpointCrankBuildPost(
    makeJsonRequest("http://localhost/api/streams/checkpoint-crank", {
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      mode: args.mode,
      executionIntervalMillis: args.executionIntervalMillis,
      iterations: args.iterations,
    }),
  );

  assert.strictEqual(
    buildResponse.status,
    201,
    `${args.mode} checkpoint crank build should return 201`,
  );

  const buildJson = await json<
    CheckpointCrankBuildResponse & { error?: string }
  >(buildResponse);

  assert(
    buildJson.transactions?.checkpointCrank,
    buildJson.error ||
      `${args.mode} checkpoint crank build missing transaction`,
  );

  logSection(`Checkpoint crank: ${args.mode}`);

  const signature = await sendBuiltTransaction({
    spec: buildJson.transactions.checkpointCrank,
    signer: args.signer,
    signerLabel: `checkpoint-crank:${args.mode}`,
    teeAuthToken: args.teeAuthToken,
    useTeeRpc: true,
  });

  const finalizeResponse = await checkpointCrankFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/streams/checkpoint-crank",
      {
        employerWallet: args.employerWallet,
        streamId: args.streamId,
        mode: args.mode,
        taskId: buildJson.taskId,
        signature,
        status: args.mode === "schedule" ? "active" : "stopped",
      },
      "PATCH",
    ),
  );

  assert.strictEqual(
    finalizeResponse.status,
    200,
    `${args.mode} checkpoint crank finalize should return 200`,
  );

  const finalizeJson = await json<{
    message?: string;
    stream?: {
      id: string;
      checkpointCrankTaskId?: string | null;
      checkpointCrankStatus?: string | null;
    };
    error?: string;
  }>(finalizeResponse);

  assert(
    finalizeJson.stream,
    finalizeJson.error ||
      `${args.mode} checkpoint crank finalize missing updated stream`,
  );

  console.log(`checkpoint crank ${args.mode} complete:`, {
    signature,
    taskId: buildJson.taskId,
    checkpointCrankTaskId: finalizeJson.stream.checkpointCrankTaskId,
    checkpointCrankStatus: finalizeJson.stream.checkpointCrankStatus,
  });

  return {
    build: buildJson,
    finalize: finalizeJson,
    signature,
  };
}

async function buildControlAndFinalize(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  action: Extract<ControlAction, "pause" | "resume" | "stop">;
  signer: Keypair;
  crankIntervalMs?: number;
}) {
  const buildResponse = await controlBuildPost(
    makeJsonRequest("http://localhost/api/streams/control", {
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      action: args.action,
      teeAuthToken: args.teeAuthToken,
    }),
  );

  assert.strictEqual(
    buildResponse.status,
    201,
    `${args.action} build should return 201`,
  );

  const buildJson = await json<StreamControlBuildResponse & { error?: string }>(
    buildResponse,
  );

  assert(
    buildJson.transactions?.control,
    buildJson.error || `${args.action} build missing control transaction`,
  );
  assert(
    buildJson.transactions?.commitEmployee,
    buildJson.error || `${args.action} build missing commit transaction`,
  );

  logSection(`Control action: ${args.action}`);

  const controlSignature = await sendBuiltTransaction({
    spec: buildJson.transactions.control,
    signer: args.signer,
    signerLabel: `${args.action}:control`,
    teeAuthToken: args.teeAuthToken,
    useTeeRpc: true,
  });

  const commitSignature = await sendBuiltTransaction({
    spec: buildJson.transactions.commitEmployee,
    signer: args.signer,
    signerLabel: `${args.action}:commit`,
    teeAuthToken: args.teeAuthToken,
    useTeeRpc: true,
  });

  const finalizeResponse = await controlFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/streams/control",
      {
        employerWallet: args.employerWallet,
        streamId: args.streamId,
        action: args.action,
        employeePda: buildJson.employeePda,
        privatePayrollPda: buildJson.privatePayrollPda,
        controlSignature,
        commitSignature,
      },
      "PATCH",
    ),
  );

  assert.strictEqual(
    finalizeResponse.status,
    200,
    `${args.action} finalize should return 200`,
  );

  const finalizeJson = await json<{
    message?: string;
    stream?: {
      id: string;
      status: string;
      ratePerSecond: number;
    };
    error?: string;
  }>(finalizeResponse);

  assert(
    finalizeJson.stream,
    finalizeJson.error || `${args.action} finalize missing updated stream`,
  );

  console.log(`${args.action} complete:`, {
    controlSignature,
    commitSignature,
    streamStatus: finalizeJson.stream.status,
    ratePerSecond: finalizeJson.stream.ratePerSecond,
  });

  let checkpointCrank:
    | {
        build: CheckpointCrankBuildResponse;
        finalize: {
          message?: string;
          stream?: {
            id: string;
            checkpointCrankTaskId?: string | null;
            checkpointCrankStatus?: string | null;
          };
          error?: string;
        };
        signature: string;
      }
    | undefined;

  if (args.action === "resume") {
    checkpointCrank = await buildCheckpointCrankAndFinalize({
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      signer: args.signer,
      mode: "schedule",
      executionIntervalMillis: args.crankIntervalMs,
      iterations: 999_999_999,
    });
  } else if (args.action === "pause" || args.action === "stop") {
    checkpointCrank = await buildCheckpointCrankAndFinalize({
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      signer: args.signer,
      mode: "cancel",
    });
  }

  return {
    build: buildJson,
    finalize: finalizeJson,
    controlSignature,
    commitSignature,
    checkpointCrank,
  };
}

async function fetchExactState(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
}): Promise<ExactStateSnapshot> {
  const response = await payrollStateGet(
    makeGetRequest(
      `http://localhost/api/payroll/state?employerWallet=${encodeURIComponent(
        args.employerWallet,
      )}&streamId=${encodeURIComponent(args.streamId)}`,
      args.teeAuthToken,
    ),
  );

  assert.strictEqual(response.status, 200, "State route should return 200");

  const jsonBody = await json<
    ExactPrivatePayrollStateResponse & { error?: string }
  >(response);

  assert(jsonBody.state, jsonBody.error || "State route missing state payload");

  return {
    syncedAt: jsonBody.syncedAt,
    streamStatus: jsonBody.stream.status,
    ratePerSecond: jsonBody.stream.ratePerSecond,
    employeePda: jsonBody.state.employeePda,
    privatePayrollPda: jsonBody.state.privatePayrollPda,
    permissionPda: jsonBody.stream.permissionPda,
    lastAccrualTimestamp: BigInt(jsonBody.state.lastAccrualTimestamp),
    accruedUnpaidMicro: BigInt(jsonBody.state.accruedUnpaidMicro),
    totalPaidPrivateMicro: BigInt(jsonBody.state.totalPaidPrivateMicro),
  };
}

function didCheckpointAdvance(
  before: ExactStateSnapshot,
  after: ExactStateSnapshot,
) {
  return (
    after.lastAccrualTimestamp > before.lastAccrualTimestamp ||
    after.accruedUnpaidMicro > before.accruedUnpaidMicro
  );
}

function formatSnapshot(label: string, snapshot: ExactStateSnapshot) {
  return {
    label,
    syncedAt: snapshot.syncedAt,
    streamStatus: snapshot.streamStatus,
    lastAccrualTimestamp: snapshot.lastAccrualTimestamp.toString(),
    accruedUnpaidMicro: snapshot.accruedUnpaidMicro.toString(),
    accruedUnpaidUi: toUiAmount(snapshot.accruedUnpaidMicro).toFixed(6),
    totalPaidPrivateMicro: snapshot.totalPaidPrivateMicro.toString(),
  };
}

async function waitForAutonomousCheckpoint(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  baseline: ExactStateSnapshot;
  attempts: number;
  delayMs: number;
}) {
  let latest = args.baseline;

  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    await sleep(args.delayMs);
    latest = await fetchExactState({
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
    });

    console.log(
      `[poll:autonomous-checkpoint] ${attempt}/${args.attempts}`,
      formatSnapshot("latest", latest),
    );

    if (didCheckpointAdvance(args.baseline, latest)) {
      return latest;
    }
  }

  throw new Error(
    `Autonomous checkpoint did not advance within ${args.attempts} attempts`,
  );
}

async function ensureNoFurtherAutonomousCheckpoint(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  baseline: ExactStateSnapshot;
  waitMs: number;
}) {
  await sleep(args.waitMs);

  const after = await fetchExactState({
    employerWallet: args.employerWallet,
    streamId: args.streamId,
    teeAuthToken: args.teeAuthToken,
  });

  console.log(
    "State after cancel wait:",
    formatSnapshot("after-cancel", after),
  );

  assert.strictEqual(
    after.lastAccrualTimestamp.toString(),
    args.baseline.lastAccrualTimestamp.toString(),
    "lastAccrualTimestamp should not advance after crank cancellation",
  );

  assert.strictEqual(
    after.accruedUnpaidMicro.toString(),
    args.baseline.accruedUnpaidMicro.toString(),
    "accruedUnpaidMicro should not advance after crank cancellation",
  );

  return after;
}

async function main() {
  assertEnv("MONGODB_URI");

  const walletPath = resolveWalletPath();
  const employer = loadKeypair(walletPath);
  const employee = Keypair.generate();
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  const initialRate = envNumber("TEST_INITIAL_RATE", 0.02);
  const crankIntervalMs = envInteger("TEST_CRANK_INTERVAL_MS", 1000);
  const pollAttempts = envInteger("TEST_AUTONOMOUS_POLL_ATTEMPTS", 15);
  const pollDelayMs = envInteger("TEST_AUTONOMOUS_POLL_DELAY_MS", 3000);
  const cancelSettleWaitMs = envInteger("TEST_CANCEL_SETTLE_WAIT_MS", 6000);

  const employeeName = `Autonomous Checkpoint ${randomUUID().slice(0, 8)}`;
  const connection = new Connection(DEVNET_RPC, "confirmed");

  console.log("=== Autonomous Checkpoint Devnet E2E ===");
  console.log("Employer wallet:", employerWallet);
  console.log("Employee wallet:", employeeWallet);
  console.log("Employer keypair:", walletPath);

  logSection("Preflight");

  const employerSol = await connection.getBalance(
    employer.publicKey,
    "confirmed",
  );
  assert(employerSol > 0, "Employer wallet must be funded with devnet SOL");

  const employerBaseUsdc = await getBalance(employerWallet);
  const employerBaseUsdcMicro = BigInt(employerBaseUsdc.balance);

  console.log("Employer SOL:", (employerSol / 1_000_000_000).toFixed(4));
  console.log(
    "Employer base USDC:",
    `${toUiAmount(employerBaseUsdcMicro).toFixed(6)} USDC`,
  );

  assert(
    employerBaseUsdcMicro > 0n,
    "Employer must hold devnet USDC on base for setup preconditions",
  );

  await fundAccountIfNeeded({
    connection,
    payer: employer,
    recipient: employee.publicKey,
    minLamports: 200_000_000,
  });

  await fundEmployeeUsdcIfNeeded({
    connection,
    payer: employer,
    recipient: employee.publicKey,
    minAmountMicro: 1n,
  });

  const employerTeeAuthToken = await fetchTeeAuthToken(
    employer.publicKey,
    keypairSignMessageFactory(employer),
  );
  assert(
    employerTeeAuthToken.length > 0,
    "Expected non-empty employer TEE auth token",
  );

  const employeeTeeAuthToken = await fetchTeeAuthToken(
    employee.publicKey,
    keypairSignMessageFactory(employee),
  );
  assert(
    employeeTeeAuthToken.length > 0,
    "Expected non-empty employee TEE auth token",
  );

  console.log("Employer TEE auth acquired");
  console.log("Employee TEE auth acquired");

  logSection("Create employee");

  const employeeResponse = await employeesPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/employees",
      wallet: employerWallet,
      signer: employer,
      body: {
        employerWallet,
        wallet: employeeWallet,
        name: employeeName,
        notes: "Created by autonomous checkpoint e2e runner",
      },
    }),
  );

  assert.strictEqual(
    employeeResponse.status,
    201,
    "Employee create should return 201",
  );

  const employeeJson = await json<{
    employee?: {
      id: string;
      wallet: string;
      name: string;
    };
    error?: string;
  }>(employeeResponse);

  assert(
    employeeJson.employee,
    employeeJson.error || "Employee create missing payload",
  );

  const employeeId = employeeJson.employee.id;
  console.log("Employee created:", employeeJson.employee);

  logSection("Create paused stream");

  const streamResponse = await streamsPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams",
      wallet: employerWallet,
      signer: employer,
      body: {
        employerWallet,
        employeeId,
        ratePerSecond: initialRate,
        status: "paused",
      },
    }),
  );

  assert.strictEqual(
    streamResponse.status,
    201,
    "Stream create should return 201",
  );

  const streamJson = await json<{
    stream?: {
      id: string;
      status: string;
      ratePerSecond: number;
    };
    error?: string;
  }>(streamResponse);

  assert(
    streamJson.stream,
    streamJson.error || "Stream create missing payload",
  );

  const streamId = streamJson.stream.id;
  console.log("Stream created:", streamJson.stream);

  logSection("Build onboarding transactions");

  const onboardResponse = await onboardBuildPost(
    makeJsonRequest("http://localhost/api/streams/onboard", {
      employerWallet,
      streamId,
      teeAuthToken: employerTeeAuthToken,
    }),
  );

  assert(
    onboardResponse.status === 200 || onboardResponse.status === 201,
    `Onboard build should return 200 or 201, received ${onboardResponse.status}`,
  );

  const onboardJson = await json<OnboardBuildResponse & { error?: string }>(
    onboardResponse,
  );

  if (!onboardJson.alreadyOnboarded) {
    assert(
      onboardJson.transactions?.createEmployee,
      onboardJson.error || "Missing createEmployee onboarding tx",
    );
    assert(
      onboardJson.transactions?.createPermission,
      onboardJson.error || "Missing createPermission onboarding tx",
    );
    assert(
      onboardJson.transactions?.baseSetup,
      onboardJson.error || "Missing baseSetup onboarding tx",
    );
    assert(
      onboardJson.transactions?.initializePrivatePayroll,
      onboardJson.error || "Missing initializePrivatePayroll onboarding tx",
    );
  }

  console.log("Onboarding build:", {
    employeePda: onboardJson.employeePda,
    privatePayrollPda: onboardJson.privatePayrollPda,
    permissionPda: onboardJson.permissionPda,
    alreadyOnboarded: onboardJson.alreadyOnboarded ?? false,
  });

  logSection("Sign and send onboarding transactions");

  let baseSetupSignature: string | undefined;
  if (onboardJson.transactions.baseSetup) {
    baseSetupSignature = await sendBuiltTransaction({
      spec: onboardJson.transactions.baseSetup,
      signer: employer,
      signerLabel: "onboard:baseSetup",
    });

    console.log("Waiting for delegation to settle...");
    await sleep(3000);
  }

  let initializePrivatePayrollSignature: string | undefined;
  if (onboardJson.transactions.initializePrivatePayroll) {
    initializePrivatePayrollSignature = await sendBuiltTransaction({
      spec: onboardJson.transactions.initializePrivatePayroll,
      signer: employer,
      signerLabel: "onboard:initializePrivatePayroll",
      teeAuthToken: employerTeeAuthToken,
      useTeeRpc: true,
      retrySendCount: 3,
      retryDelayMs: 5_000,
    });
  }

  console.log("Onboarding signatures:", {
    baseSetupSignature,
    initializePrivatePayrollSignature,
  });

  logSection("Finalize onboarding metadata");

  const onboardFinalizeResponse = await onboardFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/streams/onboard",
      {
        employerWallet,
        streamId,
        employeePda: onboardJson.employeePda,
        privatePayrollPda: onboardJson.privatePayrollPda,
        permissionPda: onboardJson.permissionPda,
      },
      "PATCH",
    ),
  );

  assert.strictEqual(
    onboardFinalizeResponse.status,
    200,
    "Onboard finalize should return 200",
  );

  const onboardFinalizeJson = await json<{
    message?: string;
    stream?: {
      id: string;
      employeePda?: string;
      privatePayrollPda?: string;
      permissionPda?: string;
      delegatedAt?: string | null;
    };
    error?: string;
  }>(onboardFinalizeResponse);

  assert(
    onboardFinalizeJson.stream,
    onboardFinalizeJson.error || "Onboard finalize missing updated stream",
  );

  console.log("Onboard finalize:", onboardFinalizeJson.stream);

  logSection("Employee self-initializes private account");

  const employeePrivateInitBuildResponse = await employeePrivateInitBuildPost(
    makeJsonRequest("http://localhost/api/employee-private-init", {
      employeeWallet,
    }),
  );

  assert.strictEqual(
    employeePrivateInitBuildResponse.status,
    201,
    "Employee private init build should return 201",
  );

  const employeePrivateInitBuildJson = await json<
    EmployeePrivateInitBuildResponse & { error?: string }
  >(employeePrivateInitBuildResponse);

  assert(
    employeePrivateInitBuildJson.transaction,
    employeePrivateInitBuildJson.error ||
      "Employee private init build missing transaction",
  );

  const employeePrivateInitSignature = await sendBuiltTransaction({
    spec: employeePrivateInitBuildJson.transaction,
    signer: employee,
    signerLabel: "employee:initPrivateAccount",
  });

  const employeePrivateInitFinalizeResponse =
    await employeePrivateInitFinalizePatch(
      makeJsonRequest(
        "http://localhost/api/employee-private-init",
        {
          employeeWallet,
          initializedAt: new Date().toISOString(),
          teeAuthToken: employeeTeeAuthToken,
        },
        "PATCH",
      ),
    );

  assert.strictEqual(
    employeePrivateInitFinalizeResponse.status,
    200,
    "Employee private init finalize should return 200",
  );

  const employeePrivateInitFinalizeJson = await json<
    EmployeePrivateInitFinalizeResponse & { error?: string }
  >(employeePrivateInitFinalizeResponse);

  console.log("Employee private init:", {
    employeePrivateInitSignature,
    initializedAt: employeePrivateInitFinalizeJson.initializedAt,
    privateBalance: employeePrivateInitFinalizeJson.privateBalance?.balance,
  });

  logSection("Read exact initial payroll state");

  const exactStateBeforeResume = await fetchExactState({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
  });

  console.log(
    "Exact state before resume:",
    formatSnapshot("before-resume", exactStateBeforeResume),
  );

  logSection("Resume stream and schedule checkpoint crank");

  const resumeResult = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "resume",
    signer: employer,
    crankIntervalMs,
  });

  assert.strictEqual(
    resumeResult.finalize.stream?.status,
    "active",
    "Resume should mark the stream active",
  );
  assert(
    resumeResult.checkpointCrank?.build.mode === "schedule",
    "Resume should schedule checkpoint crank",
  );
  assert(
    resumeResult.checkpointCrank?.finalize.stream?.checkpointCrankStatus ===
      "active",
    "Resume should activate checkpoint crank",
  );
  assert(
    typeof resumeResult.checkpointCrank?.finalize.stream
      ?.checkpointCrankTaskId === "string" &&
      resumeResult.checkpointCrank.finalize.stream.checkpointCrankTaskId
        .length > 0,
    "Resume should persist checkpoint crank task id",
  );

  const exactStateAfterResume = await fetchExactState({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
  });

  console.log(
    "Exact state immediately after resume:",
    formatSnapshot("after-resume", exactStateAfterResume),
  );

  logSection("Direct checkpoint smoke test");

  const directCheckpoint = await buildAndSendDirectCheckpoint({
    employerWallet,
    employeePda: exactStateAfterResume.employeePda,
    privatePayrollPda: exactStateAfterResume.privatePayrollPda,
    permissionPda: exactStateAfterResume.permissionPda,
    teeAuthToken: employerTeeAuthToken,
    signer: employer,
  });

  const exactStateAfterDirectCheckpoint = await fetchExactState({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
  });

  console.log("Direct checkpoint result:", {
    signature: directCheckpoint.signature,
    before: formatSnapshot("before-direct", exactStateAfterResume),
    after: formatSnapshot("after-direct", exactStateAfterDirectCheckpoint),
    deltaLastAccrualTimestamp: (
      exactStateAfterDirectCheckpoint.lastAccrualTimestamp -
      exactStateAfterResume.lastAccrualTimestamp
    ).toString(),
    deltaAccruedUnpaidMicro: (
      exactStateAfterDirectCheckpoint.accruedUnpaidMicro -
      exactStateAfterResume.accruedUnpaidMicro
    ).toString(),
  });

  assert(
    didCheckpointAdvance(
      exactStateAfterResume,
      exactStateAfterDirectCheckpoint,
    ),
    "Expected direct checkpointAccrual to advance exact on-chain payroll state",
  );

  logSection("Wait for autonomous checkpoint");

  const autonomousState = await waitForAutonomousCheckpoint({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    baseline: exactStateAfterDirectCheckpoint,
    attempts: pollAttempts,
    delayMs: pollDelayMs,
  });

  console.log("Autonomous checkpoint observed:", {
    before: formatSnapshot("baseline", exactStateAfterDirectCheckpoint),
    after: formatSnapshot("autonomous", autonomousState),
    deltaLastAccrualTimestamp: (
      autonomousState.lastAccrualTimestamp -
      exactStateAfterDirectCheckpoint.lastAccrualTimestamp
    ).toString(),
    deltaAccruedUnpaidMicro: (
      autonomousState.accruedUnpaidMicro -
      exactStateAfterDirectCheckpoint.accruedUnpaidMicro
    ).toString(),
  });

  assert(
    didCheckpointAdvance(exactStateAfterDirectCheckpoint, autonomousState),
    "Expected autonomous checkpoint to advance exact on-chain payroll state without manual tick",
  );

  logSection("Pause stream and cancel checkpoint crank");

  const pauseResult = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "pause",
    signer: employer,
  });

  assert.strictEqual(
    pauseResult.finalize.stream?.status,
    "paused",
    "Pause should mark the stream paused",
  );
  assert(
    pauseResult.checkpointCrank?.build.mode === "cancel",
    "Pause should cancel checkpoint crank",
  );
  assert(
    pauseResult.checkpointCrank?.finalize.stream?.checkpointCrankStatus ===
      "stopped",
    "Pause should stop checkpoint crank",
  );

  logSection("Verify no further autonomous checkpoint after cancel");

  const stateAfterPause = await fetchExactState({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
  });

  console.log(
    "Exact state after pause:",
    formatSnapshot("after-pause", stateAfterPause),
  );

  const stableStateAfterCancel = await ensureNoFurtherAutonomousCheckpoint({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    baseline: stateAfterPause,
    waitMs: cancelSettleWaitMs,
  });

  logSection("Summary");

  console.log({
    employerWallet,
    employeeWallet,
    employeeId,
    streamId,
    employeePda: autonomousState.employeePda,
    privatePayrollPda: autonomousState.privatePayrollPda,
    permissionPda: autonomousState.permissionPda,
    crankTaskId:
      resumeResult.checkpointCrank?.finalize.stream?.checkpointCrankTaskId,
    crankIntervalMs,
    baselineLastAccrualTimestamp:
      exactStateAfterResume.lastAccrualTimestamp.toString(),
    directCheckpointSignature: directCheckpoint.signature,
    directCheckpointLastAccrualTimestamp:
      exactStateAfterDirectCheckpoint.lastAccrualTimestamp.toString(),
    autonomousLastAccrualTimestamp:
      autonomousState.lastAccrualTimestamp.toString(),
    baselineAccruedUnpaidMicro:
      exactStateAfterResume.accruedUnpaidMicro.toString(),
    directCheckpointAccruedUnpaidMicro:
      exactStateAfterDirectCheckpoint.accruedUnpaidMicro.toString(),
    autonomousAccruedUnpaidMicro: autonomousState.accruedUnpaidMicro.toString(),
    stableAfterCancelLastAccrualTimestamp:
      stableStateAfterCancel.lastAccrualTimestamp.toString(),
    stableAfterCancelAccruedUnpaidMicro:
      stableStateAfterCancel.accruedUnpaidMicro.toString(),
  });

  console.log("\nAutonomous checkpoint verification completed successfully.");
}

main().catch((error: unknown) => {
  console.error(
    "Autonomous checkpoint verification failed:",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
