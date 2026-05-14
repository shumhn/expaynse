import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { type PrivateTransferPrivacyConfig } from "@/lib/magicblock-api";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import { getEmployeePdaForStream, getPrivatePayrollPda } from "@/lib/server/payroll-pdas";
import {
  findUnsettledTransfer,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import { savePayrollRun } from "@/lib/server/history-store";

import type { ExactPrivatePayrollState } from "./tick-types";

export const MAGIC_VAULT = new PublicKey(
  "MagicVau1t999999999999999999999999999999999",
);

export const TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL ||
  "https://devnet-tee.magicblock.app";

export const PAYROLL_TRANSFER_PRIVACY: PrivateTransferPrivacyConfig = {
  minDelayMs: 600_000,
  maxDelayMs: 600_000,
  split: 3,
};

export function hasAppliedEmployerSettlement(args: {
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

export function computeLiveClaimableAmountMicro(args: {
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

export function badRequest(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

export function microToUsdc(amountMicro: number) {
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
  const minLen = 241;
  if (data.length < minLen) {
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

export async function fetchExactPrivatePayrollState(args: {
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

export async function getTeeProgramForEmployer(
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

export async function serializeUnsignedTransaction(
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

export async function savePayrollRunHistory(input: {
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
