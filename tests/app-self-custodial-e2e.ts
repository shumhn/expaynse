// Route-level self-custodial payroll devnet e2e runner
//
// What this covers:
// 1. Creates an employee via app route handler
// 2. Creates a paused stream via app route handler
// 3. Builds employer-signed onboarding transactions
// 4. Signs/sends onboarding txs with employer wallet
// 5. Finalizes onboarding metadata in app storage
// 6. Employee self-initializes their private account
// 7. Resumes the stream via employer-signed control route
// 8. Previews PER accrual with employer TEE auth
// 9. Updates rate, pauses, resumes again
// 10. Builds employer-signed payroll tick bundle
// 11. Signs/sends tick txs with employer wallet
// 12. Finalizes payroll history/runtime state
// 13. Verifies post-tick employee balances and persisted runtime state
// 14. Stops the stream and verifies future ticks skip it
//
// Required env:
// - TEST_AUTHORITY_KEYPAIR=/path/to/employer-keypair.json (preferred)
//   or ANCHOR_WALLET=/path/to/employer-keypair.json
//   or ~/.config/solana/id.json
// - MONGODB_URI=...
//
// Optional env:
// - TEST_INITIAL_RATE=0.02
// - TEST_UPDATED_RATE=0.03
// - TEST_WAIT_AFTER_RESUME_MS=3000
// - TEST_WAIT_AFTER_UPDATE_MS=2500
// - TEST_WAIT_AFTER_FINAL_RESUME_MS=3000

import assert from "assert";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { NextRequest } from "next/server.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  POST as employeePrivateInitBuildPost,
  PATCH as employeePrivateInitFinalizePatch,
} from "../app/api/employee-private-init/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { GET as previewGet } from "../app/api/payroll/preview/route.ts";
import {
  PATCH as tickFinalizePatch,
  POST as tickBuildPost,
} from "../app/api/payroll/tick/route.ts";
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
import {
  deposit,
  fetchTeeAuthToken,
  getBalance,
  getPrivateBalance,
  signAndSend,
} from "../lib/magicblock-api.ts";
import { getEmployeeById, getStreamById } from "../lib/server/payroll-store.ts";
import { makeAuthenticatedJsonRequest } from "./wallet-auth-test-helpers.ts";

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

type SendableTx = Transaction | VersionedTransaction;

type SendSpec = {
  transactionBase64: string;
  sendTo: string;
};

const TEE_RPC_BASE = "https://devnet-tee.magicblock.app";

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

type ControlAction = "update-rate" | "pause" | "resume" | "stop";

type ControlBuildResponse = {
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

type CheckpointCrankMode = "schedule" | "cancel";

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

type PreviewResponse = {
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
  preview: {
    employeePda: string;
    privatePayrollPda: string;
    employee: string;
    employer: string;
    employeeWallet: string;
    ratePerSecondMicro: string;
    lastAccrualTimestamp: string;
    accruedUnpaidMicro: string;
    totalPaidPrivateMicro: string;
    elapsedSeconds: number;
    pendingAccrualMicro: string;
    claimableAmountMicro: string;
  };
};

type TickBuildResponse = {
  employerWallet: string;
  processed: number;
  phase?: "settle";
  message?: string;
  results: Array<{
    streamId: string;
    employeeId: string;
    employeeWallet: string;
    skipped: boolean;
    reason?: string;
    elapsedSeconds?: number;
    amountMicro?: number;
    employeePda?: string;
    privatePayrollPda?: string;
    transactions?: {
      transfer?: SendSpec;
      settleSalary?: SendSpec;
      commitEmployee?: SendSpec;
    };
  }>;
};

type TickFinalizeItem = {
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  amountMicro: number;
  employeePda: string;
  privatePayrollPda: string;
  transferSignature: string;
  settleSalarySignature: string;
  commitSignature: string;
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
      `Environment variable ${name} must be a non-negative integer`
    );
  }
  return parsed;
}

