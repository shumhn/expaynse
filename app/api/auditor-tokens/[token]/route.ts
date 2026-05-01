import { NextRequest, NextResponse } from "next/server";
import { validateAuditorToken } from "@/lib/server/payroll-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const doc = await validateAuditorToken(token);

    await saveComplianceEvent({
      actorWallet: doc.employerWallet,
      action: "auditor-tokens.validate",
      route: request.nextUrl.pathname,
      subjectWallet: doc.employerWallet,
      resourceType: "auditor-token",
      resourceId: doc.id,
      status: "success",
    });

    return NextResponse.json({
      valid: true,
      employerWallet: doc.employerWallet,
      label: doc.label,
      expiresAt: doc.expiresAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid auditor token";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
