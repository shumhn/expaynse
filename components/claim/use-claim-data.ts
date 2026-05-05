
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { toast } from "sonner";
import {
  getPrivateBalance,
  privateTransfer,
  withdraw,
  signAndSend,
  fetchTeeAuthToken,
  isJwtExpired,
  type BalanceResponse,
} from "@/lib/magicblock-api";
import {
  clearCachedTeeToken,
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import type { PayrollPayoutMode } from "@/lib/payroll-payout-mode";

export interface EmployeePrivateInitStatusResponse {
  employeeWallet: string;
  registered: boolean;
  initialized: boolean;
  status?: "pending" | "processing" | "confirmed" | "failed";
  requestedAt?: string | null;
  lastAttemptAt?: string | null;
  confirmedAt?: string | null;
  txSignature?: string | null;
  error?: string | null;
  message: string;
}

export interface EmployeePayrollSummaryResponse {
  employeeWallet: string;
  employees: Array<{
    id: string;
    employerWallet: string;
    name: string;
    privateRecipientInitializedAt: string | null;
  }>;
  streams: Array<{
    employerWallet: string;
    employee: {
      id: string;
      wallet: string;
      name: string;
      privateRecipientInitializedAt: string | null;
    };
    stream: {
      id: string;
      status: "active" | "paused" | "stopped";
      ratePerSecond: number;
      payoutMode: PayrollPayoutMode;
      allowedPayoutModes: PayrollPayoutMode[];
      employeePda: string | null;
      privatePayrollPda: string | null;
      permissionPda: string | null;
      delegatedAt: string | null;
      recipientPrivateInitializedAt: string | null;
      lastPaidAt: string | null;
      totalPaid: number;
      checkpointCrankStatus: "idle" | "pending" | "active" | "failed" | "stopped" | null;
      checkpointCrankUpdatedAt: string | null;
      updatedAt: string;
    };
    liveState: {
      ready: boolean;
      source: "per-preview" | "stream-metadata";
      reason:
        | "preview-available"
        | "tee-token-missing"
        | "stream-not-delegated"
        | "private-account-not-initialized"
        | "private-state-missing"
        | "preview-unavailable";
    };
    preview: {
      employeePda: string;
      privatePayrollPda: string;
      employee: string;
      streamId: string;
      status: "active" | "paused" | "stopped";
      version: string;
      lastCheckpointTs: string;
      ratePerSecondMicro: string;
      lastAccrualTimestamp: string;
      accruedUnpaidMicro: string;
      totalPaidPrivateMicro: string;
      elapsedSeconds: number;
      pendingAccrualMicro: string;
      claimableAmountMicro: string;
      effectiveClaimableAmountMicro: string;
      monthlyCapUsd: number | null;
      monthlyCapMicro: string | null;
      cycleKey: string | null;
      cycleStart: string | null;
      cycleEnd: string | null;
      paidThisCycleMicro: string | null;
      remainingCapMicro: string | null;
      capReached: boolean;
    } | null;
  }>;
  syncedAt: string;
}

export type MagicBlockHealthState = "checking" | "ok" | "error";

export function useClaimData() {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  const [privBalance, setPrivBalance] = useState<string | null>(null);
  const [payrollSummary, setPayrollSummary] = useState<EmployeePayrollSummaryResponse | null>(null);
  const [payrollSummaryError, setPayrollSummaryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingPayrollSummary, setLoadingPayrollSummary] = useState(false);
  const [initializingPrivateAccount, setInitializingPrivateAccount] = useState(false);
  const [privateAccountInitialized, setPrivateAccountInitialized] = useState(false);
  const [checkingPrivateInitStatus, setCheckingPrivateInitStatus] = useState(false);
  const [registeredEmployeeWallet, setRegisteredEmployeeWallet] = useState(false);
  const [privateInitStatus, setPrivateInitStatus] = useState<EmployeePrivateInitStatusResponse["status"]>("pending");
  const [privateInitError, setPrivateInitError] = useState<string | null>(null);
  const [privateInitMessage, setPrivateInitMessage] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [magicBlockHealth, setMagicBlockHealth] = useState<MagicBlockHealthState>("checking");

  const tokenCache = useRef<string | null>(null);
  const payrollSummaryInFlightRef = useRef(false);
  const payrollSummaryLastFetchAtRef = useRef(0);

  const resolveMagicBlockHealth = useCallback(
    (summary: EmployeePayrollSummaryResponse | null) => {
      if (!summary || summary.streams.length === 0) return "checking" as MagicBlockHealthState;
      if (summary.streams.some((stream) => stream.liveState?.ready)) return "ok" as MagicBlockHealthState;
      if (
        summary.streams.some(
          (stream) =>
            stream.liveState?.reason === "tee-token-missing" ||
            stream.liveState?.reason === "private-state-missing" ||
            stream.liveState?.reason === "preview-unavailable",
        )
      ) {
        return "error" as MagicBlockHealthState;
      }
      return "checking" as MagicBlockHealthState;
    },
    [],
  );

  useEffect(() => {
    tokenCache.current = null;
    setPrivBalance(null);
    setPayrollSummary(null);
    setPayrollSummaryError(null);
    setPrivateAccountInitialized(false);
    setRegisteredEmployeeWallet(false);
    setPrivateInitStatus("pending");
    setPrivateInitError(null);
    setPrivateInitMessage(null);
  }, [publicKey]);

  const getOrFetchToken = useCallback(
    async (options?: { interactive?: boolean }) => {
      const interactive = options?.interactive !== false;
      if (tokenCache.current && !isJwtExpired(tokenCache.current)) return tokenCache.current;
      if (tokenCache.current && isJwtExpired(tokenCache.current)) {
        tokenCache.current = null;
        if (publicKey) clearCachedTeeToken(publicKey.toBase58());
      }
      if (!tokenCache.current && publicKey) {
        const persisted = loadCachedTeeToken(publicKey.toBase58());
        if (persisted) {
          tokenCache.current = persisted;
          return persisted;
        }
      }
      if (!interactive) return null;
      if (!publicKey || !signMessage) throw new Error("Wallet does not support message signing");
      const token = await getOrCreateCachedTeeToken(publicKey.toBase58(), async () => {
        toast.info("Please sign the message to authorize access to your private vault");
        return fetchTeeAuthToken(publicKey, signMessage);
      });
      tokenCache.current = token;
      return token;
    },
    [publicKey, signMessage]
  );

  const fetchPrivateInitStatus = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!publicKey) return;
      if (!options?.silent) setCheckingPrivateInitStatus(true);
      try {
        const response = await fetch(`/api/employee-private-init?employeeWallet=${publicKey.toBase58()}`);
        const json = (await response.json()) as EmployeePrivateInitStatusResponse & {
          error?: string;
        };
        if (!response.ok) throw new Error(json.error || "Failed to load private account status");
        setRegisteredEmployeeWallet(json.registered);
        setPrivateAccountInitialized(json.initialized);
        setPrivateInitStatus(json.status ?? (json.initialized ? "confirmed" : "pending"));
        setPrivateInitError(json.error ?? null);
        setPrivateInitMessage(json.message ?? null);
        return json.initialized;
      } catch (err: any) {
        if (!options?.silent) toast.error(`Private account status failed: ${err.message}`);
        return false;
      } finally {
        if (!options?.silent) setCheckingPrivateInitStatus(false);
      }
    },
    [publicKey]
  );

  const fetchPrivateBalance = useCallback(
    async (options?: { silent?: boolean; interactive?: boolean }) => {
      if (!publicKey) return;
      setLoading(true);
      try {
        const token = await getOrFetchToken({
          interactive: options?.interactive ?? options?.silent !== true,
        });
        if (!token) return;
        const res = (await getPrivateBalance(publicKey.toBase58(), token)) as BalanceResponse;
        if (res.location !== "ephemeral") throw new Error(`Expected ephemeral balance, got ${res.location}`);
        const normalized = parseFloat((parseInt(res.balance ?? "0", 10) / 1_000_000).toFixed(6)).toString();
        setPrivBalance(normalized);
        if (!options?.silent) toast.success(`Current private balance: ${normalized} USDC`);
      } catch (err: any) {
        if (!options?.silent) toast.error(`Private balance failed: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [publicKey, getOrFetchToken]
  );

  const fetchEmployeePayrollSummary = useCallback(
    async (options?: { silent?: boolean; force?: boolean; interactive?: boolean }) => {
      if (!publicKey) return;
      const silent = options?.silent === true;
      const force = options?.force === true;
      const interactive = options?.interactive ?? !silent;
      const now = Date.now();
      if (silent && !force && (payrollSummaryInFlightRef.current || now - payrollSummaryLastFetchAtRef.current < 1500)) return;
      payrollSummaryInFlightRef.current = true;
      payrollSummaryLastFetchAtRef.current = now;
      if (!silent) setLoadingPayrollSummary(true);
      try {
        let token: string | null = null;
        try {
          token = await getOrFetchToken({ interactive });
        } catch {
          token = null;
        }
        const response = await fetch(
          `/api/payroll/employee?employeeWallet=${publicKey.toBase58()}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          },
        );
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Failed to load summary");
        setPayrollSummary(json);
        setPayrollSummaryError(null);
        setMagicBlockHealth(resolveMagicBlockHealth(json));
      } catch (err: any) {
        setMagicBlockHealth("error");
        if (!silent) {
          setPayrollSummaryError(err.message);
          toast.error(`Summary failed: ${err.message}`);
        }
      } finally {
        if (!silent) setLoadingPayrollSummary(false);
        payrollSummaryInFlightRef.current = false;
      }
    },
    [publicKey, getOrFetchToken, resolveMagicBlockHealth]
  );

  return {
    publicKey,
    signTransaction,
    signMessage,
    connected,
    privBalance,
    payrollSummary,
    payrollSummaryError,
    loading,
    loadingPayrollSummary,
    initializingPrivateAccount,
    privateAccountInitialized,
    checkingPrivateInitStatus,
    registeredEmployeeWallet,
    privateInitStatus,
    privateInitError,
    privateInitMessage,
    withdrawing,
    magicBlockHealth,
    setInitializingPrivateAccount,
    setWithdrawing,
    setMagicBlockHealth,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    getOrFetchToken,
  };
}
