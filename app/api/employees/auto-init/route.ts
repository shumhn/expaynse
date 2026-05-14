import { NextRequest, NextResponse } from "next/server";

import {
  getEmployeeById,
  listEmployees,
  listEmployeesByWallet,
} from "@/lib/server/payroll-store";
import { sponsorInitializeEmployeeVault } from "@/lib/server/sponsor";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      employeeWallet?: string;
    };

    const employerWallet = body.employerWallet?.trim() ?? "";
    const employeeWallet = body.employeeWallet?.trim() ?? "";

    if (!employerWallet || !employeeWallet) {
      return NextResponse.json(
        { error: "Missing employerWallet or employeeWallet" },
        { status: 400 },
      );
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const employerEmployees = await listEmployees(employerWallet);
    const ownedEmployee = employerEmployees.find(
      (employee) => employee.wallet === employeeWallet,
    );

    if (!ownedEmployee) {
      return NextResponse.json(
        { error: "Employee does not belong to this employer" },
        { status: 403 },
      );
    }

    const initialized = await sponsorInitializeEmployeeVault(
      employeeWallet,
      employerWallet,
    );

    const refreshedEmployees = await listEmployeesByWallet(employeeWallet);
    const refreshedEmployee =
      refreshedEmployees.find(
        (employee) =>
          employee.employerWallet === employerWallet &&
          employee.id === ownedEmployee.id,
      ) ??
      (await getEmployeeById(employerWallet, ownedEmployee.id)) ??
      ownedEmployee;

    if (!initialized) {
      return NextResponse.json(
        {
          error:
            refreshedEmployee.privateRecipientInitError ||
            "Server auto-init did not complete.",
          employee: refreshedEmployee,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        employee: refreshedEmployee,
        message: "Private recipient auto-init completed successfully.",
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to auto-initialize employee private recipient";

    return NextResponse.json(
      { error: message },
      { status: isWalletAuthorizationError(error) ? 401 : 400 },
    );
  }
}
