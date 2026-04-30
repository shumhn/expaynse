"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  ArrowLeft,
  Calendar,
  Loader2,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import { getOrCreateCachedTeeToken, loadCachedTeeToken } from "@/lib/client/tee-auth-cache";
import { fetchTeeAuthToken, isJwtExpired } from "@/lib/magicblock-api";
import {
  getAccruedInCycle,
  getScheduleCycleSnapshot,
  ratePerSecondToMonthlyUsd,
} from "@/lib/payroll-math";
import {
  payoutModeSummary,
  type PayrollPayoutMode,
} from "@/lib/payroll-payout-mode";

interface Employee {
  id: string;
  wallet: string;
  name: string;
  department?: string;
  role?: string;
  employmentType?: "full_time" | "part_time" | "contract";
  compensationUnit?: "monthly" | "weekly" | "hourly";
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  compensationAmountUsd?: number;
  monthlySalaryUsd?: number;
  weeklyHours?: number;
  startDate?: string | null;
  createdAt: string;
}

interface StreamInfo {
  id: string;
  employeeId: string;
  status: "active" | "paused" | "stopped";
  ratePerSecond: number;
  startsAt?: string | null;
  payoutMode?: PayrollPayoutMode;
  employeePda?: string | null;
  privatePayrollPda?: string | null;
  delegatedAt: string | null;
  checkpointCrankStatus?: "idle" | "pending" | "active" | "failed" | "stopped" | null;
  totalPaid: number;
}

interface StatementRow {
  statementId: string;
  cycle: {
    id: string;
    label: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    status: string;
  };
  payroll: {
    currency: string;
    netPayAmount: number;
    grossAmount: number;
    baseSalaryAmount: number;
    activeDays: number;
    periodDays: number;
  };
  payout: {
    status: "unpaid" | "paid" | "failed" | "queued";
    txSignature?: string;
    paidAt?: string;
  };
}

interface PreviewResponse {
  preview: {
    claimableAmountMicro: string;
    effectiveClaimableAmountMicro: string;
  };
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function getPrivateReadiness(stream: StreamInfo | null) {
  if (!stream) {
    return {
      label: "Not wired",
      className: "bg-white/[0.04] text-[#8f8f95] border-white/10",
    };
  }

  if (stream.privatePayrollPda && stream.employeePda && stream.delegatedAt) {
    return {
      label: "PER Ready",
      className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    };
  }

  if (stream.checkpointCrankStatus === "pending" || stream.checkpointCrankStatus === "active") {
    return {
      label: "Syncing",
      className: "bg-blue-500/15 text-blue-300 border-blue-400/30",
    };
  }

  return {
    label: "Needs sync",
    className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  };
}

function formatCompensationBasis(employee: Employee | null) {
  if (
    !employee ||
    !Number.isFinite(employee.compensationAmountUsd) ||
    !employee.compensationAmountUsd
  ) {
    return null;
  }

  if (employee.compensationUnit === "hourly") {
    return `${formatCurrency(employee.compensationAmountUsd)}/hr`;
  }

  if (employee.compensationUnit === "weekly") {
    return `${formatCurrency(employee.compensationAmountUsd)}/week`;
  }

  return `${formatCurrency(employee.compensationAmountUsd)}/month`;
}

function toUtcDateKey(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

export default function EmployeeStatementPage() {
  const params = useParams<{ employeeId: string }>();
  const employeeId = params?.employeeId;
  const { publicKey, signMessage } = useWallet();
  const walletAddr = publicKey?.toBase58();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [claimableNow, setClaimableNow] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tokenCache = useRef<string | null>(null);
  const cycleSnapshot = getScheduleCycleSnapshot(employee?.paySchedule);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!walletAddr || !signMessage || !employeeId) {
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const [employeeRes, streamRes, statementRes] = await Promise.all([
          walletAuthenticatedFetch({
            wallet: walletAddr,
            signMessage,
            path: `/api/employees?employerWallet=${walletAddr}`,
          }),
          walletAuthenticatedFetch({
            wallet: walletAddr,
            signMessage,
            path: `/api/streams?employerWallet=${walletAddr}`,
          }),
          walletAuthenticatedFetch({
            wallet: walletAddr,
            signMessage,
            path: `/api/payroll-runs/statements?scope=employer&employerWallet=${walletAddr}&employeeId=${employeeId}`,
          }),
        ]);

        const employeeJson = await employeeRes.json();
        const streamJson = await streamRes.json();
        const statementJson = await statementRes.json();

        if (!employeeRes.ok) {
          throw new Error(employeeJson.error || "Failed to load employee");
        }

        const nextEmployee =
          ((employeeJson.employees ?? []) as Employee[]).find(
            (entry) => entry.id === employeeId,
          ) ?? null;
        setEmployee(nextEmployee);

        const nextStream =
          ((streamJson.streams ?? []) as StreamInfo[]).find(
            (entry) => entry.employeeId === employeeId,
          ) ?? null;
        setStream(nextStream);

        if (statementRes.ok) {
          setStatements((statementJson.statements ?? []) as StatementRow[]);
        }

        if (!nextStream || !publicKey) {
          setClaimableNow(null);
          return;
        }

        if (tokenCache.current && isJwtExpired(tokenCache.current)) {
          tokenCache.current = null;
        }

        if (!tokenCache.current) {
          tokenCache.current =
            loadCachedTeeToken(publicKey.toBase58()) ??
            (await getOrCreateCachedTeeToken(publicKey.toBase58(), async () =>
              fetchTeeAuthToken(publicKey, signMessage),
            ));
        }

        const previewRes = await fetch(
          `/api/payroll/preview?employerWallet=${walletAddr}&streamId=${nextStream.id}`,
          {
            headers: {
              Authorization: `Bearer ${tokenCache.current}`,
            },
          },
        );

        if (!previewRes.ok) {
          setClaimableNow(null);
          return;
        }

        const previewJson = (await previewRes.json()) as PreviewResponse;
        setClaimableNow(
          Number(previewJson.preview.effectiveClaimableAmountMicro) / 1_000_000,
        );
      } catch (error: unknown) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to load employee statement",
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [employeeId, publicKey, signMessage, walletAddr]);

