
"use client";

import { useEffect, useMemo } from "react";
import {
  Loader2,
  ShieldCheck,
  RefreshCw,
  LogOut,
  CircleDollarSign
} from "lucide-react";
import Link from "next/link";
import { EmployeeLayout } from "@/components/employee-layout";
import { useClaimData } from "@/components/claim/use-claim-data";
import {
  formatUsdc,
  getCurrentCycleSnapshot,
  getStatusMeta,
  getLiveStateCopy,
  microToUsdc,
  computeLiveClaimableAmountMicro,
} from "@/components/claim/claim-utils";

export default function ClaimDashboardPage() {
  const {
    publicKey,
    privBalance,
    payrollSummary,
    payrollSummaryError,
    loadingPayrollSummary,
    magicBlockHealth,
    fetchEmployeePayrollSummary,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    privateAccountInitialized,
    registeredEmployeeWallet,
    liveNowMs,
  } = useClaimData();

  const cycleInfo = useMemo(() => getCurrentCycleSnapshot(), []);

  useEffect(() => {
    if (publicKey) {
      void fetchPrivateInitStatus({ silent: true });
      void fetchPrivateBalance({ silent: true, interactive: true });
      void fetchEmployeePayrollSummary({ silent: false });
    }
  }, [publicKey, fetchPrivateInitStatus, fetchPrivateBalance, fetchEmployeePayrollSummary]);

  const primaryPayrollStream = payrollSummary?.streams?.[0];
  const hasPrivatePayrollMode =
    payrollSummary?.employees?.some(
      (employee) => employee.payrollMode === "private_payroll",
    ) ?? false;
  const canonicalSnapshot = primaryPayrollStream?.snapshot ?? null;
  const runtimeStatus = canonicalSnapshot?.status ?? primaryPayrollStream?.stream.status ?? null;
  const statusMeta = runtimeStatus ? getStatusMeta(runtimeStatus) : null;
  const StatusIcon = statusMeta?.icon;
  const hasLiveSnapshot = Boolean(canonicalSnapshot && primaryPayrollStream?.liveState?.ready);
  const correctionPollMs = hasLiveSnapshot ? 4000 : 8000;
  useEffect(() => {
    if (!publicKey) return;
    const poll = setInterval(() => {
      void fetchPrivateBalance({ silent: true });
      void fetchEmployeePayrollSummary({ silent: true, interactive: false });
    }, correctionPollMs);
    return () => clearInterval(poll);
  }, [
    publicKey,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    correctionPollMs,
  ]);

  const exactClaimableAmountMicro =
    hasLiveSnapshot && canonicalSnapshot
      ? computeLiveClaimableAmountMicro({
          snapshot: canonicalSnapshot,
          nowMs: liveNowMs,
        })
      : null;
  const monthlySalaryAmount = canonicalSnapshot?.monthlyCapUsd ?? null;
  const claimableNowAmount = hasLiveSnapshot ? microToUsdc(exactClaimableAmountMicro) : null;
  const paidThisCycleAmount = hasLiveSnapshot ? microToUsdc(canonicalSnapshot?.paidThisCycleMicro) : null;
  const earnedThisMonthAmount =
    claimableNowAmount !== null && paidThisCycleAmount !== null
      ? paidThisCycleAmount + claimableNowAmount
      : null;
  const remainingThisMonthAmount =
    earnedThisMonthAmount !== null && monthlySalaryAmount !== null
      ? Math.max(0, monthlySalaryAmount - earnedThisMonthAmount)
      : null;
  const claimedThisMonthAmount = hasLiveSnapshot && primaryPayrollStream ? primaryPayrollStream.stream.totalPaid : null;

  const employmentStatusLabel = !primaryPayrollStream
    ? "No stream"
    : hasLiveSnapshot
      ? runtimeStatus === "active"
        ? "Full Time"
        : "On Hold"
      : "Awaiting PER sync";
  const nextReleaseLabel = hasLiveSnapshot
    ? "Auto-accruing in real-time"
    : "Sign + refresh to load live PER state";
  const privateBalanceAmount = Number.parseFloat(privBalance ?? "0");
  const employeeExperienceState = !registeredEmployeeWallet
    ? "not_registered"
    : !privateAccountInitialized
      ? "needs_private_init"
      : privateBalanceAmount > 0
        ? "balance_available"
        : hasLiveSnapshot
          ? "ready_to_claim"
          : "waiting_for_employer";

  const employeeExperienceCopy = {
    not_registered: {
      eyebrow: "Step 1",
      title: "This wallet is not on payroll yet",
      body: "Ask your employer to add this wallet to your payroll roster before you try to claim salary.",
      ctaHref: "/claim/withdraw",
      ctaLabel: "Open Claim Center",
    },
    needs_private_init: {
      eyebrow: "Step 2",
      title: "Set up your private account once",
      body: "Your employer has added you, but your private receiving account still needs a one-time setup before salary can arrive.",
      ctaHref: "/claim/withdraw",
      ctaLabel: "Set Up Private Account",
    },
    waiting_for_employer: {
      eyebrow: "Step 3",
      title: hasPrivatePayrollMode
        ? "Waiting for your next private payroll payout"
        : "Waiting for payroll activation",
      body: hasPrivatePayrollMode
        ? "Your private account is ready. Your employer can now send salary privately, and it will appear in your private balance when paid."
        : "Your private account is ready. Your employer still needs to finish payroll setup before new salary becomes claimable.",
      ctaHref: "/claim/balances",
      ctaLabel: "Check Payroll Status",
    },
    ready_to_claim: {
      eyebrow: "Step 4",
      title: hasPrivatePayrollMode
        ? "Private salary is available"
        : "Salary is ready to claim",
      body: hasPrivatePayrollMode
        ? "Your employer has sent private payroll. Review your private balance and withdraw whenever you want."
        : "Your payroll stream is live. Claim any available salary into your private balance, then withdraw whenever you want.",
      ctaHref: "/claim/withdraw",
      ctaLabel: hasPrivatePayrollMode ? "Open Withdraw" : "Claim Salary",
    },
    balance_available: {
      eyebrow: "Step 5",
      title: "You have funds in your private balance",
      body: "Your salary has already landed privately. You can withdraw it to your wallet now or keep it private for later.",
      ctaHref: "/claim/withdraw",
      ctaLabel: "Withdraw Funds",
    },
  }[employeeExperienceState];

  return (
    <EmployeeLayout>
      <div className="mx-auto max-w-6xl px-4 py-2 sm:px-6">
        <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="font-heading text-4xl font-bold tracking-tight text-white">My Payroll</h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#a8a8aa]">
              {hasPrivatePayrollMode
                ? "MagicBlock PER handles your private payroll balance and private payouts. Withdraw whenever your employer sends salary privately."
                : "Base Solana handles funding and exits. MagicBlock PER handles your live private salary accrual and claimable state."}
            </p>
          </div>
          <div className="flex w-fit rounded-2xl border border-white/10 bg-white/5 p-1 backdrop-blur-xl">
            <button className="h-9 min-w-[108px] rounded-xl bg-[#1eba98] px-4 text-[10px] font-bold uppercase tracking-wider text-black shadow-sm transition-all">
              Dashboard
            </button>
            <Link href="/claim/balances" className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline">
              Balances
            </Link>
            <Link href="/claim/withdraw" className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline">
              Withdraw
            </Link>
          </div>
        </div>

        <div className="relative min-h-[400px] rounded-3xl border border-white/10 bg-[#0b0b0d] p-6 shadow-[0_10px_40px_rgba(0,0,0,0.35)] sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              {statusMeta && StatusIcon ? (
                <div className={`inline-flex items-center gap-2 px-3 py-1.5 border rounded-full mb-5 ${statusMeta.className}`}>
                  <StatusIcon size={14} />
                  <span className="text-[9px] uppercase tracking-[0.15em] font-bold">{statusMeta.label}</span>
                </div>
              ) : (
                <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-sky-400/25 bg-sky-500/10 px-3 py-1.5">
                  <CircleDollarSign size={14} className="text-sky-300" />
                  <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-sky-300">Live Payroll Status</span>
                </div>
              )}

              <h2 className="font-heading text-2xl font-bold tracking-tight text-white">
                {primaryPayrollStream ? primaryPayrollStream.employee.name : "Your private payroll"}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#a8a8aa]">
                {primaryPayrollStream && statusMeta
                  ? statusMeta.copy
                  : hasPrivatePayrollMode
                    ? "Track private payroll payouts, see what is already in your private balance, and withdraw when you are ready."
                    : "See whether your payroll is live, how much has accrued privately, and what is already available in your vault."}
              </p>

	              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                <ShieldCheck size={14} className={magicBlockHealth === "ok" ? "text-[#1eba98]" : magicBlockHealth === "error" ? "text-amber-300" : "text-[#8f8f95]"} />
                <span className={`text-[9px] font-bold uppercase tracking-[0.15em] ${magicBlockHealth === "ok" ? "text-[#1eba98]" : magicBlockHealth === "error" ? "text-amber-300" : "text-[#8f8f95]"}`}>
                  MagicBlock Payments {magicBlockHealth === "ok" ? "Online" : magicBlockHealth === "error" ? "Degraded" : "Checking"}
                </span>
              </div>
	              {primaryPayrollStream && hasLiveSnapshot ? (
                <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-[#1eba98]/25 bg-[#1eba98]/10 px-3 py-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">
                    Live PER Synced
                  </span>
                </div>
	              ) : null}
	            </div>

	            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
	              <Link href={employeeExperienceCopy.ctaHref} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#1eba98]/40 bg-[#1eba98]/15 px-4 text-[10px] font-bold uppercase tracking-wider text-[#1eba98] transition-all hover:bg-[#1eba98]/25 no-underline">
	                <LogOut size={14} />
	                {employeeExperienceCopy.ctaLabel}
	              </Link>
              <button
                onClick={() => void fetchEmployeePayrollSummary({ force: true })}
                disabled={loadingPayrollSummary}
                className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 text-[10px] font-bold uppercase tracking-wider text-white transition-all hover:bg-white/10 disabled:opacity-40"
              >
                {loadingPayrollSummary ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                Refresh
              </button>
            </div>
          </div>

          {loadingPayrollSummary && !payrollSummary ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-3xl bg-black/70 backdrop-blur-sm">
              <Loader2 size={32} className="mb-4 animate-spin text-[#1eba98]" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">Syncing Stream...</p>
            </div>
          ) : null}

	          {primaryPayrollStream ? (
	            <>
	              <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-5">
	                <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">
	                  {employeeExperienceCopy.eyebrow}
	                </p>
	                <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
	                  <div>
	                    <h3 className="text-lg font-bold text-white">{employeeExperienceCopy.title}</h3>
	                    <p className="mt-1 text-sm leading-relaxed text-[#a8a8aa]">
	                      {employeeExperienceCopy.body}
	                    </p>
	                  </div>
	                  <Link
	                    href={employeeExperienceCopy.ctaHref}
	                    className="inline-flex h-11 items-center justify-center rounded-xl bg-[#1eba98] px-4 text-[10px] font-bold uppercase tracking-wider text-black transition-all hover:bg-[#18a786] no-underline"
	                  >
	                    {employeeExperienceCopy.ctaLabel}
	                  </Link>
	                </div>
	              </div>

	              <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl border border-[#1eba98]/35 bg-[#1eba98]/10 p-6">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">Your {cycleInfo.label} Salary</p>
                  <p className="mt-2 text-3xl font-bold tracking-tight text-white">
                    {monthlySalaryAmount !== null ? `$${formatUsdc(monthlySalaryAmount, 2)}` : "—"}
                  </p>
                  <p className="mt-1.5 text-[10px] text-[#9ce8d5]">
                    {monthlySalaryAmount !== null ? "Monthly context from live PER state." : "Available after PER sync."}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#8f8f95]">Earned So Far</p>
                  <p className="mt-2 text-3xl font-bold tracking-tight text-white">
                    {earnedThisMonthAmount !== null ? `$${formatUsdc(earnedThisMonthAmount, 2)}` : "—"}
                  </p>
                  <p className="mt-1.5 text-[10px] text-[#a8a8aa]">
                    {remainingThisMonthAmount !== null
                      ? `Remaining: $${formatUsdc(remainingThisMonthAmount, 2)}`
                      : "Requires signed PER snapshot"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#8f8f95]">Available To Claim</p>
                  <p className="mt-2 text-3xl font-bold tracking-tight text-white">
                    {claimableNowAmount !== null ? `$${formatUsdc(claimableNowAmount, 4)}` : "—"}
                  </p>
                  <p className="mt-1.5 text-[10px] text-[#a8a8aa]">
                    {claimableNowAmount !== null
                      ? `Claimed: $${formatUsdc(claimedThisMonthAmount ?? 0, 2)}`
                      : "Sign once to unlock claimable amount"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#8f8f95]">Employment Status</p>
                  <p className="mt-2 text-xl font-bold tracking-tight text-white">{employmentStatusLabel}</p>
                  <p className="mt-1.5 text-[10px] text-[#a8a8aa]">{nextReleaseLabel}</p>
                </div>
              </div>
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-xs leading-relaxed text-[#b6b6bc]">
                  {getLiveStateCopy(primaryPayrollStream.liveState)}
                </p>
              </div>
            </>
          ) : !loadingPayrollSummary && (
            <div className="mt-12 rounded-[2rem] border border-dashed border-white/20 bg-white/[0.02] p-12 text-center">
              <p className="text-xl font-bold tracking-tight text-white">
                {hasPrivatePayrollMode ? "No live stream needed." : "No payroll stream found."}
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#8f8f95]">
                {hasPrivatePayrollMode
                  ? "This employer uses private payroll payouts instead of realtime streaming. Watch your private balance for the next payout."
                  : "Connect a wallet registered with Expaynse to see your live payroll dashboard."}
              </p>
            </div>
          )}

          {payrollSummaryError && (
            <div className="mt-6 flex items-center gap-3 rounded-2xl border border-red-400/30 bg-red-500/10 p-4 text-red-300">
              <ShieldCheck size={18} className="rotate-180" />
              <p className="text-xs font-bold uppercase tracking-wider">{payrollSummaryError}</p>
            </div>
          )}
        </div>
      </div>
    </EmployeeLayout>
  );
}
