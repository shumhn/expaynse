import { NextRequest, NextResponse } from "next/server";

import { saveComplianceEvent } from "@/lib/server/compliance-store";
import { listEmployees } from "@/lib/server/payroll-store";
import {
  listPayrollProfiles,
  upsertPayrollProfile,
} from "@/lib/server/payroll-runs-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getEmployerWalletFromRequest(request: NextRequest) {
  const employerWallet = request.nextUrl.searchParams
    .get("employerWallet")
    ?.trim();

  if (!employerWallet) {
    throw new Error("Missing employerWallet query parameter");
  }

  return employerWallet;
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

    const [profiles, employees] = await Promise.all([
      listPayrollProfiles(employerWallet),
      listEmployees(employerWallet),
    ]);

    const profileByEmployeeId = new Map(
      profiles.map((profile) => [profile.employeeId, profile]),
    );

    const employeeProfiles = employees.map((employee) => ({
      employee,
      payrollProfile: profileByEmployeeId.get(employee.id) ?? null,
    }));

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.profiles.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-profile",
      status: "success",
      metadata: {
        profileCount: profiles.length,
      },
    });

    return NextResponse.json({ profiles, employeeProfiles });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch payroll profiles";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      employeeId?: string;
      currency?: string;
      baseSalaryMonthly?: number;
      allowancesMonthly?: number;
      fixedDeductionsMonthly?: number;
      taxPercent?: number;
      joinDate?: string;
      exitDate?: string | null;
      status?: "active" | "inactive";
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.employeeId) {
      return badRequest("employeeId is required");
    }

    if (typeof body.baseSalaryMonthly !== "number") {
      return badRequest("baseSalaryMonthly must be a number");
    }

    if (!body.joinDate) {
      return badRequest("joinDate is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const profile = await upsertPayrollProfile({
      employerWallet: body.employerWallet,
      employeeId: body.employeeId,
      currency: body.currency,
      baseSalaryMonthly: body.baseSalaryMonthly,
      allowancesMonthly: body.allowancesMonthly,
      fixedDeductionsMonthly: body.fixedDeductionsMonthly,
      taxPercent: body.taxPercent,
      joinDate: body.joinDate,
      exitDate: body.exitDate,
      status: body.status,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "payroll-runs.profiles.upsert",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "payroll-profile",
      resourceId: profile.id,
      status: "success",
      metadata: {
        employeeId: profile.employeeId,
        baseSalaryMonthly: profile.baseSalaryMonthly,
      },
    });

    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to upsert payroll profile";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
