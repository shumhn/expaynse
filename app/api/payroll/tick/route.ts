import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const MAGIC_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import {
  type PrivateTransferPrivacyConfig,
} from "@/lib/magicblock-api";
import crypto from "node:crypto";
import { findCompanyByEmployerWallet } from "@/lib/server/company-store";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import { sendPayrollFromCompanyTreasury } from "@/lib/server/treasury-payroll-transfer";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import { verifyAuthorizedWalletRequest } from "@/lib/wallet-request-auth";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  createTransferRecord,
  findUnsettledTransfer,
  fulfillPendingCashoutRequestsForStream,
  getCashoutRequestById,
  getEmployeeById,
  getStreamById,
  listStreams,
  resolveEmployeePrivateRecipientInitializedAt,
  resolveStreamPayoutMode,
  sumSuccessfulTransferAmountMicroForStream,
  updateStreamRuntimeState,
  updateStreamStatus,
  updateTransferStatus,
  updateTransferRecord,
  type PayrollPayoutMode,
  type PayrollStreamRecord,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import { savePayrollRun } from "@/lib/server/history-store";
import {
  evaluateMonthlyCap,
} from "@/lib/server/monthly-cap";
import { getConfirmedUnixTimestamp } from "@/lib/server/private-payroll-state";

const TEE_URL = process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL || "https://devnet-tee.magicblock.app";
const PAYROLL_TRANSFER_PRIVACY: PrivateTransferPrivacyConfig = {
  minDelayMs: 600_000,
  maxDelayMs: 600_000,
  split: 3,
};

