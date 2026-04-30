import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { computePayrollCycle } from "@/lib/server/payroll-runs-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ cycleId: string }> },
) {
  try {
    const { cycleId } = await context.params;

    if (!cycleId) {
      return badRequest("cycleId is required");
    }

    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const result = await computePayrollCycle({
      employerWallet: body.employerWallet,
      cycleId,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "payroll-runs.cycles.compute",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "payroll-cycle",
      resourceId: cycleId,
      status: "success",
      metadata: {
        employeeCount: result.totals.employeeCount,
        netAmount: result.totals.netAmount,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute payroll cycle";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
