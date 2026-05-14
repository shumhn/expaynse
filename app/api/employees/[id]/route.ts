import { NextRequest, NextResponse } from "next/server";
import { updateEmployee } from "@/lib/server/payroll-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";
import { normalizePayrollMode, type PayrollMode } from "@/lib/payroll-mode";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: employeeId } = await context.params;
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      payrollMode?: PayrollMode;
    };

    if (!body.employerWallet) {
      return NextResponse.json(
        { error: "employerWallet is required" },
        { status: 400 }
      );
    }

    if (!employeeId) {
      return NextResponse.json(
        { error: "Employee ID is required" },
        { status: 400 }
      );
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const updates: any = {};
    if (body.payrollMode) {
      updates.payrollMode = normalizePayrollMode(body.payrollMode);
    }

    const updatedEmployee = await updateEmployee(
      body.employerWallet,
      employeeId,
      updates
    );

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "employees.update",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "employee",
      resourceId: employeeId,
      status: "success",
    });

    return NextResponse.json({ employee: updatedEmployee }, { status: 200 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to update employee";

    return NextResponse.json(
      { error: message },
      { status: isWalletAuthorizationError(error) ? 401 : 400 }
    );
  }
}
