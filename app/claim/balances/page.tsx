
"use client";

import { useEffect } from "react";
import { 
  Loader2, 
  Wallet, 
  RefreshCw, 
  LogOut, 
  ArrowRightLeft,
  CircleCheck,
  ShieldAlert
} from "lucide-react";
import Link from "next/link";
import { EmployeeLayout } from "@/components/employee-layout";
import { useClaimData } from "@/components/claim/use-claim-data";
import { 
  formatMicroUsdc,
  formatPayrollRate,
  formatLastPrivateUpdate,
  computeLiveClaimableAmountMicro,
} from "@/components/claim/claim-utils";
import { toast } from "sonner";
import { signAndSend } from "@/lib/magicblock-api";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

export default function ClaimBalancesPage() {
  const {
    publicKey,
    signTransaction,
    signMessage,
    privBalance,
    payrollSummary,
    privateAccountInitialized,
    registeredEmployeeWallet,
    privateInitStatus,
    privateInitError,
    initializingPrivateAccount,
    setInitializingPrivateAccount,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    liveNowMs,
  } = useClaimData();

  useEffect(() => {
    if (publicKey) {
      void fetchPrivateInitStatus({ silent: true });
      void fetchPrivateBalance({ silent: true, interactive: true });
      void fetchEmployeePayrollSummary({ silent: true, interactive: true });
    }
  }, [publicKey, fetchPrivateInitStatus, fetchPrivateBalance, fetchEmployeePayrollSummary]);

  const primaryPayrollStream = payrollSummary?.streams?.[0];
  const hasPrivatePayrollMode =
    payrollSummary?.employees?.some(
      (employee) => employee.payrollMode === "private_payroll",
    ) ?? false;
  const canonicalSnapshot = primaryPayrollStream?.snapshot ?? null;
  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    return "Unknown error";
  };
  const hasLiveSnapshot = Boolean(canonicalSnapshot && primaryPayrollStream?.liveState?.ready);
  const correctionPollMs = hasLiveSnapshot ? 4000 : 8000;
  useEffect(() => {
    if (!publicKey) return;
    const poll = setInterval(() => {
      void fetchEmployeePayrollSummary({ silent: true, interactive: false });
      void fetchPrivateBalance({ silent: true });
    }, correctionPollMs);
    return () => clearInterval(poll);
  }, [
    publicKey,
    fetchEmployeePayrollSummary,
    fetchPrivateBalance,
    correctionPollMs,
  ]);
  const privateBalanceAmount = Number.parseFloat(privBalance ?? "0");
  const previewRatePerSecond =
    hasLiveSnapshot && canonicalSnapshot
      ? Number(
          canonicalSnapshot.ratePerSecondMicro,
        ) / 1_000_000
      : NaN;
  const effectiveRatePerSecond =
    Number.isFinite(previewRatePerSecond) && previewRatePerSecond > 0
      ? previewRatePerSecond
      : 0;
  const exactPrimaryClaimableAmountMicro =
    hasLiveSnapshot && canonicalSnapshot
      ? computeLiveClaimableAmountMicro({
          snapshot: canonicalSnapshot,
          nowMs: liveNowMs,
        })
      : null;

  const handleInitialize = async () => {
    if (!publicKey || !signTransaction || !signMessage) return;
    setInitializingPrivateAccount(true);
    try {
      const currentStatus = await fetch("/api/employee-private-init?employeeWallet=" + publicKey.toBase58());
      const currentStatusJson = await currentStatus.json();
      if (currentStatus.ok && currentStatusJson.initialized) {
        toast.success("Private vault is already initialized");
        void fetchPrivateInitStatus({ silent: true });
        return;
      }

      // 1. Build init transaction
      const buildRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/employee-private-init",
        method: "POST",
        body: { employeeWallet: publicKey.toBase58() },
      });
      const buildJson = await buildRes.json();
      if (!buildRes.ok) throw new Error(buildJson.error || "Failed to build init tx");

      // 2. Sign and send
      const signature = await signAndSend(buildJson.transaction.transactionBase64, signTransaction, {
        sendTo: buildJson.transaction.sendTo,
      });

      // 3. Finalize
      const patchRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/employee-private-init",
        method: "PATCH",
        body: {
          employeeWallet: publicKey.toBase58(),
          txSignature: signature,
        },
      });
      if (!patchRes.ok) throw new Error("Failed to finalize initialization");

      toast.success("Private vault initialized successfully!");
      void fetchPrivateInitStatus({ silent: false });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const isAlreadyInitializedLikeError =
        message.includes("Attempt to debit an account but found no record of a prior credit") ||
        message.toLowerCase().includes("already in use") ||
        message.toLowerCase().includes("already initialized");

      if (isAlreadyInitializedLikeError) {
        await walletAuthenticatedFetch({
          wallet: publicKey.toBase58(),
          signMessage,
          path: "/api/employee-private-init",
          method: "PATCH",
          body: { employeeWallet: publicKey.toBase58() },
        }).catch(() => undefined);
        toast.success("Private vault was already initialized. Synced status.");
        void fetchPrivateInitStatus({ silent: true });
        return;
      }
      toast.error(`Init failed: ${message}`);
    } finally {
      setInitializingPrivateAccount(false);
    }
  };

  const employeeBalanceState = !registeredEmployeeWallet
    ? "not_registered"
    : !privateAccountInitialized
      ? "needs_private_init"
      : privateBalanceAmount > 0
        ? "balance_available"
        : hasLiveSnapshot
          ? "ready_to_claim"
          : "waiting_for_employer";

  const quickAction = {
    not_registered: {
      title: "Waiting for employer setup",
      body: "This wallet has not been connected to a payroll stream yet.",
      href: "/claim/dashboard",
      label: "View Dashboard",
    },
    needs_private_init: {
      title: "Set up your private account",
      body: "Finish your one-time setup so salary can land in your private balance.",
      href: "/claim/withdraw",
      label: "Set Up Account",
    },
    waiting_for_employer: {
      title: hasPrivatePayrollMode
        ? "Waiting for your next private payroll payout"
        : "Payroll setup is still in progress",
      body: hasPrivatePayrollMode
        ? "Your account is ready. Your employer can now send salary privately, and it will appear in your private balance when paid."
        : "Your account is ready, but your employer still needs to activate payroll.",
      href: "/claim/dashboard",
      label: "Check Status",
    },
    ready_to_claim: {
      title: hasPrivatePayrollMode
        ? "Private salary is available"
        : "Claim available salary",
      body: hasPrivatePayrollMode
        ? "Your employer has sent private payroll. Review your private balance and withdraw when you are ready."
        : "Move earned salary into your private balance whenever you are ready.",
      href: "/claim/withdraw",
      label: hasPrivatePayrollMode ? "Open Withdraw" : "Claim Salary",
    },
    balance_available: {
      title: "Withdraw your private balance",
      body: "Funds are already in your private balance and ready to move to your wallet.",
      href: "/claim/withdraw",
      label: "Withdraw Funds",
    },
  }[employeeBalanceState];

  return (
    <EmployeeLayout>
      <div className="mx-auto max-w-6xl px-4 py-2 sm:px-6">
        <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="font-heading text-4xl font-bold tracking-tight text-white">My Balances</h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#a8a8aa]">
              {hasPrivatePayrollMode
                ? "MagicBlock PER shows your private balance and private payroll payouts. Base Solana is where you withdraw publicly."
                : "Base Solana shows public wallet funds. MagicBlock PER shows your private balance and live payroll accrual."}
            </p>
          </div>
          <div className="flex w-fit rounded-2xl border border-white/10 bg-white/5 p-1 backdrop-blur-xl">
            <Link href="/claim/dashboard" className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline">
              Dashboard
            </Link>
            <button className="h-9 min-w-[108px] rounded-xl bg-[#1eba98] px-4 text-[10px] font-bold uppercase tracking-wider text-black shadow-sm transition-all">
              Balances
            </button>
            <Link href="/claim/withdraw" className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline">
              Withdraw
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-3xl border border-white/10 bg-[#0b0b0d] p-8 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#1eba98]/15 text-[#1eba98]">
                    <Wallet size={20} />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">Live Balance</p>
                    <h3 className="text-lg font-bold tracking-tight text-white">Accrued Earnings</h3>
                  </div>
                </div>
                <button
                  onClick={() => void fetchEmployeePayrollSummary({ silent: false, interactive: true })}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-[#8f8f95] shadow-sm transition-all hover:border-[#1eba98]/40 hover:text-[#1eba98]"
                >
                  <RefreshCw size={16} />
                </button>
              </div>

              <div className="mb-10">
                <div className="flex items-baseline gap-2">
                  <span className="text-6xl font-bold tracking-tighter text-white">
                    {hasLiveSnapshot && exactPrimaryClaimableAmountMicro !== null
                      ? formatMicroUsdc(exactPrimaryClaimableAmountMicro, 6)
                      : "—"}
                  </span>
                  <span className="text-xl font-bold tracking-tight text-[#62626b]">USDC</span>
                </div>
                <p className="mt-2 text-xs text-[#a8a8aa]">
                  {hasPrivatePayrollMode
                    ? "Private payroll sent by your employer will appear here before withdrawal."
                    : "Accrued from your active payroll stream."}
                </p>
                {hasLiveSnapshot ? (
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#1eba98]/30 bg-[#1eba98]/10 px-3 py-1.5">
                    <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">
                      Payroll Source: Live PER
                    </span>
                  </div>
                ) : null}
              </div>

	              {!registeredEmployeeWallet ? (
                <div className="flex items-start gap-4 rounded-2xl border border-dashed border-white/20 bg-white/[0.02] p-6">
                  <ShieldAlert className="shrink-0 text-[#8f8f95]" size={20} />
                  <div>
                    <p className="text-sm font-bold text-white">Pending Assignment</p>
                    <p className="mt-1 text-xs leading-relaxed text-[#a8a8aa]">
                      {hasPrivatePayrollMode
                        ? "Your wallet is not yet registered with an employer. Private payroll balances will appear once you are added."
                        : "Your wallet is not yet registered with an employer. Your live balance will appear once you are added to a payroll stream."}
                    </p>
                  </div>
                </div>
	              ) : !privateAccountInitialized ? (
	                <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-6">
                  <div className="flex items-start gap-4 mb-4">
                    <ShieldAlert className="shrink-0 text-amber-300" size={20} />
                    <div>
	                      <p className="text-sm font-bold text-amber-200">Account Initialization Required</p>
	                      <p className="mt-1 text-xs leading-relaxed text-amber-100/90">
	                        {hasPrivatePayrollMode
                            ? "To receive private payroll payouts, you must first initialize your private account."
                            : "To receive private USDC from your payroll streams, you must first initialize your private account."}
	                      </p>
                        {privateInitStatus === "failed" && privateInitError ? (
                          <p className="mt-2 text-xs leading-relaxed text-amber-100/80">
                            Last setup attempt: {privateInitError}
                          </p>
                        ) : null}
	                    </div>
	                  </div>
                  <button
                    onClick={handleInitialize}
                    disabled={initializingPrivateAccount}
                    className="w-full rounded-xl border border-amber-300/30 bg-amber-500/20 py-3 text-[11px] font-bold uppercase tracking-widest text-amber-100 transition-all hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    {initializingPrivateAccount ? <Loader2 className="animate-spin mx-auto" size={16} /> : "Initialize Private Vault"}
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-4 rounded-2xl border border-[#1eba98]/30 bg-[#1eba98]/10 p-6">
                  <CircleCheck className="shrink-0 text-[#1eba98]" size={20} />
                  <div>
                    <p className="text-sm font-bold text-[#84f7dc]">Stream Active & Synced</p>
                    <p className="mt-1 text-xs leading-relaxed text-[#9ce8d5]">
                      {hasPrivatePayrollMode
                        ? "Your private account is ready. Private payroll payouts will appear here after your employer runs payroll."
                        : "Your payroll stream is live. Accrued earnings update in real-time."}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-2xl border border-white/10 bg-[#0b0b0d] p-6">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-[#8f8f95]">PER Private Balance</p>
                <p className="text-xl font-bold text-white">{privBalance ?? "0.00"}</p>
                <p className="mt-1 text-[10px] font-bold text-[#62626b]">USDC</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#0b0b0d] p-6">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-[#8f8f95]">Stream Pace</p>
                <p className="text-xl font-bold text-white">
                  {primaryPayrollStream
                    ? formatPayrollRate(effectiveRatePerSecond)
                    : "0 USDC/sec"}
                </p>
                <p className="mt-1 text-[10px] font-bold text-[#62626b]">{hasLiveSnapshot ? "TEE RATE" : "PER SNAPSHOT REQUIRED"}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#0b0b0d] p-6">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-[#8f8f95]">Last Sync</p>
                <p className="mt-1 text-sm font-bold text-white">
                  {hasLiveSnapshot && canonicalSnapshot
                    ? formatLastPrivateUpdate(canonicalSnapshot.lastAccrualTimestamp)
                    : "PER snapshot unavailable"}
                </p>
                <p className="mt-1 text-[10px] font-bold text-[#62626b]">UTC</p>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0b0d] p-8 text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full -mr-16 -mt-16 blur-2xl group-hover:bg-emerald-500/20 transition-all" />
              <div className="relative z-10">
                <p className="mb-6 text-[10px] font-bold uppercase tracking-[0.2em] text-[#84f7dc]">Quick Actions</p>
	                <h4 className="text-xl font-bold tracking-tight mb-2">{quickAction.title}</h4>
	                <p className="mb-8 text-xs leading-relaxed text-[#a8a8aa]">
	                  {quickAction.body}
	                </p>
	                <div className="space-y-3">
	                  <Link href={quickAction.href} className="group/item flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 p-4 transition-all hover:bg-white/10 no-underline">
	                    <div className="flex items-center gap-3">
	                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#1eba98]/20 text-[#1eba98]">
	                        <ArrowRightLeft size={16} />
	                      </div>
	                      <span className="text-xs font-bold uppercase tracking-wider">{quickAction.label}</span>
	                    </div>
	                    <LogOut size={14} className="text-[#8f8f95] transition-colors group-hover/item:text-[#1eba98]" />
	                  </Link>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-[#1eba98]/30 bg-[#1eba98]/10 p-8">
              <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-[#84f7dc]">Security Note</p>
              <p className="text-xs italic leading-relaxed text-[#9ce8d5]">
                Your balances are encrypted and only accessible by your private key. Expaynse never stores your unencrypted balance or transaction history.
              </p>
            </div>
          </div>
        </div>
      </div>
    </EmployeeLayout>
  );
}
