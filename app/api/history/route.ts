import { NextRequest, NextResponse } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import {
  clearWalletActivityHistory,
  getWalletActivityHistory,
  type PrivacyConfigRecord,
  type ProviderMetaRecord,
  saveClaimRecord,
  savePayrollRun,
  saveSetupAction,
  updateSetupActionStatus,
} from "@/lib/server/history-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getWalletFromRequest(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim();

  if (!wallet) {
    throw new Error("Missing wallet query parameter");
  }

  return wallet;
}

async function requireWalletAuthorization(args: {
  request: NextRequest;
  wallet: string;
  body?: string;
}) {
  await verifyAuthorizedWalletRequest({
    headers: args.request.headers,
    expectedWallet: args.wallet,
    method: args.request.method,
    path: `${args.request.nextUrl.pathname}${args.request.nextUrl.search}`,
    body: args.body,
  });
}

function normalizePrivacyConfig(
  value: unknown,
): PrivacyConfigRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const config: PrivacyConfigRecord = {};

  if (input.visibility === "private") {
    config.visibility = "private";
  }

  if (input.fromBalance === "base" || input.fromBalance === "ephemeral") {
    config.fromBalance = input.fromBalance;
  }

  if (input.toBalance === "base" || input.toBalance === "ephemeral") {
    config.toBalance = input.toBalance;
  }

  if (typeof input.minDelayMs === "number" && Number.isFinite(input.minDelayMs)) {
    config.minDelayMs = input.minDelayMs;
  }

  if (typeof input.maxDelayMs === "number" && Number.isFinite(input.maxDelayMs)) {
    config.maxDelayMs = input.maxDelayMs;
  }

  if (typeof input.split === "number" && Number.isFinite(input.split)) {
    config.split = input.split;
  }

  if (typeof input.memo === "string" && input.memo.trim()) {
    config.memo = input.memo.trim();
  }

  if (
    input.destinationStrategy === "connected-wallet" ||
    input.destinationStrategy === "custom-address"
  ) {
    config.destinationStrategy = input.destinationStrategy;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizeProviderMeta(value: unknown): ProviderMetaRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const meta: ProviderMetaRecord = {};

  if (input.provider === "magicblock") {
    meta.provider = "magicblock";
  }

  if (typeof input.sendTo === "string" && input.sendTo.trim()) {
    meta.sendTo = input.sendTo.trim();
  }

  if (
    input.action === "employee-withdrawal" ||
    input.action === "employee-private-transfer" ||
    input.action === "claim"
  ) {
    meta.action = input.action;
  }

  if (
    typeof input.destinationWallet === "string" &&
    input.destinationWallet.trim()
  ) {
    meta.destinationWallet = input.destinationWallet.trim();
  }

  if (typeof input.creditVerified === "boolean") {
    meta.creditVerified = input.creditVerified;
  }

  if (typeof input.errorMessage === "string" && input.errorMessage.trim()) {
    meta.errorMessage = input.errorMessage.trim();
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

const devnetConnection = new Connection(clusterApiUrl("devnet"), "confirmed");

export async function GET(request: NextRequest) {
  try {
    const wallet = getWalletFromRequest(request);
    await requireWalletAuthorization({ request, wallet });
    const history = await getWalletActivityHistory(wallet);

    const failedSetupActions = history.setupActions.filter(
      (action) => action.status === "failed" && !!action.txSig,
    );

    if (failedSetupActions.length > 0) {
      const statuses = await devnetConnection.getSignatureStatuses(
        failedSetupActions
          .map((action) => action.txSig)
          .filter((value): value is string => Boolean(value)),
      );

      await Promise.all(
        failedSetupActions.map(async (action, index) => {
          const status = statuses.value[index];
          if (
            status &&
            !status.err &&
            (status.confirmationStatus === "confirmed" ||
              status.confirmationStatus === "finalized")
          ) {
            await updateSetupActionStatus({
              id: action.id,
              wallet,
              status: "success",
            });
            action.status = "success";
          }
        }),
      );
    }

    await saveComplianceEvent({
      actorWallet: wallet,
      action: "history.read",
      route: request.nextUrl.pathname,
      subjectWallet: wallet,
      resourceType: "history",
      status: "success",
    });

    return NextResponse.json(history);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch history";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = (JSON.parse(rawBody || "{}") as
      | {
          kind?: "payroll-run";
          wallet?: string;
          mode?: "streaming" | "private_payroll";
          totalAmount?: number;
          employeeCount?: number;
          employeeIds?: string[];
          employeeNames?: string[];
          recipientAddresses?: string[];
          depositSig?: string;
          transferSig?: string;
          status?: "success" | "failed";
          privacyConfig?: unknown;
          providerMeta?: unknown;
        }
      | {
          kind?: "setup-action";
          wallet?: string;
          type?: "initialize-mint" | "fund-treasury";
          amount?: number;
          txSig?: string;
          status?: "success" | "failed";
        }
      | {
          kind?: "claim-record";
          wallet?: string;
          amount?: number;
          recipient?: string;
          txSig?: string;
          status?: "success" | "failed" | "submitted";
          privacyConfig?: unknown;
          providerMeta?: unknown;
        });

    if (!body?.kind) {
      return badRequest("kind is required");
    }

    if (!body.wallet) {
      return badRequest("wallet is required");
    }

    await requireWalletAuthorization({
      request,
      wallet: body.wallet,
      body: rawBody,
    });

    switch (body.kind) {
      case "payroll-run": {
        if (typeof body.totalAmount !== "number") {
          return badRequest("totalAmount must be a number");
        }

        if (typeof body.employeeCount !== "number") {
          return badRequest("employeeCount must be a number");
        }

        if (!Array.isArray(body.recipientAddresses)) {
          return badRequest("recipientAddresses must be an array");
        }

        if (!body.status || !["success", "failed", "submitted"].includes(body.status)) {
          return badRequest("status must be success, failed, or submitted");
        }

        const payrollRun = await savePayrollRun({
          wallet: body.wallet,
          mode: body.mode === "private_payroll" ? "private_payroll" : "streaming",
          totalAmount: body.totalAmount,
          employeeCount: body.employeeCount,
          employeeIds: Array.isArray(body.employeeIds)
            ? body.employeeIds.filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0,
              )
            : undefined,
          employeeNames: Array.isArray(body.employeeNames)
            ? body.employeeNames.filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0,
              )
            : undefined,
          recipientAddresses: body.recipientAddresses,
          depositSig: body.depositSig,
          transferSig: body.transferSig,
          status: body.status,
          privacyConfig: normalizePrivacyConfig(body.privacyConfig),
          providerMeta: normalizeProviderMeta(body.providerMeta),
        });
        await saveComplianceEvent({
          actorWallet: body.wallet,
          action: "history.payroll-run.write",
          route: request.nextUrl.pathname,
          subjectWallet: body.wallet,
          resourceType: "history",
          resourceId: payrollRun.id,
          status: "success",
          metadata: {
            employeeCount: payrollRun.employeeCount,
            status: payrollRun.status,
            mode: payrollRun.mode ?? "streaming",
          },
        });

        return NextResponse.json({ payrollRun }, { status: 201 });
      }

      case "setup-action": {
        if (!body.type || !["initialize-mint", "fund-treasury"].includes(body.type)) {
          return badRequest("type must be initialize-mint or fund-treasury");
        }

        if (!body.status || !["success", "failed"].includes(body.status)) {
          return badRequest("status must be success or failed");
        }

        const setupAction = await saveSetupAction({
          wallet: body.wallet,
          type: body.type,
          amount: body.amount,
          txSig: body.txSig,
          status: body.status,
        });
        await saveComplianceEvent({
          actorWallet: body.wallet,
          action: "history.setup-action.write",
          route: request.nextUrl.pathname,
          subjectWallet: body.wallet,
          resourceType: "history",
          resourceId: setupAction.id,
          status: "success",
          metadata: {
            type: setupAction.type,
            status: setupAction.status,
          },
        });

        return NextResponse.json({ setupAction }, { status: 201 });
      }

      case "claim-record": {
        if (typeof body.amount !== "number") {
          return badRequest("amount must be a number");
        }

        if (!body.recipient) {
          return badRequest("recipient is required");
        }

        if (!body.status || !["success", "failed"].includes(body.status)) {
          return badRequest("status must be success or failed");
        }

        const claimRecord = await saveClaimRecord({
          wallet: body.wallet,
          amount: body.amount,
          recipient: body.recipient,
          txSig: body.txSig,
          status: body.status,
          privacyConfig: normalizePrivacyConfig(body.privacyConfig),
          providerMeta: normalizeProviderMeta(body.providerMeta),
        });
        await saveComplianceEvent({
          actorWallet: body.wallet,
          action: "history.claim-record.write",
          route: request.nextUrl.pathname,
          subjectWallet: body.wallet,
          resourceType: "history",
          resourceId: claimRecord.id,
          status: "success",
          metadata: {
            status: claimRecord.status,
          },
        });

        return NextResponse.json({ claimRecord }, { status: 201 });
      }

      default:
        return badRequest("Unsupported history kind");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save history";
    return badRequest(message);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const wallet = getWalletFromRequest(request);
    await requireWalletAuthorization({ request, wallet });
    const result = await clearWalletActivityHistory(wallet);
    await saveComplianceEvent({
      actorWallet: wallet,
      action: "history.clear",
      route: request.nextUrl.pathname,
      subjectWallet: wallet,
      resourceType: "history",
      status: "success",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to clear history";
    return badRequest(message);
  }
}
