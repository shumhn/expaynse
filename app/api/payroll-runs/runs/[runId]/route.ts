import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  getPayrollRunById,
  listPayrollRunItems,
} from "@/lib/server/payroll-runs-run-store";
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
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params;

    if (!runId) {
      return badRequest("runId is required");
    }

    const employerWallet = getEmployerWalletFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const [run, items] = await Promise.all([
      getPayrollRunById({ employerWallet, runId }),
      listPayrollRunItems({ employerWallet, runId }),
    ]);

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.run.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-run",
      resourceId: runId,
      status: "success",
      metadata: {
        status: run.status,
        itemCount: items.length,
      },
    });

    return NextResponse.json({ run, items });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch payroll run";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
