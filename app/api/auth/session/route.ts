import { NextRequest, NextResponse } from "next/server";

import { createWalletSessionToken } from "@/lib/server/wallet-session";
import { verifySignedWalletRequest } from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      wallet?: string;
    };
    const wallet = body.wallet?.trim() ?? "";

    if (!wallet) {
      throw new Error("wallet is required");
    }

    await verifySignedWalletRequest({
      headers: request.headers,
      expectedWallet: wallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const session = createWalletSessionToken(wallet);

    return NextResponse.json({
      wallet,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    });
  } catch (error: unknown) {
    return badRequest(
      error instanceof Error ? error.message : "Failed to create wallet session",
    );
  }
}
