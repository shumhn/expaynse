import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  createPayrollCycle,
  listPayrollCycleItems,
  listPayrollCycles,
  type PayrollFrequency,
} from "@/lib/server/payroll-runs-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getEmployerWalletFromRequest(request: NextRequest) {
  const employerWallet = request.nextUrl.searchParams
    .get("employerWallet")
    ?.trim();

  if (!employerWallet) {
    throw new Error("Missing employerWallet query parameter");
  }

  return employerWallet;
}

export async function GET(request: NextRequest) {
  try {
    const employerWallet = getEmployerWalletFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const cycles = await listPayrollCycles(employerWallet);
    const cyclesWithItemCount = await Promise.all(
      cycles.map(async (cycle) => {
        const items = await listPayrollCycleItems({
          employerWallet,
          cycleId: cycle.id,
        });

        return {
          ...cycle,
          itemCount: items.length,
        };
      }),
    );

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.cycles.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-cycle",
      status: "success",
      metadata: {
        cycleCount: cycles.length,
      },
    });

    return NextResponse.json({ cycles: cyclesWithItemCount });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load payroll cycles";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      label?: string;
      frequency?: PayrollFrequency;
      periodStart?: string;
      periodEnd?: string;
      payDate?: string;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.label) {
      return badRequest("label is required");
    }

    if (!body.frequency) {
      return badRequest("frequency is required");
    }

    if (!body.periodStart || !body.periodEnd || !body.payDate) {
      return badRequest("periodStart, periodEnd, and payDate are required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const cycle = await createPayrollCycle({
      employerWallet: body.employerWallet,
      createdByWallet: body.employerWallet,
      label: body.label,
      frequency: body.frequency,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      payDate: body.payDate,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "payroll-runs.cycles.create",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "payroll-cycle",
      resourceId: cycle.id,
      status: "success",
      metadata: {
        frequency: cycle.frequency,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
      },
    });

    return NextResponse.json({ cycle }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create payroll cycle";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
