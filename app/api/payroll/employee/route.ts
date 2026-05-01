import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  listEmployeesByWallet,
  listStreams,
  updateStreamRuntimeState,
  updateStreamStatus,
  type EmployeeRecord,
  type PayrollPayoutMode,
  type PayrollStreamRecord,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import {
  evaluateMonthlyCap,
  hasCapStateChanged,
} from "@/lib/server/monthly-cap";

const TEE_URL = "https://devnet-tee.magicblock.app";
const PRIVATE_PAYROLL_STATE_LEN = 114;

type PrivatePayrollPreview = {
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
};

type EmployeePayrollStreamSummary = {
  employerWallet: string;
  employee: {
    id: string;
    wallet: string;
    name: string;
    privateRecipientInitializedAt: string | null;
  };
  stream: {
    id: string;
    status: PayrollStreamStatus;
    ratePerSecond: number;
    payoutMode: PayrollPayoutMode;
    allowedPayoutModes: PayrollPayoutMode[];
    employeePda: string | null;
    privatePayrollPda: string | null;
    permissionPda: string | null;
    delegatedAt: string | null;
    recipientPrivateInitializedAt: string | null;
    lastPaidAt: string | null;
    totalPaid: number;
    checkpointCrankStatus:
      | "idle"
      | "pending"
      | "active"
      | "failed"
      | "stopped"
      | null;
    checkpointCrankUpdatedAt: string | null;
    updatedAt: string;
  };
  liveState: {
    ready: boolean;
    source: "per-preview" | "stream-metadata";
    reason:
      | "preview-available"
      | "tee-token-missing"
      | "stream-not-delegated"
      | "private-account-not-initialized"
      | "private-state-missing"
      | "preview-unavailable";
  };
  preview: PrivatePayrollPreview | null;
};

type EmployeePayrollSummaryResponse = {
  employeeWallet: string;
  employees: Array<{
    id: string;
    employerWallet: string;
    name: string;
    privateRecipientInitializedAt: string | null;
  }>;
  streams: EmployeePayrollStreamSummary[];
  syncedAt: string;
};

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

function isMissingPrivateStateError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes("private payroll state not found") ||
    message.includes("private payroll state account is not initialized") ||
    message.includes("private state expired")
  );
}

function decodePrivatePayrollState(
  data: Buffer,
  employeePda: PublicKey,
  privatePayrollPda: PublicKey,
): Omit<
  PrivatePayrollPreview,
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