  const monthlySalary =
    employee?.monthlySalaryUsd ??
    (stream ? ratePerSecondToMonthlyUsd(stream.ratePerSecond) : 0);
  const cycleTarget = stream
    ? stream.ratePerSecond * cycleSnapshot.totalSeconds
    : 0;
  const earnedThisMonth = stream
    ? Math.min(
        Math.max(cycleTarget, 0),
        getAccruedInCycle({
          ratePerSecond: stream.ratePerSecond,
          cycleStart: cycleSnapshot.start,
          cycleTotalSeconds: cycleSnapshot.totalSeconds,
          nowMs,
          startsAt: stream.startsAt ?? employee?.startDate ?? null,
        }),
      )
    : 0;
  const claimedThisMonth =
    claimableNow !== null
      ? Math.max(0, earnedThisMonth - claimableNow)
      : statements
          .filter(
            (statement) =>
              toUtcDateKey(statement.cycle.periodStart) ===
                toUtcDateKey(cycleSnapshot.start) &&
              toUtcDateKey(statement.cycle.periodEnd) ===
                toUtcDateKey(cycleSnapshot.end),
          )
          .reduce((sum, statement) => sum + statement.payroll.netPayAmount, 0);
  const remainingThisMonth = Math.max(cycleTarget - earnedThisMonth, 0);
  const privateReadiness = getPrivateReadiness(stream);
  const compensationBasis = formatCompensationBasis(employee);

