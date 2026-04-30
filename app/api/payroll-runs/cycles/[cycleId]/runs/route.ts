import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  createPayrollRun,
  listPayrollRunsForCycle,
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

    const runs = await listPayrollRunsForCycle({
      employerWallet,
      cycleId,
    });

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.runs.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-run",
      status: "success",
      metadata: {
        cycleId,
        runCount: runs.length,
      },
    });

    return NextResponse.json({ runs });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch payroll runs";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
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

    const payload = await createPayrollRun({
      employerWallet: body.employerWallet,
      cycleId,
      initiatedByWallet: body.employerWallet,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "payroll-runs.runs.create",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "payroll-run",
      resourceId: payload.run.id,
      status: "success",
      metadata: {
        cycleId,
        itemCount: payload.run.totals.itemCount,
        queuedCount: payload.run.totals.queuedCount,
      },
    });

    return NextResponse.json(payload, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create payroll run";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
