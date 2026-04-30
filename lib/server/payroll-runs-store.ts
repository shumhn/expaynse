import { randomUUID } from "crypto";
import { MongoClient, type Db } from "mongodb";

import { listEmployees, type EmployeeRecord } from "@/lib/server/payroll-store";

export type PayrollFrequency = "weekly" | "biweekly" | "monthly";
export type PayrollCycleStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "processing"
  | "completed"
  | "cancelled";

export interface PayrollProfileRecord {
  id: string;
  employerWallet: string;
  employeeId: string;
  currency: string;
  baseSalaryMonthly: number;
  allowancesMonthly: number;
  fixedDeductionsMonthly: number;
  taxPercent: number;
  joinDate: string;
  exitDate?: string | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface PayrollCycleRecord {
  id: string;
  employerWallet: string;
  label: string;
  frequency: PayrollFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: PayrollCycleStatus;
  createdByWallet: string;
  approvedByWallet?: string;
  approvedAt?: string;
  completedAt?: string;
  totals: {
    employeeCount: number;
    grossAmount: number;
    deductionAmount: number;
    taxAmount: number;
    netAmount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PayrollCycleItemRecord {
  id: string;
  employerWallet: string;
  cycleId: string;
  employeeId: string;
  employeeWallet: string;
  employeeName: string;
  currency: string;
  status: "draft" | "approved" | "paid" | "failed";
  breakdown: {
    periodDays: number;
    activeDays: number;
    baseSalaryAmount: number;
    allowancesAmount: number;
    grossAmount: number;
    deductionsAmount: number;
    taxableAmount: number;
    taxWithheldAmount: number;
    netPayAmount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPayrollProfileInput {
  employerWallet: string;
  employeeId: string;
  currency?: string;
  baseSalaryMonthly: number;
  allowancesMonthly?: number;
  fixedDeductionsMonthly?: number;
  taxPercent?: number;
  joinDate: string;
  exitDate?: string | null;
  status?: "active" | "inactive";
}

export interface CreatePayrollCycleInput {
  employerWallet: string;
  createdByWallet: string;
  label: string;
  frequency: PayrollFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "expaynse";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI environment variable");
}

declare global {
  // eslint-disable-next-line no-var
  var __expaynseRealPayrollMongoClientPromise: Promise<MongoClient> | undefined;
}

const clientPromise =
  global.__expaynseRealPayrollMongoClientPromise ??
  new MongoClient(MONGODB_URI).connect();

if (process.env.NODE_ENV !== "production") {
  global.__expaynseRealPayrollMongoClientPromise = clientPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWallet(wallet: string) {
  return wallet.trim();
}

function assertWallet(wallet: string, fieldName: string) {
  const value = normalizeWallet(wallet);
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function assertDate(value: string, fieldName: string) {
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return new Date(parsed).toISOString();
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

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function startOfUtcDay(dateIso: string) {
  const date = new Date(dateIso);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function diffDaysInclusive(startIso: string, endIso: string) {
  const start = startOfUtcDay(startIso);
  const end = startOfUtcDay(endIso);
  if (end < start) {
    return 0;
  }
  return Math.floor((end - start) / 86400000) + 1;
}

function getMonthDays(dateIso: string) {
  const date = new Date(dateIso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db(MONGODB_DB);
}

async function payrollProfilesCollection() {
  return (await getDb()).collection<PayrollProfileRecord>("payroll_profiles");
}

async function payrollCyclesCollection() {
  return (await getDb()).collection<PayrollCycleRecord>("payroll_cycles");
}

async function payrollCycleItemsCollection() {
  return (await getDb()).collection<PayrollCycleItemRecord>("payroll_cycle_items");
}

function assertPayrollFrequency(value: string): PayrollFrequency {
  if (value === "weekly" || value === "biweekly" || value === "monthly") {
    return value;
  }
  throw new Error("frequency must be weekly, biweekly, or monthly");
}

function assertCycleStatusForMutation(status: PayrollCycleStatus) {
  if (status === "completed" || status === "cancelled") {
    throw new Error(`Cycle cannot be modified when status is ${status}`);
  }
}

function ensureEmployeeExists(
  employeesById: Map<string, EmployeeRecord>,
  employeeId: string,
) {
  const employee = employeesById.get(employeeId);
  if (!employee) {
    throw new Error(`Employee not found for employeeId: ${employeeId}`);
  }
  return employee;
}

export async function listPayrollProfiles(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  return (await payrollProfilesCollection())
    .find({ employerWallet: wallet })
    .sort({ createdAt: 1 })
    .toArray();
}

export async function upsertPayrollProfile(input: UpsertPayrollProfileInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const employeeId = input.employeeId.trim();
  if (!employeeId) {
    throw new Error("employeeId is required");
  }

  const baseSalaryMonthly = assertPositiveNumber(
    input.baseSalaryMonthly,
    "baseSalaryMonthly",
  );
  const allowancesMonthly = assertNonNegativeNumber(
    input.allowancesMonthly ?? 0,
    "allowancesMonthly",
  );
  const fixedDeductionsMonthly = assertNonNegativeNumber(
    input.fixedDeductionsMonthly ?? 0,
    "fixedDeductionsMonthly",
  );
  const taxPercent = assertNonNegativeNumber(input.taxPercent ?? 0, "taxPercent");
  if (taxPercent > 100) {
    throw new Error("taxPercent cannot be more than 100");
  }

  const joinDate = assertDate(input.joinDate, "joinDate");
  const exitDate = input.exitDate ? assertDate(input.exitDate, "exitDate") : null;

  const employees = await listEmployees(employerWallet);
  const target = employees.find((employee) => employee.id === employeeId);
  if (!target) {
    throw new Error("Employee not found for this employer");
  }

  const now = nowIso();
  const collection = await payrollProfilesCollection();
  const existing = await collection.findOne({ employerWallet, employeeId });

  const payload = {
    employerWallet,
    employeeId,
    currency: (input.currency ?? "USD").trim().toUpperCase() || "USD",
    baseSalaryMonthly,
    allowancesMonthly,
    fixedDeductionsMonthly,
    taxPercent,
    joinDate,
    exitDate,
    status: input.status ?? "active",
    updatedAt: now,
  } as const;

  if (!existing) {
    const created: PayrollProfileRecord = {
      id: randomUUID(),
      ...payload,
      createdAt: now,
    };
    await collection.insertOne(created);
    return created;
  }

  await collection.updateOne(
    { employerWallet, employeeId },
    {
      $set: payload,
    },
  );

  return {
    ...existing,
    ...payload,
  };
}

export async function createPayrollCycle(input: CreatePayrollCycleInput) {
  const employerWallet = assertWallet(input.employerWallet, "Employer wallet");
  const createdByWallet = assertWallet(input.createdByWallet, "createdByWallet");
  const label = input.label.trim();
  if (!label) {
    throw new Error("label is required");
  }

  const frequency = assertPayrollFrequency(input.frequency);
  const periodStart = assertDate(input.periodStart, "periodStart");
  const periodEnd = assertDate(input.periodEnd, "periodEnd");
  const payDate = assertDate(input.payDate, "payDate");

  if (Date.parse(periodEnd) < Date.parse(periodStart)) {
    throw new Error("periodEnd must be on or after periodStart");
  }

  const now = nowIso();
  const cycle: PayrollCycleRecord = {
    id: randomUUID(),
    employerWallet,
    label,
    frequency,
    periodStart,
    periodEnd,
    payDate,
    status: "draft",
    createdByWallet,
    totals: {
      employeeCount: 0,
      grossAmount: 0,
      deductionAmount: 0,
      taxAmount: 0,
      netAmount: 0,
    },
    createdAt: now,
    updatedAt: now,
  };

  await (await payrollCyclesCollection()).insertOne(cycle);
  return cycle;
}

export async function listPayrollCycles(employerWallet: string) {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  return (await payrollCyclesCollection())
    .find({ employerWallet: wallet })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function getPayrollCycleById(
  employerWallet: string,
  cycleId: string,
): Promise<PayrollCycleRecord> {
  const wallet = assertWallet(employerWallet, "Employer wallet");
  const cycle = await (await payrollCyclesCollection()).findOne({
    employerWallet: wallet,
    id: cycleId,
  });

  if (!cycle) {
    throw new Error("Payroll cycle not found");
  }

  return cycle;
}

function computeActiveDays(args: {
  periodStart: string;
  periodEnd: string;
  joinDate: string;
  exitDate?: string | null;
}) {
  const effectiveStart =
    Date.parse(args.joinDate) > Date.parse(args.periodStart)
      ? args.joinDate
      : args.periodStart;
  const effectiveEnd =
    args.exitDate && Date.parse(args.exitDate) < Date.parse(args.periodEnd)
      ? args.exitDate
      : args.periodEnd;

  if (Date.parse(effectiveEnd) < Date.parse(effectiveStart)) {
    return 0;
  }

  return diffDaysInclusive(effectiveStart, effectiveEnd);
}

export async function computePayrollCycle(args: {
  employerWallet: string;
  cycleId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const cycle = await getPayrollCycleById(employerWallet, args.cycleId);
  assertCycleStatusForMutation(cycle.status);
  if (cycle.status !== "draft" && cycle.status !== "pending_approval") {
    throw new Error(
      `Cycle can only be computed from draft or pending_approval, got ${cycle.status}`,
    );
  }

  const [profiles, employees] = await Promise.all([
    listPayrollProfiles(employerWallet),
    listEmployees(employerWallet),
  ]);

  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const periodDays = diffDaysInclusive(cycle.periodStart, cycle.periodEnd);
  const standardMonthDays = getMonthDays(cycle.periodStart);

  const now = nowIso();
  const items: PayrollCycleItemRecord[] = [];

  let grossAmount = 0;
  let deductionAmount = 0;
  let taxAmount = 0;
  let netAmount = 0;

  for (const profile of profiles) {
    if (profile.status !== "active") {
      continue;
    }

    const employee = ensureEmployeeExists(employeesById, profile.employeeId);
    const activeDays = computeActiveDays({
      periodStart: cycle.periodStart,
      periodEnd: cycle.periodEnd,
      joinDate: profile.joinDate,
      exitDate: profile.exitDate,
    });

    if (activeDays <= 0) {
      continue;
    }

    const proratedFactor = activeDays / standardMonthDays;
    const baseSalaryAmount = roundMoney(profile.baseSalaryMonthly * proratedFactor);
    const allowancesAmount = roundMoney(
      profile.allowancesMonthly * proratedFactor,
    );
    const gross = roundMoney(baseSalaryAmount + allowancesAmount);
    const deductions = roundMoney(profile.fixedDeductionsMonthly * proratedFactor);
    const taxable = roundMoney(Math.max(gross - deductions, 0));
    const taxWithheld = roundMoney((taxable * profile.taxPercent) / 100);
    const netPay = roundMoney(Math.max(taxable - taxWithheld, 0));

    grossAmount += gross;
    deductionAmount += deductions;
    taxAmount += taxWithheld;
    netAmount += netPay;

    items.push({
      id: randomUUID(),
      employerWallet,
      cycleId: cycle.id,
      employeeId: employee.id,
      employeeWallet: employee.wallet,
      employeeName: employee.name,
      currency: profile.currency,
      status: "draft",
      breakdown: {
        periodDays,
        activeDays,
        baseSalaryAmount,
        allowancesAmount,
        grossAmount: gross,
        deductionsAmount: deductions,
        taxableAmount: taxable,
        taxWithheldAmount: taxWithheld,
        netPayAmount: netPay,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  const itemCollection = await payrollCycleItemsCollection();
  await itemCollection.deleteMany({ employerWallet, cycleId: cycle.id });
  if (items.length > 0) {
    await itemCollection.insertMany(items);
  }

  const totals = {
    employeeCount: items.length,
    grossAmount: roundMoney(grossAmount),
    deductionAmount: roundMoney(deductionAmount),
    taxAmount: roundMoney(taxAmount),
    netAmount: roundMoney(netAmount),
  };

  const nextStatus: PayrollCycleStatus = "pending_approval";

  const updatedAt = nowIso();
  await (await payrollCyclesCollection()).updateOne(
    { employerWallet, id: cycle.id },
    {
      $set: {
        totals,
        status: nextStatus,
        updatedAt,
      },
    },
  );

  return {
    cycle: {
      ...cycle,
      totals,
      status: nextStatus,
      updatedAt,
    },
    items,
    totals,
  };
}

export async function listPayrollCycleItems(args: {
  employerWallet: string;
  cycleId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  return (await payrollCycleItemsCollection())
    .find({ employerWallet, cycleId: args.cycleId })
    .sort({ employeeName: 1 })
    .toArray();
}

export async function listPayrollCycleItemsForEmployer(args: {
  employerWallet: string;
  employeeId?: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const query: {
    employerWallet: string;
    employeeId?: string;
  } = {
    employerWallet,
  };

  if (args.employeeId?.trim()) {
    query.employeeId = args.employeeId.trim();
  }

  return (await payrollCycleItemsCollection())
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

export async function updatePayrollCycleItemStatus(args: {
  employerWallet: string;
  cycleId: string;
  itemId: string;
  status: PayrollCycleItemRecord["status"];
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const updatedAt = nowIso();
  const collection = await payrollCycleItemsCollection();
  const existing = await collection.findOne({
    employerWallet,
    cycleId: args.cycleId,
    id: args.itemId,
  });

  if (!existing) {
    throw new Error("Payroll cycle item not found");
  }

  await collection.updateOne(
    {
      employerWallet,
      cycleId: args.cycleId,
      id: args.itemId,
    },
    {
      $set: {
        status: args.status,
        updatedAt,
      },
    },
  );

  return {
    ...existing,
    status: args.status,
    updatedAt,
  };
}

export async function updatePayrollCycleStatus(args: {
  employerWallet: string;
  cycleId: string;
  status: PayrollCycleStatus;
  completedAt?: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const cycle = await getPayrollCycleById(employerWallet, args.cycleId);
  const updatedAt = nowIso();

  await (await payrollCyclesCollection()).updateOne(
    {
      employerWallet,
      id: cycle.id,
    },
    {
      $set: {
        status: args.status,
        completedAt: args.completedAt ?? cycle.completedAt ?? undefined,
        updatedAt,
      },
    },
  );

  return {
    ...cycle,
    status: args.status,
    completedAt: args.completedAt ?? cycle.completedAt,
    updatedAt,
  };
}

export async function approvePayrollCycle(args: {
  employerWallet: string;
  cycleId: string;
  approverWallet: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const approverWallet = assertWallet(args.approverWallet, "approverWallet");
  const cycle = await getPayrollCycleById(employerWallet, args.cycleId);

  if (cycle.status !== "pending_approval" && cycle.status !== "draft") {
    throw new Error(`Cycle cannot be approved from status ${cycle.status}`);
  }

  const itemCount = await (await payrollCycleItemsCollection()).countDocuments({
    employerWallet,
    cycleId: cycle.id,
  });

  if (itemCount === 0) {
    throw new Error("Cannot approve a cycle with zero payroll items");
  }

  const approvedAt = nowIso();
  await (await payrollCyclesCollection()).updateOne(
    { employerWallet, id: cycle.id },
    {
      $set: {
        status: "approved",
        approvedByWallet: approverWallet,
        approvedAt,
        updatedAt: approvedAt,
      },
    },
  );

  await (await payrollCycleItemsCollection()).updateMany(
    { employerWallet, cycleId: cycle.id },
    {
      $set: {
        status: "approved",
        updatedAt: approvedAt,
      },
    },
  );

  return {
    ...cycle,
    status: "approved" as const,
    approvedByWallet: approverWallet,
    approvedAt,
    updatedAt: approvedAt,
  };
}

export async function buildPayrollDisbursementPlan(args: {
  employerWallet: string;
  cycleId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const cycle = await getPayrollCycleById(employerWallet, args.cycleId);

  if (cycle.status !== "approved" && cycle.status !== "processing") {
    throw new Error(
      "Disbursement plan can only be built for approved or processing cycles",
    );
  }

  const items = await listPayrollCycleItems({
    employerWallet,
    cycleId: cycle.id,
  });

  const recipients = items
    .filter((item) => item.breakdown.netPayAmount > 0)
    .map((item) => ({
      employeeId: item.employeeId,
      employeeName: item.employeeName,
      recipientAddress: item.employeeWallet,
      amount: item.breakdown.netPayAmount,
      amountMicro: Math.round(item.breakdown.netPayAmount * 1_000_000),
      currency: item.currency,
    }));

  const totalAmount = roundMoney(
    recipients.reduce((sum, recipient) => sum + recipient.amount, 0),
  );

  return {
    cycle,
    recipients,
    summary: {
      recipientCount: recipients.length,
      totalAmount,
      totalAmountMicro: Math.round(totalAmount * 1_000_000),
    },
  };
}