  return (
    <EmployerLayout>
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/people"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#8f8f95] hover:text-white no-underline"
          >
            <ArrowLeft size={14} />
            Back to People
          </Link>
        </div>

        {loading ? (
          <div className="py-24 flex flex-col items-center justify-center">
            <Loader2 size={28} className="animate-spin text-[#1eba98] mb-4" />
            <p className="text-sm text-[#8f8f95]">Loading employee statement...</p>
          </div>
        ) : !employee ? (
          <div className="bg-[#0a0a0a] border border-white/10 rounded-[2rem] p-10 text-center">
            <p className="text-lg font-semibold text-white">
              Employee not found
            </p>
            <p className="text-sm text-[#8f8f95] mt-2">
              This employee may not belong to your connected employer wallet.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-6 mb-8">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8f8f95] mb-2">
                  Employee Profile
                </p>
                <h1 className="text-3xl font-bold text-white tracking-tight">
                  {employee.name}
                </h1>
                {(employee.role || employee.department) && (
                  <p className="text-sm text-[#8f8f95] mt-2">
                    {[employee.role, employee.department].filter(Boolean).join(" · ")}
                  </p>
                )}
                <p className="text-sm text-[#8f8f95] mt-2 font-mono">
                  {employee.wallet}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border text-[11px] font-bold uppercase tracking-widest ${privateReadiness.className}`}>
                  <ShieldCheck size={14} />
                  {privateReadiness.label}
                </div>
                <Link
                  href={`/disburse?employee=${employee.id}`}
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-white no-underline transition-colors hover:bg-white/10"
                >
                  Open Payroll
                </Link>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 mb-8">
              <div className="bg-[#0a0a0a] border border-white/10 rounded-[1.5rem] p-5">
                <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-2">
                  Monthly equivalent
                </p>
                <p className="text-2xl font-bold text-white">
                  {formatCurrency(monthlySalary)}
                </p>
                {compensationBasis && (
                  <p className="text-xs text-[#8f8f95] mt-2">{compensationBasis}</p>
                )}
              </div>
              <div className="bg-[#0a0a0a] border border-white/10 rounded-[1.5rem] p-5">
                <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-2">
                  Earned this cycle
                </p>
                <p className="text-2xl font-bold text-white">
                  {formatCurrency(earnedThisMonth)}
                </p>
              </div>
              <div className="bg-[#0a0a0a] border border-white/10 rounded-[1.5rem] p-5">
                <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-2">
                  Claimed / paid
                </p>
                <p className="text-2xl font-bold text-white">
                  {formatCurrency(claimedThisMonth)}
                </p>
              </div>
              <div className="bg-[#0a0a0a] border border-white/10 rounded-[1.5rem] p-5">
                <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-2">
                  Remaining this cycle
                </p>
                <p className="text-2xl font-bold text-white">
                  {formatCurrency(remainingThisMonth)}
                </p>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr] mb-8">
              <div className="bg-[#0a0a0a] border border-white/10 rounded-[2rem] p-6 shadow-sm">
                <div className="flex items-center gap-2 mb-5">
                  <Calendar size={16} className="text-[#8f8f95]" />
                  <h2 className="text-lg font-bold text-white">
                    Current Cycle
                  </h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Period
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {cycleSnapshot.start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} - {cycleSnapshot.end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Stream starts
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {new Date(
                        stream?.startsAt ?? employee.startDate ?? employee.createdAt,
                      ).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Per second
                    </p>
                    <p className="text-sm font-semibold text-white font-mono">
                      {stream ? `${stream.ratePerSecond.toFixed(8)} USDC` : "Unavailable"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Claimable now
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {claimableNow !== null ? formatCurrency(claimableNow) : "Preview unavailable"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-[#0a0a0a] border border-white/10 rounded-[2rem] p-6 shadow-sm">
                <div className="flex items-center gap-2 mb-5">
                  <Wallet size={16} className="text-[#8f8f95]" />
                  <h2 className="text-lg font-bold text-white">
                    Private Stream Health
                  </h2>
                </div>
                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Settlement mode
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {payoutModeSummary(stream?.payoutMode ?? "base")}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Delegation
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {stream?.delegatedAt ? "Complete" : "Pending"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-[#8f8f95] mb-1">
                      Checkpoint status
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {stream?.checkpointCrankStatus ?? "idle"}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#0a0a0a] border border-white/10 rounded-[2rem] overflow-hidden">
              <div className="px-6 py-5 border-b border-white/10">
                <h2 className="text-lg font-bold text-white">
                  Statement History
                </h2>
                <p className="text-sm text-[#8f8f95] mt-1">
                  Historical payroll cycles and payout status for this employee.
                </p>
              </div>
              <div className="grid grid-cols-[1.3fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-3 text-[11px] font-bold uppercase tracking-wider text-[#8f8f95] border-b border-white/10">
                <span>Cycle</span>
                <span>Pay date</span>
                <span>Net pay</span>
                <span>Status</span>
                <span>Days active</span>
              </div>
              {statements.length === 0 ? (
                <div className="px-6 py-14 text-center text-sm text-[#8f8f95]">
                  No generated statements yet for this employee.
                </div>
              ) : (
                statements.map((statement) => (
                  <div
                    key={statement.statementId}
                    className="grid grid-cols-[1.3fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-4 border-b border-white/5 text-sm items-center"
                  >
                    <div>
                      <p className="font-semibold text-white">
                        {statement.cycle.label}
                      </p>
                      <p className="text-xs text-[#8f8f95] mt-1">
                        {new Date(statement.cycle.periodStart).toLocaleDateString()} - {new Date(statement.cycle.periodEnd).toLocaleDateString()}
                      </p>
                    </div>
                    <span className="text-[#b6b6bc]">
                      {new Date(statement.cycle.payDate).toLocaleDateString()}
                    </span>
                    <span className="font-semibold text-white">
                      {formatCurrency(statement.payroll.netPayAmount)}
                    </span>
                    <span className="inline-flex items-center w-fit px-2.5 py-1 rounded-lg text-[11px] font-bold border border-white/10 bg-white/5 text-white">
                      {statement.payout.status}
                    </span>
                    <span className="text-[#b6b6bc]">
                      {statement.payroll.activeDays}/{statement.payroll.periodDays}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </EmployerLayout>
  );
}
