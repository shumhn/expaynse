import { NextRequest, NextResponse } from "next/server";

import {
  deposit,
  type BalanceResponse,
  getPrivateBalance,
} from "@/lib/magicblock-api";
import {
  listEmployeesByWallet,
  markEmployeePrivateRecipientInitialized,
  type PrivateRecipientInitStatus,
} from "@/lib/server/payroll-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

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
  txSignature?: string;
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
  status: PrivateRecipientInitStatus | "unregistered";
  requestedAt: string | null;
  lastAttemptAt: string | null;
  confirmedAt: string | null;
  txSignature: string | null;
  error: string | null;
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
    const initializedEmployee =
      employees.find((employee) => !!employee.privateRecipientInitializedAt) ??
      employees.find(
        (employee) => employee.privateRecipientInitStatus === "confirmed",
      ) ??
      employees[0] ??
      null;
    const initialized = !!(
      initializedEmployee?.privateRecipientInitializedAt ||
      initializedEmployee?.privateRecipientInitStatus === "confirmed"
    );
    const status = !registered
      ? "unregistered"
      : initializedEmployee?.privateRecipientInitStatus ?? "pending";
    const message = !registered
      ? "This wallet is not registered as a Expaynse employee yet."
      : initialized
        ? "Private payroll account is initialized."
        : status === "processing"
          ? "Private payroll account initialization is in progress."
          : status === "failed"
            ? "Private payroll account initialization failed and needs retry."
            : "Private payroll account is not initialized yet.";

    const response: EmployeePrivateInitStatusResponse = {
      employeeWallet,
      registered,
      initialized,
      status,
      requestedAt: initializedEmployee?.privateRecipientInitRequestedAt ?? null,
      lastAttemptAt: initializedEmployee?.privateRecipientInitLastAttemptAt ?? null,
      confirmedAt:
        initializedEmployee?.privateRecipientInitConfirmedAt ??
        initializedEmployee?.privateRecipientInitializedAt ??
        null,
      txSignature: initializedEmployee?.privateRecipientInitTxSignature ?? null,
      error: initializedEmployee?.privateRecipientInitError ?? null,
      message,
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
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as BuildEmployeePrivateInitBody;
    const employeeWallet = assertWallet(
      body.employeeWallet ?? "",
      "Employee wallet",
    );
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employeeWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });
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

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as FinalizeEmployeePrivateInitBody;
    const employeeWallet = assertWallet(
      body.employeeWallet ?? "",
      "Employee wallet",
    );
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employeeWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });
    const initializedAt =
      body.initializedAt?.trim() || new Date().toISOString();
    const txSignature = body.txSignature?.trim() || null;
    const teeAuthToken = body.teeAuthToken?.trim();

    const result = await markEmployeePrivateRecipientInitialized(
      employeeWallet,
      initializedAt,
      txSignature,
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

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
