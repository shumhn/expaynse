import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { listEmployeesByWallet } from "@/lib/server/payroll-store";
import {
  listPayrollRunItemsForEmployer,
  listPayrollRunsForEmployer,
} from "@/lib/server/payroll-runs-run-store";
import {
  listPayrollCycleItemsForEmployer,
  listPayrollCycles,
} from "@/lib/server/payroll-runs-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

type StatementScope = "employer" | "employee";

interface StatementRow {
  statementId: string;
  employerWallet: string;
  employee: {
    id: string;
    name: string;
    wallet: string;
  };
  cycle: {
    id: string;
    label: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    status: string;
  };
  payroll: {
    currency: string;
    baseSalaryAmount: number;
    allowancesAmount: number;
    grossAmount: number;
    deductionsAmount: number;
    taxableAmount: number;
    taxWithheldAmount: number;
    netPayAmount: number;
    periodDays: number;
    activeDays: number;
  };
  payout: {
    status: "unpaid" | "paid" | "failed" | "queued";
    runId?: string;
    runStatus?: string;
    txSignature?: string;
    attempts?: number;
    errorMessage?: string;
    paidAt?: string;
  };
  generatedAt: string;
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getScope(request: NextRequest): StatementScope {
  const scope = request.nextUrl.searchParams.get("scope")?.trim() ?? "employer";
  if (scope === "employer" || scope === "employee") {
    return scope;
  }
  throw new Error("scope must be employer or employee");
}

function getEmployerWallet(request: NextRequest) {
  const employerWallet = request.nextUrl.searchParams
    .get("employerWallet")
    ?.trim();

  if (!employerWallet) {
    throw new Error("Missing employerWallet query parameter");
  }

  return employerWallet;
}

function getEmployeeWallet(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) {
    throw new Error("Missing wallet query parameter");
  }
  return wallet;
}