type PayrollTickBuildResult = {
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  cashoutRequestId?: string;
  requestedAmountMicro?: number;
  skipped: boolean;
  reason?: string;
  elapsedSeconds?: number;
  amountMicro?: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  transferFromBalance?: "base" | "ephemeral";
  transferToBalance?: "base" | "ephemeral";
  employeePda?: string;
  privatePayrollPda?: string;
  /** Signature of the treasury→employee transfer (already executed server-side) */
  transferSignature?: string;
  transferSendTo?: string;
  accountingOnly?: boolean;
  settlementAlreadyApplied?: boolean;
  needsRecovery?: boolean;
  transactions?: {
    settleSalary?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    commitEmployee?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
};

type PayrollTickFinalizeItem = {
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  cashoutRequestId?: string;
  requestedAmountMicro?: number;
  amountMicro: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  transferFromBalance?: "base" | "ephemeral";
  transferToBalance?: "base" | "ephemeral";
  transferSendTo?: string;
  employeePda: string;
  privatePayrollPda: string;
  transferSignature?: string;
  accountingOnly?: boolean;
  settleSalarySignature?: string;
  commitSignature: string;
};

type ExactPrivatePayrollState = {
  employeePda: string;
  privatePayrollPda: string;
  employee: string;
  streamId: string;
  status: PayrollStreamStatus;
  version: string;
  lastCheckpointTs: string;
  ratePerSecondMicro: string;
  lastAccrualTimestamp: string;
  accruedUnpaidMicro: string;
  totalPaidPrivateMicro: string;
};

function hasAppliedEmployerSettlement(args: {
  state: ExactPrivatePayrollState;
  transfer: Awaited<ReturnType<typeof findUnsettledTransfer>>;
  amountMicro: number;
}) {
  const beforeTotalPaid = args.transfer?.providerMeta?.totalPaidPrivateBeforeMicro;
  if (!beforeTotalPaid) return false;

  return (
    BigInt(args.state.totalPaidPrivateMicro) >=
    BigInt(beforeTotalPaid) + BigInt(args.amountMicro)
  );
}

function computeLiveClaimableAmountMicro(args: {
  state: ExactPrivatePayrollState;
  nowUnix: number;
  startsAt?: string | null;
}) {
  const startsAtUnix = args.startsAt
    ? Math.floor(new Date(args.startsAt).getTime() / 1000)
    : null;
  const hasFutureStart =
    startsAtUnix !== null &&
    Number.isFinite(startsAtUnix) &&
    args.nowUnix < startsAtUnix;
  const shouldAccrue = args.state.status === "active" && !hasFutureStart;
  const lastAccrualUnix = Number(args.state.lastAccrualTimestamp);
  const elapsedSeconds =
    shouldAccrue && Number.isFinite(lastAccrualUnix)
      ? Math.max(0, args.nowUnix - lastAccrualUnix)
      : 0;
  const pendingAccrualMicro = shouldAccrue
    ? BigInt(args.state.ratePerSecondMicro) * BigInt(elapsedSeconds)
    : BigInt(0);
  const claimableAmountMicro =
    BigInt(args.state.accruedUnpaidMicro) + pendingAccrualMicro;

  return {
    hasFutureStart,
    elapsedSeconds,
    pendingAccrualMicro,
    claimableAmountMicro,
  };
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function microToUsdc(amountMicro: number) {
  if (!Number.isFinite(amountMicro) || amountMicro < 0) {
    throw new Error("Invalid micro amount");
  }

  return amountMicro / 1_000_000;
}

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readI64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigInt64LE(offset);
}

function mapEmployeeStatusToStreamStatus(status?: number): PayrollStreamStatus {
  switch (status) {
    case 0:
      return "paused";
    case 1:
      return "active";
    case 2:
      return "paused";
    case 3:
      return "stopped";
    default:
      throw new Error(`Unknown private payroll status: ${String(status)}`);
  }
}

function decodePrivatePayrollState(
  data: Buffer,
  employeePda: PublicKey,
  privatePayrollPda: PublicKey,
): ExactPrivatePayrollState {
  // V2 PrivatePayrollState layout (matches Rust struct):
  // offset 0:   employee           (32 bytes)
  // offset 32:  employee_wallet    (32 bytes)
  // offset 64:  stream_id          (32 bytes)
  // offset 96:  mint               (32 bytes)
  // offset 128: payroll_treasury   (32 bytes)
  // offset 160: settlement_auth    (32 bytes)
  // offset 192: status             (1 byte)
  // offset 193: version            (8 bytes, u64 LE)
  // offset 201: last_checkpoint_ts (8 bytes, i64 LE)
  // offset 209: rate_per_second    (8 bytes, u64 LE)
  // offset 217: last_accrual_ts    (8 bytes, i64 LE)
  // offset 225: accrued_unpaid     (8 bytes, u64 LE)
  // offset 233: total_paid_private (8 bytes, u64 LE)
  const MIN_LEN = 241;
  if (data.length < MIN_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  const employee = new PublicKey(data.subarray(0, 32));
  const streamId = data.subarray(64, 96).toString("hex");
  const status = mapEmployeeStatusToStreamStatus(data.readUInt8(192));
  const version = readU64LE(data, 193);
  const lastCheckpointTs = readI64LE(data, 201);
  const ratePerSecondMicro = readU64LE(data, 209);
  const lastAccrualTimestamp = readI64LE(data, 217);
  const accruedUnpaidMicro = readU64LE(data, 225);
  const totalPaidPrivateMicro = readU64LE(data, 233);

  return {
    employeePda: employeePda.toBase58(),
    privatePayrollPda: privatePayrollPda.toBase58(),
    employee: employee.toBase58(),
    streamId,
    status,
    version: String(version),
    lastCheckpointTs: String(lastCheckpointTs),
    ratePerSecondMicro: String(ratePerSecondMicro),
    lastAccrualTimestamp: String(lastAccrualTimestamp),
    accruedUnpaidMicro: String(accruedUnpaidMicro),
    totalPaidPrivateMicro: String(totalPaidPrivateMicro),
  };
}

async function fetchExactPrivatePayrollState(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
}): Promise<ExactPrivatePayrollState> {
  assertWallet(args.employerWallet, "Employer wallet");
  const employeePda = getEmployeePdaForStream(
    args.employerWallet,
    args.streamId,
  );
  const privatePayrollPda = getPrivatePayrollPda(employeePda);

  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(args.teeAuthToken)}`,
    "confirmed",
  );

  const accountInfo = await connection.getAccountInfo(
    privatePayrollPda,
    "confirmed",
  );

  if (!accountInfo?.data) {
    throw new Error("Private payroll state not found in PER");
  }

  return decodePrivatePayrollState(
    Buffer.from(accountInfo.data),
    employeePda,
    privatePayrollPda,
  );
}

async function loadIdl(provider: anchor.AnchorProvider) {
  return loadPayrollIdl(provider);
}

async function getTeeProgramForEmployer(
  employerPubkey: PublicKey,
  teeAuthToken: string,
) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadIdl(provider);
  const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
  return { connection, provider, program };
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

async function buildSettleTickForStream(args: {
  employerWallet: string;
  stream: PayrollStreamRecord;
  teeAuthToken: string;
  treasuryKeypair: import("@solana/web3.js").Keypair;
  maxSettlementAmountMicro?: number;
  cashoutRequestId?: string;
}): Promise<PayrollTickBuildResult> {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const employee = await getEmployeeById(
    employerWallet,
    args.stream.employeeId,
  );

  if (!employee) {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: "unknown",
      skipped: true,
      reason: "Employee record not found",
    };
  }

  if (!args.stream.employeePda || !args.stream.privatePayrollPda) {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: employee.wallet,
      skipped: true,
      reason: "Stream is not yet PER onboarded",
    };
  }

  const defaultPayoutMode = resolveStreamPayoutMode(args.stream);
  let resolvedPayoutMode: PayrollPayoutMode = defaultPayoutMode;
  let destinationWallet = employee.wallet;
  let requestedAmountMicro = args.maxSettlementAmountMicro;

  if (args.cashoutRequestId) {
    const request = await getCashoutRequestById(args.cashoutRequestId);

    if (!request) {
      return {
        streamId: args.stream.id,
        employeeId: args.stream.employeeId,
        employeeWallet: employee.wallet,
        cashoutRequestId: args.cashoutRequestId,
        skipped: true,
        reason: "Cashout request not found",
      };
    }

    if (request.employerWallet !== employerWallet || request.streamId !== args.stream.id) {
      return {
        streamId: args.stream.id,
        employeeId: args.stream.employeeId,
        employeeWallet: employee.wallet,
        cashoutRequestId: args.cashoutRequestId,
        skipped: true,
        reason: "Cashout request does not match this payroll stream",
      };
    }

    if (request.status !== "pending") {
      return {
        streamId: args.stream.id,
        employeeId: args.stream.employeeId,
        employeeWallet: employee.wallet,
        cashoutRequestId: args.cashoutRequestId,
        skipped: true,
        reason: "Cashout request is no longer pending",
      };
    }

    resolvedPayoutMode =
      request.payoutMode === "ephemeral" || request.payoutMode === "base"
        ? request.payoutMode
        : defaultPayoutMode;
    destinationWallet = request.destinationWallet?.trim() || employee.wallet;
    requestedAmountMicro = Math.round(request.requestedAmount * 1_000_000);
  }

  const transferFromBalance: "base" | "ephemeral" = "ephemeral";
  const transferToBalance: "base" | "ephemeral" =
    resolvedPayoutMode === "ephemeral" ? "ephemeral" : "base";

  if (resolvedPayoutMode === "ephemeral") {
    const recipientPrivateInitializedAt =
      args.stream.recipientPrivateInitializedAt ??
      employee.privateRecipientInitializedAt ??
      (await resolveEmployeePrivateRecipientInitializedAt(
        employerWallet,
        args.stream.employeeId,
      )) ??
      null;

    if (!recipientPrivateInitializedAt) {
      return {
        streamId: args.stream.id,
        employeeId: args.stream.employeeId,
        employeeWallet: employee.wallet,
        cashoutRequestId: args.cashoutRequestId,
        requestedAmountMicro,
        payoutMode: resolvedPayoutMode,
        destinationWallet,
        transferFromBalance,
        transferToBalance,
        skipped: true,
        reason:
          "Employee must initialize their private account from the Claim page before the first private-to-private payroll tick",
      };
    }

    if (!args.stream.recipientPrivateInitializedAt) {
      await updateStreamRuntimeState({
        employerWallet,
        streamId: args.stream.id,
        recipientPrivateInitializedAt,
      });
    }
  }

  const employerPubkey = new PublicKey(employerWallet);
  const employeePda = new PublicKey(args.stream.employeePda);
  const privatePayrollPda = new PublicKey(args.stream.privatePayrollPda);

  const { connection: teeConnection, program } = await getTeeProgramForEmployer(
    employerPubkey,
    args.teeAuthToken,
  );

  const exactState = await fetchExactPrivatePayrollState({
    employerWallet,
    streamId: args.stream.id,
    teeAuthToken: args.teeAuthToken,
  });

  const onChainStatus = exactState.status;

  if (onChainStatus !== args.stream.status) {
    await updateStreamStatus({
      employerWallet,
      streamId: args.stream.id,
      status: onChainStatus,
    });
  }

  if (
    onChainStatus !== "active" &&
    onChainStatus !== "paused" &&
    onChainStatus !== "stopped"
  ) {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: employee.wallet,
      skipped: true,
      reason: `Stream is not settleable in status ${onChainStatus}`,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
    };
  }

  const nowUnix = await getConfirmedUnixTimestamp(teeConnection);
  const rawClaimable = computeLiveClaimableAmountMicro({
    state: exactState,
    nowUnix,
    startsAt: args.stream.startsAt ?? employee.startDate ?? null,
  });
  const cap = evaluateMonthlyCap({
    stream: args.stream,
    employee,
    rawClaimableAmountMicro: rawClaimable.claimableAmountMicro,
    totalPaidPrivateMicro: BigInt(exactState.totalPaidPrivateMicro),
  });
  const effectiveClaimableAmountMicro = rawClaimable.hasFutureStart
    ? BigInt(0)
    : BigInt(cap.effectiveClaimableAmountMicro);

  if (effectiveClaimableAmountMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PER accrued amount exceeds safe integer range");
  }

  const accruedAmountMicro = Number(effectiveClaimableAmountMicro);

  const amountMicro =
    typeof requestedAmountMicro === "number"
      ? Math.min(accruedAmountMicro, requestedAmountMicro)
      : accruedAmountMicro;
  const unsettled = await findUnsettledTransfer(args.stream.id);
  const onChainPaidMicro = BigInt(exactState.totalPaidPrivateMicro);
  const successfulPaidMicro =
    await sumSuccessfulTransferAmountMicroForStream(args.stream.id);
  const missingAppliedAccountingMicro =
    !unsettled && successfulPaidMicro > onChainPaidMicro
      ? successfulPaidMicro - onChainPaidMicro
      : BigInt(0);
  if (missingAppliedAccountingMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PER accounting repair amount exceeds safe integer range");
  }
  const accountingOnlyAmountMicro =
    missingAppliedAccountingMicro > BigInt(0)
      ? Number(
        missingAppliedAccountingMicro > rawClaimable.claimableAmountMicro
          ? rawClaimable.claimableAmountMicro
          : missingAppliedAccountingMicro,
      )
      : 0;

  if (!unsettled && amountMicro < 1 && accountingOnlyAmountMicro < 1) {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: employee.wallet,
      cashoutRequestId: args.cashoutRequestId,
      requestedAmountMicro,
      payoutMode: resolvedPayoutMode,
      destinationWallet,
      transferFromBalance,
      transferToBalance,
      skipped: true,
      reason: amountMicro <= 0
        ? "No accrued private payroll amount is available to settle"
        : "Accrued amount is less than 1 micro USDC — too small to transfer",
      elapsedSeconds: rawClaimable.elapsedSeconds,
      amountMicro,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
    };
  }

  // unsettled.amount is stored in USDC; convert back to micro for the API
  const actualAmountMicro = unsettled
    ? Math.round(unsettled.amount * 1_000_000)
    : accountingOnlyAmountMicro >= 1
      ? accountingOnlyAmountMicro
      : amountMicro;
  const accountingOnly = !unsettled && accountingOnlyAmountMicro >= 1;
  const settlementAlreadyApplied = hasAppliedEmployerSettlement({
    state: exactState,
    transfer: unsettled,
    amountMicro: actualAmountMicro,
  });
  const settlementMeta = {
    settleAmountMicro: String(actualAmountMicro),
    privatePayrollVersionBefore: exactState.version,
    accruedUnpaidBeforeMicro: exactState.accruedUnpaidMicro,
    totalPaidPrivateBeforeMicro: exactState.totalPaidPrivateMicro,
  };

  const settleSalaryIx = settlementAlreadyApplied
    ? null
    : await program.methods
      .paySalary(new BN(actualAmountMicro))
      .accountsPartial({
        crankOrEmployer: employerPubkey,
        employer: employerPubkey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
        vault: MAGIC_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();

  const commitIx = await program.methods
    .commitEmployee()
    .accountsPartial({
      employer: employerPubkey,
      employee: employeePda,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();

  const [settleSalarySerialized, commitSerialized] = await Promise.all([
    settleSalaryIx
      ? serializeUnsignedTransaction(
        teeConnection,
        employerPubkey,
        new Transaction().add(settleSalaryIx),
      )
      : Promise.resolve(null),
    serializeUnsignedTransaction(
      teeConnection,
      employerPubkey,
      new Transaction().add(commitIx),
    ),
  ]);

  if (accountingOnly) {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: employee.wallet,
      cashoutRequestId: args.cashoutRequestId,
      requestedAmountMicro,
      payoutMode: resolvedPayoutMode,
      destinationWallet,
      transferFromBalance,
      transferToBalance,
      skipped: false,
      needsRecovery: true,
      accountingOnly: true,
      reason:
        "An earlier payroll transfer is paid in the database but not consumed in PER accounting. Sign once to sync state; no new treasury transfer will be sent.",
      elapsedSeconds: 0,
      amountMicro: actualAmountMicro,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
      settlementAlreadyApplied: false,
      transactions: {
        ...(settleSalarySerialized
          ? {
            settleSalary: {
              transactionBase64: Buffer.from(settleSalarySerialized).toString(
                "base64",
              ),
              sendTo: "ephemeral" as const,
            },
          }
          : {}),
        commitEmployee: {
          transactionBase64: Buffer.from(commitSerialized).toString("base64"),
          sendTo: "ephemeral",
        },
      },
    };
  }

  if (unsettled && unsettled.status !== "transfer_pending") {
    return {
      streamId: args.stream.id,
      employeeId: args.stream.employeeId,
      employeeWallet: employee.wallet,
      cashoutRequestId: args.cashoutRequestId,
      requestedAmountMicro,
      payoutMode: resolvedPayoutMode,
      destinationWallet,
      transferFromBalance,
      transferToBalance,
      skipped: false,
      needsRecovery: true,
      reason: "A previous payroll transfer was sent but not settled on-chain.",
      elapsedSeconds: 0,
      amountMicro: actualAmountMicro,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
      transferSignature: unsettled.txSignature,
      settlementAlreadyApplied,
      transactions: {
        ...(settleSalarySerialized
          ? {
            settleSalary: {
              transactionBase64: Buffer.from(settleSalarySerialized).toString(
                "base64",
              ),
              sendTo: "ephemeral" as const,
            },
          }
          : {}),
        commitEmployee: {
          transactionBase64: Buffer.from(commitSerialized).toString("base64"),
          sendTo: "ephemeral",
        },
      },
    };
  }

  let pendingTransferId = unsettled?.id;
  let clientRefId = unsettled?.providerMeta?.clientRefId;

  if (!unsettled || unsettled.status !== "transfer_pending") {
    const newTransfer = await createTransferRecord({
      employerWallet: args.employerWallet,
      employeeId: args.stream.employeeId,
      streamId: args.stream.id,
      amount: microToUsdc(actualAmountMicro),
      recipientAddress: destinationWallet,
      status: "transfer_pending",
      providerMeta: { provider: "magicblock", ...settlementMeta },
      privacyConfig: {
        visibility: "private",
        fromBalance: transferFromBalance ?? "ephemeral",
        toBalance: transferToBalance ?? "ephemeral",
      },
    });
    pendingTransferId = newTransfer.id;
    // MagicBlock API requires clientRefId to be a non-negative bigint string
    const hash = crypto.createHash("sha256").update(`payroll-${args.stream.id}-${pendingTransferId}`).digest();
    clientRefId = BigInt("0x" + hash.subarray(0, 8).toString("hex")).toString();

    await updateTransferRecord(pendingTransferId, {
      providerMeta: { provider: "magicblock", clientRefId, ...settlementMeta },
    });
  }

  // ── Execute treasury transfer server-side ──────────────────
  const treasuryTransfer = await sendPayrollFromCompanyTreasury({
    treasuryKeypair: args.treasuryKeypair,
    employeeWallet: destinationWallet,
    amountMicro: actualAmountMicro,
    clientRefId: clientRefId as string,
    fromBalance: transferFromBalance,
    toBalance: transferToBalance,
    privacy: PAYROLL_TRANSFER_PRIVACY,
  });

  // ── Immediate Pre-Save for Double-Spend Protection ───────────
  await updateTransferRecord(pendingTransferId as string, {
    status: "transfer_sent",
    txSignature: treasuryTransfer.signature,
    providerMeta: {
      provider: "magicblock",
      sendTo: treasuryTransfer.sendTo,
      clientRefId,
      ...settlementMeta,
    },
  });

  return {
    streamId: args.stream.id,
    employeeId: args.stream.employeeId,
    employeeWallet: employee.wallet,
    cashoutRequestId: args.cashoutRequestId,
    requestedAmountMicro,
    payoutMode: resolvedPayoutMode,
    destinationWallet,
    transferFromBalance,
    transferToBalance,
    skipped: false,
    elapsedSeconds: 0,
    amountMicro: actualAmountMicro,
    employeePda: employeePda.toBase58(),
    privatePayrollPda: privatePayrollPda.toBase58(),
    transferSignature: treasuryTransfer.signature,
    transferSendTo: treasuryTransfer.sendTo,
    settlementAlreadyApplied: false,
    transactions: {
      ...(settleSalarySerialized
        ? {
          settleSalary: {
            transactionBase64: Buffer.from(settleSalarySerialized).toString(
              "base64",
            ),
            sendTo: "ephemeral" as const,
          },
        }
        : {}),
      commitEmployee: {
        transactionBase64: Buffer.from(commitSerialized).toString("base64"),
        sendTo: "ephemeral",
      },
    },
  };
}

async function savePayrollRunHistory(input: {
  wallet: string;
  totalAmountMicro: number;
  employeeCount: number;
  recipientAddresses: string[];
  transferSignature?: string;
  status: "success" | "failed";
  providerSendTo?: string;
  fromBalance?: "base" | "ephemeral";
  toBalance?: "base" | "ephemeral";
}) {
  await savePayrollRun({
    wallet: input.wallet,
    totalAmount: input.totalAmountMicro / 1_000_000,
    employeeCount: input.employeeCount,
    recipientAddresses: input.recipientAddresses,
    transferSig: input.transferSignature,
    status: input.status,
    privacyConfig: {
      visibility: "private",
      fromBalance: input.fromBalance ?? "ephemeral",
      toBalance: input.toBalance ?? "ephemeral",
      minDelayMs: PAYROLL_TRANSFER_PRIVACY.minDelayMs,
      maxDelayMs: PAYROLL_TRANSFER_PRIVACY.maxDelayMs,
      split: PAYROLL_TRANSFER_PRIVACY.split,
    },
    providerMeta: {
      provider: "magicblock",
      sendTo: input.providerSendTo,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      employerWallet?: string;
      teeAuthToken?: string;
      streamId?: string;
      maxSettlementAmountMicro?: number;
      cashoutRequestId?: string;
    };

    const employerWallet = assertWallet(
      body.employerWallet || "",
      "Employer wallet",
    );

    // Verify authentication (only the employer who owns the wallet can initiate this)
    // We expect `wallet` query param to match the employer's wallet, and they must have signed the request.
    const urlWallet = request.nextUrl.searchParams.get("wallet")?.trim();
    if (!urlWallet || urlWallet !== employerWallet) {
      return badRequest("Wallet query param missing or mismatch", 401);
    }

    const rawBody = await request.text().catch(() => "");
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: urlWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
      body: rawBody || JSON.stringify(body),
    });

    const teeAuthToken = body.teeAuthToken?.trim();
    const streamId = body.streamId?.trim();
    const cashoutRequestId = body.cashoutRequestId?.trim();
    const maxSettlementAmountMicro =
      typeof body.maxSettlementAmountMicro === "number"
        ? body.maxSettlementAmountMicro
        : undefined;

    if (!teeAuthToken) {
      return badRequest(
        "teeAuthToken is required to build employer-signed payroll tick transactions",
      );
    }

    if (maxSettlementAmountMicro !== undefined) {
      if (!streamId) {
        return badRequest(
          "streamId is required when maxSettlementAmountMicro is provided",
        );
      }

      if (
        !Number.isSafeInteger(maxSettlementAmountMicro) ||
        maxSettlementAmountMicro <= 0
      ) {
        return badRequest("maxSettlementAmountMicro must be a positive integer");
      }
    }

    // ── Look up Company Treasury ───────────────────────────────
    const company = await findCompanyByEmployerWallet(employerWallet);
    if (!company) {
      return badRequest(
        "No company found for this employer wallet. Set up your company first.",
        404,
      );
    }

    const treasuryKeypair = await loadCompanyKeypair({
      companyId: company.id,
      kind: "treasury",
    });

    if (treasuryKeypair.publicKey.toBase58() !== company.treasuryPubkey) {
      return badRequest(
        "Treasury keypair does not match company treasury pubkey. Contact support.",
        500,
      );
    }

    let candidateStreams: PayrollStreamRecord[];

    if (streamId) {
      const stream = await getStreamById(employerWallet, streamId);

      if (!stream) {
        return badRequest("Stream not found for this employer", 404);
      }

      candidateStreams = [stream];
    } else {
      const streams = await listStreams(employerWallet);
      candidateStreams = streams.filter((stream) => stream.status === "active");
    }

    if (candidateStreams.length === 0) {
      return NextResponse.json({
        employerWallet,
        processed: 0,
        message: streamId
          ? "Selected stream is not available for tick reconciliation"
          : "No active payroll streams available for tick reconciliation",
        results: [] satisfies PayrollTickBuildResult[],
      });
    }

    const results: PayrollTickBuildResult[] = [];

    for (const stream of candidateStreams) {
      try {
        const result = await buildSettleTickForStream({
          employerWallet,
          stream,
          teeAuthToken,
          treasuryKeypair,
          maxSettlementAmountMicro,
          cashoutRequestId,
        });
        results.push(result);
      } catch (error: unknown) {
        const employee = await getEmployeeById(
          employerWallet,
          stream.employeeId,
        );
        results.push({
          streamId: stream.id,
          employeeId: stream.employeeId,
          employeeWallet: employee?.wallet || "unknown",
          skipped: true,
          reason:
            error instanceof Error
              ? error.message
              : "Unknown tick build failure",
        });
      }
    }

    const needsRecoveryResults = results.filter((r) => r.needsRecovery);
    if (needsRecoveryResults.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          needsRecovery: true,
          reason: "A previous payroll transfer was sent but not settled on-chain.",
          results: needsRecoveryResults,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      employerWallet,
      processed: candidateStreams.length,
      phase: "settle",
      results,
    });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error ? error.message : "Failed to build payroll tick",
      500,
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employerWallet?: string;
      results?: PayrollTickFinalizeItem[];
    };

    const employerWallet = body.employerWallet?.trim();
    const results = body.results;

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!Array.isArray(results)) {
      return badRequest("results must be an array");
    }

    let totalTransferredMicro = 0;
    const successfulRecipients: string[] = [];
    let firstTransferSignature: string | undefined;
    let firstProviderSendTo: string | undefined;
    let firstTransferFromBalance: "base" | "ephemeral" | undefined;
    let firstTransferToBalance: "base" | "ephemeral" | undefined;
    const streams = await listStreams(employerWallet);
    const streamMap = new Map(streams.map((stream) => [stream.id, stream]));

    for (const result of results) {
      if (!result.streamId || !result.employeeId || !result.employeeWallet) {
        return badRequest(
          "Each result must include streamId, employeeId, and employeeWallet",
        );
      }

      if (
        !Number.isFinite(result.amountMicro) ||
        result.amountMicro <= 0 ||
        !Number.isSafeInteger(result.amountMicro)
      ) {
        return badRequest(`Invalid amountMicro for stream ${result.streamId}`);
      }

      if (
        result.requestedAmountMicro !== undefined &&
        (!Number.isSafeInteger(result.requestedAmountMicro) ||
          result.requestedAmountMicro <= 0)
      ) {
        return badRequest(
          `Invalid requestedAmountMicro for stream ${result.streamId}`,
        );
      }

      if (
        result.transferFromBalance !== undefined &&
        result.transferFromBalance !== "base" &&
        result.transferFromBalance !== "ephemeral"
      ) {
        return badRequest(
          `Invalid transferFromBalance for stream ${result.streamId}`,
        );
      }

      if (
        result.transferToBalance !== undefined &&
        result.transferToBalance !== "base" &&
        result.transferToBalance !== "ephemeral"
      ) {
        return badRequest(`Invalid transferToBalance for stream ${result.streamId}`);
      }

      const existingStream = streamMap.get(result.streamId);
      const nextTotalPaid = result.accountingOnly
        ? existingStream?.totalPaid ?? 0
        : (existingStream?.totalPaid ?? 0) + microToUsdc(result.amountMicro);

      if (!result.accountingOnly) {
        if (!result.transferSignature) {
          return badRequest(`Missing transferSignature for stream ${result.streamId}`);
        }

        const unsettled = await findUnsettledTransfer(result.streamId);
        if (unsettled) {
          await updateTransferStatus(unsettled.id, "success", result.transferSignature);
        } else {
          await createTransferRecord({
            employerWallet,
            employeeId: result.employeeId,
            streamId: result.streamId,
            amount: microToUsdc(result.amountMicro),
            recipientAddress: result.destinationWallet || result.employeeWallet,
            txSignature: result.transferSignature,
            status: "success",
            privacyConfig: {
              visibility: "private",
              fromBalance: result.transferFromBalance ?? "ephemeral",
              toBalance: result.transferToBalance ?? "ephemeral",
            },
            providerMeta: {
              provider: "magicblock",
              sendTo:
                result.transferSendTo ||
                (result.transferToBalance === "base" ? "base" : "ephemeral"),
            },
          });
        }
      }

      await updateStreamRuntimeState({
        employerWallet,
        streamId: result.streamId,
        employeePda: result.employeePda,
        privatePayrollPda: result.privatePayrollPda,
        delegatedAt: new Date().toISOString(),
        ...(result.accountingOnly ? {} : { lastPaidAt: new Date().toISOString() }),
        totalPaid: nextTotalPaid,
      });

      if (!result.accountingOnly) {
        if (
          result.cashoutRequestId &&
          result.requestedAmountMicro !== undefined &&
          result.amountMicro >= result.requestedAmountMicro
        ) {
          await fulfillPendingCashoutRequestsForStream({
            employerWallet,
            streamId: result.streamId,
            requestId: result.cashoutRequestId,
            resolvedByWallet: employerWallet,
            resolutionNote:
              "Fulfilled automatically after employer settled the requested cashout amount.",
          });
        } else if (!result.cashoutRequestId) {
          await fulfillPendingCashoutRequestsForStream({
            employerWallet,
            streamId: result.streamId,
            settledAmountMicro: result.amountMicro,
            resolvedByWallet: employerWallet,
            resolutionNote:
              "Fulfilled automatically after employer settlement tick.",
          });
        }
      }

      if (existingStream) {
        streamMap.set(result.streamId, {
          ...existingStream,
          totalPaid: nextTotalPaid,
        });
      }

      if (!result.accountingOnly) {
        totalTransferredMicro += result.amountMicro;
        successfulRecipients.push(result.destinationWallet || result.employeeWallet);
      }

      if (!result.accountingOnly && !firstTransferSignature) {
        firstTransferSignature = result.transferSignature;
        firstProviderSendTo = result.transferSendTo || (result.transferToBalance === "base" ? "base" : "ephemeral");
        firstTransferFromBalance = result.transferFromBalance ?? "ephemeral";
        firstTransferToBalance = result.transferToBalance ?? "ephemeral";
      }
    }

    if (totalTransferredMicro > 0) {
      await savePayrollRunHistory({
        wallet: employerWallet,
        totalAmountMicro: totalTransferredMicro,
        employeeCount: successfulRecipients.length,
        recipientAddresses: successfulRecipients,
        transferSignature: firstTransferSignature,
        status: "success",
        providerSendTo: firstProviderSendTo,
        fromBalance: firstTransferFromBalance,
        toBalance: firstTransferToBalance,
      });
    }

    return NextResponse.json({
      employerWallet,
      processed: results.length,
      totalTransferredMicro,
      results,
    });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error
        ? error.message
        : "Failed to finalize employer-signed payroll tick",
      500,
    );
  }
}
