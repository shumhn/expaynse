import { NextRequest, NextResponse } from "next/server";
import {
  CompanyRouteAuthError,
  requireCompanyOwnerRequest,
} from "@/lib/server/company-route-auth";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await context.params;

  try {
    const { company } = await requireCompanyOwnerRequest({
      request,
      companyId,
    });

    return NextResponse.json({
      ok: true,
      treasury: {
        companyId: company.id,
        currency: company.currency,
        treasuryPubkey: company.treasuryPubkey,
        settlementPubkey: company.settlementPubkey,
      },
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
        error: error instanceof Error ? error.message : "Failed to load treasury metadata.",
      },
      { status: 500 }
    );
  }
}
