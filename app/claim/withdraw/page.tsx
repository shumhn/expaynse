"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  LogOut,
  ShieldCheck,
  CircleHelp,
  Info,
} from "lucide-react";
import Link from "next/link";
import { EmployerLayout } from "@/components/employer-layout";
import { useClaimData } from "@/components/claim/use-claim-data";
import { toast } from "sonner";
import { PublicKey } from "@solana/web3.js";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import { privateTransfer, withdraw, signAndSend } from "@/lib/magicblock-api";

export default function ClaimWithdrawPage() {
  const {
    publicKey,
    signTransaction,
    signMessage,
    privBalance,
    payrollSummary,
    loading,
    privateAccountInitialized,
    registeredEmployeeWallet,
    initializingPrivateAccount,
    withdrawing,
    setWithdrawing,
    setInitializingPrivateAccount,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    getOrFetchToken,
  } = useClaimData();
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [withdrawRecipient, setWithdrawRecipient] = useState<string>("");
  const [requestAmount, setRequestAmount] = useState<string>("");
  const [requestMode, setRequestMode] = useState<"base" | "ephemeral">("base");
  const [requestDestination, setRequestDestination] = useState<string>("");
  const [requestNote, setRequestNote] = useState<string>("");
  const [submittingRequest, setSubmittingRequest] = useState<boolean>(false);
  const [loadingRequests, setLoadingRequests] = useState<boolean>(false);
  const [cashoutRequests, setCashoutRequests] = useState<
    Array<{
      id: string;
      requestedAmount: number;
      status: "pending" | "fulfilled" | "dismissed" | "cancelled";
      payoutMode?: "base" | "ephemeral";
      createdAt: string;
      note?: string;
    }>
  >([]);

  useEffect(() => {
    if (publicKey) {
      void fetchPrivateInitStatus({ silent: true });
      void fetchPrivateBalance({ silent: true, interactive: true });
      void fetchEmployeePayrollSummary({ silent: true, interactive: true });
    }
  }, [
    publicKey,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
  ]);

  useEffect(() => {
    if (!publicKey) return;
    const poll = setInterval(() => {
      void fetchPrivateBalance({ silent: true });
      void fetchEmployeePayrollSummary({ silent: true, interactive: false });
    }, 5000);
    return () => clearInterval(poll);
  }, [publicKey, fetchPrivateBalance, fetchEmployeePayrollSummary]);

  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    return "Unknown error";
  };

  const privBalanceNum = parseFloat(privBalance ?? "0");
  const primaryPayrollStream = payrollSummary?.streams?.[0];
  const liveClaimableMicros =
    Number(primaryPayrollStream?.preview?.effectiveClaimableAmountMicro ?? 0) ||
    Number(primaryPayrollStream?.preview?.claimableAmountMicro ?? 0) ||
    0;
  const liveClaimableUsdc = liveClaimableMicros / 1_000_000;
  const requestMaxUsdc =
    liveClaimableUsdc > 0 ? liveClaimableUsdc : privBalanceNum;

  const pendingRequest = cashoutRequests.find((r) => r.status === "pending");
  const hasPendingRequest = !!pendingRequest;

  const fetchCashoutRequests = useCallback(
    async (silent = true) => {
      if (!publicKey || !signMessage) return;
      if (!silent) setLoadingRequests(true);
      try {
        const response = await walletAuthenticatedFetch({
          wallet: publicKey.toBase58(),
          signMessage,
          path: `/api/cashout-requests?scope=employee&employeeWallet=${publicKey.toBase58()}`,
        });
        const json = (await response.json()) as {
          requests?: Array<{
            id: string;
            requestedAmount: number;
            status: "pending" | "fulfilled" | "dismissed" | "cancelled";
            payoutMode?: "base" | "ephemeral";
            createdAt: string;
            note?: string;
          }>;
          error?: string;
        };
        if (!response.ok)
          throw new Error(json.error || "Failed to load requests");
        setCashoutRequests(json.requests ?? []);
      } catch (err: unknown) {
        if (!silent)
          toast.error(`Request history failed: ${getErrorMessage(err)}`);
      } finally {
        if (!silent) setLoadingRequests(false);
      }
    },
    [publicKey, signMessage],
  );

  useEffect(() => {
    if (!publicKey || !signMessage) return undefined;
    const timer = setTimeout(() => {
      void fetchCashoutRequests(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [publicKey, signMessage, fetchCashoutRequests]);

  const inputWithdrawRecipient =
    withdrawRecipient || publicKey?.toBase58() || "";
  const withdrawRecipientTrimmed = inputWithdrawRecipient.trim();

  const isValidWithdrawRecipient = useMemo(() => {
    if (!withdrawRecipientTrimmed) return false;
    try {
      new PublicKey(withdrawRecipientTrimmed);
      return true;
    } catch {
      return false;
    }
  }, [withdrawRecipientTrimmed]);

  const isValidAmount = (() => {
    if (withdrawAmount.trim() === "") return true;
    const val = parseFloat(withdrawAmount);
    return !isNaN(val) && val > 0 && val <= privBalanceNum;
  })();

  const isOwnWalletDestination = useMemo(() => {
    if (!publicKey || !isValidWithdrawRecipient) return false;
    return withdrawRecipientTrimmed === publicKey.toBase58();
  }, [publicKey, withdrawRecipientTrimmed, isValidWithdrawRecipient]);

  const handleWithdraw = async () => {
    if (!publicKey || !signTransaction) return;
    setWithdrawing(true);
    try {
      const token = await getOrFetchToken();
      if (!token) throw new Error("Authentication failed");

      const amountToWithdraw =
        withdrawAmount.trim() === ""
          ? privBalanceNum
          : parseFloat(withdrawAmount);

      let buildRes;
      if (isOwnWalletDestination) {
        buildRes = await withdraw(
          publicKey.toBase58(),
          amountToWithdraw,
          token,
        );
      } else {
        buildRes = await privateTransfer(
          publicKey.toBase58(),
          withdrawRecipientTrimmed,
          amountToWithdraw,
          undefined,
          token,
        );
      }

      if (!buildRes.transactionBase64) {
        throw new Error("API did not return a transaction");
      }

      await signAndSend(buildRes.transactionBase64, signTransaction, {
        sendTo: buildRes.sendTo,
      });

      toast.success(
        isOwnWalletDestination
          ? "Withdrawal successful!"
          : "Private transfer successful!",
      );
      setWithdrawAmount("");
      void fetchPrivateBalance({ silent: true });
      void fetchEmployeePayrollSummary({
        silent: true,
        force: true,
        interactive: false,
      });
    } catch (err: unknown) {
      toast.error(`Transaction failed: ${getErrorMessage(err)}`);
    } finally {
      setWithdrawing(false);
    }
  };

  const handleInitialize = async () => {
    if (!publicKey || !signTransaction) return;
    setInitializingPrivateAccount(true);
    try {
      const currentStatus = await fetch(
        "/api/employee-private-init?employeeWallet=" + publicKey.toBase58(),
      );
      const currentStatusJson = await currentStatus.json();
      if (currentStatus.ok && currentStatusJson.initialized) {
        toast.success("Private vault is already initialized");
        void fetchPrivateInitStatus({ silent: true });
        return;
      }

      const buildRes = await fetch("/api/employee-private-init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeWallet: publicKey.toBase58() }),
      });
      const buildJson = await buildRes.json();
      if (!buildRes.ok)
        throw new Error(buildJson.error || "Failed to build init tx");

      await signAndSend(
        buildJson.transaction.transactionBase64,
        signTransaction,
        {
          sendTo: buildJson.transaction.sendTo,
        },
      );

      const patchRes = await fetch("/api/employee-private-init", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeWallet: publicKey.toBase58() }),
      });
      if (!patchRes.ok) throw new Error("Failed to finalize initialization");

      toast.success("Private vault initialized!");
      void fetchPrivateInitStatus({ silent: false });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const isAlreadyInitializedLikeError =
        message.includes(
          "Attempt to debit an account but found no record of a prior credit",
        ) ||
        message.toLowerCase().includes("already in use") ||
        message.toLowerCase().includes("already initialized");

      if (isAlreadyInitializedLikeError) {
        await fetch("/api/employee-private-init", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employeeWallet: publicKey.toBase58() }),
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

  const handleSubmitRequest = async () => {
    if (!publicKey || !signMessage) return;
    if (!primaryPayrollStream?.stream?.id) {
      toast.error("No payroll stream found to request payout from");
      return;
    }

    const amount = Number.parseFloat(requestAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid request amount");
      return;
    }
    if (requestMaxUsdc > 0 && amount > requestMaxUsdc) {
      toast.error(
        `Request exceeds max claimable (${requestMaxUsdc.toFixed(6)} USDC)`,
      );
      return;
    }
    if (hasPendingRequest) {
      toast.error(
        "You already have a pending request. Wait for employer action or refresh.",
      );
      return;
    }

    setSubmittingRequest(true);
    try {
      const response = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/cashout-requests",
        method: "POST",
        body: {
          employeeWallet: publicKey.toBase58(),
          streamId: primaryPayrollStream.stream.id,
          requestedAmount: Math.round(amount * 1_000_000) / 1_000_000,
          maxRequestableAmount: Math.round(requestMaxUsdc * 1_000_000) / 1_000_000,
          payoutMode: requestMode,
          destinationWallet:
            requestMode === "base"
              ? requestDestination.trim() || publicKey.toBase58()
              : undefined,
          note: requestNote.trim() || undefined,
        },
      });
      const json = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(json.error || "Failed to create request");
      toast.success("Payout request sent to employer");
      setRequestAmount("");
      setRequestNote("");
      await fetchCashoutRequests(false);
    } catch (err: unknown) {
      toast.error(`Request failed: ${getErrorMessage(err)}`);
    } finally {
      setSubmittingRequest(false);
    }
  };

  return (
    <EmployerLayout>
      <div className="mx-auto max-w-6xl px-4 py-2 sm:px-6">
        <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="font-heading text-4xl font-bold tracking-tight text-white">
              Withdraw Funds
            </h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#a8a8aa]">
              Securely move your settled salary from your private vault to any
              wallet.
            </p>
          </div>
          <div className="flex w-fit rounded-2xl border border-white/10 bg-white/5 p-1 backdrop-blur-xl">
            <Link
              href="/claim/dashboard"
              className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline"
            >
              Dashboard
            </Link>
            <Link
              href="/claim/balances"
              className="flex h-9 min-w-[108px] items-center justify-center rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider text-[#8f8f95] transition-all hover:bg-white/10 hover:text-white no-underline"
            >
              Balances
            </Link>
            <button className="h-9 min-w-[108px] rounded-xl bg-[#1eba98] px-4 text-[10px] font-bold uppercase tracking-wider text-black shadow-sm transition-all">
              Withdraw
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="rounded-3xl border border-white/10 bg-[#0b0b0d] p-6 shadow-[0_10px_40px_rgba(0,0,0,0.35)] sm:p-8">
              <div className="space-y-8">
                <div>
                  <label className="mb-4 block px-1 text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                    Destination Wallet
                  </label>
                  <div className="group rounded-2xl border border-white/10 bg-white/5 px-5 py-4 shadow-inner transition-all focus-within:border-[#1eba98]/40">
                    <input
                      type="text"
                      placeholder="Enter Solana address"
                      value={inputWithdrawRecipient}
                      onChange={(e) => setWithdrawRecipient(e.target.value)}
                      disabled={!privateAccountInitialized}
                      className="w-full bg-transparent text-sm font-bold text-white outline-none placeholder:text-[#62626b]"
                    />
                  </div>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-1">
                    <div className="flex items-center gap-2">
                      <Info size={12} className="text-[#8f8f95]" />
                      <p className="text-[10px] font-medium italic text-[#8f8f95]">
                        {isOwnWalletDestination
                          ? "Direct withdrawal to your base wallet."
                          : "Encrypted private transfer to external address."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setWithdrawRecipient(publicKey?.toBase58() ?? "")
                      }
                      disabled={!privateAccountInitialized}
                      className="text-[10px] font-bold uppercase tracking-wider text-[#1eba98] transition-colors hover:text-[#64f0ce]"
                    >
                      Use My Wallet
                    </button>
                  </div>
                  {withdrawRecipientTrimmed && !isValidWithdrawRecipient && (
                    <p className="mt-2 px-1 text-[10px] font-bold text-red-300">
                      Invalid Solana address format
                    </p>
                  )}
                </div>

                <div>
                  <label className="mb-4 block px-1 text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                    {isOwnWalletDestination
                      ? "Amount to Withdraw"
                      : "Amount to Send"}
                  </label>
                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 shadow-inner transition-all focus-within:border-[#1eba98]/40">
                    <input
                      type="number"
                      placeholder={`Max ${privBalanceNum.toFixed(2)}`}
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      disabled={!privateAccountInitialized}
                      className="flex-1 bg-transparent text-lg font-bold text-white outline-none placeholder:text-[#62626b]"
                    />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                      USDC
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setWithdrawAmount(privBalanceNum.toFixed(2))
                      }
                      disabled={
                        !privateAccountInitialized || privBalanceNum <= 0
                      }
                      className="text-[10px] font-bold uppercase tracking-wider text-[#1eba98] transition-colors hover:text-[#64f0ce]"
                    >
                      Max
                    </button>
                  </div>
                  {withdrawAmount &&
                    parseFloat(withdrawAmount) > privBalanceNum && (
                      <p className="mt-2 px-1 text-[10px] font-bold text-red-300">
                        Insufficient private balance
                      </p>
                    )}
                </div>

                <div className="flex flex-col gap-4 pt-4 sm:flex-row">
                  {!privateAccountInitialized ? (
                    <button
                      onClick={handleInitialize}
                      disabled={
                        initializingPrivateAccount || !registeredEmployeeWallet
                      }
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-amber-300/30 bg-amber-500/20 py-4 text-[11px] font-bold uppercase tracking-widest text-amber-200 transition-all hover:bg-amber-500/30 disabled:opacity-40"
                    >
                      {initializingPrivateAccount ? (
                        <Loader2 className="animate-spin" size={16} />
                      ) : (
                        <ShieldCheck size={16} />
                      )}
                      {registeredEmployeeWallet
                        ? "Initialize First"
                        : "No Stream Found"}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => void fetchPrivateBalance()}
                        disabled={loading || withdrawing}
                        className="flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white/10"
                      >
                        {loading ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          <RefreshCw size={16} />
                        )}
                      </button>
                      <button
                        onClick={handleWithdraw}
                        disabled={
                          withdrawing ||
                          privBalanceNum <= 0 ||
                          !isValidWithdrawRecipient ||
                          (withdrawAmount.trim() !== "" && !isValidAmount)
                        }
                        className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1eba98] py-4 text-[11px] font-bold uppercase tracking-widest text-black shadow-lg transition-all hover:bg-[#18a786] disabled:opacity-30"
                      >
                        {withdrawing ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          <LogOut size={16} />
                        )}
                        {withdrawAmount.trim() === ""
                          ? "Withdraw Full Balance"
                          : `Confirm ${isOwnWalletDestination ? "Withdraw" : "Transfer"}`}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-3xl border border-white/10 bg-[#0b0b0d] p-6 shadow-[0_10px_40px_rgba(0,0,0,0.35)] sm:p-8">
              <div className="mb-5 flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">
                  Request Employer Payout
                </h3>
                <button
                  onClick={() => void fetchCashoutRequests(false)}
                  disabled={loadingRequests}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#a8a8aa] transition-all hover:bg-white/10 disabled:opacity-40"
                >
                  {loadingRequests ? (
                    <Loader2 className="animate-spin" size={12} />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  Refresh
                </button>
              </div>

              {hasPendingRequest ? (
                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <p className="text-xs font-bold text-amber-200">
                    You have a pending request of{" "}
                    {pendingRequest.requestedAmount < 0.01
                      ? pendingRequest.requestedAmount.toFixed(6)
                      : pendingRequest.requestedAmount.toFixed(2)}{" "}
                    USDC. You cannot create another until it is resolved.
                  </p>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 shadow-inner transition-all focus-within:border-[#1eba98]/40">
                  <input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    placeholder={`Max ${requestMaxUsdc.toFixed(6)} USDC`}
                    value={requestAmount}
                    onChange={(e) => setRequestAmount(e.target.value)}
                    className="flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-[#62626b]"
                  />
                  <button
                    type="button"
                    onClick={() => setRequestAmount(requestMaxUsdc.toFixed(6))}
                    disabled={requestMaxUsdc <= 0}
                    className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#1eba98] transition-colors hover:text-[#64f0ce] disabled:opacity-30"
                  >
                    Max
                  </button>
                </div>
                <select
                  value={requestMode}
                  onChange={(e) =>
                    setRequestMode(e.target.value as "base" | "ephemeral")
                  }
                  className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white outline-none"
                >
                  <option value="base">Direct payout (base wallet)</option>
                  <option value="ephemeral">Keep in private vault</option>
                </select>
                {requestMode === "base" ? (
                  <input
                    type="text"
                    placeholder="Destination wallet (optional)"
                    value={requestDestination}
                    onChange={(e) => setRequestDestination(e.target.value)}
                    className="sm:col-span-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white outline-none placeholder:text-[#62626b]"
                  />
                ) : null}
                <textarea
                  placeholder="Optional note (rent, emergency, etc.)"
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  className="sm:col-span-2 min-h-[90px] rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white outline-none placeholder:text-[#62626b]"
                />
              </div>
              <div className="mt-2 flex items-center justify-between px-1">
                <p className="text-[10px] text-[#8f8f95]">
                  Live claimable now:{" "}
                  <span className="font-bold text-[#64f0ce]">
                    {liveClaimableUsdc.toFixed(6)} USDC
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setRequestAmount(requestMaxUsdc.toFixed(6))}
                  disabled={requestMaxUsdc <= 0}
                  className="text-[10px] font-bold uppercase tracking-wider text-[#1eba98] transition-colors hover:text-[#64f0ce] disabled:opacity-30"
                >
                  Use Max
                </button>
              </div>

              <button
                onClick={handleSubmitRequest}
                disabled={
                  submittingRequest ||
                  !publicKey ||
                  !primaryPayrollStream?.stream?.id ||
                  hasPendingRequest
                }
                className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#1eba98] px-5 text-[10px] font-bold uppercase tracking-wider text-black transition-all hover:bg-[#18a786] disabled:opacity-40"
              >
                {submittingRequest ? (
                  <Loader2 className="animate-spin" size={14} />
                ) : null}
                Send Request
              </button>

              <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                  Recent Requests
                </p>
                {cashoutRequests.length === 0 ? (
                  <p className="text-xs text-[#8f8f95]">No requests yet.</p>
                ) : (
                  <div className="space-y-2">
                    {cashoutRequests.slice(0, 5).map((request) => (
                      <div
                        key={request.id}
                        className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                      >
                        <div>
                          <p className="text-sm font-semibold text-white">
                            $
                            {request.requestedAmount < 0.01
                              ? request.requestedAmount.toFixed(6)
                              : request.requestedAmount.toFixed(2)}{" "}
                            USDC
                          </p>
                          <p className="text-[10px] text-[#8f8f95]">
                            {new Date(request.createdAt).toLocaleString()} •{" "}
                            {request.payoutMode ?? "ephemeral"}
                          </p>
                        </div>
                        <span className="rounded-full border border-white/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#a8a8aa]">
                          {request.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-3xl border border-[#1eba98]/30 bg-[#1eba98]/10 p-8">
              <h4 className="mb-4 flex items-center gap-2 text-sm font-bold text-[#84f7dc]">
                <ShieldCheck size={18} className="text-[#1eba98]" />
                Privacy & Security
              </h4>
              <div className="space-y-4">
                <div className="flex gap-3">
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#1eba98]" />
                  <p className="text-xs leading-relaxed text-[#9ce8d5]">
                    Transactions are settled via TEE (Trusted Execution
                    Environments), meaning no one can see your withdrawal
                    destination.
                  </p>
                </div>
                <div className="flex gap-3">
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#1eba98]" />
                  <p className="text-xs leading-relaxed text-[#9ce8d5]">
                    Your employer sees that you claimed your salary, but not
                    where the funds were sent.
                  </p>
                </div>
                <div className="flex gap-3">
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#1eba98]" />
                  <p className="text-xs leading-relaxed text-[#9ce8d5]">
                    Funds remain encrypted in the MagicBlock Payments layer
                    until they reach your chosen destination.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-[#0b0b0d] p-8">
              <div className="mb-4 flex items-center gap-2 text-[#8f8f95]">
                <CircleHelp size={16} />
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  Help Center
                </span>
              </div>
              <p className="text-xs leading-relaxed text-[#a8a8aa]">
                Need to split your withdrawal or schedule recurring transfers?
                Premium features are coming soon to the Expaynse dashboard.
              </p>
            </div>
          </div>
        </div>
      </div>
    </EmployerLayout>
  );
}
