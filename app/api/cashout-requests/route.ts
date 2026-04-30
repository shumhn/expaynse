import { NextRequest, NextResponse } from "next/server";

import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  createCashoutRequest,
  listCashoutRequestsForEmployee,
  listCashoutRequestsForEmployer,
  resolveCashoutRequest,
  type CashoutRequestStatus,
} from "@/lib/server/payroll-store";
import type { PayrollPayoutMode } from "@/lib/payroll-payout-mode";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function assertScope(scope: string | null) {
  if (scope === "employee" || scope === "employer") {
    return scope;
  }

  throw new Error("scope must be employee or employer");
}

function assertResolutionStatus(status: string | undefined) {
  if (
    status === "fulfilled" ||
    status === "dismissed" ||
    status === "cancelled"
  ) {
    return status;
  }

  throw new Error("status must be fulfilled, dismissed, or cancelled");
}

function assertPayoutMode(
  payoutMode: PayrollPayoutMode | undefined,
): PayrollPayoutMode | undefined {
  if (payoutMode === undefined) {
    return undefined;
  }

  if (payoutMode === "base" || payoutMode === "ephemeral") {
    return payoutMode;
  }

  throw new Error("payoutMode must be base or ephemeral");
}

export async function GET(request: NextRequest) {
  try {
    const scope = assertScope(request.nextUrl.searchParams.get("scope"));

    if (scope === "employee") {
      const employeeWallet = assertWallet(
        request.nextUrl.searchParams.get("employeeWallet") ?? "",
        "Employee wallet",
      );

      await verifyAuthorizedWalletRequest({
        headers: request.headers,
        expectedWallet: employeeWallet,
        method: "GET",
        path: request.nextUrl.pathname + request.nextUrl.search,
      });

      const requests = await listCashoutRequestsForEmployee(employeeWallet);

      await saveComplianceEvent({
        actorWallet: employeeWallet,
        action: "cashout-requests.read.employee",
        route: "/api/cashout-requests",
        subjectWallet: employeeWallet,
        resourceType: "cashout-request",
        status: "success",
        metadata: { scope, count: requests.length },
      });

      return NextResponse.json({ requests });
    }

    const employerWallet = assertWallet(
      request.nextUrl.searchParams.get("employerWallet") ?? "",
      "Employer wallet",
    );

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: "GET",
      path: request.nextUrl.pathname + request.nextUrl.search,
    });

    const requests = await listCashoutRequestsForEmployer(employerWallet);

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "cashout-requests.read.employer",
      route: "/api/cashout-requests",
      subjectWallet: employerWallet,
      resourceType: "cashout-request",
      status: "success",
      metadata: { scope, count: requests.length },
    });

    return NextResponse.json({ requests });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error
        ? error.message
        : "Failed to load cashout requests",
      isWalletAuthorizationError(error) ? 401 : 400,
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employeeWallet?: string;
      streamId?: string;
      requestedAmount?: number | string;
      maxRequestableAmount?: number | string;
      payoutMode?: PayrollPayoutMode;
      destinationWallet?: string;
      note?: string;
    };

    const employeeWallet = assertWallet(
      body.employeeWallet ?? "",
      "Employee wallet",
    );

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employeeWallet,
      method: "POST",
      path: request.nextUrl.pathname,
      body: JSON.stringify(body),
    });

    const normalizeAmount = (value: number | string | undefined, fieldName: string) => {
      if (value === undefined || value === null || value === "") {
        throw new Error(`${fieldName} is required`);
      }
      const asString = typeof value === "string" ? value.trim().replace(/,/g, "") : String(value);
      const parsed = Number.parseFloat(asString);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${fieldName} must be a positive number`);
      }
      const micro = Math.round(parsed * 1_000_000);
      if (!Number.isSafeInteger(micro) || micro <= 0) {
        throw new Error(`${fieldName} is too small`);
      }
      return micro;
    };

    const requestedAmountMicro = normalizeAmount(body.requestedAmount, "Requested amount");
    const maxRequestableAmountMicro =
      body.maxRequestableAmount !== undefined
        ? normalizeAmount(body.maxRequestableAmount, "Max requestable amount")
        : undefined;

    if (
      maxRequestableAmountMicro !== undefined &&
      requestedAmountMicro > maxRequestableAmountMicro
    ) {
      throw new Error(
        `Requested amount exceeds max claimable (${(maxRequestableAmountMicro / 1_000_000).toFixed(6)} USDC)`,
      );
    }

    const created = await createCashoutRequest({
      employeeWallet,
      streamId: body.streamId?.trim() ?? "",
      requestedAmount: requestedAmountMicro / 1_000_000,
      payoutMode: assertPayoutMode(body.payoutMode),
      destinationWallet: body.destinationWallet?.trim() || undefined,
      note: body.note,
    });

    await saveComplianceEvent({
      actorWallet: employeeWallet,
      action: "cashout-requests.create",
      route: "/api/cashout-requests",
      subjectWallet: employeeWallet,
      resourceType: "cashout-request",
      resourceId: created.id,
      status: "success",
      metadata: {
        streamId: created.streamId,
        requestedAmount: created.requestedAmount,
      },
    });

    return NextResponse.json({ request: created }, { status: 201 });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error
        ? error.message
        : "Failed to create cashout request",
      isWalletAuthorizationError(error) ? 401 : 400,
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employerWallet?: string;
      requestId?: string;
      status?: CashoutRequestStatus;
      resolutionNote?: string;
    };

    const employerWallet = assertWallet(
      body.employerWallet ?? "",
      "Employer wallet",
    );
    const requestId = body.requestId?.trim();

    if (!requestId) {
      throw new Error("requestId is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: "PATCH",
      path: request.nextUrl.pathname,
      body: JSON.stringify(body),
    });

    const nextStatus = assertResolutionStatus(body.status);

    const updated = await resolveCashoutRequest({
      employerWallet,
      requestId,
      status: nextStatus,
      resolvedByWallet: employerWallet,
      resolutionNote: body.resolutionNote,
    });

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: `cashout-requests.${nextStatus}`,
      route: "/api/cashout-requests",
      subjectWallet: updated.employeeWallet,
      resourceType: "cashout-request",
      resourceId: updated.id,
      status: "success",
      metadata: {
        streamId: updated.streamId,
        requestedAmount: updated.requestedAmount,
      },
    });

    return NextResponse.json({ request: updated });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error
        ? error.message
        : "Failed to resolve cashout request",
      isWalletAuthorizationError(error) ? 401 : 400,
    );
  }
}
