"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  LogOut,
  ShieldCheck,
  CircleHelp,
  Info,
  Send,
  AlertTriangle,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import Link from "next/link";
import { EmployerLayout } from "@/components/employer-layout";
import { useClaimData } from "@/components/claim/use-claim-data";
import { toast } from "sonner";
import { PublicKey } from "@solana/web3.js";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import {
  getBalance,
  getPrivateBalance,
  privateTransfer,
  signAndSend,
} from "@/lib/magicblock-api";

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
    privateInitStatus,
    privateInitError,
    initializingPrivateAccount,
    withdrawing,
    setWithdrawing,
    setInitializingPrivateAccount,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    getOrFetchToken,
  } = useClaimData();
  const [visiblePrivBalance, setVisiblePrivBalance] = useState<string | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [withdrawRecipient, setWithdrawRecipient] = useState<string>("");
  const [withdrawSyncNotice, setWithdrawSyncNotice] = useState<string>("");
  const [requestAmount, setRequestAmount] = useState<string>("");
  const [requestMode, setRequestMode] = useState<"base" | "ephemeral">("base");
  const [requestDestination, setRequestDestination] = useState<string>("");
  const [requestNote, setRequestNote] = useState<string>("");
  const [submittingRequest, setSubmittingRequest] = useState<boolean>(false);
  const [loadingRequests, setLoadingRequests] = useState<boolean>(false);
  const [loadingWithdrawHistory, setLoadingWithdrawHistory] = useState<boolean>(false);
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
  const [withdrawHistory, setWithdrawHistory] = useState<
    Array<{
      id: string;
      date: string;
      amount: number;
      recipient: string;
      txSig?: string;
      status: "success" | "failed" | "submitted";
      providerMeta?: {
        action?:
          | "employee-withdrawal"
          | "employee-external-transfer"
          | "employee-private-transfer"
          | "claim";
        destinationWallet?: string;
        creditVerified?: boolean;
        errorMessage?: string;
      };
      privacyConfig?: {
        fromBalance?: "base" | "ephemeral";
        toBalance?: "base" | "ephemeral";
      };
    }>
  >([]);
  const [onChainPendingClaim, setOnChainPendingClaim] = useState<any | null>(null);

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

  useEffect(() => {
    setVisiblePrivBalance(privBalance);
  }, [privBalance]);

  const effectivePrivBalance = visiblePrivBalance ?? privBalance ?? "0";
  const privBalanceNum = parseFloat(effectivePrivBalance);
  const primaryPayrollStream = payrollSummary?.streams?.[0];
  const hasLivePreview = Boolean(
    primaryPayrollStream?.preview && primaryPayrollStream?.liveState?.ready,
  );
  const liveClaimableMicros =
    hasLivePreview
      ? Number(primaryPayrollStream?.preview?.effectiveClaimableAmountMicro ?? 0) ||
        Number(primaryPayrollStream?.preview?.claimableAmountMicro ?? 0) ||
        0
      : 0;
  const liveClaimableUsdc = liveClaimableMicros / 1_000_000;
  const requestMaxUsdc = liveClaimableUsdc > 0 ? liveClaimableUsdc : 0;
  const pendingRequest = cashoutRequests.find((r) => r.status === "pending");
  const hasPendingRequest = !!pendingRequest || !!onChainPendingClaim;
  const employeeClaimState = !registeredEmployeeWallet
    ? "not_registered"
    : !privateAccountInitialized
      ? "needs_private_init"
      : hasPendingRequest
        ? "claim_pending"
        : privBalanceNum > 0
          ? "balance_available"
          : hasLivePreview
            ? "ready_to_claim"
            : "waiting_for_employer";

  const employeeClaimSummary = {
    not_registered: {
      step: "Step 1",
      title: "Ask your employer to add this wallet",
      body: "This wallet is not on a payroll stream yet, so there is nothing to claim or withdraw.",
    },
    needs_private_init: {
      step: "Step 2",
      title: "Finish your one-time private setup",
      body: privateInitStatus === "failed" && privateInitError
        ? `Your last automatic setup attempt failed: ${privateInitError}`
        : "Your employer has added you, but your private receiving account still needs one quick setup before salary can arrive.",
    },
    waiting_for_employer: {
      step: "Step 3",
      title: "Waiting for payroll activation",
      body: "Your private account is ready. Your employer still needs to finish private payroll setup before salary becomes claimable.",
    },
    ready_to_claim: {
      step: "Step 4",
      title: "Claim salary into your private balance",
      body: "Your payroll stream is live. Claim available salary privately first, then withdraw it to your wallet whenever you choose.",
    },
    balance_available: {
      step: "Step 5",
      title: "Withdraw your private balance",
      body: "You already have settled funds in your private balance. Move them to your wallet or send them privately to another address.",
    },
    claim_pending: {
      step: "In Progress",
      title: "Finish your current claim first",
      body: "You already have a payout in progress. Let it settle before starting another claim.",
    },
  }[employeeClaimState];

  const claimDisabledReason = !registeredEmployeeWallet
    ? "Your employer still needs to add this wallet to payroll."
    : !privateAccountInitialized
      ? "Set up your private account once before you claim salary."
      : !primaryPayrollStream?.stream?.id
        ? "Your payroll stream is not ready yet."
        : hasPendingRequest
          ? "Finish your pending claim before starting a new one."
          : !hasLivePreview
            ? "Your employer still needs to finish private payroll setup."
            : requestMaxUsdc <= 0
              ? "No salary is available to claim yet."
              : null;

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
          requests?: any[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(json.error || "Failed to load requests");
        setCashoutRequests(json.requests ?? []);

        if (primaryPayrollStream?.stream?.id) {
          const claimRes = await fetch(`/api/claim-salary/request?streamId=${primaryPayrollStream.stream.id}`);
          const claimJson = await claimRes.json();
          if (claimRes.ok) {
            setOnChainPendingClaim(claimJson.pendingClaim || null);
          }
        }
      } catch (err: unknown) {
        if (!silent)
          toast.error(`Request history failed: ${getErrorMessage(err)}`);
      } finally {
        if (!silent) setLoadingRequests(false);
      }
    },
    [publicKey, signMessage, primaryPayrollStream?.stream?.id],
  );

  const fetchWithdrawHistory = useCallback(
    async (silent = true) => {
      if (!publicKey || !signMessage) return;
      if (!silent) setLoadingWithdrawHistory(true);
      try {
        const response = await walletAuthenticatedFetch({
          wallet: publicKey.toBase58(),
          signMessage,
          path: `/api/history?wallet=${publicKey.toBase58()}`,
          method: "GET",
        });
        const json = (await response.json()) as {
          claimRecords?: Array<{
            id: string;
            date: string;
            amount: number;
            recipient: string;
            txSig?: string;
            status: "success" | "failed" | "submitted";
            providerMeta?: {
              action?:
                | "employee-withdrawal"
                | "employee-external-transfer"
                | "employee-private-transfer"
                | "claim";
              destinationWallet?: string;
              creditVerified?: boolean;
              errorMessage?: string;
            };
            privacyConfig?: {
              fromBalance?: "base" | "ephemeral";
              toBalance?: "base" | "ephemeral";
            };
          }>;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(json.error || "Failed to load withdraw history");
        }

        const items = (json.claimRecords ?? []).filter((record) =>
          record.providerMeta?.action === "employee-withdrawal" ||
          record.providerMeta?.action === "employee-external-transfer" ||
          record.providerMeta?.action === "employee-private-transfer",
        );
        setWithdrawHistory(items);
      } catch (err: unknown) {
        if (!silent) {
          toast.error(`Withdraw history failed: ${getErrorMessage(err)}`);
        }
      } finally {
        if (!silent) setLoadingWithdrawHistory(false);
      }
    },
    [publicKey, signMessage],
  );

  useEffect(() => {
    if (!publicKey || !signMessage || !primaryPayrollStream?.stream?.id) return undefined;
    const timer = setTimeout(() => {
      void fetchCashoutRequests(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [publicKey, signMessage, primaryPayrollStream?.stream?.id, fetchCashoutRequests]);

  useEffect(() => {
    if (!publicKey || !signMessage) return undefined;
    const timer = setTimeout(() => {
      void fetchWithdrawHistory(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [publicKey, signMessage, fetchWithdrawHistory]);

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

  useEffect(() => {
    if (withdrawAmount.trim() === "") {
      if (withdrawSyncNotice) setWithdrawSyncNotice("");
      return;
    }
    const parsedAmount = parseFloat(withdrawAmount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= privBalanceNum) {
      if (withdrawSyncNotice) setWithdrawSyncNotice("");
      return;
    }
    setWithdrawAmount(privBalanceNum > 0 ? privBalanceNum.toFixed(6) : "");
    setWithdrawSyncNotice(
      privBalanceNum > 0
        ? `Balance refreshed. Latest withdrawable amount is ${privBalanceNum.toFixed(6)} USDC.`
        : "Balance refreshed. Your private balance is now empty.",
    );
  }, [privBalanceNum, withdrawAmount, withdrawSyncNotice]);

  const isOwnWalletDestination = useMemo(() => {
    if (!publicKey || !isValidWithdrawRecipient) return false;
    return withdrawRecipientTrimmed === publicKey.toBase58();
  }, [publicKey, withdrawRecipientTrimmed, isValidWithdrawRecipient]);

  const handleWithdraw = async () => {
    if (!publicKey || !signTransaction) return;
    setWithdrawing(true);
    const withdrawToastId = "employee-withdraw-toast";
    toast.loading("Preparing withdrawal...", { id: withdrawToastId });
    let activeToken: string | null = null;
    try {
      activeToken = await getOrFetchToken();
      if (!activeToken) throw new Error("Authentication failed");

      const amountToWithdraw =
        withdrawAmount.trim() === ""
          ? privBalanceNum
          : parseFloat(withdrawAmount);
      const latestPrivateBalance = await getPrivateBalance(
        publicKey.toBase58(),
        activeToken,
      );
      const latestPrivateBalanceMicro =
        parseInt(latestPrivateBalance.balance ?? "0", 10) || 0;
      const latestPrivateBalanceUi =
        latestPrivateBalanceMicro > 0
          ? (latestPrivateBalanceMicro / 1_000_000).toFixed(6)
          : "0";
      setVisiblePrivBalance(latestPrivateBalanceUi);
      const amountToWithdrawMicro = Math.round(amountToWithdraw * 1_000_000);

      if (amountToWithdrawMicro <= 0) {
        throw new Error("Enter a valid withdrawal amount.");
      }

      if (latestPrivateBalanceMicro < amountToWithdrawMicro) {
        setWithdrawAmount(
          latestPrivateBalanceMicro > 0 ? latestPrivateBalanceUi : "",
        );
        setWithdrawSyncNotice(
          latestPrivateBalanceMicro > 0
            ? `Balance refreshed. Latest withdrawable amount is ${latestPrivateBalanceUi} USDC.`
            : "Balance refreshed. Your private balance is now empty.",
        );
        void fetchPrivateBalance({ silent: true });
        throw new Error(
          latestPrivateBalanceMicro === 0
            ? "Your private balance is already empty. Refresh completed state and try again."
            : `Private balance changed. Latest available balance is ${latestPrivateBalanceUi} USDC.`,
        );
      }

      const expectedAmountMicro = Math.round(amountToWithdraw * 1_000_000);
      const baseBalanceBefore = isOwnWalletDestination
        ? await getBalance(publicKey.toBase58()).catch(() => null)
        : null;
      const buildRes = await privateTransfer(
        publicKey.toBase58(),
        withdrawRecipientTrimmed,
        amountToWithdraw,
        undefined,
        activeToken,
        {
          fromBalance: "ephemeral",
          toBalance: "base",
        },
      );

      if (!buildRes.transactionBase64) {
        throw new Error("API did not return a transaction");
      }

      const txSignature = await signAndSend(buildRes.transactionBase64, signTransaction, {
        sendTo: buildRes.sendTo || "base",
      });

      let baseCredited = false;
      if (isOwnWalletDestination) {
        const baseBeforeMicro = parseInt(baseBalanceBefore?.balance ?? "0", 10) || 0;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const latestBase = await getBalance(publicKey.toBase58()).catch(() => null);
          const latestBaseMicro = parseInt(latestBase?.balance ?? "0", 10) || 0;
          if (latestBaseMicro >= baseBeforeMicro + expectedAmountMicro) {
            baseCredited = true;
            break;
          }
        }
      }

      if (isOwnWalletDestination) {
        if (baseCredited) {
          toast.success("Withdrawal successful!", { id: withdrawToastId });
        } else {
          toast.warning(
            "Transaction was submitted, but the base-wallet credit is not visible yet. Refresh your wallet and balances.",
            { id: withdrawToastId },
          );
        }
      } else {
        toast.success("External wallet transfer successful!", { id: withdrawToastId });
      }

      if (signMessage) {
        try {
          await walletAuthenticatedFetch({
            path: "/api/history",
            method: "POST",
            signMessage,
            wallet: publicKey.toBase58(),
            body: {
              kind: "claim-record",
              wallet: publicKey.toBase58(),
              amount: amountToWithdraw,
              recipient: withdrawRecipientTrimmed,
              txSig: txSignature,
              status:
                isOwnWalletDestination && !baseCredited ? "submitted" : "success",
              privacyConfig: {
                visibility: "private",
                fromBalance: "ephemeral",
                toBalance: "base",
                destinationStrategy: isOwnWalletDestination
                  ? "connected-wallet"
                  : "custom-address",
              },
              providerMeta: {
                provider: "magicblock",
                sendTo:
                  typeof buildRes.sendTo === "string" ? buildRes.sendTo : undefined,
                action: isOwnWalletDestination
                  ? "employee-withdrawal"
                  : "employee-external-transfer",
                destinationWallet: withdrawRecipientTrimmed,
                creditVerified: isOwnWalletDestination ? baseCredited : true,
              },
            },
          });
        } catch (historyErr) {
          console.error("Failed to save withdraw history", historyErr);
        }
      }
      setWithdrawAmount("");
      setWithdrawSyncNotice("");
      void fetchPrivateBalance({ silent: true });
      void fetchEmployeePayrollSummary({
        silent: true,
        force: true,
        interactive: false,
      });
      void fetchWithdrawHistory(true);
    } catch (err: unknown) {
      const rawMessage = getErrorMessage(err);
      const isPriorCreditError =
        rawMessage.includes(
          "Attempt to debit an account but found no record of a prior credit",
        ) ||
        rawMessage.toLowerCase().includes("prior credit");

      if (isPriorCreditError) {
        setWithdrawSyncNotice(
          "Your private balance changed while the transaction was being prepared. The UI is refreshing to the latest available amount.",
        );
        if (activeToken && publicKey) {
          void getPrivateBalance(publicKey.toBase58(), activeToken)
            .then((balance) => {
              const latestMicro = parseInt(balance.balance ?? "0", 10) || 0;
              setVisiblePrivBalance(
                latestMicro > 0 ? (latestMicro / 1_000_000).toFixed(6) : "0",
              );
            })
            .catch(() => undefined);
        }
        void fetchPrivateBalance({ silent: true });
        void fetchEmployeePayrollSummary({
          silent: true,
          force: true,
          interactive: false,
        });
      }

      const message = isPriorCreditError
        ? "Your private balance is no longer available for this withdrawal. The UI has been refreshed with the latest state."
        : rawMessage;
      toast.error(`Transaction failed: ${message}`, { id: withdrawToastId });
      if (publicKey && signMessage) {
        try {
          await walletAuthenticatedFetch({
            path: "/api/history",
            method: "POST",
            signMessage,
            wallet: publicKey.toBase58(),
            body: {
              kind: "claim-record",
              wallet: publicKey.toBase58(),
              amount:
                withdrawAmount.trim() === ""
                  ? privBalanceNum
                  : parseFloat(withdrawAmount) || 0,
              recipient: withdrawRecipientTrimmed || publicKey.toBase58(),
              status: "failed",
              privacyConfig: {
                visibility: "private",
                fromBalance: "ephemeral",
                toBalance: "base",
                destinationStrategy: isOwnWalletDestination
                  ? "connected-wallet"
                  : "custom-address",
              },
              providerMeta: {
                provider: "magicblock",
                action: isOwnWalletDestination
                  ? "employee-withdrawal"
                  : "employee-external-transfer",
                destinationWallet: withdrawRecipientTrimmed || publicKey.toBase58(),
                creditVerified: false,
                errorMessage: message,
              },
            },
          });
        } catch (historyErr) {
          console.error("Failed to save failed withdraw history", historyErr);
        }
        void fetchWithdrawHistory(true);
      }
    } finally {
      setWithdrawing(false);
    }
  };

  const formatTxSig = (value?: string) =>
    value ? `${value.slice(0, 6)}...${value.slice(-6)}` : "Not recorded";

  const handleInitialize = async () => {
    if (!publicKey || !signTransaction || !signMessage) return;
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

      const buildRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/employee-private-init",
        method: "POST",
        body: { employeeWallet: publicKey.toBase58() },
      });
      const buildJson = await buildRes.json();
      if (!buildRes.ok)
        throw new Error(buildJson.error || "Failed to build init tx");

      const signature = await signAndSend(
        buildJson.transaction.transactionBase64,
        signTransaction,
        {
          sendTo: buildJson.transaction.sendTo,
        },
      );

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


  const handleClaimSalary = async () => {
    if (!publicKey || !signTransaction || !signMessage || !primaryPayrollStream?.stream) return;
    const amount = parseFloat(requestAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    if (!hasLivePreview) {
      toast.error("Live PER preview is required. Refresh and sign first.");
      return;
    }
    if (requestMaxUsdc > 0 && amount > requestMaxUsdc) {
      toast.error(`Request exceeds max claimable (${requestMaxUsdc.toFixed(6)} USDC)`);
      return;
    }

    setSubmittingRequest(true);
    try {
      const token = await getOrFetchToken();
      if (!token) throw new Error("Authentication failed");

      // 1. Build request_withdrawal tx
      const buildRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/claim-salary/request",
        method: "POST",
        body: {
          employeeWallet: publicKey.toBase58(),
          streamId: primaryPayrollStream.stream.id,
          amountMicro: Math.round(amount * 1_000_000),
          teeAuthToken: token,
        },
      });
      const buildJson = await buildRes.json();
      if (!buildRes.ok) throw new Error(buildJson.error || "Failed to build claim tx");

      // 2. Sign and send to PER
      const signature = await signAndSend(
        buildJson.transactions.requestWithdrawal.transactionBase64,
        signTransaction,
        { sendTo: "ephemeral", rpcUrl: `https://devnet-tee.magicblock.app?token=${encodeURIComponent(token)}`, signMessage, publicKey }
      );

      // 3. Save claim to DB
      const patchRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/claim-salary/request",
        method: "PATCH",
        body: {
          employeeWallet: publicKey.toBase58(),
          streamId: primaryPayrollStream.stream.id,
          amountMicro: Math.round(amount * 1_000_000),
          claimId: buildJson.claimId,
          signature,
          teeAuthToken: token,
        },
      });
      const patchJson = await patchRes.json();
      if (!patchRes.ok) throw new Error(patchJson.error || "Failed to save claim");

      toast.success("Claim submitted successfully!");
      setRequestAmount("");

      // 4. Trigger the backend to pay automatically
      toast.loading("Processing payout...", { id: "payout-toast" });
      const processRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/claim-salary/process",
        method: "POST",
        body: {
          streamId: primaryPayrollStream.stream.id,
          teeAuthToken: token,
          employeeWallet: publicKey.toBase58(),
        },
      });
      const processJson = await processRes.json();

      if (!processRes.ok) {
        toast.error("Claim is stuck. Please click Sync Claim State later.", { id: "payout-toast" });
      } else {
        toast.success("Claim paid successfully!", { id: "payout-toast" });
      }

      await fetchCashoutRequests(false);
    } catch (err: unknown) {
      toast.error(`Claim failed: ${getErrorMessage(err)}`);
    } finally {
      setSubmittingRequest(false);
    }
  };

  const [syncingClaim, setSyncingClaim] = useState(false);
  const [cancellingClaim, setCancellingClaim] = useState(false);

  const handleSyncClaim = async () => {
    if (!publicKey || !signMessage || !primaryPayrollStream?.stream?.id) return;
    setSyncingClaim(true);
    toast.loading("Syncing claim state...", { id: "sync-toast" });
    try {
      const token = await getOrFetchToken();
      if (!token) throw new Error("Authentication failed");
      const processRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/claim-salary/process",
        method: "POST",
        body: {
          streamId: primaryPayrollStream.stream.id,
          teeAuthToken: token,
          employeeWallet: publicKey.toBase58(),
        },
      });
      const processJson = await processRes.json();

      if (!processRes.ok) {
        throw new Error(processJson.error || "Failed to sync claim");
      }
      toast.success("Claim synced successfully!", { id: "sync-toast" });
      await fetchCashoutRequests(false);
    } catch (err: unknown) {
      toast.error(`Sync failed: ${getErrorMessage(err)}`, { id: "sync-toast" });
    } finally {
      setSyncingClaim(false);
    }
  };

  const handleCancelClaim = async () => {
    if (!publicKey || !signMessage || !primaryPayrollStream?.stream?.id) return;
    setCancellingClaim(true);
    toast.loading("Cancelling claim...", { id: "cancel-claim-toast" });
    try {
      const token = await getOrFetchToken();
      if (!token) throw new Error("Authentication failed");
      const cancelRes = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/claim-salary/cancel",
        method: "POST",
        body: {
          streamId: primaryPayrollStream.stream.id,
          teeAuthToken: token,
          employeeWallet: publicKey.toBase58(),
        },
      });
      const cancelJson = await cancelRes.json();

      if (!cancelRes.ok) {
        throw new Error(cancelJson.error || "Failed to cancel claim");
      }

      toast.success("Claim cancelled successfully.", { id: "cancel-claim-toast" });
      await Promise.all([
        fetchCashoutRequests(false),
        fetchEmployeePayrollSummary({ silent: true, interactive: false }),
      ]);
    } catch (err: unknown) {
      toast.error(`Cancel failed: ${getErrorMessage(err)}`, {
        id: "cancel-claim-toast",
      });
    } finally {
      setCancellingClaim(false);
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

        <div className="mb-6 rounded-3xl border border-white/10 bg-white/5 p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">
            {employeeClaimSummary.step}
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-white">
                {employeeClaimSummary.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-[#a8a8aa]">
                {employeeClaimSummary.body}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#8f8f95]">
                Current private balance
              </p>
              <p className="mt-1 text-lg font-bold text-white">
                {privBalanceNum.toFixed(6)} USDC
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="rounded-3xl border border-white/10 bg-[#0b0b0d] p-6 shadow-[0_10px_40px_rgba(0,0,0,0.35)] sm:p-8">
              <div className="space-y-8">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                    How this works
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">1. Claim</p>
                      <p className="mt-2 text-xs leading-relaxed text-[#b6b6bc]">
                        Salary moves privately from your employer treasury into your private balance.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">2. Hold</p>
                      <p className="mt-2 text-xs leading-relaxed text-[#b6b6bc]">
                        Funds can stay private here until you are ready to move them.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#84f7dc]">3. Withdraw</p>
                      <p className="mt-2 text-xs leading-relaxed text-[#b6b6bc]">
                        Send the private balance to your own wallet or another private destination.
                      </p>
                    </div>
                  </div>
                </div>

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
                          : "Transfer from your private balance to the destination wallet's base balance."}
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
                      placeholder={`Max ${privBalanceNum.toString()}`}
                      value={withdrawAmount}
                      onChange={(e) => {
                        setWithdrawAmount(e.target.value);
                        if (withdrawSyncNotice) setWithdrawSyncNotice("");
                      }}
                      disabled={!privateAccountInitialized}
                      className="flex-1 bg-transparent text-lg font-bold text-white outline-none placeholder:text-[#62626b]"
                    />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95]">
                      USDC
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setWithdrawAmount(privBalanceNum.toString())
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
                  {withdrawSyncNotice && (
                    <p className="mt-2 px-1 text-[10px] font-bold text-amber-200">
                      {withdrawSyncNotice}
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
                  Claim Salary
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

	              {onChainPendingClaim && ["needs_sync", "paying"].includes(onChainPendingClaim.status) ? (
                <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
	                  <p className="text-xs font-bold text-rose-200 mb-2">
                    {onChainPendingClaim.status === "needs_sync"
	                      ? "Your last payout reached your private balance, but the final bookkeeping step still needs to sync."
	                      : "Your claim is processing now. If it stays stuck for a while, you can finish the sync here."}
	                  </p>
                  <button
                    onClick={handleSyncClaim}
                    disabled={syncingClaim}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-500 py-2 text-[10px] font-bold uppercase tracking-widest text-black transition-all hover:bg-rose-400 disabled:opacity-40"
                  >
                    {syncingClaim ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                    Sync Claim State
                  </button>
                </div>
              ) : null}

              {onChainPendingClaim && onChainPendingClaim.status === "failed" ? (
                <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                  <p className="text-xs font-bold text-red-200 mb-2">
                    Your claim payout failed, likely due to insufficient funds in your employer's treasury. You can retry the payout.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      onClick={handleSyncClaim}
                      disabled={syncingClaim || cancellingClaim}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-500 py-2 text-[10px] font-bold uppercase tracking-widest text-black transition-all hover:bg-red-400 disabled:opacity-40"
                    >
                      {syncingClaim ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                      Retry Payout
                    </button>
                    <button
                      onClick={handleCancelClaim}
                      disabled={syncingClaim || cancellingClaim}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-300/40 bg-transparent py-2 text-[10px] font-bold uppercase tracking-widest text-red-100 transition-all hover:bg-red-400/10 disabled:opacity-40"
                    >
                      {cancellingClaim ? <Loader2 className="animate-spin" size={14} /> : <LogOut size={14} />}
                      Cancel Claim
                    </button>
                  </div>
                </div>
              ) : null}

              {onChainPendingClaim && onChainPendingClaim.status === "requested" ? (
                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <p className="text-xs font-bold text-amber-200 mb-2">
                    Your claim is still pending on the payroll engine. You can wait for payout processing or cancel it to restore the amount back into claimable balance.
                  </p>
                  <button
                    onClick={handleCancelClaim}
                    disabled={cancellingClaim}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-300/40 bg-transparent py-2 text-[10px] font-bold uppercase tracking-widest text-amber-100 transition-all hover:bg-amber-400/10 disabled:opacity-40"
                  >
                    {cancellingClaim ? <Loader2 className="animate-spin" size={14} /> : <LogOut size={14} />}
                    Cancel Pending Claim
                  </button>
                </div>
              ) : null}

	              {hasPendingRequest && (!onChainPendingClaim || !["requested", "needs_sync", "paying", "failed"].includes(onChainPendingClaim.status)) ? (
	                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
	                  <p className="text-xs font-bold text-amber-200">
	                    You already have a claim in progress. Wait for it to settle before starting another.
	                  </p>
	                </div>
	              ) : null}

              <div className="grid grid-cols-1 gap-4">
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
              </div>
	              {!hasLivePreview ? (
	                <p className="mt-3 text-[11px] text-amber-300">
	                  Claiming unlocks after your employer finishes payroll setup and live salary sync is available.
	                </p>
	              ) : null}
              <div className="mt-2 flex items-center justify-between px-1">
                <p className="text-[10px] text-[#8f8f95]">
                  Live claimable now:{" "}
                  <span className="font-bold text-[#64f0ce]">
                    {hasLivePreview ? `${liveClaimableUsdc.toFixed(6)} USDC` : "—"}
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
	                onClick={handleClaimSalary}
	                disabled={
	                  submittingRequest ||
	                  !publicKey ||
	                  !registeredEmployeeWallet ||
	                  !privateAccountInitialized ||
	                  !primaryPayrollStream?.stream?.id ||
	                  !hasLivePreview ||
	                  requestMaxUsdc <= 0 ||
	                  hasPendingRequest
                }
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-4 text-[11px] font-bold uppercase tracking-widest text-white shadow-sm transition-all hover:bg-white/20 disabled:opacity-30"
              >
                {submittingRequest ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  <Send size={16} />
                )}
                {hasPendingRequest ? "Pending..." : "Claim Salary"}
              </button>
	              <p className="mt-4 text-center text-[10px] text-[#62626b]">
	                Claimed salary lands in your private balance first, then you can withdraw it whenever you want.
	              </p>
                {claimDisabledReason ? (
                  <p className="mt-2 text-center text-[11px] text-amber-300">
                    {claimDisabledReason}
                  </p>
                ) : null}

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

            <div className="mt-6 rounded-3xl border border-white/10 bg-[#0b0b0d] p-6 shadow-[0_10px_40px_rgba(0,0,0,0.35)] sm:p-8">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">
                    Recent Withdrawals
                  </h3>
                  <p className="mt-1 text-xs text-[#8f8f95]">
                    Signed receipts for your latest base exits and private sends.
                  </p>
                </div>
                <button
                  onClick={() => void fetchWithdrawHistory(false)}
                  disabled={loadingWithdrawHistory}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#a8a8aa] transition-all hover:bg-white/10 disabled:opacity-40"
                >
                  {loadingWithdrawHistory ? (
                    <Loader2 className="animate-spin" size={12} />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  Refresh
                </button>
              </div>

              {withdrawHistory.length === 0 ? (
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-5">
                  <p className="text-xs text-[#8f8f95]">
                    No withdrawal receipts yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {withdrawHistory.slice(0, 5).map((record) => {
                    const isPendingCredit = record.status === "submitted";
                    const isFailed = record.status === "failed";
                    const isExternalTransfer =
                      record.providerMeta?.action === "employee-external-transfer" ||
                      record.providerMeta?.action === "employee-private-transfer";
                    return (
                      <div
                        key={record.id}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {isPendingCredit ? (
                                <Clock3 size={14} className="text-amber-300" />
                              ) : isFailed ? (
                                <AlertTriangle size={14} className="text-red-300" />
                              ) : (
                                <CheckCircle2 size={14} className="text-[#64f0ce]" />
                              )}
                              <p className="text-sm font-bold text-white">
                                {isExternalTransfer
                                  ? "External wallet transfer"
                                  : "Base wallet withdrawal"}
                              </p>
                              <span
                                className={`inline-flex rounded-lg border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                                  isPendingCredit
                                    ? "border-amber-300/30 bg-amber-400/10 text-amber-200"
                                    : isFailed
                                      ? "border-red-400/30 bg-red-500/10 text-red-200"
                                      : "border-[#1eba98]/20 bg-[#1eba98]/10 text-[#84f7dc]"
                                }`}
                              >
                                {record.status}
                              </span>
                            </div>
                            <p className="mt-2 text-xs text-[#a8a8aa] break-all">
                              Destination: {record.providerMeta?.destinationWallet ?? record.recipient}
                            </p>
                            <p className="mt-1 text-[11px] text-[#8f8f95]">
                              {new Date(record.date).toLocaleString()}
                            </p>
                            <p className="mt-2 text-[11px] text-[#b6b6bc]">
                              {isPendingCredit
                                ? "Fee may already be spent. The withdrawal transaction was submitted, but the base-wallet credit is not visible yet."
                                : isFailed
                                  ? record.providerMeta?.errorMessage ?? "The transaction did not complete."
                                  : "Funds were submitted successfully."}
                            </p>
                            <p className="mt-2 text-[10px] uppercase tracking-widest text-[#62626b]">
                              Tx: {formatTxSig(record.txSig)}
                            </p>
                          </div>
                          <div className="shrink-0 text-left sm:text-right">
                            <p className="text-sm font-bold text-white">
                              {record.amount.toFixed(6)} USDC
                            </p>
                            <p className="mt-1 text-[10px] uppercase tracking-widest text-[#8f8f95]">
                              {record.privacyConfig?.fromBalance ?? "ephemeral"} → {record.privacyConfig?.toBalance ?? "unknown"}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
