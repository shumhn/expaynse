import { NextRequest, NextResponse } from "next/server";

import {
  listComplianceEventsForWallet,
  saveComplianceEvent,
} from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getWalletFromRequest(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim();

  if (!wallet) {
    throw new Error("Missing wallet query parameter");
  }

  return wallet;
}

function getLimitFromRequest(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("limit")?.trim();

  if (!raw) {
    return 25;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be between 1 and 100");
  }

  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const wallet = getWalletFromRequest(request);
    const limit = getLimitFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: wallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const events = await listComplianceEventsForWallet(wallet);
    const limitedEvents = events.slice(0, limit);

    await saveComplianceEvent({
      actorWallet: wallet,
      action: "compliance-events.read",
      route: request.nextUrl.pathname,
      subjectWallet: wallet,
      resourceType: "compliance-event",
      status: "success",
      metadata: {
        limit,
        count: limitedEvents.length,
      },
    });

    return NextResponse.json({
      wallet,
      count: limitedEvents.length,
      events: limitedEvents,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list compliance events";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
