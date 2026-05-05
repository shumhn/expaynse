import { Connection, PublicKey } from "@solana/web3.js";

import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";

export const TEE_URL = "https://devnet-tee.magicblock.app";
export const PRIVATE_PAYROLL_STATE_PREVIEW_MIN_LEN = 241;
export const PRIVATE_PAYROLL_STATE_FULL_LEN = 315;
export const PRIVATE_PAYROLL_STATUS_ACTIVE = 1;
export const PRIVATE_PENDING_STATUS_NONE = 0;
export const PRIVATE_PENDING_STATUS_REQUESTED = 1;

export type DecodedPrivatePayrollState = {
  employee: string;
  employeeWallet: string;
  streamIdHex: string;
  mint: string;
  payrollTreasury: string;
  settlementAuthority: string;
  statusByte: number;
  version: bigint;
  lastCheckpointTs: bigint;
  ratePerSecondMicro: bigint;
  lastAccrualTimestamp: bigint;
  accruedUnpaidMicro: bigint;
  totalPaidPrivateMicro: bigint;
  totalCancelledMicro: bigint;
  nextClaimId: bigint;
  pendingClaimId: bigint;
  pendingAmountMicro: bigint;
  pendingClientRefHashHex: string;
  pendingRequestedAt: bigint;
  pendingStatus: number;
  bump: number;
};

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readI64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigInt64LE(offset);
}

export function decodePrivatePayrollState(data: Buffer) {
  if (data.length < PRIVATE_PAYROLL_STATE_FULL_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  return {
    employee: new PublicKey(data.subarray(0, 32)).toBase58(),
    employeeWallet: new PublicKey(data.subarray(32, 64)).toBase58(),
    streamIdHex: data.subarray(64, 96).toString("hex"),
    mint: new PublicKey(data.subarray(96, 128)).toBase58(),
    payrollTreasury: new PublicKey(data.subarray(128, 160)).toBase58(),
    settlementAuthority: new PublicKey(data.subarray(160, 192)).toBase58(),
    statusByte: data.readUInt8(192),
    version: readU64LE(data, 193),
    lastCheckpointTs: readI64LE(data, 201),
    ratePerSecondMicro: readU64LE(data, 209),
    lastAccrualTimestamp: readI64LE(data, 217),
    accruedUnpaidMicro: readU64LE(data, 225),
    totalPaidPrivateMicro: readU64LE(data, 233),
    totalCancelledMicro: readU64LE(data, 241),
    nextClaimId: readU64LE(data, 249),
    pendingClaimId: readU64LE(data, 257),
    pendingAmountMicro: readU64LE(data, 265),
    pendingClientRefHashHex: data.subarray(273, 305).toString("hex"),
    pendingRequestedAt: readI64LE(data, 305),
    pendingStatus: data.readUInt8(313),
    bump: data.readUInt8(314),
  } satisfies DecodedPrivatePayrollState;
}

export async function getConfirmedUnixTimestamp(connection: Connection) {
  try {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);

    if (typeof blockTime === "number" && Number.isFinite(blockTime)) {
      return blockTime;
    }
  } catch {
    // Fall back to local wall clock if confirmed TEE time is unavailable.
  }

  return Math.floor(Date.now() / 1000);
}

export async function fetchPrivatePayrollState(args: {
  employerWallet: string;
  streamId: string;
  teeAuthToken: string;
}) {
  const employeePda = getEmployeePdaForStream(args.employerWallet, args.streamId);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(args.teeAuthToken)}`,
    "confirmed",
  );
  const accountInfo = await connection.getAccountInfo(privatePayrollPda, "confirmed");

  if (!accountInfo?.data) {
    throw new Error("Private payroll state not found in PER");
  }

  return {
    connection,
    employeePda,
    privatePayrollPda,
    accountInfo,
    state: decodePrivatePayrollState(Buffer.from(accountInfo.data)),
  };
}

export function computeRawClaimableAmountMicro(args: {
  state: DecodedPrivatePayrollState;
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
  const shouldAccrue =
    args.state.statusByte === PRIVATE_PAYROLL_STATUS_ACTIVE && !hasFutureStart;
  const lastAccrual = Number(args.state.lastAccrualTimestamp);
  const elapsedSeconds = shouldAccrue ? Math.max(0, args.nowUnix - lastAccrual) : 0;
  const pendingAccrualMicro = shouldAccrue
    ? args.state.ratePerSecondMicro * BigInt(elapsedSeconds)
    : BigInt(0);
  const claimableAmountMicro =
    args.state.accruedUnpaidMicro + pendingAccrualMicro;

  return {
    hasFutureStart,
    elapsedSeconds,
    pendingAccrualMicro,
    claimableAmountMicro,
  };
}
