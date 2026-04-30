import { randomUUID } from "crypto";
import { MongoClient, type Db } from "mongodb";

import {
  getPayrollCycleById,
  listPayrollCycleItems,
  updatePayrollCycleItemStatus,
  updatePayrollCycleStatus,
} from "@/lib/server/payroll-runs-store";

export type PayrollRunStatus =
  | "queued"
  | "running"
  | "partially_failed"
  | "completed"
  | "failed"
  | "cancelled";

export type PayrollRunItemStatus =
  | "queued"
  | "processing"
  | "paid"
  | "failed"
  | "skipped";

export interface PayrollRunRecord {
  id: string;
  employerWallet: string;
  cycleId: string;
  initiatedByWallet: string;
  status: PayrollRunStatus;
  totals: {
    itemCount: number;
    queuedCount: number;
    processingCount: number;
    paidCount: number;
    failedCount: number;
    skippedCount: number;
    grossAmount: number;
    netAmount: number;
  };
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollRunItemRecord {
  id: string;
  employerWallet: string;
  runId: string;
  cycleId: string;
  cycleItemId: string;
  employeeId: string;
  employeeWallet: string;
  employeeName: string;
  amount: number;
  amountMicro: number;
  currency: string;
  status: PayrollRunItemStatus;
  attempts: number;
  txSignature?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "expaynse";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI environment variable");
}

declare global {
  // eslint-disable-next-line no-var
  var __expaynseRealPayrollRunMongoClientPromise:
    | Promise<MongoClient>
    | undefined;
}

const clientPromise =
  global.__expaynseRealPayrollRunMongoClientPromise ??
  new MongoClient(MONGODB_URI).connect();

if (process.env.NODE_ENV !== "production") {
  global.__expaynseRealPayrollRunMongoClientPromise = clientPromise;
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

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db(MONGODB_DB);
}

async function payrollRunsCollection() {
  return (await getDb()).collection<PayrollRunRecord>("payroll_runs_real");
}

async function payrollRunItemsCollection() {
  return (await getDb()).collection<PayrollRunItemRecord>("payroll_run_items_real");
}

function deriveRunStatusFromCounts(counts: {
  queuedCount: number;
  processingCount: number;
  paidCount: number;
  failedCount: number;
  skippedCount: number;
}) {
  if (counts.queuedCount > 0 || counts.processingCount > 0) {
    return "running" as const;
  }

  if (counts.paidCount > 0 && counts.failedCount === 0) {
    return "completed" as const;
  }

  if (counts.paidCount > 0 && counts.failedCount > 0) {
    return "partially_failed" as const;
  }

  if (counts.paidCount === 0 && counts.failedCount > 0) {
    return "failed" as const;
  }

  if (counts.skippedCount > 0) {
    return "cancelled" as const;
  }

  return "failed" as const;
}

async function recomputeRunStatus(args: {
  employerWallet: string;
  runId: string;
  forceStatus?: PayrollRunStatus;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const runs = await payrollRunsCollection();
  const items = await payrollRunItemsCollection();

  const run = await runs.findOne({
    employerWallet,
    id: args.runId,
  });

  if (!run) {
    throw new Error("Payroll run not found");
  }

  const runItems = await items
    .find({ employerWallet, runId: args.runId })
    .sort({ createdAt: 1 })
    .toArray();

  const queuedCount = runItems.filter((item) => item.status === "queued").length;
  const processingCount = runItems.filter(
    (item) => item.status === "processing",
  ).length;
  const paidCount = runItems.filter((item) => item.status === "paid").length;
  const failedCount = runItems.filter((item) => item.status === "failed").length;
  const skippedCount = runItems.filter((item) => item.status === "skipped").length;

  const nextStatus = args.forceStatus
    ? args.forceStatus
    : deriveRunStatusFromCounts({
        queuedCount,
        processingCount,
        paidCount,
        failedCount,
        skippedCount,
      });

  const grossAmount = roundMoney(
    runItems.reduce((sum, item) => sum + item.amount, 0),
  );
  const netAmount = roundMoney(
    runItems
      .filter((item) => item.status === "paid")
      .reduce((sum, item) => sum + item.amount, 0),
  );

  const completedAt =
    nextStatus === "completed" ||
    nextStatus === "partially_failed" ||
    nextStatus === "failed" ||
    nextStatus === "cancelled"
      ? nowIso()
      : undefined;

  const updatedAt = nowIso();

  await runs.updateOne(
    {
      employerWallet,
      id: args.runId,
    },
    {
      $set: {
        status: nextStatus,
        totals: {
          itemCount: runItems.length,
          queuedCount,
          processingCount,
          paidCount,
          failedCount,
          skippedCount,
          grossAmount,
          netAmount,
        },
        completedAt,
        updatedAt,
      },
    },
  );

  const refreshed = await runs.findOne({
    employerWallet,
    id: args.runId,
  });

  if (!refreshed) {
    throw new Error("Payroll run could not be refreshed");
  }

  return {
    run: refreshed,
    items: runItems,
  };
}

export async function createPayrollRun(args: {
  employerWallet: string;
  cycleId: string;
  initiatedByWallet: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const initiatedByWallet = assertWallet(
    args.initiatedByWallet,
    "initiatedByWallet",
  );

  const cycle = await getPayrollCycleById(employerWallet, args.cycleId);
  if (cycle.status !== "approved" && cycle.status !== "processing") {
    throw new Error(
      `Cycle must be approved before run creation. Current status: ${cycle.status}`,
    );
  }

  const runs = await payrollRunsCollection();
  const existingOpenRun = await runs.findOne({
    employerWallet,
    cycleId: cycle.id,
    status: { $in: ["queued", "running"] },
  });

  if (existingOpenRun) {
    throw new Error("An active payroll run already exists for this cycle");
  }

  const cycleItems = await listPayrollCycleItems({
    employerWallet,
    cycleId: cycle.id,
  });

  if (cycleItems.length === 0) {
    throw new Error("Cannot create run for a cycle without items");
  }

  const now = nowIso();
  const runId = randomUUID();

  const runItems: PayrollRunItemRecord[] = cycleItems.map((item) => {
    const amount = roundMoney(item.breakdown.netPayAmount);
    const isPayable = amount > 0;

    return {
      id: randomUUID(),
      employerWallet,
      runId,
      cycleId: cycle.id,
      cycleItemId: item.id,
      employeeId: item.employeeId,
      employeeWallet: item.employeeWallet,
      employeeName: item.employeeName,
      amount,
      amountMicro: Math.round(amount * 1_000_000),
      currency: item.currency,
      status: isPayable ? "queued" : "skipped",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  });

  const totals = {
    itemCount: runItems.length,
    queuedCount: runItems.filter((item) => item.status === "queued").length,
    processingCount: 0,
    paidCount: 0,
    failedCount: 0,
    skippedCount: runItems.filter((item) => item.status === "skipped").length,
    grossAmount: roundMoney(runItems.reduce((sum, item) => sum + item.amount, 0)),
    netAmount: 0,
  };

  const run: PayrollRunRecord = {
    id: runId,
    employerWallet,
    cycleId: cycle.id,
    initiatedByWallet,
    status: totals.queuedCount > 0 ? "running" : "cancelled",
    totals,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: totals.queuedCount > 0 ? undefined : now,
  };

  await runs.insertOne(run);
  if (runItems.length > 0) {
    await (await payrollRunItemsCollection()).insertMany(runItems);
  }

  await updatePayrollCycleStatus({
    employerWallet,
    cycleId: cycle.id,
    status: "processing",
  });

  return {
    run,
    items: runItems,
  };
}

export async function listPayrollRunsForCycle(args: {
  employerWallet: string;
  cycleId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  return (await payrollRunsCollection())
    .find({ employerWallet, cycleId: args.cycleId })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function listPayrollRunsForEmployer(args: {
  employerWallet: string;
  cycleId?: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const query: {
    employerWallet: string;
    cycleId?: string;
  } = {
    employerWallet,
  };

  if (args.cycleId?.trim()) {
    query.cycleId = args.cycleId.trim();
  }

  return (await payrollRunsCollection()).find(query).sort({ createdAt: -1 }).toArray();
}

export async function getPayrollRunById(args: {
  employerWallet: string;
  runId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const run = await (await payrollRunsCollection()).findOne({
    employerWallet,
    id: args.runId,
  });

  if (!run) {
    throw new Error("Payroll run not found");
  }

  return run;
}

export async function listPayrollRunItems(args: {
  employerWallet: string;
  runId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  return (await payrollRunItemsCollection())
    .find({ employerWallet, runId: args.runId })
    .sort({ employeeName: 1 })
    .toArray();
}

export async function listPayrollRunItemsForEmployer(args: {
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

  return (await payrollRunItemsCollection())
    .find(query)
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function markPayrollRunItemProcessing(args: {
  employerWallet: string;
  runId: string;
  itemId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const items = await payrollRunItemsCollection();
  const item = await items.findOne({
    employerWallet,
    runId: args.runId,
    id: args.itemId,
  });

  if (!item) {
    throw new Error("Payroll run item not found");
  }

  if (item.status !== "queued") {
    throw new Error(`Item cannot move to processing from ${item.status}`);
  }

  const updatedAt = nowIso();
  await items.updateOne(
    {
      employerWallet,
      runId: args.runId,
      id: args.itemId,
    },
    {
      $set: {
        status: "processing",
        updatedAt,
      },
    },
  );

  return recomputeRunStatus({
    employerWallet,
    runId: args.runId,
  });
}

export async function resolvePayrollRunItem(args: {
  employerWallet: string;
  runId: string;
  itemId: string;
  status: "paid" | "failed";
  txSignature?: string;
  errorMessage?: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const items = await payrollRunItemsCollection();
  const item = await items.findOne({
    employerWallet,
    runId: args.runId,
    id: args.itemId,
  });

  if (!item) {
    throw new Error("Payroll run item not found");
  }

  if (!["queued", "processing", "failed"].includes(item.status)) {
    throw new Error(`Item cannot be resolved from ${item.status}`);
  }

  if (args.status === "paid" && !args.txSignature?.trim()) {
    throw new Error("txSignature is required when marking item as paid");
  }

  const updatedAt = nowIso();
  const nextAttempts = item.attempts + 1;

  await items.updateOne(
    {
      employerWallet,
      runId: args.runId,
      id: args.itemId,
    },
    {
      $set: {
        status: args.status,
        txSignature:
          args.status === "paid"
            ? args.txSignature?.trim()
            : item.txSignature ?? undefined,
        errorMessage:
          args.status === "failed"
            ? args.errorMessage?.trim() || "Execution failed"
            : undefined,
        attempts: nextAttempts,
        updatedAt,
      },
    },
  );

  await updatePayrollCycleItemStatus({
    employerWallet,
    cycleId: item.cycleId,
    itemId: item.cycleItemId,
    status: args.status === "paid" ? "paid" : "failed",
  });

  return recomputeRunStatus({
    employerWallet,
    runId: args.runId,
  });
}

export async function retryFailedPayrollRunItems(args: {
  employerWallet: string;
  runId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const items = await payrollRunItemsCollection();

  const failedItems = await items
    .find({
      employerWallet,
      runId: args.runId,
      status: "failed",
    })
    .toArray();

  if (failedItems.length === 0) {
    return recomputeRunStatus({
      employerWallet,
      runId: args.runId,
    });
  }

  const updatedAt = nowIso();
  await items.updateMany(
    {
      employerWallet,
      runId: args.runId,
      status: "failed",
    },
    {
      $set: {
        status: "queued",
        errorMessage: undefined,
        updatedAt,
      },
    },
  );

  await Promise.all(
    failedItems.map((item) =>
      updatePayrollCycleItemStatus({
        employerWallet,
        cycleId: item.cycleId,
        itemId: item.cycleItemId,
        status: "approved",
      }),
    ),
  );

  return recomputeRunStatus({
    employerWallet,
    runId: args.runId,
  });
}

export async function finalizePayrollRun(args: {
  employerWallet: string;
  runId: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const run = await getPayrollRunById({
    employerWallet,
    runId: args.runId,
  });

  const items = await listPayrollRunItems({
    employerWallet,
    runId: args.runId,
  });

  const hasUnresolved = items.some(
    (item) => item.status === "queued" || item.status === "processing",
  );

  if (hasUnresolved) {
    throw new Error("Cannot finalize run while queued/processing items remain");
  }

  const paidCount = items.filter((item) => item.status === "paid").length;
  const failedCount = items.filter((item) => item.status === "failed").length;

  let forceStatus: PayrollRunStatus;
  if (paidCount > 0 && failedCount === 0) {
    forceStatus = "completed";
  } else if (paidCount > 0 && failedCount > 0) {
    forceStatus = "partially_failed";
  } else if (failedCount > 0) {
    forceStatus = "failed";
  } else {
    forceStatus = "cancelled";
  }

  const recomputed = await recomputeRunStatus({
    employerWallet,
    runId: run.id,
    forceStatus,
  });

  if (forceStatus === "completed") {
    await updatePayrollCycleStatus({
      employerWallet,
      cycleId: run.cycleId,
      status: "completed",
      completedAt: nowIso(),
    });
  }

  return recomputed;
}
