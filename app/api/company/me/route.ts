import { NextRequest, NextResponse } from "next/server";
import {
  CompanyRouteAuthError,
  requireEmployerCompanyRequest,
} from "@/lib/server/company-route-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const employerWallet = request.nextUrl.searchParams.get("employerWallet");

  if (!employerWallet) {
    return NextResponse.json(
      { ok: false, error: "Missing employerWallet query param." },
      { status: 400 }
    );
  }

  try {
    const { company } = await requireEmployerCompanyRequest({
      request,
      employerWallet,
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
        error: error instanceof Error ? error.message : "Failed to load company.",
      },
      { status: 400 }
    );
  }
}
