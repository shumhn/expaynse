"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Download,
  Copy,
  FileSpreadsheet,
  Link2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Clock3,
  Users,
  ReceiptText,
  CheckCircle2,
  XCircle,
  KeyRound,
  Eye,
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

  const recentStatements = useMemo(() => statements.slice(0, 6), [statements]);

  const complianceFlowSteps = useMemo(
    () => [
      {
        title: "Prepare evidence",
        body: "Payroll statements, payout status, and wallet-scoped history are assembled into export-ready records.",
      },
      {
        title: "Issue scoped access",
        body: "Employers generate revocable auditor links with clear labels and expiry windows for each review engagement.",
      },
      {
        title: "Review privately",
        body: "Auditors see read-only payroll evidence without transaction authority or unrestricted salary disclosure.",
      },
      {
        title: "Revoke when done",
        body: "Once the audit engagement ends, the employer can revoke access without affecting payroll execution.",
      },
    ],
    [],
  );

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
        toast.success(`${scope[0].toUpperCase()}${scope.slice(1)} export downloaded`);
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
      <div className="space-y-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#1eba98]/20 bg-[#1eba98]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#1eba98]">
              <ShieldCheck size={12} />
              Compliance Workspace
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Private payroll, auditable by design
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[#a8a8aa] sm:text-base">
                MagicBlock provides the screened private execution layer. Expaynse adds
                signed access control, scoped auditor links, payroll statements, and
                exportable evidence bundles for real payroll operations.
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

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-5">
            <div className="mb-4 inline-flex rounded-2xl bg-[#1eba98]/10 p-3 text-[#1eba98]">
              <KeyRound size={18} />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Active auditor links
            </p>
            <div className="mt-2 text-3xl font-bold text-white">{activeTokens.length}</div>
            <p className="mt-2 text-sm text-[#a8a8aa]">
              Revocable read-only access for external accountants or auditors.
            </p>
          </div>

          <div className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-5">
            <div className="mb-4 inline-flex rounded-2xl bg-[#1eba98]/10 p-3 text-[#1eba98]">
              <ReceiptText size={18} />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Payroll statements
            </p>
            <div className="mt-2 text-3xl font-bold text-white">{statementSummary?.count ?? 0}</div>
            <p className="mt-2 text-sm text-[#a8a8aa]">
              Statement records with gross, deductions, withheld tax, and net pay.
            </p>
          </div>

          <div className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-5">
            <div className="mb-4 inline-flex rounded-2xl bg-[#1eba98]/10 p-3 text-[#1eba98]">
              <CheckCircle2 size={18} />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Paid statements
            </p>
            <div className="mt-2 text-3xl font-bold text-white">{statementSummary?.paidCount ?? 0}</div>
            <p className="mt-2 text-sm text-[#a8a8aa]">
              Net payroll already disbursed with transaction-linked payout records.
            </p>
          </div>

          <div className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-5">
            <div className="mb-4 inline-flex rounded-2xl bg-[#1eba98]/10 p-3 text-[#1eba98]">
              <Users size={18} />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Compliance events
            </p>
            <div className="mt-2 text-3xl font-bold text-white">{events.length}</div>
            <p className="mt-2 text-sm text-[#a8a8aa]">
              Signed access, export, and disclosure actions recorded in the audit trail.
            </p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">Export controls</h2>
                <p className="mt-1 text-sm text-[#a8a8aa]">
                  Generate the exact disclosure bundle needed for owners, auditors, or employees.
                </p>
              </div>
              <button
                onClick={handleDownloadStatementsCsv}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                <FileSpreadsheet size={16} />
                Export statements CSV
              </button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {[
                {
                  scope: "owner" as const,
                  title: "Owner bundle",
                  description:
                    "Full wallet-scoped history, statement records, and compliance events for internal review.",
                },
                {
                  scope: "auditor" as const,
                  title: "Auditor bundle",
                  description:
                    "Redacted export with hashed recipients and proof of control flow for external review.",
                },
                {
                  scope: "employee" as const,
                  title: "Employee bundle",
                  description:
                    "Self-view export for the authenticated wallet’s own claim and access history.",
                },
              ].map((item) => (
                <div
                  key={item.scope}
                  className="rounded-2xl border border-white/5 bg-white/[0.02] p-5"
                >
                  <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-white">
                    {item.title}
                  </h3>
                  <p className="mt-3 min-h-[72px] text-sm leading-6 text-[#a8a8aa]">
                    {item.description}
                  </p>
                  <button
                    onClick={() => void handleDownloadExport(item.scope)}
                    className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-[#1eba98] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#21d4ae]"
                  >
                    <Download size={16} />
                    Download JSON
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div>
              <h2 className="text-xl font-bold text-white">MagicBlock compliance boundary</h2>
              <p className="mt-1 text-sm text-[#a8a8aa]">
                What MagicBlock provides versus what Expaynse records at the application layer.
              </p>
            </div>

            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-[#1eba98]/15 bg-[#1eba98]/5 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck size={18} className="mt-0.5 text-[#1eba98]" />
                  <div>
                    <h3 className="text-sm font-bold text-white">MagicBlock layer</h3>
                    <p className="mt-1 text-sm leading-6 text-[#a8a8aa]">
                      Private execution, access-controlled PER state, and the screened execution boundary
                      that powers real-time payroll without exposing raw salary flows on public RPCs.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                <div className="flex items-start gap-3">
                  <ShieldAlert size={18} className="mt-0.5 text-[#1eba98]" />
                  <div>
                    <h3 className="text-sm font-bold text-white">Expaynse application layer</h3>
                    <p className="mt-1 text-sm leading-6 text-[#a8a8aa]">
                      Wallet-signed authorization, auditor links, statement records, and exportable evidence
                      bundles so payroll activity can be shared intentionally instead of leaked by default.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
          <div>
            <h2 className="text-xl font-bold text-white">Compliance flow</h2>
            <p className="mt-1 text-sm text-[#a8a8aa]">
              Private by default, auditable on demand. This is the operating workflow Expaynse adds on top of MagicBlock&apos;s screened private execution layer.
            </p>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-4">
            {complianceFlowSteps.map((step, index) => (
              <div
                key={step.title}
                className="rounded-2xl border border-white/5 bg-white/[0.02] p-5"
              >
                <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#1eba98]">
                  Step {index + 1}
                </div>
                <h3 className="mt-3 text-sm font-bold uppercase tracking-[0.16em] text-white">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[#a8a8aa]">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
          <div>
            <h2 className="text-xl font-bold text-white">Selective disclosure presets</h2>
            <p className="mt-1 text-sm text-[#a8a8aa]">
              Compliance should stay private by default and become visible only to the right audience.
            </p>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {[
              {
                title: "Owner view",
                icon: ShieldCheck,
                description:
                  "Internal payroll operations view with full wallet-scoped history, statement records, and access events.",
              },
              {
                title: "Auditor view",
                icon: Eye,
                description:
                  "Redacted disclosure for external review. Recipients are hashed in exports, while payout flow and evidence remain inspectable.",
              },
              {
                title: "Employee view",
                icon: Users,
                description:
                  "Self-service bundle limited to the authenticated worker’s own claim, statement, and access history.",
              },
            ].map((preset) => {
              const Icon = preset.icon;
              return (
                <div
                  key={preset.title}
                  className="rounded-2xl border border-white/5 bg-white/[0.02] p-5"
                >
                  <div className="inline-flex rounded-2xl bg-[#1eba98]/10 p-3 text-[#1eba98]">
                    <Icon size={18} />
                  </div>
                  <h3 className="mt-4 text-sm font-bold uppercase tracking-[0.16em] text-white">
                    {preset.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#a8a8aa]">
                    {preset.description}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white">Recent compliance activity</h2>
                <p className="mt-1 text-sm text-[#a8a8aa]">
                  Signed access and disclosure events recorded for this employer wallet.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {events.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-sm text-[#8f8f95]">
                  No compliance events yet. Create an auditor link or export a bundle to start the audit trail.
                </div>
              ) : (
                events.slice(0, 10).map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">{event.action}</span>
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
                      <p className="mt-1 text-sm text-[#a8a8aa]">
                        {event.resourceType}
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
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white">Auditor links</h2>
                <p className="mt-1 text-sm text-[#a8a8aa]">
                  Read-only access you can revoke without exposing raw wallet control.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
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
                      className="rounded-2xl border border-white/5 bg-white/[0.02] p-4"
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

        <section className="rounded-3xl border border-white/5 bg-[#0a0a0a] p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">Recent payroll statements</h2>
              <p className="mt-1 text-sm text-[#a8a8aa]">
                Evidence-ready payroll rows that map gross pay to net payout status.
              </p>
            </div>

            {statementSummary ? (
              <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-[#a8a8aa]">
                <span>Paid: {statementSummary.paidCount}</span>
                <span>Queued: {statementSummary.queuedCount}</span>
                <span>Failed: {statementSummary.failedCount}</span>
                <span>Total net: {formatUsd(statementSummary.totalNetPay)}</span>
              </div>
            ) : null}
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full divide-y divide-white/5">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
                  <th className="pb-3 pr-4">Employee</th>
                  <th className="pb-3 pr-4">Cycle</th>
                  <th className="pb-3 pr-4">Gross</th>
                  <th className="pb-3 pr-4">Tax</th>
                  <th className="pb-3 pr-4">Net</th>
                  <th className="pb-3 pr-4">Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {recentStatements.length === 0 ? (
                  <tr>
                    <td className="py-6 text-sm text-[#8f8f95]" colSpan={6}>
                      No statements generated yet.
                    </td>
                  </tr>
                ) : (
                  recentStatements.map((statement) => (
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
                      <td className="py-4 pr-4 text-sm text-white">
                        {formatUsd(statement.payroll.grossAmount)}
                      </td>
                      <td className="py-4 pr-4 text-sm text-white">
                        {formatUsd(statement.payroll.taxWithheldAmount)}
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
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
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
