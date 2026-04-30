import { NextRequest, NextResponse } from "next/server";

import {
  getWalletActivityHistory,
  type ClaimRecord,
  type PayrollRun,
} from "@/lib/server/history-store";
import {
  listComplianceEventsForWallet,
  saveComplianceEvent,
  type ComplianceEvent,
} from "@/lib/server/compliance-store";
import {
  sha256Hex,
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

type ExportScope = "owner" | "auditor" | "employee";

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

function getScopeFromRequest(request: NextRequest): ExportScope {
  const scope = request.nextUrl.searchParams.get("scope")?.trim() ?? "owner";

  if (scope === "owner" || scope === "auditor" || scope === "employee") {
    return scope;
  }

  throw new Error("scope must be owner, auditor, or employee");
}

function inferProfile(walletHistory: {
  payrollRuns: PayrollRun[];
  claimRecords: ClaimRecord[];
}) {
  const hasPayrollRuns = walletHistory.payrollRuns.length > 0;
  const hasClaimRecords = walletHistory.claimRecords.length > 0;

  if (hasPayrollRuns && hasClaimRecords) {
    return "mixed";
  }

  if (hasPayrollRuns) {
    return "employer";
  }

  if (hasClaimRecords) {
    return "employee";
  }

  return "unknown";
}

async function hashAddress(value: string) {
  const fullHash = await sha256Hex(value);
  return `sha256:${fullHash.slice(0, 16)}`;
}

async function mapPayrollRunsForAuditor(records: PayrollRun[]) {
  return Promise.all(
    records.map(async (record) => ({
      id: record.id,
      date: record.date,
      totalAmount: record.totalAmount,
      employeeCount: record.employeeCount,
      recipientCount: record.recipientAddresses.length,
      recipientAddressHashes: await Promise.all(
        record.recipientAddresses.map((address) => hashAddress(address)),
      ),
      transferSig: record.transferSig,
      depositSig: record.depositSig,
      status: record.status,
      privacyConfig: record.privacyConfig,
      providerMeta: record.providerMeta,
    })),
  );
}

async function mapClaimRecordsForAuditor(records: ClaimRecord[]) {
  return Promise.all(
    records.map(async (record) => ({
      id: record.id,
      date: record.date,
      amount: record.amount,
      recipientHash: await hashAddress(record.recipient),
      txSig: record.txSig,
      status: record.status,
      privacyConfig: record.privacyConfig,
      providerMeta: record.providerMeta,
    })),
  );
}

function mapComplianceEventsForAuditor(events: ComplianceEvent[]) {
  return events.map((event) => ({
    id: event.id,
    date: event.date,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    status: event.status,
    metadata: event.metadata,
  }));
}

async function buildScopedExport(args: {
  wallet: string;
  scope: ExportScope;
  history: Awaited<ReturnType<typeof getWalletActivityHistory>>;
  complianceEvents: ComplianceEvent[];
}) {
  const profile = inferProfile(args.history);
  const common = {
    wallet: args.wallet,
    scope: args.scope,
    generatedAt: new Date().toISOString(),
    roleHint: profile,
    retentionNotice:
      "Expaynse compliance exports are wallet-scoped evidence bundles. Keep them under your internal retention and disclosure policy before sharing.",
    summary: {
      payrollRunCount: args.history.payrollRuns.length,
      setupActionCount: args.history.setupActions.length,
      claimRecordCount: args.history.claimRecords.length,
      complianceEventCount: args.complianceEvents.length,
      totalPayrollAmount: args.history.payrollRuns.reduce(
        (sum, record) => sum + record.totalAmount,
        0,
      ),
      totalClaimAmount: args.history.claimRecords.reduce(
        (sum, record) => sum + record.amount,
        0,
      ),
    },
  };

  switch (args.scope) {
    case "auditor":
      return {
        ...common,
        disclosure: {
          level: "redacted-auditor",
          note:
            "Recipient identities are hashed. This export is designed to prove payroll activity and control flow without disclosing raw recipient addresses.",
        },
        records: {
          payrollRuns: await mapPayrollRunsForAuditor(args.history.payrollRuns),
          setupActions: args.history.setupActions,
          claimRecords: await mapClaimRecordsForAuditor(args.history.claimRecords),
          complianceEvents: mapComplianceEventsForAuditor(args.complianceEvents),
        },
      };
    case "employee":
      return {
        ...common,
        disclosure: {
          level: "employee-self-view",
          note:
            "This export contains only the authenticated wallet's own setup, claim, and access records.",
        },
        records: {
          setupActions: args.history.setupActions,
          claimRecords: args.history.claimRecords,
          complianceEvents: args.complianceEvents.filter(
            (event) =>
              event.action.startsWith("history.") ||
              event.action.startsWith("compliance-export."),
          ),
        },
      };
    case "owner":
    default:
      return {
        ...common,
        disclosure: {
          level: "owner-full",
          note:
            "This export contains the authenticated wallet's full Expaynse history and compliance access log.",
        },
        records: {
          payrollRuns: args.history.payrollRuns,
          setupActions: args.history.setupActions,
          claimRecords: args.history.claimRecords,
          complianceEvents: args.complianceEvents,
        },
      };
  }
}

export async function GET(request: NextRequest) {
  try {
    const wallet = getWalletFromRequest(request);
    const scope = getScopeFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: wallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const [history, complianceEvents] = await Promise.all([
      getWalletActivityHistory(wallet),
      listComplianceEventsForWallet(wallet),
    ]);

    const payload = await buildScopedExport({
      wallet,
      scope,
      history,
      complianceEvents,
    });
    const payloadJson = JSON.stringify(payload);
    const integritySha256 = await sha256Hex(payloadJson);

    await saveComplianceEvent({
      actorWallet: wallet,
      action: `compliance-export.${scope}.read`,
      route: request.nextUrl.pathname,
      subjectWallet: wallet,
      resourceType: "compliance-export",
      status: "success",
      metadata: {
        scope,
        integritySha256,
      },
    });

    return NextResponse.json({
      ...payload,
      integrity: {
        algorithm: "sha256",
        digest: integritySha256,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build compliance export";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
