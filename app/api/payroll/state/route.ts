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
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import {
  evaluateMonthlyCap,
  hasCapStateChanged,
} from "@/lib/server/monthly-cap";
import { deriveObservedCheckpointCrankStatus } from "@/lib/checkpoint-sync";

const TEE_URL = "https://devnet-tee.magicblock.app";

type ExactPrivatePayrollState = {
  employeePda: string;
  privatePayrollPda: string;
  employee: string;
  streamId: string;
  teeObservedAt: string;
  status: PayrollStreamStatus;
  version: string;
  lastCheckpointTs: string;
  ratePerSecondMicro: string;
  lastAccrualTimestamp: string;
  accruedUnpaidMicro: string;
  rawClaimableAmountMicro: string;
  pendingAccrualMicro: string;
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
    checkpointCrankStatus?: "idle" | "pending" | "active" | "failed" | "stopped" | "stale" | null;
    checkpointCrankUpdatedAt?: string | null;
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
    case 0:
      return "paused"; // 0-initialized on base chain means not streaming yet
    case 1:
      return "active";
    case 2:
      return "paused";
    case 3:
      return "stopped";
    default:
      throw new Error(
        "Private payroll state account is not initialized (unexpected status byte)"
      );
  }
}

async function getConfirmedTeeUnixTimestamp(teeAuthToken: string) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );

  try {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);

    if (typeof blockTime === "number" && Number.isFinite(blockTime)) {
      return blockTime;
    }
  } catch {
    // Fall back to local time if confirmed TEE time is unavailable.
  }

  return Math.floor(Date.now() / 1000);
}

function decodePrivatePayrollState(
  data: Buffer,
  employeePda: PublicKey,
  privatePayrollPda: PublicKey,
): ExactPrivatePayrollState {
  // PrivatePayrollState uses AnchorSerialize (not #[account]),
  // so there is NO 8-byte Anchor discriminator.
  // The ephemeral account allocates 8 + LEN bytes, but serialize writes from byte 0.
  //
  // V2 PrivatePayrollState layout:
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
  // offset 241: total_cancelled    (8 bytes, u64 LE)
  // offset 249: next_claim_id      (8 bytes, u64 LE)
  // offset 257: pending_claim_id   (8 bytes, u64 LE)
  // offset 265: pending_amount     (8 bytes, u64 LE)
  // offset 273: pending_client_ref (32 bytes)
  // offset 305: pending_req_at     (8 bytes, i64 LE)
  // offset 313: pending_status     (1 byte)
  // offset 314: bump               (1 byte)
  // TOTAL: 315 bytes

  const MIN_LEN = 241; // enough to read through total_paid_private
  if (data.length < MIN_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  const employee = new PublicKey(data.subarray(0, 32));
  const streamIdBytes = data.subarray(64, 96);
  const streamId = streamIdBytes.toString("hex");
  
  const statusByte = data.readUInt8(192);
  const status = mapEmployeeStatusToStreamStatus(statusByte);
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
    teeObservedAt: "0",
    status,
    version: String(version),
    lastCheckpointTs: String(lastCheckpointTs),
    ratePerSecondMicro: String(ratePerSecondMicro),
    lastAccrualTimestamp: String(lastAccrualTimestamp),
    accruedUnpaidMicro: String(accruedUnpaidMicro),
    rawClaimableAmountMicro: String(accruedUnpaidMicro),
    pendingAccrualMicro: "0",
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
    const teeObservedAt = await getConfirmedTeeUnixTimestamp(teeAuthToken);

    const startsAtUnix = stream.startsAt
      ? Math.floor(new Date(stream.startsAt).getTime() / 1000)
      : employee.startDate
        ? Math.floor(new Date(employee.startDate).getTime() / 1000)
        : null;
    const hasFutureStart =
      startsAtUnix !== null &&
      Number.isFinite(startsAtUnix) &&
      startsAtUnix > teeObservedAt;
    const shouldAccrue = state.status === "active" && !hasFutureStart;
    const lastAccrualTimestamp = Number(state.lastAccrualTimestamp);
    const elapsedSeconds =
      shouldAccrue && Number.isFinite(lastAccrualTimestamp)
        ? Math.max(0, teeObservedAt - lastAccrualTimestamp)
        : 0;
    const pendingAccrualMicro =
      shouldAccrue
        ? BigInt(state.ratePerSecondMicro) * BigInt(elapsedSeconds)
        : BigInt(0);
    const rawClaimableAmountMicro =
      BigInt(state.accruedUnpaidMicro) + pendingAccrualMicro;

    const cap = evaluateMonthlyCap({
      stream,
      employee,
      rawClaimableAmountMicro,
      totalPaidPrivateMicro: BigInt(state.totalPaidPrivateMicro),
    });

    state.teeObservedAt = String(teeObservedAt);
    state.rawClaimableAmountMicro = rawClaimableAmountMicro.toString();
    state.pendingAccrualMicro = pendingAccrualMicro.toString();
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

    const observedCheckpointCrankStatus = deriveObservedCheckpointCrankStatus({
      currentStatus: stream.checkpointCrankStatus,
      lastAccrualTimestamp: state.lastAccrualTimestamp,
    });

    if (observedCheckpointCrankStatus !== stream.checkpointCrankStatus) {
      await updateStreamRuntimeState({
        employerWallet,
        streamId,
        checkpointCrankStatus: observedCheckpointCrankStatus,
        checkpointCrankUpdatedAt: new Date().toISOString(),
      });
      stream.checkpointCrankStatus = observedCheckpointCrankStatus;
      stream.checkpointCrankUpdatedAt = new Date().toISOString();
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
        checkpointCrankStatus: stream.checkpointCrankStatus ?? null,
        checkpointCrankUpdatedAt: stream.checkpointCrankUpdatedAt ?? null,
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
