import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  getEmployeeById,
  getStreamById,
  updateStreamRuntimeState,
  updateStreamStatus,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import {
  evaluateMonthlyCap,
  hasCapStateChanged,
} from "@/lib/server/monthly-cap";

const TEE_URL = "https://devnet-tee.magicblock.app";
const PRIVATE_PAYROLL_STATE_LEN = 114;

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
  effectiveClaimableAmountMicro: string;
  monthlyCapUsd: number | null;
  monthlyCapMicro: string | null;
  cycleKey: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  paidThisCycleMicro: string | null;
  remainingCapMicro: string | null;
  capReached: boolean;
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
    status: PayrollStreamStatus;
    ratePerSecond: number;
    employeePda: string | null;
    privatePayrollPda: string | null;
    permissionPda: string | null;
    delegatedAt: string | null;
    lastPaidAt: string | null;
    totalPaid: number;
  };
  state: ExactPrivatePayrollState;
  syncedAt: string;
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isMissingPrivatePayrollStateError(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  return (
    normalized.includes("private payroll state not found") ||
    normalized.includes("private payroll state account is not initialized")
  );
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
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
    effectiveClaimableAmountMicro: String(accruedUnpaidMicro),
    monthlyCapUsd: null,
    monthlyCapMicro: null,
    cycleKey: null,
    cycleStart: null,
    cycleEnd: null,
    paidThisCycleMicro: null,
    remainingCapMicro: null,
    capReached: false,
  };
}

async function fetchExactPrivatePayrollState(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
}): Promise<ExactPrivatePayrollState> {
  assertWallet(args.employerWallet, "Employer wallet");
  const employeePda = getEmployeePdaForStream(args.employerWallet, args.streamId);
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

export async function GET(request: NextRequest) {
  try {
    const employerWallet = request.nextUrl.searchParams
      .get("employerWallet")
      ?.trim();
    const streamId = request.nextUrl.searchParams.get("streamId")?.trim();

    const authHeader = request.headers.get("authorization")?.trim();
    const teeAuthToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!teeAuthToken) {
      return badRequest(
        "Authorization Bearer token is required for employer-authenticated TEE state reads",
        401,
      );
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const employee = await getEmployeeById(employerWallet, stream.employeeId);
    if (!employee) {
      return badRequest("Employee not found for this stream", 404);
    }

    const state = await fetchExactPrivatePayrollState({
      employerWallet,
      streamId,
      teeAuthToken,
    });

    const cap = evaluateMonthlyCap({
      stream,
      employee,
      rawClaimableAmountMicro: BigInt(state.accruedUnpaidMicro),
      totalPaidPrivateMicro: BigInt(state.totalPaidPrivateMicro),
    });

    const startsAtUnix = stream.startsAt
      ? new Date(stream.startsAt).getTime()
      : employee.startDate
        ? new Date(employee.startDate).getTime()
        : null;
    const hasFutureStart =
      startsAtUnix !== null && Number.isFinite(startsAtUnix) && startsAtUnix > Date.now();

    state.effectiveClaimableAmountMicro = cap.effectiveClaimableAmountMicro;
    state.monthlyCapUsd = cap.monthlyCapUsd;
    state.monthlyCapMicro = cap.monthlyCapMicro;
    state.cycleKey = cap.cycleKey;
    state.cycleStart = cap.cycleStart;
    state.cycleEnd = cap.cycleEnd;
    state.paidThisCycleMicro = cap.paidThisCycleMicro;
    state.remainingCapMicro = cap.remainingCapMicro;
    state.capReached = cap.capReached;

    if (hasFutureStart) {
      state.effectiveClaimableAmountMicro = "0";
      state.capReached = false;
    }

    if (hasCapStateChanged(stream.monthlyCapState, cap.nextCapState)) {
      await updateStreamRuntimeState({
        employerWallet,
        streamId,
        monthlyCapState: cap.nextCapState,
      });
    }

    const employeePda = stream.employeePda ?? state.employeePda;
    const resolvedStatus =
      hasFutureStart || (cap.capReached && state.status === "active")
        ? "paused"
        : state.status;
    state.status = resolvedStatus;

    if (resolvedStatus !== stream.status) {
      await updateStreamStatus({
        employerWallet,
        streamId,
        status: resolvedStatus,
      });
    }

    const response: ExactPrivatePayrollStateResponse = {
      employerWallet,
      streamId,
      employee: {
        id: employee.id,
        wallet: employee.wallet,
        name: employee.name,
      },
      stream: {
        id: stream.id,
        status: resolvedStatus,
        ratePerSecond: stream.ratePerSecond,
        employeePda,
        privatePayrollPda: stream.privatePayrollPda ?? state.privatePayrollPda,
        permissionPda: stream.permissionPda ?? null,
        delegatedAt: stream.delegatedAt ?? null,
        lastPaidAt: stream.lastPaidAt,
        totalPaid: stream.totalPaid,
      },
      state,
      syncedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to read exact private payroll state";
    if (isMissingPrivatePayrollStateError(error)) {
      return badRequest(message, 404);
    }

    return badRequest(message, 500);
  }
}