async function buildEmployerStatements(args: {
  employerWallet: string;
  employeeId?: string;
}) {
  const cycles = await listPayrollCycles(args.employerWallet);
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));

  const [cycleItems, runItems, runs] = await Promise.all([
    listPayrollCycleItemsForEmployer({
      employerWallet: args.employerWallet,
      employeeId: args.employeeId,
    }),
    listPayrollRunItemsForEmployer({
      employerWallet: args.employerWallet,
      employeeId: args.employeeId,
    }),
    listPayrollRunsForEmployer({ employerWallet: args.employerWallet }),
  ]);

  const runById = new Map(runs.map((run) => [run.id, run]));
  const runItemByCycleItemId = new Map<typeof runItems[number]["cycleItemId"], typeof runItems[number]>();

  for (const runItem of runItems) {
    const existing = runItemByCycleItemId.get(runItem.cycleItemId);
    if (!existing) {
      runItemByCycleItemId.set(runItem.cycleItemId, runItem);
      continue;
    }

    if (new Date(runItem.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
      runItemByCycleItemId.set(runItem.cycleItemId, runItem);
    }
  }

  const generatedAt = new Date().toISOString();

  const statements: StatementRow[] = cycleItems.map((item) => {
    const cycle = cycleById.get(item.cycleId);
    const runItem = runItemByCycleItemId.get(item.id);
    const run = runItem ? runById.get(runItem.runId) : undefined;

    let payoutStatus: StatementRow["payout"]["status"] = "unpaid";

    if (runItem?.status === "paid") {
      payoutStatus = "paid";
    } else if (runItem?.status === "failed") {
      payoutStatus = "failed";
    } else if (runItem?.status === "queued" || runItem?.status === "processing") {
      payoutStatus = "queued";
    }

    return {
      statementId: `${item.employeeId}:${item.cycleId}`,
      employerWallet: item.employerWallet,
      employee: {
        id: item.employeeId,
        name: item.employeeName,
        wallet: item.employeeWallet,
      },
      cycle: {
        id: item.cycleId,
        label: cycle?.label ?? item.cycleId,
        periodStart: cycle?.periodStart ?? item.createdAt,
        periodEnd: cycle?.periodEnd ?? item.createdAt,
        payDate: cycle?.payDate ?? item.createdAt,
        status: cycle?.status ?? "unknown",
      },
      payroll: {
        currency: item.currency,
        baseSalaryAmount: item.breakdown.baseSalaryAmount,
        allowancesAmount: item.breakdown.allowancesAmount,
        grossAmount: item.breakdown.grossAmount,
        deductionsAmount: item.breakdown.deductionsAmount,
        taxableAmount: item.breakdown.taxableAmount,
        taxWithheldAmount: item.breakdown.taxWithheldAmount,
        netPayAmount: item.breakdown.netPayAmount,
        periodDays: item.breakdown.periodDays,
        activeDays: item.breakdown.activeDays,
      },
      payout: {
        status: payoutStatus,
        runId: runItem?.runId,
        runStatus: run?.status,
        txSignature: runItem?.txSignature,
        attempts: runItem?.attempts,
        errorMessage: runItem?.errorMessage,
        paidAt: runItem?.status === "paid" ? runItem.updatedAt : undefined,
      },
      generatedAt,
    };
  });

  return {
    statements,
    summary: {
      count: statements.length,
      paidCount: statements.filter((row) => row.payout.status === "paid").length,
      unpaidCount: statements.filter((row) => row.payout.status === "unpaid").length,
      failedCount: statements.filter((row) => row.payout.status === "failed").length,
      queuedCount: statements.filter((row) => row.payout.status === "queued").length,
      totalNetPay: statements.reduce((sum, row) => sum + row.payroll.netPayAmount, 0),
      totalPaid: statements
        .filter((row) => row.payout.status === "paid")
        .reduce((sum, row) => sum + row.payroll.netPayAmount, 0),
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const scope = getScope(request);

    if (scope === "employer") {
      const employerWallet = getEmployerWallet(request);
      const employeeId = request.nextUrl.searchParams.get("employeeId")?.trim();

      await verifyAuthorizedWalletRequest({
        headers: request.headers,
        expectedWallet: employerWallet,
        method: request.method,
        path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
      });

      const payload = await buildEmployerStatements({
        employerWallet,
        employeeId,
      });

      await saveComplianceEvent({
        actorWallet: employerWallet,
        action: "payroll-runs.statements.read.employer",
        route: request.nextUrl.pathname,
        subjectWallet: employerWallet,
        resourceType: "payroll-statement",
        status: "success",
        metadata: {
          scope,
          employeeId: employeeId ?? "all",
          count: payload.summary.count,
        },
      });

      return NextResponse.json({
        scope,
        employerWallet,
        ...payload,
      });
    }

    const wallet = getEmployeeWallet(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: wallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const employments = await listEmployeesByWallet(wallet);

    if (employments.length === 0) {
      return NextResponse.json({
        scope,
        wallet,
        statements: [],
        summary: {
          count: 0,
          paidCount: 0,
          unpaidCount: 0,
          failedCount: 0,
          queuedCount: 0,
          totalNetPay: 0,
          totalPaid: 0,
        },
      });
    }

    const statementsByEmployer = await Promise.all(
      employments.map(async (employment) => {
        const payload = await buildEmployerStatements({
          employerWallet: employment.employerWallet,
          employeeId: employment.id,
        });

        return payload.statements;
      }),
    );

    const statements = statementsByEmployer
      .flat()
      .sort(
        (a, b) =>
          new Date(b.cycle.payDate).getTime() -
          new Date(a.cycle.payDate).getTime(),
      );

    await saveComplianceEvent({
      actorWallet: wallet,
      action: "payroll-runs.statements.read.employee",
      route: request.nextUrl.pathname,
      subjectWallet: wallet,
      resourceType: "payroll-statement",
      status: "success",
      metadata: {
        scope,
        employerCount: employments.length,
        count: statements.length,
      },
    });

    return NextResponse.json({
      scope,
      wallet,
      statements,
      summary: {
        count: statements.length,
        paidCount: statements.filter((row) => row.payout.status === "paid").length,
        unpaidCount: statements.filter((row) => row.payout.status === "unpaid").length,
        failedCount: statements.filter((row) => row.payout.status === "failed").length,
        queuedCount: statements.filter((row) => row.payout.status === "queued").length,
        totalNetPay: statements.reduce((sum, row) => sum + row.payroll.netPayAmount, 0),
        totalPaid: statements
          .filter((row) => row.payout.status === "paid")
          .reduce((sum, row) => sum + row.payroll.netPayAmount, 0),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate statements";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