async function fetchPrivatePayrollPreview(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
  streamStatus: PayrollStreamStatus;
  startsAt?: string | null;
}): Promise<PrivatePayrollPreview> {
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

  const now = await getConfirmedTeeUnixTimestamp(args.teeAuthToken);
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

function statusRank(status: PayrollStreamStatus) {
  switch (status) {
    case "active":
      return 0;
    case "paused":
      return 1;
    case "stopped":
      return 2;
  }
}

async function buildStreamSummary(args: {
  employeeWallet: string;
  employee: EmployeeRecord;
  stream: PayrollStreamRecord;
  teeAuthToken: string | null;
}): Promise<EmployeePayrollStreamSummary> {
  const { employee, stream, teeAuthToken } = args;
  let resolvedStatus = stream.status;

  let preview: PrivatePayrollPreview | null = null;
  let liveState: EmployeePayrollStreamSummary["liveState"];

  if (
    !stream.delegatedAt ||
    (!stream.privatePayrollPda && !stream.employeePda)
  ) {
    liveState = {
      ready: false,
      source: "stream-metadata",
      reason: "stream-not-delegated",
    };
  } else if (!teeAuthToken) {
    liveState = {
      ready: false,
      source: "stream-metadata",
      reason: "tee-token-missing",
    };
  } else {
    try {
      preview = await fetchPrivatePayrollPreview({
        employerWallet: employee.employerWallet,
        streamId: stream.id,
        teeAuthToken,
        streamStatus: resolvedStatus,
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
          employerWallet: employee.employerWallet,
          streamId: stream.id,
          monthlyCapState: cap.nextCapState,
        });
      }

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
      resolvedStatus =
        hasFutureStart || (cap.capReached && preview.status === "active")
          ? "paused"
          : preview.status;
      preview.status = resolvedStatus;

      if (resolvedStatus !== stream.status) {
        await updateStreamStatus({
          employerWallet: employee.employerWallet,
          streamId: stream.id,
          status: resolvedStatus,
        });
      }

      liveState = {
        ready: true,
        source: "per-preview",
        reason: "preview-available",
      };
    } catch (error: unknown) {
      const missingPrivateState = isMissingPrivateStateError(error);
      preview = null;
      if (missingPrivateState) {
        resolvedStatus = "stopped";
        if (resolvedStatus !== stream.status) {
          await updateStreamStatus({
            employerWallet: employee.employerWallet,
            streamId: stream.id,
            status: resolvedStatus,
          });
        }
      }
      liveState = {
        ready: false,
        source: "stream-metadata",
        reason: missingPrivateState
          ? "private-state-missing"
          : "preview-unavailable",
      };
    }
  }

  return {
    employerWallet: employee.employerWallet,
    employee: {
      id: employee.id,
      wallet: employee.wallet,
      name: employee.name,
      privateRecipientInitializedAt:
        employee.privateRecipientInitializedAt ?? null,
    },
    stream: {
      id: stream.id,
      status: resolvedStatus,
      ratePerSecond: stream.ratePerSecond,
      payoutMode: stream.payoutMode === "ephemeral" ? "ephemeral" : "base",
      allowedPayoutModes:
        Array.isArray(stream.allowedPayoutModes) &&
        stream.allowedPayoutModes.length > 0
          ? stream.allowedPayoutModes.filter(
              (mode): mode is PayrollPayoutMode =>
                mode === "base" || mode === "ephemeral",
            )
          : [stream.payoutMode === "ephemeral" ? "ephemeral" : "base"],
      employeePda: stream.employeePda ?? preview?.employeePda ?? null,
      privatePayrollPda:
        stream.privatePayrollPda ?? preview?.privatePayrollPda ?? null,
      permissionPda: stream.permissionPda ?? null,
      delegatedAt: stream.delegatedAt ?? null,
      recipientPrivateInitializedAt: stream.recipientPrivateInitializedAt ?? null,
      lastPaidAt: stream.lastPaidAt ?? null,
      totalPaid: stream.totalPaid,
      checkpointCrankStatus: stream.checkpointCrankStatus ?? null,
      checkpointCrankUpdatedAt: stream.checkpointCrankUpdatedAt ?? null,
      updatedAt: stream.updatedAt,
    },
    liveState,
    preview,
  };
}

export async function GET(request: NextRequest) {
  try {
    const employeeWallet = assertWallet(
      request.nextUrl.searchParams.get("employeeWallet") ?? "",
      "Employee wallet",
    );

    const authHeader = request.headers.get("authorization")?.trim();
    const teeAuthToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    const employees = await listEmployeesByWallet(employeeWallet);
    if (employees.length === 0) {
      const empty: EmployeePayrollSummaryResponse = {
        employeeWallet,
        employees: [],
        streams: [],
        syncedAt: new Date().toISOString(),
      };

      return NextResponse.json(empty);
    }

    const streamGroups = await Promise.all(
      employees.map(async (employee) => {
        const employerStreams = await listStreams(employee.employerWallet);
        const matchingStreams = employerStreams.filter(
          (stream) => stream.employeeId === employee.id,
        );

        return Promise.all(
          matchingStreams.map((stream) =>
            buildStreamSummary({
              employeeWallet,
              employee,
              stream,
              teeAuthToken,
            }),
          ),
        );
      }),
    );

    const streams = streamGroups.flat().sort((left, right) => {
      const statusCompare =
        statusRank(left.stream.status) - statusRank(right.stream.status);
      if (statusCompare !== 0) {
        return statusCompare;
      }

      return (
        new Date(right.stream.updatedAt).getTime() -
        new Date(left.stream.updatedAt).getTime()
      );
    });

    const response: EmployeePayrollSummaryResponse = {
      employeeWallet,
      employees: employees.map((employee) => ({
        id: employee.id,
        employerWallet: employee.employerWallet,
        name: employee.name,
        privateRecipientInitializedAt:
          employee.privateRecipientInitializedAt ?? null,
      })),
      streams,
      syncedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load employee payroll summary";

    return badRequest(message, 500);
  }
}
