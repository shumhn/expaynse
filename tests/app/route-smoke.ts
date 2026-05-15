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
} from "../../app/api/employee-private-init/route.ts";
import {
  GET as claimRequestGet,
  PATCH as claimRequestFinalizePatch,
  POST as claimRequestBuildPost,
} from "../../app/api/claim-salary/request/route.ts";
import { POST as claimProcessPost } from "../../app/api/claim-salary/process/route.ts";
import { POST as companyCreatePost } from "../../app/api/company/create/route.ts";
import { POST as employeesAutoInitPost } from "../../app/api/employees/auto-init/route.ts";
import { POST as employeesPost } from "../../app/api/employees/route.ts";
import { GET as previewGet } from "../../app/api/payroll/preview/route.ts";
import {
  PATCH as checkpointCrankFinalizePatch,
  POST as checkpointCrankBuildPost,
} from "../../app/api/streams/checkpoint-crank/route.ts";
import {
  PATCH as controlFinalizePatch,
  POST as controlBuildPost,
} from "../../app/api/streams/control/route.ts";
import {
  PATCH as onboardFinalizePatch,
  POST as onboardBuildPost,
} from "../../app/api/streams/onboard/route.ts";
import { POST as streamsPost } from "../../app/api/streams/route.ts";
import {
  buildPrivateTransfer,
  deposit,
  fetchTeeAuthToken,
  getBalance,
  getPrivateBalance,
  signAndSend,
} from "../../lib/magicblock-api.ts";
import { getPayrollStore, getStreamById } from "../../lib/server/payroll-store.ts";
import { loadCompanyKeypair } from "../../lib/server/company-key-vault.ts";
import {
  makeAuthenticatedGetRequest,
  makeAuthenticatedJsonRequest,
} from "../helpers/wallet-auth-test-helpers.ts";
import {
  fundBaseUsdcIfNeeded,
  fundPrivateUsdcIfNeeded,
} from "../helpers/devnet-funding.ts";

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
    balance: string;
    location: "base" | "ephemeral";
  } | null;
};

type EmployeeAutoInitResponse = {
  message?: string;
  employee?: {
    id: string;
    wallet: string;
    privateRecipientInitStatus?: string | null;
    privateRecipientInitializedAt?: string | null;
    privateRecipientInitError?: string | null;
  };
  error?: string;
};

type ClaimRequestBuildResponse = {
  employeeWallet: string;
  streamId: string;
  amountMicro: number;
  claimId: number;
  transactions: {
    requestWithdrawal: SendSpec;
  };
  error?: string;
};

type ClaimRequestFinalizeResponse = {
  message?: string;
  claim?: {
    id: string;
    streamId: string;
    claimId: number;
    amountMicro: number;
    status: string;
  };
  error?: string;
};

type ClaimProcessResponse = {
  message?: string;
  claim?: {
    id: string;
    status: string;
    paymentTxSignature?: string | null;
    markPaidTxSignature?: string | null;
  };
  error?: string;
};

