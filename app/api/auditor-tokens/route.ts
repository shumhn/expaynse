import { NextRequest, NextResponse } from "next/server";
import {
  createAuditorToken,
  listAuditorTokens,
  revokeAuditorToken,
} from "@/lib/server/payroll-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const employerWallet = request.nextUrl.searchParams.get("employerWallet");

    if (!employerWallet) {
      return badRequest("Missing employerWallet query parameter");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const tokens = await listAuditorTokens(employerWallet);

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "auditor-tokens.list",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "auditor-token",
      status: "success",
      metadata: { count: tokens.length },
    });

    return NextResponse.json({ tokens });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to list auditor tokens";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employerWallet?: string;
      label?: string;
      expiresDays?: number;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: JSON.stringify(body),
    });

    const token = await createAuditorToken({
      employerWallet: body.employerWallet,
      label: body.label,
      expiresDays: body.expiresDays,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "auditor-tokens.create",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "auditor-token",
      resourceId: token.id,
      status: "success",
      metadata: { expiresAt: token.expiresAt },
    });

    return NextResponse.json({ token }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to create auditor token";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employerWallet?: string;
      token?: string;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.token) {
      return badRequest("token is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: JSON.stringify(body),
    });

    await revokeAuditorToken(body.token, body.employerWallet);

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "auditor-tokens.revoke",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "auditor-token",
      status: "success",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to revoke auditor token";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