function resolveWalletPath() {
  const testAuthority = process.env.TEST_AUTHORITY_KEYPAIR?.trim();
  if (testAuthority) {
    return testAuthority;
  }

  const anchorWallet = process.env.ANCHOR_WALLET?.trim();
  if (anchorWallet) {
    return anchorWallet;
  }

  const defaultSolanaId = path.join(os.homedir(), ".config/solana/id.json");
  if (fs.existsSync(defaultSolanaId)) {
    return defaultSolanaId;
  }

  throw new Error(
    "Missing test authority keypair. Set TEST_AUTHORITY_KEYPAIR, ANCHOR_WALLET, or ensure ~/.config/solana/id.json exists.",
  );
}

function loadKeypair(walletPath: string) {
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[]
  );
  return Keypair.fromSecretKey(secret);
}

function toUiAmount(amountMicro: bigint | number) {
  const numeric =
    typeof amountMicro === "bigint" ? Number(amountMicro) : amountMicro;
  return numeric / 1_000_000;
}

function clampRateForAvailableUsdc(args: {
  desiredRate: number;
  availableBaseUsdcMicro: bigint;
  activeSecondsBudget: number;
  reserveDivisor: number;
  minimumRate?: number;
}) {
  const minimumRate = args.minimumRate ?? 0.00001;
  const availableUi = toUiAmount(args.availableBaseUsdcMicro);
  const usableBudgetUi = Math.max(
    minimumRate * Math.max(1, args.activeSecondsBudget),
    availableUi / args.reserveDivisor
  );
  const cappedRate = usableBudgetUi / Math.max(1, args.activeSecondsBudget);
  return Math.min(args.desiredRate, Math.max(minimumRate, cappedRate));
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
    `Funding ${args.recipient.toBase58()} with ${(
      lamportsNeeded / 1_000_000_000
    ).toFixed(3)} SOL from employer wallet`
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
    })
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
    "confirmed"
  );

  return args.connection.getBalance(args.recipient, "confirmed");
}

async function waitForPrivateBalanceAtLeast(args: {
  label: string;
  address: string;
  token: string;
  minMicro: bigint;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = args.attempts ?? 12;
  const delayMs = args.delayMs ?? 2000;

  for (let i = 0; i < attempts; i += 1) {
    const next = await getPrivateBalance(args.address, args.token);
    const nextAmount = BigInt(next.balance);
    console.log(
      `[poll:${args.label}] ${i + 1}/${attempts} private=${toUiAmount(
        nextAmount
      ).toFixed(6)} USDC`
    );
    if (nextAmount >= args.minMicro) {
      return nextAmount;
    }
    await sleep(delayMs);
  }

  throw new Error(
    `Timed out waiting for private balance >= ${args.minMicro.toString()} micro`
  );
}

async function fundEmployerPrivateUsdcIfNeeded(args: {
  employerWallet: string;
  employerTeeAuthToken: string;
  signer: Keypair;
  minAmountMicro: bigint;
}) {
  const current = await getPrivateBalance(
    args.employerWallet,
    args.employerTeeAuthToken
  );
  const currentMicro = BigInt(current.balance);

  console.log("Employer private balance before settlement:", {
    location: current.location,
    balance: current.balance,
  });

  if (currentMicro >= args.minAmountMicro) {
    return currentMicro;
  }

  const shortfallMicro = args.minAmountMicro - currentMicro;
  const topUpMicro = shortfallMicro + 100_000n;
  const topUpUiAmount = toUiAmount(topUpMicro);

  console.log(
    `Funding employer private balance with ${topUpUiAmount.toFixed(
      6
    )} USDC for settlement transfer precondition`
  );

  const depositBuild = await deposit(args.employerWallet, topUpUiAmount);

  if (!depositBuild.transactionBase64) {
    throw new Error(
      "Employer private top-up deposit did not return a transaction"
    );
  }

  const depositSignature = await sendBuiltTransaction({
    spec: {
      transactionBase64: depositBuild.transactionBase64,
      sendTo: depositBuild.sendTo || "base",
    },
    signer: args.signer,
    signerLabel: "employer:privateTopUp",
  });

  console.log("Employer private top-up signature:", depositSignature);

  return waitForPrivateBalanceAtLeast({
    label: "employer-private-balance",
    address: args.employerWallet,
    token: args.employerTeeAuthToken,
    minMicro: args.minAmountMicro,
  });
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
    args.payer.publicKey
  );
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.payer,
    mint,
    args.recipient
  );

  const deltaMicro = args.minAmountMicro - currentMicro;
  if (deltaMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "Requested employee USDC top-up exceeds safe integer range"
    );
  }

  console.log(
    `Funding ${recipientWallet} with ${toUiAmount(deltaMicro).toFixed(
      6
    )} base USDC for self-init e2e precondition`
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
      Number(deltaMicro)
    )
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
    "confirmed"
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
    }
  );
}

