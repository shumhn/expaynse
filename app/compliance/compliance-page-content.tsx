"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  CircleHelp,
  Download,
  Copy,
  FileSpreadsheet,
  Link2,
  RefreshCw,
  ShieldCheck,
  Clock3,
  Users,
  ReceiptText,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";

import { EmployerLayout } from "@/components/employer-layout";
import { AuditorModal } from "@/components/auditor-modal";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

type AuditorToken = {
  id: string;
  token: string;
  employerWallet: string;
  label?: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ComplianceEvent = {
  id: string;
  date: string;
  actorWallet: string;
  action: string;
  route: string;
  subjectWallet?: string;
  resourceType: string;
  resourceId?: string;
  status: "success" | "failed";
  metadata?: Record<string, string | number | boolean | null>;
};

type StatementSummary = {
  count: number;
  paidCount: number;
  unpaidCount: number;
  failedCount: number;
  queuedCount: number;
  totalNetPay: number;
  totalPaid: number;
};

type StatementRow = {
  statementId: string;
  employee: {
    id: string;
    name: string;
    wallet: string;
  };
  cycle: {
    label: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    status: string;
  };
  payroll: {
    currency: string;
    grossAmount: number;
    deductionsAmount: number;
    taxableAmount: number;
    taxWithheldAmount: number;
    netPayAmount: number;
  };
  payout: {
    status: "unpaid" | "paid" | "failed" | "queued";
    txSignature?: string;
  };
  generatedAt: string;
};

function formatUsd(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeState(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));

  if (days <= 0) return "Expired";
  if (days === 1) return "Expires in 1 day";
  return `Expires in ${days} days`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function shortenWallet(wallet: string) {
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function formatComplianceAction(action: string) {
  const labels: Record<string, string> = {
    "compliance-events.read": "Viewed compliance activity",
    "auditor-tokens.list": "Viewed auditor links",
    "auditor-token.create": "Generated auditor link",
    "auditor-token.revoke": "Revoked auditor link",
    "history.read": "Viewed activity history",
    "compliance-export.owner.read": "Downloaded internal review export",
    "compliance-export.auditor.read": "Downloaded external audit export",
    "compliance-export.employee.read": "Downloaded employee copy",
    "payroll-runs.statements.read.employer": "Viewed payroll statements",
    "payroll-runs.statements.read.employee": "Viewed employee statements",
  };

  return labels[action] ?? action.replaceAll(".", " ");
}

function InfoHint({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[#8f8f95]"
      aria-label={label}
    >
      <CircleHelp size={12} />
    </span>
  );
}

export function CompliancePageContent() {
  const { publicKey, signMessage } = useWallet();
  const [loading, setLoading] = useState(false);
  const [auditorModalOpen, setAuditorModalOpen] = useState(false);
  const [tokens, setTokens] = useState<AuditorToken[]>([]);
  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [statementSummary, setStatementSummary] = useState<StatementSummary | null>(null);
  const [statements, setStatements] = useState<StatementRow[]>([]);

  const walletAddr = publicKey?.toBase58();

  const loadComplianceData = useCallback(async () => {
    if (!walletAddr || !signMessage) return;

    setLoading(true);
    try {
      const [tokenRes, eventsRes, statementsRes] = await Promise.all([
        walletAuthenticatedFetch({
          path: `/api/auditor-tokens?employerWallet=${walletAddr}`,
          method: "GET",
          wallet: walletAddr,
          signMessage,
        }),
        walletAuthenticatedFetch({
          path: `/api/compliance/events?wallet=${walletAddr}&limit=25`,
          method: "GET",
          wallet: walletAddr,
          signMessage,
        }),
        walletAuthenticatedFetch({
          path: `/api/payroll-runs/statements?scope=employer&employerWallet=${walletAddr}`,
          method: "GET",
          wallet: walletAddr,
          signMessage,
        }),
      ]);

      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({ error: "Failed to load auditor tokens" }));
        throw new Error(err.error || "Failed to load auditor tokens");
      }

      if (!eventsRes.ok) {
        const err = await eventsRes.json().catch(() => ({ error: "Failed to load compliance activity" }));
        throw new Error(err.error || "Failed to load compliance activity");
      }

      if (!statementsRes.ok) {
        const err = await statementsRes.json().catch(() => ({ error: "Failed to load payroll statements" }));
        throw new Error(err.error || "Failed to load payroll statements");
      }

      const tokenData = (await tokenRes.json()) as { tokens: AuditorToken[] };
      const eventData = (await eventsRes.json()) as { events: ComplianceEvent[] };
      const statementData = (await statementsRes.json()) as {
        summary: StatementSummary;
        statements: StatementRow[];
      };

      setTokens(tokenData.tokens ?? []);
      setEvents(eventData.events ?? []);
      setStatementSummary(statementData.summary ?? null);
      setStatements(statementData.statements ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load compliance data");
    } finally {
      setLoading(false);
    }
  }, [signMessage, walletAddr]);

  useEffect(() => {
    void loadComplianceData();
  }, [loadComplianceData]);

  const activeTokens = useMemo(
    () =>
      tokens.filter(
        (token) => !token.revoked && new Date(token.expiresAt).getTime() > Date.now(),
      ),
    [tokens],
  );

  const recentStatements = useMemo(() => statements.slice(0, 4), [statements]);
  const recentEvents = useMemo(() => events.slice(0, 4), [events]);

  const handleDownloadExport = useCallback(
    async (scope: "owner" | "auditor" | "employee") => {
      if (!walletAddr || !signMessage) return;

      try {
        const response = await walletAuthenticatedFetch({
          path: `/api/compliance/export?wallet=${walletAddr}&scope=${scope}`,
          method: "GET",
          wallet: walletAddr,
          signMessage,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Failed to export compliance bundle" }));
          throw new Error(err.error || "Failed to export compliance bundle");
        }

        const payload = await response.json();
        const filename = `expaynse-compliance-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
        downloadTextFile(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8;");
        const labels = {
          owner: "Internal review export downloaded",
          auditor: "External audit export downloaded",
          employee: "Employee copy downloaded",
        } as const;
        toast.success(labels[scope]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to export compliance bundle");
      }
    },
    [signMessage, walletAddr],
  );

  const handleDownloadStatementsCsv = useCallback(() => {
    if (statements.length === 0) {
      toast.error("No payroll statements to export yet");
      return;
    }

    const header = [
      "Employee",
      "Wallet",
      "Cycle",
      "Period Start",
      "Period End",
      "Pay Date",
      "Gross",
      "Deductions",
      "Taxable",
      "Tax Withheld",
      "Net Pay",
      "Payout Status",
      "Transaction Signature",
    ];

    const rows = statements.map((statement) => [
      `"${statement.employee.name.replace(/"/g, '""')}"`,
      statement.employee.wallet,
      `"${statement.cycle.label.replace(/"/g, '""')}"`,
      statement.cycle.periodStart,
      statement.cycle.periodEnd,
      statement.cycle.payDate,
      statement.payroll.grossAmount,
      statement.payroll.deductionsAmount,
      statement.payroll.taxableAmount,
      statement.payroll.taxWithheldAmount,
      statement.payroll.netPayAmount,
      statement.payout.status,
      statement.payout.txSignature ?? "",
    ]);

    const csv = [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
    downloadTextFile(
      `expaynse-payroll-statements-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
      "text/csv;charset=utf-8;",
    );
    toast.success("Payroll statements exported");
  }, [statements]);

  const handleRevokeToken = useCallback(
    async (token: AuditorToken) => {
      if (!walletAddr || !signMessage) return;

      try {
        const response = await walletAuthenticatedFetch({
          path: "/api/auditor-tokens",
          method: "DELETE",
          wallet: walletAddr,
          signMessage,
          body: {
            employerWallet: walletAddr,
            token: token.token,
          },
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Failed to revoke auditor token" }));
          throw new Error(err.error || "Failed to revoke auditor token");
        }

        toast.success("Auditor link revoked");
        await loadComplianceData();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to revoke auditor token");
      }
    },
    [loadComplianceData, signMessage, walletAddr],
  );

  const handleCopyAuditLink = useCallback(async (token: AuditorToken) => {
    try {
      const link = `${window.location.origin}/audit/${token.token}`;
      await navigator.clipboard.writeText(link);
      toast.success("Auditor link copied");
    } catch {
      toast.error("Failed to copy auditor link");
    }
  }, []);

  return (
    <EmployerLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#1eba98]/20 bg-[#1eba98]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#1eba98]">
              <ShieldCheck size={12} />
              Compliance Workspace
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Private payroll records with controlled audit access.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#a8a8aa] sm:text-base">
                MagicBlock secures private execution. Expaynse controls disclosure, statements, and auditor review.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void loadComplianceData()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              onClick={() => setAuditorModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-2xl bg-[#1eba98] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#21d4ae]"
            >
              <Link2 size={16} />
              Generate auditor link
            </button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3 xl:gap-5">
          {[
            { icon: KeyRound, label: "Active auditor links", value: activeTokens.length },
            { icon: ReceiptText, label: "Payroll statements", value: statementSummary?.count ?? 0 },
            { icon: Users, label: "Compliance events", value: events.length },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-2xl border border-white/5 bg-[#0a0a0a] px-5 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="inline-flex rounded-xl bg-[#1eba98]/10 p-2.5 text-[#1eba98]">
                    <Icon size={16} />
                  </div>
                  <div>
                    <div className="text-lg font-bold text-white">{item.value}</div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8f8f95]">
                      {item.label}
                    </div>
                  </div>
                </div>
                <InfoHint
                  label={
                    item.label === "Active auditor links"
                      ? "Read-only links you can copy or revoke for external review."
                      : item.label === "Payroll statements"
                        ? "Evidence-ready rows with gross, deductions, withheld tax, and net pay."
                        : "Recent signed access, export, and disclosure actions."
                  }
                />
              </div>
            );
          })}
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white">Share payroll evidence</h2>
                  <InfoHint label="Choose a scoped export for owners, auditors, or employees. Auditor links are separate, read-only access links." />
                </div>
                <p className="mt-1 text-sm text-[#7f7f84]">Share only the records required for review.</p>
              </div>
              <button
                onClick={handleDownloadStatementsCsv}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                <FileSpreadsheet size={16} />
                Statements CSV
              </button>
            </div>

            <div className="mt-5 space-y-2.5">
              {[
                {
                  scope: "owner" as const,
                  title: "Internal review",
                  description: "Full payroll records for your team and finance review.",
                },
                {
                  scope: "auditor" as const,
                  title: "External audit",
                  description: "Redacted payroll evidence for auditors and accountants.",
                },
                {
                  scope: "employee" as const,
                  title: "Employee copy",
                  description: "Personal payroll copy for the connected wallet.",
                },
              ].map((item) => (
                <div
                  key={item.scope}
                  className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                    <p className="mt-1 text-sm text-[#8f8f95]">{item.description}</p>
                  </div>
                  <button
                    onClick={() => void handleDownloadExport(item.scope)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1eba98] px-4 py-2.5 text-sm font-bold text-black transition hover:bg-[#21d4ae] md:min-w-[150px]"
                  >
                    <Download size={15} />
                    Download
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs text-[#7f7f84]">
              <InfoHint label="MagicBlock handles screened private execution. Expaynse handles auditor access, statements, exports, and activity records." />
              Disclosure remains scoped, revocable, and under your control.
            </div>
          </section>

          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white">Active auditor links</h2>
                  <InfoHint label="Time-bounded, read-only links that can be copied or revoked without exposing wallet control." />
                </div>
              </div>
              <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#a8a8aa]">
                {activeTokens.length} active
              </div>
            </div>

            <div className="mt-5 space-y-2.5 overflow-y-auto pr-1">
              {tokens.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-sm text-[#8f8f95]">
                  No auditor links created yet.
                </div>
              ) : (
                tokens.map((token) => {
                  const isExpired = new Date(token.expiresAt).getTime() <= Date.now();
                  const stateLabel = token.revoked
                    ? "Revoked"
                    : isExpired
                      ? "Expired"
                      : "Active";

                  return (
                    <div
                      key={token.id}
                      className="rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white">
                              {token.label?.trim() || "Auditor access link"}
                            </span>
                            <span
                              className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${
                                token.revoked || isExpired
                                  ? "bg-white/10 text-[#a8a8aa]"
                                  : "bg-[#1eba98]/10 text-[#1eba98]"
                              }`}
                            >
                              {stateLabel}
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-[#8f8f95]">
                            {formatRelativeState(token.expiresAt)} · Created {formatDateTime(token.createdAt)}
                          </p>
                          <p className="mt-1 text-xs text-[#6f6f75]">
                            {shortenWallet(token.employerWallet)} · /audit/{token.token.slice(0, 10)}...
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          {!token.revoked && !isExpired ? (
                            <>
                              <button
                                onClick={() => void handleCopyAuditLink(token)}
                                className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-white transition hover:bg-white/10"
                              >
                                <span className="inline-flex items-center gap-1.5">
                                  <Copy size={12} />
                                  Copy
                                </span>
                              </button>
                              <button
                                onClick={() => void handleRevokeToken(token)}
                                className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-white transition hover:bg-white/10"
                              >
                                Revoke
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white">Recent compliance activity</h2>
                  <InfoHint label="Recent signed access, export, and disclosure actions for this employer wallet." />
                </div>
              </div>
              <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#a8a8aa]">
                {recentEvents.length} visible
              </div>
            </div>

            <div className="mt-5 space-y-2.5 overflow-y-auto pr-1">
              {events.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-sm text-[#8f8f95]">
                  No compliance events yet. Create an auditor link or export a bundle to start the audit trail.
                </div>
              ) : (
                recentEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-col gap-2 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">
                          {formatComplianceAction(event.action)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${
                            event.status === "success"
                              ? "bg-[#1eba98]/10 text-[#1eba98]"
                              : "bg-red-500/10 text-red-400"
                          }`}
                        >
                          {event.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#8f8f95]">
                        {event.resourceType.replaceAll("-", " ")}
                        {event.resourceId ? ` · ${event.resourceId}` : ""}
                        {event.subjectWallet ? ` · ${event.subjectWallet.slice(0, 4)}...${event.subjectWallet.slice(-4)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-[#8f8f95]">
                      <Clock3 size={14} />
                      {formatDateTime(event.date)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">Recent payroll statements</h2>
                <InfoHint label="Evidence-ready rows that connect gross pay, withheld tax, net pay, and payout status." />
              </div>

              {statementSummary ? (
                <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-[#a8a8aa]">
                  <span>Visible: {recentStatements.length}</span>
                  <span>Paid: {statementSummary.paidCount}</span>
                  <span>Queued: {statementSummary.queuedCount}</span>
                  <span>Failed: {statementSummary.failedCount}</span>
                </div>
              ) : null}
            </div>

            {recentStatements.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-sm text-[#8f8f95]">
                No statements generated yet.
              </div>
            ) : (
              <div className="mt-5 max-h-[22rem] overflow-auto">
                <table className="min-w-full divide-y divide-white/5">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
                      <th className="pb-3 pr-4">Employee</th>
                      <th className="pb-3 pr-4">Cycle</th>
                      <th className="pb-3 pr-4">Net</th>
                      <th className="pb-3 pr-4">Payout</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {recentStatements.map((statement) => (
                      <tr key={statement.statementId}>
                        <td className="py-4 pr-4">
                          <div className="text-sm font-semibold text-white">{statement.employee.name}</div>
                          <div className="text-xs text-[#8f8f95]">
                            {statement.employee.wallet.slice(0, 4)}...{statement.employee.wallet.slice(-4)}
                          </div>
                        </td>
                        <td className="py-4 pr-4 text-sm text-[#a8a8aa]">
                          <div>{statement.cycle.label}</div>
                          <div className="text-xs text-[#8f8f95]">{formatDateTime(statement.cycle.payDate)}</div>
                        </td>
                        <td className="py-4 pr-4 text-sm font-semibold text-white">
                          {formatUsd(statement.payroll.netPayAmount)}
                        </td>
                        <td className="py-4 pr-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${
                              statement.payout.status === "paid"
                                ? "bg-[#1eba98]/10 text-[#1eba98]"
                                : statement.payout.status === "failed"
                                  ? "bg-red-500/10 text-red-400"
                                  : "bg-white/10 text-[#a8a8aa]"
                            }`}
                          >
                            {statement.payout.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      <AuditorModal
        isOpen={auditorModalOpen}
        onClose={() => {
          setAuditorModalOpen(false);
          void loadComplianceData();
        }}
      />
    </EmployerLayout>
  );
}
