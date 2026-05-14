import { NextRequest, NextResponse } from "next/server";

import {
  listEmployees,
  listEmployeesByWallet,
  markEmployeePrivateRecipientInitialized,
} from "@/lib/server/payroll-store";
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
      initializedAt?: string;
      txSignature?: string;
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

    await markEmployeePrivateRecipientInitialized(
      employeeWallet,
      body.initializedAt?.trim() || new Date().toISOString(),
      body.txSignature?.trim() || null,
    );

    const refreshedEmployees = await listEmployeesByWallet(employeeWallet);
    const refreshedEmployee =
      refreshedEmployees.find(
        (employee) =>
          employee.employerWallet === employerWallet &&
          employee.id === ownedEmployee.id,
      ) ?? ownedEmployee;

    return NextResponse.json(
      {
        employee: refreshedEmployee,
        message: "Private recipient initialized successfully.",
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize employer-side private initialization";

    return NextResponse.json(
      { error: message },
      { status: isWalletAuthorizationError(error) ? 401 : 400 },
    );
  }
}
