import { NextRequest, NextResponse } from "next/server";
import {
  createEmployee,
  getEmployeeById,
  listEmployees,
} from "@/lib/server/payroll-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";
import { sponsorInitializeEmployeeVault } from "@/lib/server/sponsor";
import { normalizePayrollMode, type PayrollMode } from "@/lib/payroll-mode";

function getEmployerWalletFromRequest(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("employerWallet")?.trim();

  if (!wallet) {
    throw new Error("Missing employerWallet query parameter");
  }

  return wallet;
}

export async function GET(request: NextRequest) {
  try {
    const employerWallet = getEmployerWalletFromRequest(request);
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });
    const employees = await listEmployees(employerWallet);
    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "employees.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "employee",
      status: "success",
    });

    return NextResponse.json({ employees });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to load employees";

    return NextResponse.json(
      { error: message },
      { status: isWalletAuthorizationError(error) ? 401 : 400 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      wallet?: string;
      name?: string;
      payrollMode?: PayrollMode;
      notes?: string;
      department?: string;
      role?: string;
      employmentType?: "full_time" | "part_time" | "contract";
      paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
      compensationUnit?: "monthly" | "weekly" | "hourly";
      compensationAmountUsd?: number;
      weeklyHours?: number;
      monthlySalaryUsd?: number;
      startDate?: string | null;
    };
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet ?? "",
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const employee = await createEmployee({
      employerWallet: body.employerWallet ?? "",
      wallet: body.wallet ?? "",
      name: body.name ?? "",
      payrollMode: normalizePayrollMode(body.payrollMode),
      notes: body.notes,
      department: body.department,
      role: body.role,
      employmentType: "full_time",
      paySchedule: "monthly",
      compensationUnit: "monthly",
      compensationAmountUsd: body.compensationAmountUsd,
      weeklyHours: undefined,
      monthlySalaryUsd: body.monthlySalaryUsd,
      startDate: body.startDate,
    });
    try {
      await sponsorInitializeEmployeeVault(
        employee.wallet,
        body.employerWallet ?? "",
      );
    } catch (sponsorError) {
      console.error(
        `Sponsor initialization crashed for ${employee.wallet}:`,
        sponsorError,
      );
    }

    const latestEmployee =
      (await getEmployeeById(body.employerWallet ?? "", employee.id)) ?? employee;

    await saveComplianceEvent({
      actorWallet: body.employerWallet ?? "",
      action: "employees.create",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet ?? "",
      resourceType: "employee",
      resourceId: employee.id,
      status: "success",
      metadata: {
        employeeWallet: employee.wallet,
        privateInitStatus: latestEmployee.privateRecipientInitStatus ?? "pending",
        privateInitReady:
          latestEmployee.privateRecipientInitStatus === "confirmed",
        privateInitError: latestEmployee.privateRecipientInitError ?? null,
      },
    });

    return NextResponse.json({ employee: latestEmployee }, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to create employee";

    return NextResponse.json(
      { error: message },
      { status: isWalletAuthorizationError(error) ? 401 : 400 },
    );
  }
}