type CompanyCreateResponse = {
  ok?: boolean;
  company?: {
    id: string;
    name: string;
    employerWallet: string;
    treasuryPubkey: string;
    settlementPubkey: string;
  };
  error?: string;
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
    transferSignature?: string;
    transferSendTo?: string;
    transactions?: {
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
  return fundBaseUsdcIfNeeded({
    ...args,
    label: args.recipient.toBase58(),
  });
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

async function fundWalletPrivateUsdcIfNeeded(args: {
  connection: Connection;
  payer: Keypair;
  ownerWallet: string;
  ownerTeeAuthToken: string;
  signer: Keypair;
  minAmountMicro: bigint;
  label: string;
}) {
  const current = await getPrivateBalance(args.ownerWallet, args.ownerTeeAuthToken);
  const currentMicro = BigInt(current.balance);

  console.log(`${args.label} private balance before settlement:`, {
    location: current.location,
    balance: current.balance,
  });

  if (currentMicro >= args.minAmountMicro) {
    return currentMicro;
  }

  const shortfallMicro = args.minAmountMicro - currentMicro;
  const topUpMicro = shortfallMicro + 100_000n;
  const topUpUiAmount = toUiAmount(topUpMicro);

  await fundAccountIfNeeded({
    connection: args.connection,
    payer: args.payer,
    recipient: args.signer.publicKey,
    minLamports: 50_000_000,
  });
  await fundEmployeeUsdcIfNeeded({
    connection: args.connection,
    payer: args.payer,
    recipient: args.signer.publicKey,
    minAmountMicro: topUpMicro,
  });

  console.log(
    `Funding ${args.label} private balance with ${topUpUiAmount.toFixed(
      6
    )} USDC for settlement transfer precondition`
  );

  const transferBuild = await buildPrivateTransfer({
    from: args.signer.publicKey.toBase58(),
    to: args.ownerWallet,
    amount: topUpUiAmount,
    outputMint: DEVNET_USDC,
    balances: {
      fromBalance: "base",
      toBalance: "ephemeral",
    },
  });
  if (!transferBuild.transactionBase64) {
    throw new Error(
      `${args.label} private top-up transfer did not return a transaction`
    );
  }

  const depositSignature = await sendBuiltTransaction({
    spec: {
      transactionBase64: transferBuild.transactionBase64,
      sendTo: transferBuild.sendTo || "base",
    },
    signer: args.signer,
    signerLabel: `${args.label}:privateTopUp`,
  });

  console.log(`${args.label} private top-up signature:`, depositSignature);

  return waitForPrivateBalanceAtLeast({
    label: `${args.label}-private-balance`,
    address: args.ownerWallet,
    token: args.ownerTeeAuthToken,
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
    buildJson.transactions?.control,
    buildJson.error || `${args.action} build missing control transaction`
  );

  const controlSignature = await sendBuiltTransaction({
    spec: buildJson.transactions.control,
    signer: args.signer,
    signerLabel: `${args.action}:control`,
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
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams/checkpoint-crank",
      wallet: args.employerWallet,
      signer: args.signer,
      body: {
        employerWallet: args.employerWallet,
        streamId: args.streamId,
        teeAuthToken: args.teeAuthToken,
        mode: args.mode,
      },
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
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams/checkpoint-crank",
      wallet: args.employerWallet,
      signer: args.signer,
      body: {
        employerWallet: args.employerWallet,
        streamId: args.streamId,
        mode: args.mode,
        taskId: buildJson.taskId,
        signature,
        status: args.mode === "schedule" ? "active" : "stopped",
      },
      method: "PATCH",
    })
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

  console.log("\n[0/10] Ensuring company setup exists...");
  const companyResponse = await companyCreatePost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/company/create",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        name: "Expaynse Route Smoke Company",
      },
    })
  );
  assert.strictEqual(
    companyResponse.status,
    200,
    "Company create should return 200"
  );

  const companyJson = await json<CompanyCreateResponse>(companyResponse);
  assert(companyJson.company, companyJson.error || "Company create missing payload");

  console.log("Company ready:", {
    id: companyJson.company.id,
    treasuryPubkey: companyJson.company.treasuryPubkey,
    settlementPubkey: companyJson.company.settlementPubkey,
  });

  await fundBaseUsdcIfNeeded({
    connection,
    payer: authority,
    recipient: new PublicKey(companyJson.company.treasuryPubkey),
    minAmountMicro: 100_000n,
    label: "company-treasury",
  });

  const treasurySigner = await loadCompanyKeypair({
    companyId: companyJson.company.id,
    kind: "treasury",
  });
  const treasuryWallet = treasurySigner.publicKey.toBase58();
  assert.strictEqual(
    treasuryWallet,
    companyJson.company.treasuryPubkey,
    "Loaded treasury signer should match company treasury pubkey"
  );
  const treasuryTeeAuthToken = await fetchTeeAuthToken(
    treasurySigner.publicKey,
    keypairSignMessageFactory(treasurySigner)
  );
  await fundPrivateUsdcIfNeeded({
    connection,
    payer: authority,
    ownerWallet: treasuryWallet,
    ownerTeeAuthToken: treasuryTeeAuthToken,
    signer: authority,
    minAmountMicro: 1n,
    label: "company-treasury-bootstrap",
  });

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
        payoutMode: "ephemeral",
        allowedPayoutModes: ["ephemeral", "base"],
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
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams/onboard",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        streamId,
        teeAuthToken: employerTeeAuthToken,
      },
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

  if (onboardBuildJson.transactions.baseSetup) {
    await sendBuiltTransaction({
      spec: onboardBuildJson.transactions.baseSetup,
      signer: authority,
      signerLabel: "onboard:baseSetup",
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
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams/onboard",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        streamId,
        employeePda: onboardBuildJson.employeePda,
        privatePayrollPda: onboardBuildJson.privatePayrollPda,
        permissionPda: onboardBuildJson.permissionPda,
        teeAuthToken: employerTeeAuthToken,
      },
      method: "PATCH",
    })
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

  console.log(
    "\n[4/10] Server auto-init tries sponsor/treasury first, then employee fallback if needed..."
  );
  const autoInitResponse = await employeesAutoInitPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/employees/auto-init",
      wallet: employerWallet,
      signer: authority,
      body: {
        employerWallet,
        employeeWallet,
      },
    })
  );

  const autoInitJson = await json<EmployeeAutoInitResponse>(autoInitResponse);

  if (autoInitResponse.ok) {
    assert(
      autoInitJson.employee,
      "Server auto-init should return the refreshed employee"
    );
    console.log("Server auto-init:", {
      initializedAt:
        autoInitJson.employee.privateRecipientInitializedAt ?? null,
      status: autoInitJson.employee.privateRecipientInitStatus ?? null,
    });
  } else {
    console.log("Server auto-init unavailable, using employee fallback:", {
      status: autoInitResponse.status,
      error: autoInitJson.error ?? null,
    });

    const privateInitBuildResponse = await employeePrivateInitBuildPost(
      await makeAuthenticatedJsonRequest({
        url: "http://localhost/api/employee-private-init",
        wallet: employeeWallet,
        signer: employee,
        body: {
          employeeWallet,
        },
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
      await makeAuthenticatedJsonRequest({
        url: "http://localhost/api/employee-private-init",
        wallet: employeeWallet,
        signer: employee,
        body: {
          employeeWallet,
          teeAuthToken: employeeTeeAuthToken,
        },
        method: "PATCH",
      })
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

    console.log("Employee manual init:", {
      initializedAt: privateInitFinalizeJson.initializedAt,
      privateBalance:
        privateInitFinalizeJson.privateBalance?.balance ?? "unknown",
    });
  }

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
  const resumedAgainCrankJson = await buildCheckpointCrankAndFinalize({
    employerWallet,
    streamId,
    teeAuthToken: employerTeeAuthToken,
    signer: authority,
    mode: "schedule",
  });
  assert.strictEqual(
    resumedAgainCrankJson.stream?.checkpointCrankStatus,
    "active",
    "Second resume should reactivate checkpoint crank before settlement"
  );

  console.log("\n[8/10] Funding treasury private balance and building employee claim...");
  const employeePrivateBeforeClaim = BigInt(
    (await getPrivateBalance(employeeWallet, employeeTeeAuthToken)).balance
  );

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
    "Preview before claim should return 200"
  );
  const postResumePreviewJson = await json<{
    preview: {
      claimableAmountMicro: number;
    };
    error?: string;
  }>(postResumePreviewResponse);
  const claimAmountMicro = Math.max(
    1,
    Math.min(postResumePreviewJson.preview.claimableAmountMicro, 1_000_000)
  );
  assert(
    claimAmountMicro > 0,
    "Expected positive claimable balance before employee claim"
  );
  await fundWalletPrivateUsdcIfNeeded({
    connection,
    payer: authority,
    ownerWallet: treasuryWallet,
    ownerTeeAuthToken: treasuryTeeAuthToken,
    signer: authority,
    minAmountMicro: BigInt(claimAmountMicro + 100_000),
    label: "company-treasury",
  });
  await fundBaseUsdcIfNeeded({
    connection,
    payer: authority,
    recipient: treasurySigner.publicKey,
    minAmountMicro: BigInt(claimAmountMicro + 100_000),
    label: "company-treasury",
  });

  const claimBuildResponse = await claimRequestBuildPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/claim-salary/request",
      wallet: employeeWallet,
      signer: employee,
      body: {
        employeeWallet,
        streamId,
        amountMicro: claimAmountMicro,
        teeAuthToken: employeeTeeAuthToken,
      },
    })
  );
  assert.strictEqual(
    claimBuildResponse.status,
    201,
    "Claim build should return 201"
  );

  const claimBuildJson = await json<ClaimRequestBuildResponse>(
    claimBuildResponse
  );
  assert(
    claimBuildJson.transactions?.requestWithdrawal,
    claimBuildJson.error || "Claim build should include requestWithdrawal tx"
  );

  console.log("Claim build result:", {
    claimId: claimBuildJson.claimId,
    amountMicro: claimBuildJson.amountMicro,
  });

  const requestWithdrawalSignature = await sendBuiltTransaction({
    spec: claimBuildJson.transactions.requestWithdrawal,
    signer: employee,
    signerLabel: "claim:requestWithdrawal",
    teeAuthToken: employeeTeeAuthToken,
    useTeeRpc: true,
  });
  const claimFinalizeResponse = await claimRequestFinalizePatch(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/claim-salary/request",
      wallet: employeeWallet,
      signer: employee,
      body: {
        employeeWallet,
        streamId,
        amountMicro: claimAmountMicro,
        claimId: claimBuildJson.claimId,
        signature: requestWithdrawalSignature,
        teeAuthToken: employeeTeeAuthToken,
      },
      method: "PATCH",
    })
  );
  assert.strictEqual(
    claimFinalizeResponse.status,
    200,
    "Claim finalize should return 200"
  );
  const claimFinalizeJson = await json<ClaimRequestFinalizeResponse>(
    claimFinalizeResponse
  );
  assert(
    claimFinalizeJson.claim,
    claimFinalizeJson.error || "Claim finalize should persist pending claim"
  );
  assert.strictEqual(
    claimFinalizeJson.claim?.status,
    "requested",
    "Claim finalize should persist the request as requested"
  );

  console.log("\n[9/10] Processing server-side payout...");
  const processClaimResponse = await claimProcessPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/claim-salary/process",
      wallet: employeeWallet,
      signer: employee,
      body: {
        streamId,
        teeAuthToken: employeeTeeAuthToken,
        employeeWallet,
      },
    })
  );
  assert.strictEqual(
    processClaimResponse.status,
    200,
    "Claim process should return 200"
  );
  const processClaimJson = await json<ClaimProcessResponse>(processClaimResponse);
  assert(
    processClaimJson.claim,
    processClaimJson.error || "Claim process should return the processed claim"
  );
  assert.strictEqual(
    processClaimJson.claim?.status,
    "paid",
    "Claim process should settle the request as paid"
  );

  console.log("Processed claim:", {
    claimId: processClaimJson.claim?.id,
    paymentTxSignature: processClaimJson.claim?.paymentTxSignature,
    markPaidTxSignature: processClaimJson.claim?.markPaidTxSignature,
  });

  console.log("\n[10/10] Verifying persisted claim state and employee balances...");
  const employeePrivateAfterClaim = await waitForPrivateBalanceAtLeast({
    label: "employee-private-after-claim",
    address: employeeWallet,
    token: employeeTeeAuthToken,
    minMicro: employeePrivateBeforeClaim + BigInt(claimAmountMicro),
  });
  const payrollStore = await getPayrollStore();
  const persistedClaim = [...payrollStore.onChainClaims]
    .reverse()
    .find((claim) => claim.streamId === streamId);
  assert(persistedClaim, "Persisted claim should exist after processing");
  assert.strictEqual(
    persistedClaim?.status,
    "paid",
    "Persisted claim should be marked paid"
  );
  const persistedTransfer = [...payrollStore.transfers]
    .reverse()
    .find((transfer) => transfer.streamId === streamId);
  assert(persistedTransfer, "Persisted transfer should exist after processing");
  assert.strictEqual(
    persistedTransfer?.status,
    "success",
    "Persisted transfer should be marked success"
  );

  const persistedStream = await getStreamById(employerWallet, streamId);
  assert(persistedStream, "Persisted stream should exist after claim processing");

  console.log("Claim settlement snapshot:", {
    claimAmountMicro,
    employeePrivateBeforeClaim: employeePrivateBeforeClaim.toString(),
    employeePrivateAfterClaim: employeePrivateAfterClaim.toString(),
    persistedClaimStatus: persistedClaim?.status,
    persistedTransferStatus: persistedTransfer?.status,
    streamStatus: persistedStream!.status,
  });

  console.log("\n=== Route Smoke Test Summary ===");
  console.log("Employee ID:", employeeId);
  console.log("Stream ID:", streamId);
  console.log("Employee PDA:", onboardBuildJson.employeePda);
  console.log("Private Payroll PDA:", onboardBuildJson.privatePayrollPda);
  console.log("Permission PDA:", onboardBuildJson.permissionPda);
  console.log("Preview Claimable:", postResumePreviewJson.preview.claimableAmountMicro);
  console.log("Processed Claim ID:", claimBuildJson.claimId);
  console.log("Processed Claim Amount:", claimAmountMicro);
  console.log("\nRoute-level app smoke test completed.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error("\nRoute smoke test failed:\n");
  console.error(message);
  process.exit(1);
});
