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
  try {
    const { company } = await requireCompanyOwnerRequest({
      request,
      companyId: (await context.params).companyId,
    });

    return NextResponse.json({
      ok: true,
      instructions: {
        title: "Fund company payroll treasury",
        currency: company.currency,
        treasuryPubkey: company.treasuryPubkey,
        steps: [
          "Send USDC from employer wallet to the company payroll treasury, or use your MagicBlock deposit/transfer modal.",
          "After funding, payroll worker can settle approved employee claims from this treasury.",
          "Do not send all company funds; only fund payroll budget.",
        ],
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
        error:
          error instanceof Error
            ? error.message
            : "Failed to load funding instructions.",
      },
      { status: 500 }
    );
  }
}