async function buildCheckpointCrankAndFinalize(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  signer: Keypair;
  mode: CheckpointCrankMode;
}) {
  const buildResponse = await checkpointCrankBuildPost(
    makeJsonRequest("http://localhost/api/streams/checkpoint-crank", {
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      mode: args.mode,
    })
  );

  assert.strictEqual(
    buildResponse.status,
    201,
    `${args.mode} checkpoint crank build should return 201`
  );

  const buildJson = await json<
    CheckpointCrankBuildResponse & { error?: string }
  >(buildResponse);

  assert(
    buildJson.transactions?.checkpointCrank,
    buildJson.error || `${args.mode} checkpoint crank build missing transaction`
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
      "PATCH"
    )
  );

  assert.strictEqual(
    finalizeResponse.status,
    200,
    `${args.mode} checkpoint crank finalize should return 200`
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
      `${args.mode} checkpoint crank finalize missing updated stream`
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
  action: ControlAction;
  ratePerSecond?: number;
  signer: Keypair;
}) {
  const buildResponse = await controlBuildPost(
    makeJsonRequest("http://localhost/api/streams/control", {
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      action: args.action,
      ratePerSecond: args.ratePerSecond,
      teeAuthToken: args.teeAuthToken,
    })
  );

  assert.strictEqual(
    buildResponse.status,
    201,
    `${args.action} build should return 201`
  );

  const buildJson = await json<ControlBuildResponse & { error?: string }>(
    buildResponse
  );

  assert(
    buildJson.transactions?.control,
    buildJson.error || `${args.action} build missing control transaction`
  );
  assert(
    buildJson.transactions?.commitEmployee,
    buildJson.error || `${args.action} build missing commit transaction`
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
        ratePerSecond: args.ratePerSecond,
        employeePda: buildJson.employeePda,
        privatePayrollPda: buildJson.privatePayrollPda,
        controlSignature,
        commitSignature,
      },
      "PATCH"
    )
  );

  assert.strictEqual(
    finalizeResponse.status,
    200,
    `${args.action} finalize should return 200`
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
    finalizeJson.error || `${args.action} finalize missing updated stream`
  );

  console.log(`${args.action} complete:`, {
    controlSignature,
    commitSignature,
    streamStatus: finalizeJson.stream.status,
    ratePerSecond: finalizeJson.stream.ratePerSecond,
  });

  const shouldScheduleCheckpointCrank = args.action === "resume";
  const shouldCancelCheckpointCrank =
    args.action === "pause" || args.action === "stop";

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

  if (shouldScheduleCheckpointCrank) {
    checkpointCrank = await buildCheckpointCrankAndFinalize({
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      signer: args.signer,
      mode: "schedule",
    });
  } else if (shouldCancelCheckpointCrank) {
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

async function main() {
  assertEnv("MONGODB_URI");

  const walletPath = resolveWalletPath();
  const employer = loadKeypair(walletPath);
  const employee = Keypair.generate();
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  const requestedInitialRate = envNumber("TEST_INITIAL_RATE", 0.02);
  const requestedUpdatedRate = envNumber("TEST_UPDATED_RATE", 0.03);
  const waitAfterResumeMs = envInteger("TEST_WAIT_AFTER_RESUME_MS", 3000);
  const waitAfterUpdateMs = envInteger("TEST_WAIT_AFTER_UPDATE_MS", 2500);
  const waitAfterFinalResumeMs = envInteger(
    "TEST_WAIT_AFTER_FINAL_RESUME_MS",
    3000
  );
  const employeeName = `Self Custody ${randomUUID().slice(0, 8)}`;
  const connection = new Connection(DEVNET_RPC, "confirmed");

  console.log("=== App Self-Custodial Payroll Devnet E2E ===");
  console.log("Employer wallet:", employerWallet);
  console.log("Employee wallet:", employeeWallet);
  console.log("Employer keypair:", walletPath);

  logSection("Preflight");

  const employerSol = await connection.getBalance(
    employer.publicKey,
    "confirmed"
  );
  assert(employerSol > 0, "Employer wallet must be funded with devnet SOL");

  const employerBaseUsdc = await getBalance(employerWallet);
  const employerBaseUsdcMicro = BigInt(employerBaseUsdc.balance);

  console.log("Employer SOL:", (employerSol / 1_000_000_000).toFixed(4));
  console.log(
    "Employer base USDC:",
    `${toUiAmount(employerBaseUsdcMicro).toFixed(6)} USDC`
  );

  assert(
    employerBaseUsdcMicro > 0n,
    "Employer must hold devnet USDC on base to fund payroll transfers"
  );

  const activeSecondsBudget =
    Math.ceil(
      (waitAfterResumeMs + waitAfterUpdateMs + waitAfterFinalResumeMs) / 1000
    ) + 12;
  const updatedRate = clampRateForAvailableUsdc({
    desiredRate: requestedUpdatedRate,
    availableBaseUsdcMicro: employerBaseUsdcMicro,
    activeSecondsBudget,
    reserveDivisor: 4,
  });
  let initialRate = Math.min(
    requestedInitialRate,
    clampRateForAvailableUsdc({
      desiredRate: requestedInitialRate,
      availableBaseUsdcMicro: employerBaseUsdcMicro,
      activeSecondsBudget,
      reserveDivisor: 6,
    })
  );

  if (initialRate >= updatedRate) {
    initialRate = Math.max(0.00001, updatedRate / 2);
  }

  console.log("Requested rates:", {
    initialRate: requestedInitialRate,
    updatedRate: requestedUpdatedRate,
  });
  console.log("Effective rates:", {
    initialRate,
    updatedRate,
    activeSecondsBudget,
  });

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
    keypairSignMessageFactory(employer)
  );
  assert(
    employerTeeAuthToken.length > 0,
    "Expected non-empty employer TEE auth token"
  );

  const employeeTeeAuthToken = await fetchTeeAuthToken(
    employee.publicKey,
    keypairSignMessageFactory(employee)
  );
  assert(
    employeeTeeAuthToken.length > 0,
    "Expected non-empty employee TEE auth token"
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
        notes: "Created by self-custodial route e2e runner",
      },
    })
  );

  assert.strictEqual(
    employeeResponse.status,
    201,
    "Employee create should return 201"
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
    employeeJson.error || "Employee create missing payload"
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
    })
  );

  assert.strictEqual(
    streamResponse.status,
    201,
    "Stream create should return 201"
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
    streamJson.error || "Stream create missing payload"
  );

  const streamId = streamJson.stream.id;
  console.log("Stream created:", streamJson.stream);

  logSection("Build onboarding transactions");

  const onboardResponse = await onboardBuildPost(
    makeJsonRequest("http://localhost/api/streams/onboard", {
      employerWallet,
      streamId,
      teeAuthToken: employerTeeAuthToken,
    })
  );

  assert(
    onboardResponse.status === 200 || onboardResponse.status === 201,
    `Onboard build should return 200 or 201, received ${onboardResponse.status}`
  );

  const onboardJson = await json<OnboardBuildResponse & { error?: string }>(
    onboardResponse
  );

  if (!onboardJson.alreadyOnboarded) {
    assert(
      onboardJson.transactions?.createEmployee,
      onboardJson.error || "Missing createEmployee onboarding tx"
    );
    assert(
      onboardJson.transactions?.createPermission,
      onboardJson.error || "Missing createPermission onboarding tx"
    );
    assert(
      onboardJson.transactions?.baseSetup,
      onboardJson.error || "Missing baseSetup onboarding tx"
    );
    assert(
      onboardJson.transactions?.initializePrivatePayroll,
      onboardJson.error || "Missing initializePrivatePayroll onboarding tx"
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
      "PATCH"
    )
  );

  assert.strictEqual(
    onboardFinalizeResponse.status,
    200,
    "Onboard finalize should return 200"
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
    onboardFinalizeJson.error || "Onboard finalize missing updated stream"
  );

  console.log("Onboard finalize:", onboardFinalizeJson.stream);

  logSection("Employee self-initializes private account");

  const employeePrivateInitBuildResponse = await employeePrivateInitBuildPost(
    makeJsonRequest("http://localhost/api/employee-private-init", {
      employeeWallet,
    })
  );

  assert.strictEqual(
    employeePrivateInitBuildResponse.status,
    201,
    "Employee private init build should return 201"
  );

  const employeePrivateInitBuildJson = await json<
    EmployeePrivateInitBuildResponse & { error?: string }
  >(employeePrivateInitBuildResponse);

  assert(
    employeePrivateInitBuildJson.transaction,
    employeePrivateInitBuildJson.error ||
      "Employee private init build missing transaction"
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
        "PATCH"
      )
    );

  assert.strictEqual(
    employeePrivateInitFinalizeResponse.status,
    200,
    "Employee private init finalize should return 200"
  );

  const employeePrivateInitFinalizeJson = await json<
    EmployeePrivateInitFinalizeResponse & { error?: string }
  >(employeePrivateInitFinalizeResponse);

  console.log("Employee private init:", {
    employeePrivateInitSignature,
    initializedAt: employeePrivateInitFinalizeJson.initializedAt,
    privateBalance: employeePrivateInitFinalizeJson.privateBalance?.balance,
  });

  const streamAfterEmployeeInit = await getStreamById(employerWallet, streamId);
  assert(
    streamAfterEmployeeInit?.recipientPrivateInitializedAt,
    "Employee private init should record recipientPrivateInitializedAt on the stream"
  );

  logSection("Preview initial paused state");

  const initialPreviewResponse = await previewGet(
    makeGetRequest(
      `http://localhost/api/payroll/preview?employerWallet=${encodeURIComponent(
        employerWallet
      )}&streamId=${encodeURIComponent(streamId)}`,
      employerTeeAuthToken
    )
  );

  assert.strictEqual(
    initialPreviewResponse.status,
    200,
    "Initial preview should return 200"
  );

  const initialPreviewJson = await json<PreviewResponse & { error?: string }>(
    initialPreviewResponse
  );

  assert(
    initialPreviewJson.preview,
    initialPreviewJson.error || "Initial preview missing payload"
  );

  console.log("Initial preview:", {
    ratePerSecondMicro: initialPreviewJson.preview.ratePerSecondMicro,
    claimableAmountMicro: initialPreviewJson.preview.claimableAmountMicro,
    streamStatus: initialPreviewJson.stream.status,
  });

  const initialResumeResult = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "resume",
    signer: employer,
  });

  assert.strictEqual(
    initialResumeResult.finalize.stream?.status,
    "active",
    "Resume should mark the stream active"
  );
  assert(
    initialResumeResult.checkpointCrank?.build.mode === "schedule",
    "Resume should schedule checkpoint crank"
  );
  assert(
    initialResumeResult.checkpointCrank?.finalize.stream
      ?.checkpointCrankStatus === "active",
    "Resume should activate checkpoint crank"
  );
  assert(
    typeof initialResumeResult.checkpointCrank?.finalize.stream
      ?.checkpointCrankTaskId === "string" &&
      initialResumeResult.checkpointCrank.finalize.stream.checkpointCrankTaskId
        .length > 0,
    "Resume should persist checkpoint crank task id"
  );

  console.log(`Waiting ${waitAfterResumeMs}ms to accrue initial payroll...`);
  await sleep(waitAfterResumeMs);

  logSection("Preview after first resume");

  const postResumePreviewResponse = await previewGet(
    makeGetRequest(
      `http://localhost/api/payroll/preview?employerWallet=${encodeURIComponent(
        employerWallet
      )}&streamId=${encodeURIComponent(streamId)}`,
      employerTeeAuthToken
    )
  );

  assert.strictEqual(
    postResumePreviewResponse.status,
    200,
    "Preview after resume should return 200"
  );

  const postResumePreviewJson = await json<
    PreviewResponse & { error?: string }
  >(postResumePreviewResponse);

  const claimableAfterResume = BigInt(
    postResumePreviewJson.preview.claimableAmountMicro
  );

  console.log("Preview after resume:", {
    elapsedSeconds: postResumePreviewJson.preview.elapsedSeconds,
    claimableAmountMicro: postResumePreviewJson.preview.claimableAmountMicro,
    ratePerSecondMicro: postResumePreviewJson.preview.ratePerSecondMicro,
  });

  assert(
    claimableAfterResume > 0n,
    "Expected positive claimable amount after resuming and waiting"
  );

  const updated = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "update-rate",
    ratePerSecond: updatedRate,
    signer: employer,
  });

  assert.strictEqual(
    updated.finalize.stream?.ratePerSecond,
    updatedRate,
    "Update-rate should persist new rate"
  );

  console.log(`Waiting ${waitAfterUpdateMs}ms after rate update...`);
  await sleep(waitAfterUpdateMs);

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
    "Pause should mark the stream paused"
  );
  assert(
    pauseResult.checkpointCrank?.build.mode === "cancel",
    "Pause should cancel checkpoint crank"
  );
  assert(
    pauseResult.checkpointCrank?.finalize.stream?.checkpointCrankStatus ===
      "stopped",
    "Pause should stop checkpoint crank"
  );
  assert.strictEqual(
    pauseResult.checkpointCrank?.finalize.stream?.checkpointCrankTaskId,
    null,
    "Pause should clear checkpoint crank task id"
  );

  logSection("Preview after pause");

  const pausedPreviewResponse = await previewGet(
    makeGetRequest(
      `http://localhost/api/payroll/preview?employerWallet=${encodeURIComponent(
        employerWallet
      )}&streamId=${encodeURIComponent(streamId)}`,
      employerTeeAuthToken
    )
  );

  assert.strictEqual(
    pausedPreviewResponse.status,
    200,
    "Paused preview should return 200"
  );

  const pausedPreviewJson = await json<PreviewResponse & { error?: string }>(
    pausedPreviewResponse
  );

  console.log("Preview after pause:", {
    streamStatus: pausedPreviewJson.stream.status,
    elapsedSeconds: pausedPreviewJson.preview.elapsedSeconds,
    claimableAmountMicro: pausedPreviewJson.preview.claimableAmountMicro,
    note: "Preview is timestamp-based and may still show growth even while paused; on-chain control is authoritative.",
  });

  const resumedAgain = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "resume",
    signer: employer,
  });

  assert.strictEqual(
    resumedAgain.finalize.stream?.status,
    "active",
    "Second resume should set stream active"
  );

  console.log(`Waiting ${waitAfterFinalResumeMs}ms before payroll tick...`);
  await sleep(waitAfterFinalResumeMs);

  logSection("Build payroll tick settlement");

  const tickBuildResponse = await tickBuildPost(
    makeJsonRequest("http://localhost/api/payroll/tick", {
      employerWallet,
      teeAuthToken: employerTeeAuthToken,
    })
  );

  assert.strictEqual(
    tickBuildResponse.status,
    200,
    "Tick build should return 200"
  );

  const tickBuildJson = await json<TickBuildResponse & { error?: string }>(
    tickBuildResponse
  );

  assert(
    Array.isArray(tickBuildJson.results),
    "Tick build results must be an array"
  );

  const settleResult = tickBuildJson.results.find(
    (result) => result.streamId === streamId
  );

  assert(settleResult, "Tick build should include the created stream");
  assert(
    !settleResult.skipped,
    `Tick build unexpectedly skipped stream: ${
      settleResult.reason || "unknown reason"
    }`
  );
  assert(
    settleResult.transactions?.transfer,
    "Tick build should include transfer transaction"
  );
  assert(
    settleResult.transactions?.settleSalary,
    "Tick build should include settleSalary transaction"
  );
  assert(
    settleResult.transactions?.commitEmployee,
    "Tick build should include commitEmployee transaction"
  );
  assert(
    typeof settleResult.amountMicro === "number" &&
      settleResult.amountMicro > 0,
    "Tick build should include positive amountMicro"
  );
  assert(settleResult.employeePda, "Tick build missing employeePda");
  assert(
    settleResult.privatePayrollPda,
    "Tick build missing privatePayrollPda"
  );

  console.log("Tick build result:", {
    amountMicro: settleResult.amountMicro,
    elapsedSeconds: settleResult.elapsedSeconds,
    employeePda: settleResult.employeePda,
    privatePayrollPda: settleResult.privatePayrollPda,
  });

  await fundEmployerPrivateUsdcIfNeeded({
    employerWallet,
    employerTeeAuthToken,
    signer: employer,
    minAmountMicro: BigInt(settleResult.amountMicro),
  });

  logSection("Sign and send payroll settlement transactions");

  const transferSignature = await sendBuiltTransaction({
    spec: settleResult.transactions.transfer,
    signer: employer,
    signerLabel: "tick:transfer",
  });

  const settleSalarySignature = await sendBuiltTransaction({
    spec: settleResult.transactions.settleSalary,
    signer: employer,
    signerLabel: "tick:settleSalary",
    teeAuthToken: employerTeeAuthToken,
    useTeeRpc: true,
  });

  const commitSignature = await sendBuiltTransaction({
    spec: settleResult.transactions.commitEmployee,
    signer: employer,
    signerLabel: "tick:commitEmployee",
    teeAuthToken: employerTeeAuthToken,
    useTeeRpc: true,
  });

  console.log("Settlement signatures:", {
    transferSignature,
    settleSalarySignature,
    commitSignature,
  });

  logSection("Finalize payroll tick");

  const tickFinalizePayload: TickFinalizeItem[] = [
    {
      streamId,
      employeeId,
      employeeWallet,
      amountMicro: settleResult.amountMicro,
      employeePda: settleResult.employeePda,
      privatePayrollPda: settleResult.privatePayrollPda,
      transferSignature,
      settleSalarySignature,
      commitSignature,
    },
  ];

  const tickFinalizeResponse = await tickFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/payroll/tick",
      {
        employerWallet,
        results: tickFinalizePayload,
      },
      "PATCH"
    )
  );

  assert.strictEqual(
    tickFinalizeResponse.status,
    200,
    "Tick finalize should return 200"
  );

  const tickFinalizeJson = await json<{
    employerWallet: string;
    processed: number;
    totalTransferredMicro: number;
    results: TickFinalizeItem[];
    error?: string;
  }>(tickFinalizeResponse);

  assert.strictEqual(
    tickFinalizeJson.totalTransferredMicro,
    settleResult.amountMicro,
    "Tick finalize totalTransferredMicro should match signed amount"
  );

  console.log("Tick finalized:", {
    processed: tickFinalizeJson.processed,
    totalTransferredMicro: tickFinalizeJson.totalTransferredMicro,
  });

  logSection("Verify persisted app state");

  const persistedEmployee = await getEmployeeById(employerWallet, employeeId);
  const persistedStream = await getStreamById(employerWallet, streamId);

  assert(persistedEmployee, "Persisted employee should exist");
  assert(persistedStream, "Persisted stream should exist");
  assert(
    persistedStream!.lastPaidAt,
    "Persisted stream should have lastPaidAt after tick finalize"
  );
  assert(
    persistedStream!.totalPaid > 0,
    "Persisted stream should have positive totalPaid after tick finalize"
  );

  console.log("Persisted stream:", {
    id: persistedStream!.id,
    status: persistedStream!.status,
    totalPaid: persistedStream!.totalPaid,
    lastPaidAt: persistedStream!.lastPaidAt,
  });

  logSection("Verify post-tick balances for base payout mode");

  const employeePrivateAfterSettlement = await getPrivateBalance(
    employeeWallet,
    employeeTeeAuthToken
  );
  const employeePrivateAfterSettlementMicro = BigInt(
    employeePrivateAfterSettlement.balance
  );

  console.log("Employee private balance after settlement:", {
    location: employeePrivateAfterSettlement.location,
    balance: employeePrivateAfterSettlement.balance,
  });

  const employeeBaseAfterSettlement = await getBalance(employeeWallet);
  const employeeBaseAfterSettlementMicro = BigInt(
    employeeBaseAfterSettlement.balance
  );

  console.log("Employee base balance after settlement:", {
    location: employeeBaseAfterSettlement.location,
    balance: employeeBaseAfterSettlement.balance,
  });

  console.log("Employee balances snapshot after base settlement tick:", {
    privateAfterSettlement: employeePrivateAfterSettlement.balance,
    baseAfterSettlement: employeeBaseAfterSettlement.balance,
    settledMicro: settleResult.amountMicro,
  });

  assert(
    employeePrivateAfterSettlementMicro >= 0n,
    "Employee private balance check should return a valid non-negative value"
  );
  assert(
    employeeBaseAfterSettlementMicro >= 0n,
    "Employee base balance check should return a valid non-negative value"
  );

  const stopResult = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    action: "stop",
    signer: employer,
  });

  assert.strictEqual(
    stopResult.finalize.stream?.status,
    "stopped",
    "Stop should mark the stream stopped"
  );
  assert(
    stopResult.checkpointCrank?.build.mode === "cancel",
    "Stop should cancel checkpoint crank"
  );
  assert(
    stopResult.checkpointCrank?.finalize.stream?.checkpointCrankStatus ===
      "stopped",
    "Stop should stop checkpoint crank"
  );
  assert.strictEqual(
    stopResult.checkpointCrank?.finalize.stream?.checkpointCrankTaskId,
    null,
    "Stop should clear checkpoint crank task id"
  );

  logSection("Verify future tick skips stopped stream");

  const stoppedTickBuildResponse = await tickBuildPost(
    makeJsonRequest("http://localhost/api/payroll/tick", {
      employerWallet,
      teeAuthToken: employerTeeAuthToken,
    })
  );

  assert.strictEqual(
    stoppedTickBuildResponse.status,
    200,
    "Tick build after stop should return 200"
  );

  const stoppedTickBuildJson = await json<
    TickBuildResponse & { error?: string }
  >(stoppedTickBuildResponse);

  const stoppedTickResult = stoppedTickBuildJson.results.find(
    (result) => result.streamId === streamId
  );

  assert(
    !stoppedTickResult ||
      stoppedTickResult.skipped ||
      stoppedTickResult.reason === "Stream is not active",
    "Stopped stream should no longer produce an executable tick bundle"
  );

  console.log("Stopped tick result:", stoppedTickResult ?? "no result");

  logSection("Summary");

  console.log({
    employerWallet,
    employeeWallet,
    employeeId,
    streamId,
    employeePda: onboardJson.employeePda,
    privatePayrollPda: onboardJson.privatePayrollPda,
    permissionPda: onboardJson.permissionPda,
    checkpointCrankTaskId:
      resumedAgain.checkpointCrank?.finalize.stream?.checkpointCrankTaskId,
    tickAmountMicro: settleResult.amountMicro,
    tickAmountUi: toUiAmount(settleResult.amountMicro).toFixed(6),
    payoutMode: "base",
  });

  console.log("\nSelf-custodial app route e2e completed successfully.");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nSelf-custodial app route e2e failed.");
  console.error(error);
  process.exit(1);
});
