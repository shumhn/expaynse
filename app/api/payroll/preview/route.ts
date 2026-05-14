import { NextRequest, NextResponse } from "next/server";
import { PublicKey, Connection } from "@solana/web3.js";
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
interface PrivatePayrollStatePreview {
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
  elapsedSeconds: number;
  pendingAccrualMicro: string;
  claimableAmountMicro: string;
  effectiveClaimableAmountMicro: string;
  monthlyCapUsd: number | null;
  monthlyCapMicro: string | null;
  cycleKey: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  paidThisCycleMicro: string | null;
  remainingCapMicro: string | null;
  capReached: boolean;
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
): Omit<
  PrivatePayrollStatePreview,
  | "elapsedSeconds"
  | "pendingAccrualMicro"
  | "claimableAmountMicro"
  | "effectiveClaimableAmountMicro"
  | "monthlyCapUsd"
  | "monthlyCapMicro"
  | "cycleKey"
  | "cycleStart"
  | "cycleEnd"
  | "paidThisCycleMicro"
  | "remainingCapMicro"
  | "capReached"
> {
  if (data.length < 241) {
    throw new Error(`Private payroll state account is too small: ${data.length}`);
  }

  // Binary layout note (matches Rust struct fields/order):
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
    // Fall back to local wall clock if confirmed TEE block time is unavailable.
  }

  return Math.floor(Date.now() / 1000);
}

async function fetchPrivatePayrollPreview(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  streamStatus?: PayrollStreamStatus;
  asOfUnixTimestamp?: number;
  startsAt?: string | null;
}): Promise<PrivatePayrollStatePreview> {
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

  const baseState = decodePrivatePayrollState(
    Buffer.from(accountInfo.data),
    employeePda,
    privatePayrollPda,
  );

  const now =
    typeof args.asOfUnixTimestamp === "number"
      ? args.asOfUnixTimestamp
      : await getConfirmedTeeUnixTimestamp(args.teeAuthToken);
  const startsAtUnix = args.startsAt
    ? Math.floor(new Date(args.startsAt).getTime() / 1000)
    : null;
  const hasFutureStart =
    startsAtUnix !== null && Number.isFinite(startsAtUnix) && now < startsAtUnix;

  const lastAccrual = Number(baseState.lastAccrualTimestamp);
  const shouldAccrue = baseState.status === "active" && !hasFutureStart;
  const elapsedSeconds = shouldAccrue ? Math.max(0, now - lastAccrual) : 0;

  const ratePerSecondMicro = BigInt(baseState.ratePerSecondMicro);
  const accruedUnpaidMicro = BigInt(baseState.accruedUnpaidMicro);
  const pendingAccrualMicro = shouldAccrue
    ? ratePerSecondMicro * BigInt(elapsedSeconds)
    : BigInt(0);
  const claimableAmountMicro = accruedUnpaidMicro + pendingAccrualMicro;

  return {
    ...baseState,
    elapsedSeconds,
    pendingAccrualMicro: pendingAccrualMicro.toString(),
    claimableAmountMicro: claimableAmountMicro.toString(),
    effectiveClaimableAmountMicro: claimableAmountMicro.toString(),
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
        "Authorization Bearer token is required for employer-authenticated PER preview",
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

    const preview = await fetchPrivatePayrollPreview({
      employerWallet,
      streamId,
      teeAuthToken,
      streamStatus: stream.status,
      startsAt: stream.startsAt ?? employee.startDate ?? null,
    });

    const cap = evaluateMonthlyCap({
      stream,
      employee,
      rawClaimableAmountMicro: BigInt(preview.claimableAmountMicro),
      totalPaidPrivateMicro: BigInt(preview.totalPaidPrivateMicro),
    });

    preview.effectiveClaimableAmountMicro = cap.effectiveClaimableAmountMicro;
    preview.monthlyCapUsd = cap.monthlyCapUsd;
    preview.monthlyCapMicro = cap.monthlyCapMicro;
    preview.cycleKey = cap.cycleKey;
    preview.cycleStart = cap.cycleStart;
    preview.cycleEnd = cap.cycleEnd;
    preview.paidThisCycleMicro = cap.paidThisCycleMicro;
    preview.remainingCapMicro = cap.remainingCapMicro;
    preview.capReached = cap.capReached;

    if (hasCapStateChanged(stream.monthlyCapState, cap.nextCapState)) {
      await updateStreamRuntimeState({
        employerWallet,
        streamId,
        monthlyCapState: cap.nextCapState,
      });
    }

    const employeePda = stream.employeePda ?? preview.employeePda;
    const startsAtUnix = stream.startsAt
      ? new Date(stream.startsAt).getTime()
      : employee.startDate
        ? new Date(employee.startDate).getTime()
        : null;
    const hasFutureStart =
      startsAtUnix !== null && Number.isFinite(startsAtUnix) && startsAtUnix > Date.now();
    if (hasFutureStart) {
      preview.effectiveClaimableAmountMicro = "0";
      preview.capReached = false;
    }
    const resolvedStatus =
      hasFutureStart || (cap.capReached && preview.status === "active")
        ? "paused"
        : preview.status;
    preview.status = resolvedStatus;

    if (resolvedStatus !== stream.status) {
      await updateStreamStatus({
        employerWallet,
        streamId,
        status: resolvedStatus,
      });
    }

    return NextResponse.json({
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
        privatePayrollPda:
          stream.privatePayrollPda ?? preview.privatePayrollPda,
        permissionPda: stream.permissionPda ?? null,
        delegatedAt: stream.delegatedAt ?? null,
        lastPaidAt: stream.lastPaidAt,
        totalPaid: stream.totalPaid,
      },
      preview,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to preview private payroll state";

    return badRequest(message, 500);
  }
}
