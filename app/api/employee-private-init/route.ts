import { NextRequest, NextResponse } from "next/server";

import {
  deposit,
  type BalanceResponse,
  getPrivateBalance,
} from "@/lib/magicblock-api";
import {
  listEmployeesByWallet,
  markEmployeePrivateRecipientInitialized,
} from "@/lib/server/payroll-store";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function successResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status });
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

type BuildEmployeePrivateInitBody = {
  employeeWallet?: string;
};

type FinalizeEmployeePrivateInitBody = {
  employeeWallet?: string;
  initializedAt?: string;
  teeAuthToken?: string;
};

type BuildEmployeePrivateInitResponse = {
  employeeWallet: string;
  amountMicro: number;
  message: string;
  transaction: {
    transactionBase64: string;
    sendTo: "base" | "ephemeral";
  };
};

type EmployeePrivateInitStatusResponse = {
  employeeWallet: string;
  registered: boolean;
  initialized: boolean;
  message: string;
};

type FinalizeEmployeePrivateInitResponse = {
  employeeWallet: string;
  initializedAt: string;
  privateBalance?: BalanceResponse | null;
  message: string;
};

const INIT_AMOUNT_UI = 0.000001;

export async function GET(request: NextRequest) {
  try {
    const employeeWallet = assertWallet(
      request.nextUrl.searchParams.get("employeeWallet") ?? "",
      "Employee wallet",
    );

    const employees = await listEmployeesByWallet(employeeWallet);
    const registered = employees.length > 0;
    const initialized = employees.some(
      (employee) => !!employee.privateRecipientInitializedAt,
    );

    const response: EmployeePrivateInitStatusResponse = {
      employeeWallet,
      registered,
      initialized,
      message: !registered
        ? "This wallet is not registered as a Expaynse employee yet."
        : initialized
          ? "Private payroll account is initialized."
          : "Private payroll account is not initialized yet.",
    };

    return successResponse(response);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load employee private initialization status";

    return badRequest(message);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BuildEmployeePrivateInitBody;
    const employeeWallet = assertWallet(
      body.employeeWallet ?? "",
      "Employee wallet",
    );
    const employees = await listEmployeesByWallet(employeeWallet);

    if (employees.length === 0) {
      return badRequest(
        "This wallet is not registered as a Expaynse employee yet.",
        403,
      );
    }

    const build = await deposit(employeeWallet, INIT_AMOUNT_UI);

    if (!build.transactionBase64) {
      return badRequest(
        "Employee private initialization did not return a transaction",
        500,
      );
    }

    const response: BuildEmployeePrivateInitResponse = {
      employeeWallet,
      amountMicro: 1,
      message:
        "Sign this one-time self-initialization transaction to activate your private payroll recipient account.",
      transaction: {
        transactionBase64: build.transactionBase64,
        sendTo:
          build.sendTo === "ephemeral" || build.sendTo === "base"
            ? build.sendTo
            : "base",
      },
    };

    return successResponse(response, 201);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build employee private initialization";

    return badRequest(message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as FinalizeEmployeePrivateInitBody;
    const employeeWallet = assertWallet(
      body.employeeWallet ?? "",
      "Employee wallet",
    );
    const initializedAt =
      body.initializedAt?.trim() || new Date().toISOString();
    const teeAuthToken = body.teeAuthToken?.trim();

    const result = await markEmployeePrivateRecipientInitialized(
      employeeWallet,
      initializedAt,
    );

    let privateBalance: BalanceResponse | null = null;
    if (teeAuthToken) {
      try {
        privateBalance = await getPrivateBalance(employeeWallet, teeAuthToken);
      } catch {
        privateBalance = null;
      }
    }

    const response: FinalizeEmployeePrivateInitResponse = {
      employeeWallet: result.employeeWallet,
      initializedAt: result.initializedAt,
      privateBalance,
      message:
        "Employee private payroll recipient initialization recorded successfully.",
    };

    return successResponse(response, 200);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize employee private initialization";

    return badRequest(message);
  }
}
