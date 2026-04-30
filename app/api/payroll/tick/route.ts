import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import {
  buildPrivateTransfer,
  type PrivateTransferPrivacyConfig,
} from "@/lib/magicblock-api";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  createTransferRecord,
  fulfillPendingCashoutRequestsForStream,
  getCashoutRequestById,
  getEmployeeById,
  getStreamById,
  listStreams,
  resolveEmployeePrivateRecipientInitializedAt,
  resolveStreamPayoutMode,
  updateStreamRuntimeState,
  updateStreamStatus,
  type PayrollPayoutMode,
  type PayrollStreamRecord,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import { savePayrollRun } from "@/lib/server/history-store";

const TEE_URL = "https://devnet-tee.magicblock.app";
const PRIVATE_PAYROLL_STATE_LEN = 114;
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
  transactions?: {
    transfer?: {
      transactionBase64: string;
      sendTo: string;
    };
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
  transferSignature: string;
  settleSalarySignature: string;
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

let cachedIdl: Idl | null = null;

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
  if (data.length < PRIVATE_PAYROLL_STATE_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  const employee = new PublicKey(data.subarray(0, 32));
  const streamId = data.subarray(32, 64).toString("hex");
  const status = mapEmployeeStatusToStreamStatus(data.readUInt8(64));
  const version = readU64LE(data, 65);
  const lastCheckpointTs = readI64LE(data, 73);
  const ratePerSecondMicro = readU64LE(data, 81);
  const lastAccrualTimestamp = readI64LE(data, 89);
  const accruedUnpaidMicro = readU64LE(data, 97);
  const totalPaidPrivateMicro = readU64LE(data, 105);

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
  if (cachedIdl) return cachedIdl;

  const idl = await loadPayrollIdl(provider);
  cachedIdl = idl;
  return idl;
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

  const accruedAmountMicro = Number(exactState.accruedUnpaidMicro);

  if (!Number.isSafeInteger(accruedAmountMicro)) {
    throw new Error("PER accrued amount exceeds safe integer range");
  }

  const amountMicro =
    typeof requestedAmountMicro === "number"
      ? Math.min(accruedAmountMicro, requestedAmountMicro)
      : accruedAmountMicro;

  if (amountMicro <= 0) {
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
      reason: "No accrued private payroll amount is available to settle",
      elapsedSeconds: 0,
      amountMicro,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
    };
  }

  const settleSalaryIx = await program.methods
    .settleSalary(new BN(amountMicro))
    .accounts({
      employee: employeePda,
      privatePayroll: privatePayrollPda,
      employer: employerPubkey,
    })
    .instruction();

  const commitIx = await program.methods
    .commitEmployee()
    .accountsPartial({
      employer: employerPubkey,
      employee: employeePda,
    })
    .instruction();

  const transferBuild = await buildPrivateTransfer({
    from: employerWallet,
    to: destinationWallet,
    amountMicro,
    token: args.teeAuthToken,
    balances: {
      fromBalance: transferFromBalance,
      toBalance: transferToBalance,
    },
    privacy: PAYROLL_TRANSFER_PRIVACY,
  });

  if (!transferBuild.transactionBase64) {
    throw new Error("Private Payments API returned no transactionBase64");
  }

  const [settleSalarySerialized, commitSerialized] = await Promise.all([
    serializeUnsignedTransaction(
      teeConnection,
      employerPubkey,
      new Transaction().add(settleSalaryIx),
    ),
    serializeUnsignedTransaction(
      teeConnection,
      employerPubkey,
      new Transaction().add(commitIx),
    ),
  ]);

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
    amountMicro,
    employeePda: employeePda.toBase58(),
    privatePayrollPda: privatePayrollPda.toBase58(),
    transactions: {
      transfer: {
        transactionBase64: transferBuild.transactionBase64,
        sendTo: transferBuild.sendTo || "base",
      },
      settleSalary: {
        transactionBase64: Buffer.from(settleSalarySerialized).toString(
          "base64",
        ),
        sendTo: "ephemeral",
      },
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

      const transfer = await createTransferRecord({
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

      const existingStream = streamMap.get(result.streamId);
      const nextTotalPaid =
        (existingStream?.totalPaid ?? 0) + microToUsdc(result.amountMicro);

      await updateStreamRuntimeState({
        employerWallet,
        streamId: result.streamId,
        employeePda: result.employeePda,
        privatePayrollPda: result.privatePayrollPda,
        delegatedAt: new Date().toISOString(),
        lastPaidAt: new Date().toISOString(),
        totalPaid: nextTotalPaid,
      });

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

      if (existingStream) {
        streamMap.set(result.streamId, {
          ...existingStream,
          totalPaid: nextTotalPaid,
        });
      }

      totalTransferredMicro += result.amountMicro;
      successfulRecipients.push(result.destinationWallet || result.employeeWallet);

      if (!firstTransferSignature) {
        firstTransferSignature = transfer.txSignature;
        firstProviderSendTo = transfer.providerMeta?.sendTo;
        firstTransferFromBalance = transfer.privacyConfig?.fromBalance;
        firstTransferToBalance = transfer.privacyConfig?.toBalance;
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
