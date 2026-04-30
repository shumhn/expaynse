import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { resolvePayrollRunItem } from "@/lib/server/payroll-runs-run-store";
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
      status?: "paid" | "failed";
      txSignature?: string;
      errorMessage?: string;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.status || (body.status !== "paid" && body.status !== "failed")) {
      return badRequest("status must be paid or failed");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const result = await resolvePayrollRunItem({
      employerWallet: body.employerWallet,
      runId,
      itemId,
      status: body.status,
      txSignature: body.txSignature,
      errorMessage: body.errorMessage,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: `payroll-runs.run-item.${body.status}`,
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
      error instanceof Error ? error.message : "Failed to resolve payroll run item";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
