import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { markPayrollRunItemProcessing } from "@/lib/server/payroll-runs-run-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string; itemId: string }> },
) {
  try {
    const { runId, itemId } = await context.params;
    if (!runId || !itemId) {
      return badRequest("runId and itemId are required");
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

    const result = await markPayrollRunItemProcessing({
      employerWallet: body.employerWallet,
      runId,
      itemId,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "payroll-runs.run-item.processing",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "payroll-run-item",
      resourceId: itemId,
      status: "success",
      metadata: {
        runId,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to mark run item as processing";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
