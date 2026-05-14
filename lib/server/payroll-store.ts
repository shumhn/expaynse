import { randomUUID } from "crypto";
import { MongoClient, Db, Collection } from "mongodb";
import type { CheckpointCrankStatus } from "@/lib/checkpoint-sync";
import { normalizePayrollMode, type PayrollMode } from "@/lib/payroll-mode";

export type PayrollStreamStatus = "active" | "paused" | "stopped";
export type PayrollPayoutMode = "base" | "ephemeral";
export type PrivateRecipientInitStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "failed";

export interface EmployerRecord {
  id: string;
  wallet: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeRecord {
  id: string;
  employerWallet: string;
  wallet: string;
  name: string;
  payrollMode?: PayrollMode;
  notes?: string;
  department?: string;
  role?: string;
  employmentType?: "full_time" | "part_time" | "contract";
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  compensationUnit?: "monthly" | "weekly" | "hourly";
  compensationAmountUsd?: number;
  weeklyHours?: number;
  monthlySalaryUsd?: number;
  startDate?: string | null;
  privateRecipientInitializedAt?: string | null;
  privateRecipientInitStatus?: PrivateRecipientInitStatus;
  privateRecipientInitRequestedAt?: string | null;
  privateRecipientInitLastAttemptAt?: string | null;
  privateRecipientInitConfirmedAt?: string | null;
  privateRecipientInitTxSignature?: string | null;
  privateRecipientInitError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollStreamRecord {
  id: string;
  employerWallet: string;
  employeeId: string;
  ratePerSecond: number;
  startsAt?: string | null;
  payoutMode?: PayrollPayoutMode;
  allowedPayoutModes?: PayrollPayoutMode[];
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  delegatedAt?: string | null;
  recipientPrivateInitializedAt?: string | null;
  checkpointCrankTaskId?: string | null;
  checkpointCrankSignature?: string | null;
  checkpointCrankStatus?: CheckpointCrankStatus;
  checkpointCrankUpdatedAt?: string | null;
  lastPaidAt: string | null;
  totalPaid: number;
  status: PayrollStreamStatus;
  monthlyCapState?: {
    cycleKey: string;
    cycleStart: string;
    cycleEnd: string;
    openingTotalPaidPrivateMicro: string;
    monthlyCapUsd: number;
    cappedAt?: string | null;
  };
  compensationSnapshot?: {
    employmentType?: "full_time" | "part_time" | "contract";
    paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
    compensationUnit?: "monthly" | "weekly" | "hourly";
    compensationAmountUsd?: number;
    weeklyHours?: number;
    monthlySalaryUsd?: number;
    startsAt?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export type TransferStatus = 
  | "transfer_pending"    // DB record created, API not confirmed yet
  | "transfer_sent"       // money tx sent, payroll state not settled yet
  | "settlement_pending"  // waiting for settleSalary/mark_paid
  | "success"             // money + payroll state both complete
  | "failed"              // transfer failed before money moved
  | "recovery_required";  // manual sync needed

export interface PayrollTransferRecord {
  id: string;
  employerWallet: string;
  employeeId: string;
  streamId: string;
  amount: number;
  recipientAddress?: string;
  txSignature?: string;
  status: TransferStatus;
  errorMessage?: string;
  privacyConfig?: {
    visibility?: "private";
    fromBalance?: "base" | "ephemeral";
    toBalance?: "base" | "ephemeral";
    memo?: string;
  };
  providerMeta?: {
    provider?: "magicblock";
    sendTo?: string;
    clientRefId?: string;
    settleAmountMicro?: string;
    privatePayrollVersionBefore?: string;
    accruedUnpaidBeforeMicro?: string;
    totalPaidPrivateBeforeMicro?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type OnChainClaimStatus = 
  | "requested"
  | "paying"
  | "paid"
  | "failed"
  | "needs_sync"
  | "cancelled";

export interface OnChainClaimRecord {
  id: string; // The database ID (could just be a UUID)
  streamId: string;
  payrollPda: string;
  employeeWallet: string;
  claimId: number; // u64 claim_id emitted by the Rust program
  amountMicro: number;
  requestTxSignature: string;
  paymentTxSignature?: string | null;
  markPaidTxSignature?: string | null;
  status: OnChainClaimStatus;
  createdAt: string;
  updatedAt: string;
}

export type CashoutRequestStatus =
  | "pending"
  | "fulfilled"
  | "dismissed"
  | "cancelled";

export interface CashoutRequestRecord {
  id: string;
  employerWallet: string;
  employeeId: string;
  employeeWallet: string;
  streamId: string;
  requestedAmount: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  note?: string;
  status: CashoutRequestStatus;
  resolvedAt?: string | null;
  resolvedByWallet?: string | null;
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditorTokenRecord {
  id: string;
  token: string;
  employerWallet: string;
  label?: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollStoreData {
  employers: EmployerRecord[];
  employees: EmployeeRecord[];
  streams: PayrollStreamRecord[];
  transfers: PayrollTransferRecord[];
  cashoutRequests: CashoutRequestRecord[];
  onChainClaims: OnChainClaimRecord[];
  auditorTokens: AuditorTokenRecord[];
}

export interface CreateEmployeeInput {
  employerWallet: string;
  wallet: string;
  name: string;
  payrollMode?: PayrollMode;
  notes?: string;
  department?: string;
  role?: string;
  employmentType?: "full_time" | "part_time" | "contract";
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  compensationUnit?: "monthly" | "weekly" | "hourly";
  compensationAmountUsd?: number;
  weeklyHours?: number;
  monthlySalaryUsd?: number;
  startDate?: string | null;
}

export interface UpdateEmployeePrivateRecipientInitStateInput {
  employeeWallet: string;
  status: PrivateRecipientInitStatus;
  timestamp?: string;
  txSignature?: string | null;
  error?: string | null;
}

export interface CreateStreamInput {
  employerWallet: string;
  employeeId: string;
  ratePerSecond: number;
  startsAt?: string | null;
  payoutMode?: PayrollPayoutMode;
  allowedPayoutModes?: PayrollPayoutMode[];
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  delegatedAt?: string | null;
  recipientPrivateInitializedAt?: string | null;
  status?: PayrollStreamStatus;
  compensationSnapshot?: {
    employmentType?: "full_time" | "part_time" | "contract";
    paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
    compensationUnit?: "monthly" | "weekly" | "hourly";
    compensationAmountUsd?: number;
    weeklyHours?: number;
    monthlySalaryUsd?: number;
    startsAt?: string | null;
  };
}

export interface UpdateStreamStatusInput {
  employerWallet: string;
  streamId: string;
  status: PayrollStreamStatus;
}

export interface UpdateStreamConfigInput {
  employerWallet: string;
  streamId: string;
  ratePerSecond?: number;
  payoutMode?: PayrollPayoutMode;
  allowedPayoutModes?: PayrollPayoutMode[];
  status?: PayrollStreamStatus;
}

type EmployerDoc = EmployerRecord;
type EmployeeDoc = EmployeeRecord;
type StreamDoc = PayrollStreamRecord;
type TransferDoc = PayrollTransferRecord;
type CashoutRequestDoc = CashoutRequestRecord;
type AuditorTokenDoc = AuditorTokenRecord;

export interface UpdateStreamRuntimeStateInput {
  employerWallet: string;
  streamId: string;
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  delegatedAt?: string | null;
  recipientPrivateInitializedAt?: string | null;
  checkpointCrankTaskId?: string | null;
  checkpointCrankSignature?: string | null;
  checkpointCrankStatus?: CheckpointCrankStatus;
  checkpointCrankUpdatedAt?: string | null;
  lastPaidAt?: string | null;
  totalPaid?: number;
  monthlyCapState?: PayrollStreamRecord["monthlyCapState"];
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "expaynse";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI environment variable");
}

declare global {
  var __expaynseMongoClientPromise: Promise<MongoClient> | undefined;
}

const clientPromise =
  global.__expaynseMongoClientPromise ?? new MongoClient(MONGODB_URI).connect();

if (process.env.NODE_ENV !== "production") {
  global.__expaynseMongoClientPromise = clientPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWallet(wallet: string) {
  return wallet.trim();
}

function normalizePayoutMode(
  payoutMode: PayrollPayoutMode | undefined,
): PayrollPayoutMode {
  return payoutMode === "ephemeral" ? "ephemeral" : "base";
}

export function normalizeAllowedPayoutModes(
  allowedPayoutModes: PayrollPayoutMode[] | undefined,
  fallbackPayoutMode?: PayrollPayoutMode,
): PayrollPayoutMode[] {
  const normalized = Array.isArray(allowedPayoutModes)
    ? (["base", "ephemeral"] as const).filter((mode) =>
        allowedPayoutModes.includes(mode),
      )
    : [];

  if (normalized.length > 0) {
    return normalized;
  }

  return [normalizePayoutMode(fallbackPayoutMode)];
}

export function resolveStreamPayoutMode(stream: {
  payoutMode?: PayrollPayoutMode;
  allowedPayoutModes?: PayrollPayoutMode[];
}) {
  const fallbackPayoutMode = normalizePayoutMode(stream.payoutMode);
  const allowedPayoutModes = normalizeAllowedPayoutModes(
    stream.allowedPayoutModes,
    fallbackPayoutMode,
  );

  return allowedPayoutModes.includes(fallbackPayoutMode)
    ? fallbackPayoutMode
    : allowedPayoutModes[0] ?? fallbackPayoutMode;
}

function assertWallet(wallet: string, fieldName: string) {
  const value = normalizeWallet(wallet);
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function assertPositiveNumber(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return value;
}

function assertNonNegativeNumber(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
  return value;
}

async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db(MONGODB_DB);
}

async function employersCollection(): Promise<Collection<EmployerDoc>> {
  return (await getDb()).collection<EmployerDoc>("employers");
}

async function employeesCollection(): Promise<Collection<EmployeeDoc>> {
  return (await getDb()).collection<EmployeeDoc>("employees");
}

async function streamsCollection(): Promise<Collection<StreamDoc>> {
  return (await getDb()).collection<StreamDoc>("streams");
}

async function transfersCollection(): Promise<Collection<TransferDoc>> {
  return (await getDb()).collection<TransferDoc>("transfers");
}

async function cashoutRequestsCollection(): Promise<
  Collection<CashoutRequestDoc>
> {
  return (await getDb()).collection<CashoutRequestDoc>("cashout_requests");
}

type OnChainClaimDoc = Omit<OnChainClaimRecord, "id"> & { _id: string };

async function onChainClaimsCollection(): Promise<
  Collection<OnChainClaimDoc>
> {
  return (await getDb()).collection<OnChainClaimDoc>("on_chain_claims");
}

async function auditorTokensCollection(): Promise<Collection<AuditorTokenDoc>> {
  return (await getDb()).collection<AuditorTokenDoc>("auditor_tokens");
}

async function touchEmployer(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const timestamp = nowIso();
  const collection = await employersCollection();

  const existing = await collection.findOne({ wallet });
  if (existing) {
    await collection.updateOne(
      { wallet },
      {
        $set: {
          updatedAt: timestamp,
        },
      },
    );
    return { ...existing, updatedAt: timestamp };
  }

  const created: EmployerDoc = {
    id: randomUUID(),
    wallet,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne(created);
  return created;
}

export async function getPayrollStore(): Promise<PayrollStoreData> {
  const [employers, employees, streams, transfers, cashoutRequests, auditorTokens, onChainClaims] =
    await Promise.all([
      (await employersCollection()).find({}).sort({ createdAt: 1 }).toArray(),
      (await employeesCollection()).find({}).sort({ createdAt: 1 }).toArray(),
      (await streamsCollection()).find({}).sort({ createdAt: 1 }).toArray(),
      (await transfersCollection()).find({}).sort({ createdAt: 1 }).toArray(),
      (await cashoutRequestsCollection())
        .find({})
        .sort({ createdAt: 1 })
        .toArray(),
      (await auditorTokensCollection())
        .find({})
        .sort({ createdAt: 1 })
        .toArray(),
      (await onChainClaimsCollection())
        .find({})
        .sort({ createdAt: 1 })
        .toArray(),
    ]);

  return {
    employers: employers.map(({ ...doc }) => doc),
    employees: employees.map(({ ...doc }) => doc),
    streams: streams.map(({ ...doc }) => doc),
    transfers: transfers.map(({ ...doc }) => doc),
    cashoutRequests: cashoutRequests.map(({ ...doc }) => doc),
    auditorTokens: auditorTokens.map(({ ...doc }) => doc),
    onChainClaims: onChainClaims.map(({ _id, ...doc }) => ({
      ...doc,
      id: _id as unknown as string,
    })),
  };
}

export async function listEmployees(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await employeesCollection();

  return collection
    .find({ employerWallet: wallet })
    .sort({ createdAt: 1 })
    .toArray();
}

export async function listEmployeesByWallet(employeeWallet: string) {
  const wallet = assertWallet(employeeWallet, "Employee wallet");
  const collection = await employeesCollection();

  return collection.find({ wallet }).sort({ createdAt: 1 }).toArray();
}

export async function createEmployee(input: CreateEmployeeInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const employeeWallet = assertWallet(input.wallet, "Employee wallet");
  const name = input.name.trim();

  if (!name) {
    throw new Error("Employee name is required");
  }

  const monthlySalaryUsd =
    input.monthlySalaryUsd === undefined
      ? undefined
      : assertPositiveNumber(input.monthlySalaryUsd, "Monthly salary");
  const compensationAmountUsd =
    input.compensationAmountUsd === undefined
      ? monthlySalaryUsd
      : assertPositiveNumber(input.compensationAmountUsd, "Compensation amount");
  const weeklyHours =
    input.compensationUnit === "hourly"
      ? assertPositiveNumber(input.weeklyHours ?? 40, "Weekly hours")
      : undefined;
  const startDate = input.startDate?.trim()
    ? new Date(input.startDate).toISOString()
    : null;
  const department = input.department?.trim() || undefined;
  const role = input.role?.trim() || undefined;

  await touchEmployer(employerWallet);

  const collection = await employeesCollection();
  const duplicate = await collection.findOne({
    employerWallet,
    wallet: employeeWallet,
  });

  if (duplicate) {
    throw new Error("Employee already exists for this employer");
  }

  const timestamp = nowIso();
  const employee: EmployeeDoc = {
    id: randomUUID(),
    employerWallet,
    wallet: employeeWallet,
    name,
    payrollMode: normalizePayrollMode(input.payrollMode),
    notes: input.notes?.trim() || undefined,
    department,
    role,
    employmentType:
      input.employmentType === "contract"
        ? "contract"
        : input.employmentType === "part_time"
          ? "part_time"
          : "full_time",
    paySchedule:
      input.paySchedule === "semi_monthly" ||
      input.paySchedule === "biweekly" ||
      input.paySchedule === "weekly"
        ? input.paySchedule
        : "monthly",
    compensationUnit:
      input.compensationUnit === "weekly" || input.compensationUnit === "hourly"
        ? input.compensationUnit
        : "monthly",
    compensationAmountUsd,
    weeklyHours,
    monthlySalaryUsd,
    startDate,
    privateRecipientInitializedAt: null,
    privateRecipientInitStatus: "pending",
    privateRecipientInitRequestedAt: timestamp,
    privateRecipientInitLastAttemptAt: null,
    privateRecipientInitConfirmedAt: null,
    privateRecipientInitTxSignature: null,
    privateRecipientInitError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne(employee);
  return employee;
}

export async function getEmployeeById(
  employerWallet: string,
  employeeId: string,
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await employeesCollection();

  return collection.findOne({
    employerWallet: wallet,
    id: employeeId,
  });
}

export async function updateEmployee(
  employerWallet: string,
  employeeId: string,
  updates: Partial<EmployeeRecord>
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await employeesCollection();

  const timestamp = nowIso();
  
  const { id, employerWallet: _ew, wallet: _w, createdAt, updatedAt, ...allowedUpdates } = updates;

  const result = await collection.findOneAndUpdate(
    { employerWallet: wallet, id: employeeId },
    {
      $set: {
        ...allowedUpdates,
        updatedAt: timestamp,
      },
    },
    { returnDocument: "after" }
  );

  if (!result) {
    throw new Error("Employee not found");
  }

  return result;
}

export async function deleteEmployeeById(
  employerWallet: string,
  employeeId: string,
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const employeeCollection = await employeesCollection();
  const streamCollection = await streamsCollection();

  const employee = await employeeCollection.findOne({
    employerWallet: wallet,
    id: employeeId,
  });

  if (!employee) {
    return {
      employeeDeleted: false,
      streamsDeleted: 0,
    };
  }

  const [, streamDeleteResult] = await Promise.all([
    employeeCollection.deleteOne({
      employerWallet: wallet,
      id: employeeId,
    }),
    streamCollection.deleteMany({
      employerWallet: wallet,
      employeeId,
    }),
  ]);

  return {
    employeeDeleted: true,
    streamsDeleted: streamDeleteResult.deletedCount ?? 0,
  };
}

export async function getStreamById(employerWallet: string, streamId: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await streamsCollection();

  return collection.findOne({
    employerWallet: wallet,
    id: streamId,
  });
}

export async function getStreamByStreamId(streamId: string) {
  const collection = await streamsCollection();
  return collection.findOne({ id: streamId });
}

export async function listActiveStreams(employerWallet?: string) {
  const collection = await streamsCollection();

  if (employerWallet) {
    const wallet = assertWallet(employerWallet, "Employer wallet");
    return collection
      .find({
        employerWallet: wallet,
        status: "active",
      })
      .sort({ updatedAt: 1 })
      .toArray();
  }

  return collection
    .find({
      status: "active",
    })
    .sort({ updatedAt: 1 })
    .toArray();
}

export async function listStreams(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await streamsCollection();

  return collection
    .find({ employerWallet: wallet })
    .sort({ createdAt: 1 })
    .toArray();
}

export async function createStream(input: CreateStreamInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const ratePerSecond = assertPositiveNumber(
    input.ratePerSecond,
    "Rate per second",
  );
  const startsAt = input.startsAt?.trim()
    ? new Date(input.startsAt).toISOString()
    : null;

  await touchEmployer(employerWallet);

  const employee = await getEmployeeById(employerWallet, input.employeeId);
  if (!employee) {
    throw new Error("Employee not found for this employer");
  }

  const collection = await streamsCollection();
  const duplicate = await collection.findOne({
    employerWallet,
    employeeId: input.employeeId,
    status: { $ne: "stopped" },
  });

  if (duplicate) {
    throw new Error(
      "An active or paused stream already exists for this employee",
    );
  }

  const resolvedRecipientPrivateInitializedAt =
    input.recipientPrivateInitializedAt ??
    employee.privateRecipientInitializedAt ??
    (await resolveEmployeePrivateRecipientInitializedAt(
      employerWallet,
      input.employeeId,
    )) ??
    null;
  const allowedPayoutModes = normalizeAllowedPayoutModes(
    input.allowedPayoutModes,
    input.payoutMode,
  );
  const payoutMode = resolveStreamPayoutMode({
    payoutMode: input.payoutMode,
    allowedPayoutModes,
  });

  const timestamp = nowIso();
  const normalizedStartsAt = startsAt ?? timestamp;
  const stream: StreamDoc = {
    id: randomUUID(),
    employerWallet,
    employeeId: input.employeeId,
    ratePerSecond,
    startsAt: normalizedStartsAt,
    payoutMode,
    allowedPayoutModes,
    employeePda: input.employeePda,
    privatePayrollPda: input.privatePayrollPda,
    permissionPda: input.permissionPda,
    delegatedAt: input.delegatedAt ?? null,
    recipientPrivateInitializedAt: resolvedRecipientPrivateInitializedAt,
    checkpointCrankTaskId: null,
    checkpointCrankSignature: null,
    checkpointCrankStatus: "idle",
    checkpointCrankUpdatedAt: null,
    lastPaidAt: input.status === "active" ? normalizedStartsAt : null,
    totalPaid: 0,
    status: input.status ?? "active",
    compensationSnapshot: input.compensationSnapshot
      ? {
          employmentType: input.compensationSnapshot.employmentType,
          paySchedule: input.compensationSnapshot.paySchedule,
          compensationUnit: input.compensationSnapshot.compensationUnit,
          compensationAmountUsd: input.compensationSnapshot.compensationAmountUsd,
          weeklyHours: input.compensationSnapshot.weeklyHours,
          monthlySalaryUsd: input.compensationSnapshot.monthlySalaryUsd,
          startsAt: input.compensationSnapshot.startsAt ?? normalizedStartsAt,
        }
      : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne(stream);
  return stream;
}

export async function resolveEmployeePrivateRecipientInitializedAt(
  employerWallet: string,
  employeeId: string,
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const employee = await getEmployeeById(wallet, employeeId);

  if (!employee) {
    throw new Error("Employee not found for this employer");
  }

  if (employee.privateRecipientInitializedAt) {
    return employee.privateRecipientInitializedAt;
  }

  const siblingEmployees = await listEmployeesByWallet(employee.wallet);
  const siblingEmployeeInit =
    siblingEmployees.find(
      (candidate) => !!candidate.privateRecipientInitializedAt,
    )?.privateRecipientInitializedAt ?? null;

  if (siblingEmployeeInit) {
    await markEmployeePrivateRecipientInitialized(
      employee.wallet,
      siblingEmployeeInit,
    );
    return siblingEmployeeInit;
  }

  const streamCollection = await streamsCollection();
  const initializedStream = await streamCollection.findOne(
    {
      employeeId: {
        $in: siblingEmployees.map((candidate) => candidate.id),
      },
      recipientPrivateInitializedAt: { $nin: [null, ""] },
    },
    {
      sort: { updatedAt: -1 },
    },
  );

  const initializedAt =
    initializedStream?.recipientPrivateInitializedAt ?? null;

  if (!initializedAt) {
    return null;
  }

  await markEmployeePrivateRecipientInitialized(employee.wallet, initializedAt);

  return initializedAt;
}

export async function updateStreamStatus(input: UpdateStreamStatusInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const collection = await streamsCollection();

  const stream = await collection.findOne({
    employerWallet,
    id: input.streamId,
  });

  if (!stream) {
    throw new Error("Stream not found for this employer");
  }

  const updatedAt = nowIso();
  await collection.updateOne(
    {
      employerWallet,
      id: input.streamId,
    },
    {
      $set: {
        status: input.status,
        updatedAt,
      },
    },
  );

  return {
    ...stream,
    status: input.status,
    updatedAt,
  };
}

// ── Auditor Token Functions ────────────────────────────────
export async function updateStreamConfig(input: UpdateStreamConfigInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const collection = await streamsCollection();

  const stream = await collection.findOne({
    employerWallet,
    id: input.streamId,
  });

  if (!stream) {
    throw new Error("Stream not found for this employer");
  }

  const updateFields: Partial<StreamDoc> = {};
  const updatedAt = nowIso();
  const nextAllowedPayoutModes = normalizeAllowedPayoutModes(
    input.allowedPayoutModes ?? stream.allowedPayoutModes,
    input.payoutMode ?? stream.payoutMode,
  );

  if (typeof input.ratePerSecond === "number") {
    updateFields.ratePerSecond = assertPositiveNumber(
      input.ratePerSecond,
      "Rate per second",
    );
  }

  if (
    input.payoutMode !== undefined ||
    input.allowedPayoutModes !== undefined
  ) {
    updateFields.allowedPayoutModes = nextAllowedPayoutModes;
    updateFields.payoutMode = resolveStreamPayoutMode({
      payoutMode: input.payoutMode ?? stream.payoutMode,
      allowedPayoutModes: nextAllowedPayoutModes,
    });
  }

  if (input.status !== undefined) {
    updateFields.status = input.status;
  }

  updateFields.updatedAt = updatedAt;

  await collection.updateOne(
    {
      employerWallet,
      id: input.streamId,
    },
    {
      $set: updateFields,
    },
  );

  return {
    ...stream,
    ...updateFields,
  };
}

export async function updateStreamRuntimeState(
  input: UpdateStreamRuntimeStateInput,
) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const collection = await streamsCollection();

  const stream = await collection.findOne({
    employerWallet,
    id: input.streamId,
  });

  if (!stream) {
    throw new Error("Stream not found for this employer");
  }

  const nextTotalPaid =
    typeof input.totalPaid === "number"
      ? assertNonNegativeNumber(input.totalPaid, "totalPaid")
      : stream.totalPaid;

  const updatedAt = nowIso();
  const updateFields: Partial<StreamDoc> = {
    updatedAt,
  };

  if (typeof input.employeePda === "string") {
    updateFields.employeePda = input.employeePda;
  }

  if (typeof input.privatePayrollPda === "string") {
    updateFields.privatePayrollPda = input.privatePayrollPda;
  }

  if (typeof input.permissionPda === "string") {
    updateFields.permissionPda = input.permissionPda;
  }

  if (input.delegatedAt !== undefined) {
    updateFields.delegatedAt = input.delegatedAt;
  }

  if (input.recipientPrivateInitializedAt !== undefined) {
    updateFields.recipientPrivateInitializedAt =
      input.recipientPrivateInitializedAt;
  }

  if (input.lastPaidAt !== undefined) {
    updateFields.lastPaidAt = input.lastPaidAt;
  }

  if (input.checkpointCrankTaskId !== undefined) {
    updateFields.checkpointCrankTaskId = input.checkpointCrankTaskId;
  }

  if (input.checkpointCrankSignature !== undefined) {
    updateFields.checkpointCrankSignature = input.checkpointCrankSignature;
  }

  if (input.checkpointCrankStatus !== undefined) {
    updateFields.checkpointCrankStatus = input.checkpointCrankStatus;
  }

  if (input.checkpointCrankUpdatedAt !== undefined) {
    updateFields.checkpointCrankUpdatedAt = input.checkpointCrankUpdatedAt;
  }

  if (typeof input.totalPaid === "number") {
    updateFields.totalPaid = nextTotalPaid;
  }

  if (input.monthlyCapState !== undefined) {
    updateFields.monthlyCapState = input.monthlyCapState;
  }

  await collection.updateOne(
    {
      employerWallet,
      id: input.streamId,
    },
    {
      $set: updateFields,
    },
  );

  return {
    ...stream,
    ...updateFields,
  };
}

export async function markEmployeePrivateRecipientInitialized(
  employeeWallet: string,
  initializedAt = nowIso(),
  txSignature?: string | null,
) {
  const wallet = assertWallet(employeeWallet, "Employee wallet");
  const employees = await listEmployeesByWallet(wallet);

  if (employees.length === 0) {
    throw new Error("Employee not found for this wallet");
  }

  const employeeCollection = await employeesCollection();
  const streamCollection = await streamsCollection();

  await employeeCollection.updateMany(
    { wallet },
    {
      $set: {
        privateRecipientInitializedAt: initializedAt,
        privateRecipientInitStatus: "confirmed",
        privateRecipientInitLastAttemptAt: initializedAt,
        privateRecipientInitConfirmedAt: initializedAt,
        privateRecipientInitTxSignature: txSignature ?? null,
        privateRecipientInitError: null,
        updatedAt: initializedAt,
      },
    },
  );

  for (const employee of employees) {
    await streamCollection.updateMany(
      {
        employerWallet: employee.employerWallet,
        employeeId: employee.id,
      },
      {
        $set: {
          recipientPrivateInitializedAt: initializedAt,
          updatedAt: initializedAt,
        },
      },
    );
  }

  return {
    employeeWallet: wallet,
    initializedAt,
    employersUpdated: employees.length,
  };
}

export async function updateEmployeePrivateRecipientInitState(
  input: UpdateEmployeePrivateRecipientInitStateInput,
) {
  const wallet = assertWallet(input.employeeWallet, "Employee wallet");
  const employees = await listEmployeesByWallet(wallet);

  if (employees.length === 0) {
    throw new Error("Employee not found for this wallet");
  }

  const timestamp = input.timestamp ?? nowIso();
  const employeeCollection = await employeesCollection();
  const updateFields: Partial<EmployeeDoc> & { updatedAt: string } = {
    privateRecipientInitStatus: input.status,
    privateRecipientInitLastAttemptAt: timestamp,
    updatedAt: timestamp,
  };

  if (input.status === "processing") {
    updateFields.privateRecipientInitError = null;
  }

  if (input.status === "failed") {
    updateFields.privateRecipientInitError =
      input.error?.trim() || "Private account initialization failed";
  } else if (input.error === null) {
    updateFields.privateRecipientInitError = null;
  }

  if (input.txSignature !== undefined) {
    updateFields.privateRecipientInitTxSignature = input.txSignature;
  }

  await employeeCollection.updateMany(
    { wallet },
    {
      $set: updateFields,
    },
  );

  return {
    employeeWallet: wallet,
    status: input.status,
    employeesUpdated: employees.length,
    updatedAt: timestamp,
  };
}

export async function getEmployerPayrollView(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const [employees, streams] = await Promise.all([
    listEmployees(wallet),
    listStreams(wallet),
  ]);

  const streamMap = new Map(
    streams.map((stream) => [stream.employeeId, stream]),
  );

  return employees.map((employee) => ({
    employee,
    stream: streamMap.get(employee.id) ?? null,
  }));
}

export async function createTransferRecord(
  record: Omit<PayrollTransferRecord, "id" | "createdAt" | "updatedAt">,
) {
  const timestamp = nowIso();
  const transfer: TransferDoc = {
    ...record,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await (await transfersCollection()).insertOne(transfer);
  return transfer;
}

export async function listTransfers(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  return (await transfersCollection())
    .find({ employerWallet: wallet })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function findTransfersByEmployee(employeeId: string) {
  return (await transfersCollection())
    .find({ employeeId })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function sumSuccessfulTransferAmountMicroForStream(streamId: string) {
  const collection = await transfersCollection();
  const rows = await collection
    .find({ streamId, status: "success" })
    .project<{ amount: number }>({ amount: 1 })
    .toArray();

  return rows.reduce((sum, row) => {
    const amountMicro = Math.round((row.amount ?? 0) * 1_000_000);
    return Number.isSafeInteger(amountMicro) && amountMicro > 0
      ? sum + BigInt(amountMicro)
      : sum;
  }, BigInt(0));
}

export async function findUnsettledTransfer(streamId: string) {
  const collection = await transfersCollection();
  return collection.findOne({
    streamId,
    status: { $in: ["transfer_pending", "transfer_sent", "recovery_required"] },
  });
}

export async function updateTransferStatus(
  transferId: string,
  status: TransferStatus,
  txSignature?: string,
) {
  const collection = await transfersCollection();
  const updateDoc: any = { status, updatedAt: nowIso() };
  if (txSignature) {
    updateDoc.txSignature = txSignature;
  }

  await collection.updateOne({ id: transferId }, { $set: updateDoc });
}

export async function updateTransferRecord(
  id: string,
  updates: Partial<
    Pick<PayrollTransferRecord, "status" | "txSignature" | "errorMessage" | "providerMeta">
  >,
) {
  const collection = await transfersCollection();
  const existing = await collection.findOne({ id });

  if (!existing) {
    throw new Error("Transfer record not found");
  }

  const updatedAt = nowIso();
  await collection.updateOne(
    { id },
    {
      $set: {
        ...updates,
        updatedAt,
      },
    },
  );

  return {
    ...existing,
    ...updates,
    updatedAt,
  };
}

export async function listCashoutRequestsForEmployer(
  employerWallet: string,
  streamId?: string,
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const filter: { employerWallet: string; streamId?: string } = {
    employerWallet: wallet,
  };
  if (streamId?.trim()) {
    filter.streamId = streamId.trim();
  }
  return (await cashoutRequestsCollection())
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();
}

export async function listCashoutRequestsForEmployee(employeeWallet: string) {
  const wallet = assertWallet(employeeWallet, "Employee wallet");
  return (await cashoutRequestsCollection())
    .find({ employeeWallet: wallet })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function getCashoutRequestById(id: string) {
  return (await cashoutRequestsCollection()).findOne({ id: id.trim() });
}

export async function createCashoutRequest(input: {
  employeeWallet: string;
  streamId: string;
  requestedAmount: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  note?: string;
}) {
  const employeeWallet = assertWallet(input.employeeWallet, "Employee wallet");
  const requestedAmount = assertPositiveNumber(
    input.requestedAmount,
    "Requested amount",
  );
  const streamId = input.streamId.trim();

  if (!streamId) {
    throw new Error("Stream ID is required");
  }

  const employees = await listEmployeesByWallet(employeeWallet);
  const stream = await (await streamsCollection()).findOne({ id: streamId });

  if (!stream) {
    throw new Error("Stream not found");
  }

  const employee = employees.find(
    (candidate) =>
      candidate.id === stream.employeeId &&
      candidate.employerWallet === stream.employerWallet,
  );

  if (!employee) {
    throw new Error("Employee wallet is not authorized for this stream");
  }

  const collection = await cashoutRequestsCollection();
  const pendingExisting = await collection.findOne({
    streamId,
    employeeWallet,
    status: "pending",
  });

  if (pendingExisting) {
    throw new Error("A pending cashout request already exists for this stream");
  }

  const allowedPayoutModes = normalizeAllowedPayoutModes(
    stream.allowedPayoutModes,
    stream.payoutMode,
  );
  const resolvedDefaultPayoutMode = resolveStreamPayoutMode(stream);
  const resolvedPayoutMode = normalizePayoutMode(
    input.payoutMode ?? resolvedDefaultPayoutMode,
  );
  const destinationWallet = input.destinationWallet?.trim() || undefined;

  if (!allowedPayoutModes.includes(resolvedPayoutMode)) {
    throw new Error(
      resolvedPayoutMode === "ephemeral"
        ? "This stream does not allow private payout requests"
        : "This stream does not allow direct payout requests",
    );
  }

  if (resolvedPayoutMode === "ephemeral") {
    const recipientPrivateInitializedAt =
      stream.recipientPrivateInitializedAt ??
      employee.privateRecipientInitializedAt ??
      null;

    if (!recipientPrivateInitializedAt) {
      throw new Error(
        "Private recipient initialization is required before requesting private payout",
      );
    }

    if (destinationWallet) {
      throw new Error(
        "Custom destination wallet is only supported for direct base payouts",
      );
    }
  } else if (destinationWallet) {
    assertWallet(destinationWallet, "Destination wallet");
  }

  const timestamp = nowIso();
  const request: CashoutRequestDoc = {
    id: randomUUID(),
    employerWallet: stream.employerWallet,
    employeeId: stream.employeeId,
    employeeWallet,
    streamId,
    requestedAmount,
    payoutMode: resolvedPayoutMode,
    destinationWallet,
    note: input.note?.trim() || undefined,
    status: "pending",
    resolvedAt: null,
    resolvedByWallet: null,
    resolutionNote: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne(request);
  return request;
}

export async function resolveCashoutRequest(input: {
  employerWallet: string;
  requestId: string;
  status: Extract<
    CashoutRequestStatus,
    "fulfilled" | "dismissed" | "cancelled"
  >;
  resolvedByWallet: string;
  resolutionNote?: string;
}) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const resolvedByWallet = assertWallet(
    input.resolvedByWallet,
    "Resolved by wallet",
  );

  const collection = await cashoutRequestsCollection();
  const existing = await collection.findOne({
    id: input.requestId,
    employerWallet,
  });

  if (!existing) {
    throw new Error("Cashout request not found");
  }

  const timestamp = nowIso();
  const resolutionNote = input.resolutionNote?.trim() || null;

  await collection.updateOne(
    { id: input.requestId, employerWallet },
    {
      $set: {
        status: input.status,
        resolvedAt: timestamp,
        resolvedByWallet,
        resolutionNote,
        updatedAt: timestamp,
      },
    },
  );

  return {
    ...existing,
    status: input.status,
    resolvedAt: timestamp,
    resolvedByWallet,
    resolutionNote,
    updatedAt: timestamp,
  };
}

export async function fulfillPendingCashoutRequestsForStream(input: {
  employerWallet: string;
  streamId: string;
  requestId?: string;
  settledAmountMicro?: number;
  resolvedByWallet?: string;
  resolutionNote?: string;
}) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const resolvedByWallet = input.resolvedByWallet?.trim()
    ? assertWallet(input.resolvedByWallet, "Resolved by wallet")
    : employerWallet;
  const timestamp = nowIso();
  const resolutionNote = input.resolutionNote?.trim() || null;
  const collection = await cashoutRequestsCollection();
  const baseFilter: {
    employerWallet: string;
    streamId: string;
    status: "pending";
    id?: string;
    requestedAmount?: { $lte: number };
  } = {
    employerWallet,
    streamId: input.streamId,
    status: "pending",
  };

  if (input.requestId?.trim()) {
    baseFilter.id = input.requestId.trim();
  }

  if (input.settledAmountMicro !== undefined) {
    baseFilter.requestedAmount = {
      $lte: input.settledAmountMicro / 1_000_000,
    };
  }

  await collection.updateMany(baseFilter, {
    $set: {
      status: "fulfilled",
      resolvedAt: timestamp,
      resolvedByWallet,
      resolutionNote,
      updatedAt: timestamp,
    },
  });
}

// ── Auditor Token Functions ────────────────────────────────

function generateSecureToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "exp_";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export async function createAuditorToken(input: {
  employerWallet: string;
  label?: string;
  expiresDays?: number;
}) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const timestamp = nowIso();
  const expiresAt = new Date(
    Date.now() + (input.expiresDays ?? 30) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const token = generateSecureToken();

  const collection = await auditorTokensCollection();
  const doc: AuditorTokenDoc = {
    id: randomUUID(),
    token,
    employerWallet,
    label: input.label?.trim() || undefined,
    expiresAt,
    revoked: false,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne(doc);
  return doc;
}

export async function listAuditorTokens(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await auditorTokensCollection();
  return collection
    .find({ employerWallet: wallet })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function validateAuditorToken(token: string) {
  const collection = await auditorTokensCollection();
  const doc = await collection.findOne({ token: token.trim(), revoked: false });

  if (!doc) {
    throw new Error("Invalid or revoked auditor token");
  }

  if (new Date(doc.expiresAt) < new Date()) {
    throw new Error("Auditor token has expired");
  }

  return doc;
}

export async function revokeAuditorToken(
  token: string,
  employerWallet: string,
) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const collection = await auditorTokensCollection();
  const timestamp = nowIso();

  const result = await collection.updateOne(
    { token: token.trim(), employerWallet: wallet, revoked: false },
    {
      $set: {
        revoked: true,
        revokedAt: timestamp,
        updatedAt: timestamp,
      },
    },
  );

  if (result.matchedCount === 0) {
    throw new Error("Token not found or already revoked");
  }

  return true;
}

// -----------------------------------------------------------------------------
// On-Chain Claims API
// -----------------------------------------------------------------------------

export async function createOnChainClaim(input: {
  streamId: string;
  payrollPda: string;
  employeeWallet: string;
  claimId: number;
  amountMicro: number;
  requestTxSignature: string;
}) {
  const collection = await onChainClaimsCollection();
  
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  const record: OnChainClaimRecord = {
    id,
    streamId: input.streamId,
    payrollPda: input.payrollPda,
    employeeWallet: input.employeeWallet,
    claimId: input.claimId,
    amountMicro: input.amountMicro,
    requestTxSignature: input.requestTxSignature,
    status: "requested",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await collection.insertOne({ ...record, _id: id } as any);
  return record;
}

export async function listOnChainClaimsForEmployee(employeeWallet: string) {
  const collection = await onChainClaimsCollection();
  const docs = await collection
    .find({ employeeWallet })
    .sort({ createdAt: -1 })
    .toArray();
    
  return docs.map(doc => {
    const { _id, ...rest } = doc;
    return { ...rest, id: _id };
  });
}

export async function listOnChainClaimsForStream(streamId: string) {
  const collection = await onChainClaimsCollection();
  const docs = await collection
    .find({ streamId })
    .sort({ createdAt: -1 })
    .toArray();
    
  return docs.map(doc => {
    const { _id, ...rest } = doc;
    return { ...rest, id: _id };
  });
}

export async function listOnChainClaimsForEmployer(
  employerWallet: string,
  streamId?: string,
) {
  const streamIds = streamId?.trim()
    ? [streamId.trim()]
    : (await listActiveStreams(employerWallet)).map((s) => s.id);

  if (streamIds.length === 0) {
    return [];
  }
  
  const collection = await onChainClaimsCollection();
  const docs = await collection
    .find({ streamId: { $in: streamIds } })
    .sort({ createdAt: -1 })
    .toArray();
    
  return docs.map(doc => {
    const { _id, ...rest } = doc;
    return { ...rest, id: _id };
  });
}

export async function getPendingOnChainClaim(streamId: string) {
  const collection = await onChainClaimsCollection();
  const doc = await collection.findOne({
    streamId,
    status: { $in: ["requested", "paying", "needs_sync", "failed"] }
  });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: _id };
}

export async function getOnChainClaimById(id: string) {
  const collection = await onChainClaimsCollection();
  const doc = await collection.findOne({ _id: id } as any);
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: _id };
}

export async function updateOnChainClaim(id: string, updates: Partial<OnChainClaimRecord>) {
  const collection = await onChainClaimsCollection();
  
  const updatePayload = {
    ...updates,
    updatedAt: nowIso()
  };

  await collection.updateOne(
    { _id: id } as any,
    { $set: updatePayload }
  );

  return getOnChainClaimById(id);
}
