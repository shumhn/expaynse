import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { buildPayrollDisbursementPlan } from "@/lib/server/payroll-runs-store";
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ cycleId: string }> },
) {
  try {
    const { cycleId } = await context.params;

    if (!cycleId) {
      return badRequest("cycleId is required");
    }

    const employerWallet = getEmployerWalletFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const plan = await buildPayrollDisbursementPlan({
      employerWallet,
      cycleId,
    });

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.cycles.disbursement-plan.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-cycle",
      resourceId: cycleId,
      status: "success",
      metadata: {
        recipientCount: plan.summary.recipientCount,
        totalAmount: plan.summary.totalAmount,
      },
    });

    return NextResponse.json(plan);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate payroll disbursement plan";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
