import { NextRequest, NextResponse } from "next/server";
import { createCompany } from "@/lib/server/company-service";
import {
  CompanyRouteAuthError,
  requireEmployerWalletRequest,
} from "@/lib/server/company-route-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      name?: string;
      employerWallet?: string;
      message?: string;
      signature?: string;
      [key: string]: unknown;
    };

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing company name." },
        { status: 400 }
      );
    }

    if (!body.employerWallet || typeof body.employerWallet !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing employerWallet." },
        { status: 400 }
      );
    }

    await requireEmployerWalletRequest({
      request,
      employerWallet: body.employerWallet,
      body: rawBody,
    });

    const company = await createCompany({
      name: body.name,
      employerWallet: body.employerWallet,
      message: body.message,
      signature: body.signature,
    });

    return NextResponse.json({
      ok: true,
      company,
    });
  } catch (error) {
    if (error instanceof CompanyRouteAuthError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create company.",
      },
      { status: 400 }
    );
  }
}
