import assert from "assert";
import { randomUUID } from "crypto";
import fs from "fs";
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
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

import {
  PATCH as employeePrivateInitFinalizePatch,
  POST as employeePrivateInitBuildPost,
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
import { getStreamById } from "../lib/server/payroll-store.ts";
import { makeAuthenticatedJsonRequest } from "./wallet-auth-test-helpers.ts";

const DEFAULT_WALLET_PATH =
  "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";
const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEE_RPC_BASE = "https://devnet-tee.magicblock.app";

type SendableTx = Transaction | VersionedTransaction;

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
    createEmployee?: SendSpec;
    createPermission?: SendSpec;
    delegateBundle?: SendSpec;
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
    balance: string;
    location: "base" | "ephemeral";
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

function resolveWalletPath() {
  return process.env.ANCHOR_WALLET || DEFAULT_WALLET_PATH;
}

function loadAuthorityKeypair() {
  const walletPath = resolveWalletPath();
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
    )} base USDC for private init precondition`
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

async function buildControlAndFinalize(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  signer: Keypair;
  action: ControlAction;
}) {
  const buildResponse = await controlBuildPost(
    makeJsonRequest("http://localhost/api/streams/control", {
      employerWallet: args.employerWallet,
      streamId: args.streamId,
      teeAuthToken: args.teeAuthToken,
      action: args.action,
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
    buildJson.transactions?.control && buildJson.transactions?.commitEmployee,
    buildJson.error || `${args.action} build missing transactions`
  );

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
      "PATCH"
    )
  );
  assert.strictEqual(
    finalizeResponse.status,
    200,
    `${args.action} finalize should return 200`
  );

  return json<{
    stream?: {
      status?: string;
      ratePerSecond?: number;
    };
    error?: string;
  }>(finalizeResponse);
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

  return json<{
    stream?: {
      checkpointCrankTaskId?: string | null;
      checkpointCrankStatus?: string | null;
    };
    error?: string;
  }>(finalizeResponse);
}

async function waitForSettlementBuild(args: {
  employerWallet: string;
  employerTeeAuthToken: string;
  streamId: string;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = args.attempts ?? 10;
  const delayMs = args.delayMs ?? 1500;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await tickBuildPost(
      makeJsonRequest("http://localhost/api/payroll/tick", {
        employerWallet: args.employerWallet,
        teeAuthToken: args.employerTeeAuthToken,
        streamId: args.streamId,
      })
    );
    assert.strictEqual(response.status, 200, "Tick build should return 200");

    const jsonBody = await json<TickBuildResponse & { error?: string }>(
      response
    );
    const streamResult = jsonBody.results.find(
      (result) => result.streamId === args.streamId
    );
    assert(streamResult, "Tick build should include the created stream");

    if (
      !streamResult.skipped &&
      typeof streamResult.amountMicro === "number" &&
      streamResult.amountMicro > 0 &&
      streamResult.transactions?.transfer &&
      streamResult.transactions?.settleSalary &&
      streamResult.transactions?.commitEmployee
    ) {
      return streamResult;
    }

    console.log(
      `[poll:settlement-build] ${attempt}/${attempts} skipped=${
        streamResult.skipped
      } reason=${streamResult.reason ?? "none"}`
    );

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  throw new Error(
    "Timed out waiting for checkpointed accrued payroll to become settleable"
  );
}

async function main() {
  assertEnv("MONGODB_URI");

  const authority = loadAuthorityKeypair();
  const employerWallet = authority.publicKey.toBase58();
  const employee = Keypair.generate();
  const employeeWallet = employee.publicKey.toBase58();
  const employeeName = `Route Smoke ${randomUUID().slice(0, 8)}`;

  console.log("=== Route-level App Smoke Test ===");
  console.log("Employer:", employerWallet);
  console.log("Employee:", employeeWallet);

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const balance = await connection.getBalance(authority.publicKey, "confirmed");
  assert(balance > 0, "Configured authority wallet must be funded on devnet");

  const employerBaseUsdc = await getBalance(employerWallet);
  const employerBaseUsdcMicro = BigInt(employerBaseUsdc.balance);
  const desiredRatePerSecond = 0.05;
  const ratePerSecond = clampRateForAvailableUsdc({
    desiredRate: desiredRatePerSecond,
    availableBaseUsdcMicro: employerBaseUsdcMicro,
    activeSecondsBudget: 12,
    reserveDivisor: 4,
  });

  console.log(
    "Employer base USDC:",
    `${toUiAmount(employerBaseUsdcMicro).toFixed(6)} USDC`
  );
  console.log("Route smoke rate:", {
    desiredRatePerSecond,
    ratePerSecond,
  });

  await fundAccountIfNeeded({
    connection,
    payer: authority,
    recipient: employee.publicKey,
    minLamports: 200_000_000,
  });

  await fundEmployeeUsdcIfNeeded({
    connection,
    payer: authority,
    recipient: employee.publicKey,
    minAmountMicro: 1n,
  });

  const employerTeeAuthToken = await fetchTeeAuthToken(
    authority.publicKey,
    keypairSignMessageFactory(authority)
  );
  const employeeTeeAuthToken = await fetchTeeAuthToken(
    employee.publicKey,
    keypairSignMessageFactory(employee)
  );

  console.log("\n[1/10] Creating employee through /api/employees...");
  const employeeResponse = await employeesPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/employees",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        wallet: employeeWallet,
        name: employeeName,
        notes: "Created by route smoke test",
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
    employeeJson.error || "Employee response missing payload"
  );
  const employeeId = employeeJson.employee.id;

  console.log("Employee created:", employeeJson.employee);

  console.log("\n[2/10] Creating stream through /api/streams...");
  const streamResponse = await streamsPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        employeeId,
        ratePerSecond,
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
    streamJson.error || "Stream response missing payload"
  );
  const streamId = streamJson.stream.id;

  console.log("Stream created:", streamJson.stream);

  console.log("\n[3/10] Building and finalizing onboarding...");
  const onboardBuildResponse = await onboardBuildPost(
    makeJsonRequest("http://localhost/api/streams/onboard", {
      employerWallet,
      streamId,
      teeAuthToken: employerTeeAuthToken,
    })
  );
  assert(
    onboardBuildResponse.status === 200 || onboardBuildResponse.status === 201,
    "Onboarding build should return 200 or 201"
  );

  const onboardBuildJson = await json<
    OnboardBuildResponse & { error?: string }
  >(onboardBuildResponse);
  assert(
    onboardBuildJson.employeePda &&
      onboardBuildJson.privatePayrollPda &&
      onboardBuildJson.permissionPda,
    onboardBuildJson.error || "Onboarding build missing PDAs"
  );

  if (onboardBuildJson.transactions.createEmployee) {
    await sendBuiltTransaction({
      spec: onboardBuildJson.transactions.createEmployee,
      signer: authority,
      signerLabel: "onboard:createEmployee",
    });
  }
  if (onboardBuildJson.transactions.createPermission) {
    await sendBuiltTransaction({
      spec: onboardBuildJson.transactions.createPermission,
      signer: authority,
      signerLabel: "onboard:createPermission",
    });
  }
  if (onboardBuildJson.transactions.delegateBundle) {
    await sendBuiltTransaction({
      spec: onboardBuildJson.transactions.delegateBundle,
      signer: authority,
      signerLabel: "onboard:delegateBundle",
    });
    console.log("Waiting for delegation to settle...");
    await sleep(5000);
  }
  if (onboardBuildJson.transactions.initializePrivatePayroll) {
    await sendBuiltTransaction({
      spec: onboardBuildJson.transactions.initializePrivatePayroll,
      signer: authority,
      signerLabel: "onboard:initializePrivatePayroll",
      teeAuthToken: employerTeeAuthToken,
      useTeeRpc: true,
      retrySendCount: 3,
      retryDelayMs: 5000,
    });
  }

  const onboardFinalizeResponse = await onboardFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/streams/onboard",
      {
        employerWallet,
        streamId,
        employeePda: onboardBuildJson.employeePda,
        privatePayrollPda: onboardBuildJson.privatePayrollPda,
        permissionPda: onboardBuildJson.permissionPda,
      },
      "PATCH"
    )
  );
  assert.strictEqual(
    onboardFinalizeResponse.status,
    200,
    "Onboarding finalize should return 200"
  );

  const onboardFinalizeJson = await json<{
    stream?: {
      employeePda?: string;
      privatePayrollPda?: string;
      permissionPda?: string;
      delegatedAt?: string | null;
    };
    error?: string;
  }>(onboardFinalizeResponse);
  assert(
    onboardFinalizeJson.stream,
    onboardFinalizeJson.error || "Onboarding finalize missing stream"
  );

  console.log("Onboarded stream:", {
    employeePda: onboardFinalizeJson.stream.employeePda,
    privatePayrollPda: onboardFinalizeJson.stream.privatePayrollPda,
    permissionPda: onboardFinalizeJson.stream.permissionPda,
    delegatedAt: onboardFinalizeJson.stream.delegatedAt,
  });

  console.log("\n[4/10] Employee self-initializes private account...");
  const privateInitBuildResponse = await employeePrivateInitBuildPost(
    makeJsonRequest("http://localhost/api/employee-private-init", {
      employeeWallet,
    })
  );
  assert.strictEqual(
    privateInitBuildResponse.status,
    201,
    "Employee private init build should return 201"
  );

  const privateInitBuildJson = await json<
    EmployeePrivateInitBuildResponse & { error?: string }
  >(privateInitBuildResponse);
  assert(
    privateInitBuildJson.transaction,
    privateInitBuildJson.error || "Employee private init missing transaction"
  );

  await sendBuiltTransaction({
    spec: privateInitBuildJson.transaction,
    signer: employee,
    signerLabel: "employee:initPrivateAccount",
  });

  const privateInitFinalizeResponse = await employeePrivateInitFinalizePatch(
    makeJsonRequest(
      "http://localhost/api/employee-private-init",
      {
        employeeWallet,
        teeAuthToken: employeeTeeAuthToken,
      },
      "PATCH"
    )
  );
  assert.strictEqual(
    privateInitFinalizeResponse.status,
    200,
    "Employee private init finalize should return 200"
  );

  const privateInitFinalizeJson = await json<
    EmployeePrivateInitFinalizeResponse & { error?: string }
  >(privateInitFinalizeResponse);
  assert(
    privateInitFinalizeJson.initializedAt,
    privateInitFinalizeJson.error ||
      "Employee private init finalize missing timestamp"
  );

  console.log("Employee private init:", {
    initializedAt: privateInitFinalizeJson.initializedAt,
    privateBalance:
      privateInitFinalizeJson.privateBalance?.balance ?? "unknown",
  });

  console.log("\n[5/10] Resuming stream and scheduling checkpoint crank...");
  const resumeJson = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    action: "resume",
  });
  assert.strictEqual(
    resumeJson.stream?.status,
    "active",
    "Resume should mark the stream active"
  );

  const crankScheduleJson = await buildCheckpointCrankAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    mode: "schedule",
  });
  assert.strictEqual(
    crankScheduleJson.stream?.checkpointCrankStatus,
    "active",
    "Checkpoint crank should become active after scheduling"
  );

  console.log("\n[6/10] Previewing PER state through /api/payroll/preview...");
  await sleep(2500);

  const previewResponse = await previewGet(
    makeGetRequest(
      `http://localhost/api/payroll/preview?employerWallet=${encodeURIComponent(
        employerWallet
      )}&streamId=${encodeURIComponent(streamId)}`,
      employerTeeAuthToken
    )
  );
  assert.strictEqual(previewResponse.status, 200, "Preview should return 200");

  const previewJson = await json<{
    preview?: {
      privatePayrollPda: string;
      claimableAmountMicro: string;
      accruedUnpaidMicro: string;
      ratePerSecondMicro: string;
    };
    error?: string;
  }>(previewResponse);
  assert(
    previewJson.preview,
    previewJson.error || "Preview response missing payload"
  );
  assert.strictEqual(
    previewJson.preview.privatePayrollPda,
    onboardBuildJson.privatePayrollPda,
    "Preview privatePayrollPda should match onboarding result"
  );

  console.log("Preview result:", previewJson.preview);

  console.log("\n[7/10] Checkpoint accrued state and restore active status...");
  const pauseJson = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    action: "pause",
  });
  assert.strictEqual(
    pauseJson.stream?.status,
    "paused",
    "Pause should checkpoint and mark the stream paused"
  );

  const crankCancelJson = await buildCheckpointCrankAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    mode: "cancel",
  });
  assert.strictEqual(
    crankCancelJson.stream?.checkpointCrankStatus,
    "stopped",
    "Checkpoint crank should stop after cancel"
  );

  const resumedAgainJson = await buildControlAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    action: "resume",
  });
  assert.strictEqual(
    resumedAgainJson.stream?.status,
    "active",
    "Second resume should restore active status before settlement"
  );

  console.log("\n[8/10] Building settlement tick through /api/payroll/tick...");
  const streamResult = await waitForSettlementBuild({
    employerWallet,
    employerTeeAuthToken,
    streamId,
  });

  console.log("Tick build result:", {
    amountMicro: streamResult.amountMicro,
    employeePda: streamResult.employeePda,
    privatePayrollPda: streamResult.privatePayrollPda,
  });

  console.log(
    "\n[9/10] Funding employer private balance and sending settlement..."
  );
  await fundEmployerPrivateUsdcIfNeeded({
    employerWallet,
    employerTeeAuthToken,
    signer: authority,
    minAmountMicro: BigInt(streamResult.amountMicro),
  });

  const transferSignature = await sendBuiltTransaction({
    spec: streamResult.transactions.transfer,
    signer: authority,
    signerLabel: "tick:transfer",
  });
  const settleSalarySignature = await sendBuiltTransaction({
    spec: streamResult.transactions.settleSalary,
    signer: authority,
    signerLabel: "tick:settleSalary",
    teeAuthToken: employerTeeAuthToken,
    useTeeRpc: true,
  });
  const commitSignature = await sendBuiltTransaction({
    spec: streamResult.transactions.commitEmployee,
    signer: authority,
    signerLabel: "tick:commitEmployee",
    teeAuthToken: employerTeeAuthToken,
    useTeeRpc: true,
  });

  console.log("Settlement signatures:", {
    transferSignature,
    settleSalarySignature,
    commitSignature,
  });

  console.log("\n[10/10] Finalizing payroll tick...");
  const tickFinalizePayload: TickFinalizeItem[] = [
    {
      streamId,
      employeeId,
      employeeWallet,
      amountMicro: streamResult.amountMicro,
      employeePda: streamResult.employeePda!,
      privatePayrollPda: streamResult.privatePayrollPda!,
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
  assert.strictEqual(tickFinalizeJson.employerWallet, employerWallet);
  assert.strictEqual(
    tickFinalizeJson.totalTransferredMicro,
    streamResult.amountMicro,
    "Tick finalize total should match settled amount"
  );

  const persistedStream = await getStreamById(employerWallet, streamId);
  assert(persistedStream, "Persisted stream should exist after tick finalize");
  assert(
    typeof persistedStream!.totalPaid === "number" &&
      persistedStream!.totalPaid > 0,
    "Persisted stream should record totalPaid after tick finalize"
  );
  assert(
    persistedStream!.lastPaidAt,
    "Persisted stream should have lastPaidAt after tick finalize"
  );

  console.log("Persisted stream after tick:", {
    id: persistedStream!.id,
    totalPaid: persistedStream!.totalPaid,
    lastPaidAt: persistedStream!.lastPaidAt,
    employeePda: persistedStream!.employeePda,
    privatePayrollPda: persistedStream!.privatePayrollPda,
    permissionPda: persistedStream!.permissionPda,
  });

  console.log("\n=== Route Smoke Test Summary ===");
  console.log("Employee ID:", employeeId);
  console.log("Stream ID:", streamId);
  console.log("Employee PDA:", onboardBuildJson.employeePda);
  console.log("Private Payroll PDA:", onboardBuildJson.privatePayrollPda);
  console.log("Permission PDA:", onboardBuildJson.permissionPda);
  console.log("Preview Claimable:", previewJson.preview.claimableAmountMicro);
  console.log("Tick Transfer Signature:", transferSignature);
  console.log("Tick Amount:", streamResult.amountMicro);
  console.log("\nRoute-level app smoke test completed.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error("\nRoute smoke test failed:\n");
  console.error(message);
  process.exit(1);
});
