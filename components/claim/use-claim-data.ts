
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import {
  getPrivateBalance,
  fetchTeeAuthToken,
  isJwtExpired,
  type BalanceResponse,
} from "@/lib/magicblock-api";
import {
  clearCachedTeeToken,
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";
import type {
  EmployeePayrollSummaryResponse,
  EmployeePrivateInitStatusResponse,
  MagicBlockHealthState,
} from "./claim-types";

const CLAIM_DATA_CACHE_KEY = "expaynse:claim-data-cache";

type ClaimDataCache = {
  wallet: string;
  privBalance: string | null;
  payrollSummary: EmployeePayrollSummaryResponse | null;
  privateAccountInitialized: boolean;
  registeredEmployeeWallet: boolean;
  privateInitStatus: EmployeePrivateInitStatusResponse["status"];
  privateInitError: string | null;
  privateInitMessage: string | null;
};

function loadClaimDataCache(): ClaimDataCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CLAIM_DATA_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ClaimDataCache;
  } catch {
    return null;
  }
}

function saveClaimDataCache(cache: ClaimDataCache) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CLAIM_DATA_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore cache write failures
  }
}

export function useClaimData() {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  const initialCache = loadClaimDataCache();
  const [privBalance, setPrivBalance] = useState<string | null>(initialCache?.privBalance ?? null);
  const [payrollSummary, setPayrollSummary] = useState<EmployeePayrollSummaryResponse | null>(
    initialCache?.payrollSummary ?? null,
  );
  const [payrollSummaryError, setPayrollSummaryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingPayrollSummary, setLoadingPayrollSummary] = useState(false);
  const [initializingPrivateAccount, setInitializingPrivateAccount] = useState(false);
  const [privateAccountInitialized, setPrivateAccountInitialized] = useState(
    initialCache?.privateAccountInitialized ?? false,
  );
  const [checkingPrivateInitStatus, setCheckingPrivateInitStatus] = useState(false);
  const [registeredEmployeeWallet, setRegisteredEmployeeWallet] = useState(
    initialCache?.registeredEmployeeWallet ?? false,
  );
  const [privateInitStatus, setPrivateInitStatus] = useState<EmployeePrivateInitStatusResponse["status"]>(
    initialCache?.privateInitStatus ?? "pending",
  );
  const [privateInitError, setPrivateInitError] = useState<string | null>(initialCache?.privateInitError ?? null);
  const [privateInitMessage, setPrivateInitMessage] = useState<string | null>(initialCache?.privateInitMessage ?? null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [magicBlockHealth, setMagicBlockHealth] = useState<MagicBlockHealthState>("checking");
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());

  const tokenCache = useRef<string | null>(null);
  const payrollSummaryInFlightRef = useRef(false);
  const payrollSummaryLastFetchAtRef = useRef(0);
  const walletAddress = publicKey?.toBase58() ?? "";

  useEffect(() => {
    if (!walletAddress) return;
    saveClaimDataCache({
      wallet: walletAddress,
      privBalance,
      payrollSummary,
      privateAccountInitialized,
      registeredEmployeeWallet,
      privateInitStatus,
      privateInitError,
      privateInitMessage,
    });
  }, [
    walletAddress,
    privBalance,
    payrollSummary,
    privateAccountInitialized,
    registeredEmployeeWallet,
    privateInitStatus,
    privateInitError,
    privateInitMessage,
  ]);

  const resolveMagicBlockHealth = useCallback(
    (summary: EmployeePayrollSummaryResponse | null) => {
      if (!summary || summary.streams.length === 0) return "checking" as MagicBlockHealthState;
      if (summary.streams.some((stream) => stream.liveState?.ready)) return "ok" as MagicBlockHealthState;
      if (
        summary.streams.some(
          (stream) =>
            stream.liveState?.reason === "tee-token-missing" ||
            stream.liveState?.reason === "private-state-missing" ||
            stream.liveState?.reason === "snapshot-unavailable",
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
    const cache = loadClaimDataCache();
    const timeoutId = window.setTimeout(() => {
      if (publicKey) {
        const nextWallet = publicKey.toBase58();
        if (cache?.wallet === nextWallet) {
          setPrivBalance(cache.privBalance);
          setPayrollSummary(cache.payrollSummary);
          setPrivateAccountInitialized(cache.privateAccountInitialized);
          setRegisteredEmployeeWallet(cache.registeredEmployeeWallet);
          setPrivateInitStatus(cache.privateInitStatus);
          setPrivateInitError(cache.privateInitError);
          setPrivateInitMessage(cache.privateInitMessage);
        } else {
          setPrivBalance(null);
          setPayrollSummary(null);
          setPrivateAccountInitialized(false);
          setRegisteredEmployeeWallet(false);
          setPrivateInitStatus("pending");
          setPrivateInitError(null);
          setPrivateInitMessage(null);
        }
      } else {
        setPrivBalance(null);
        setPayrollSummary(null);
        setPrivateAccountInitialized(false);
        setRegisteredEmployeeWallet(false);
        setPrivateInitStatus("pending");
        setPrivateInitError(null);
        setPrivateInitMessage(null);
      }
      setPayrollSummaryError(null);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [publicKey]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, []);

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
      } catch (err: unknown) {
        if (!options?.silent) {
          toast.error(
            `Private account status failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
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
      } catch (err: unknown) {
        if (!options?.silent) {
          toast.error(
            `Private balance failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
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
        const json = (await response.json()) as
          | EmployeePayrollSummaryResponse
          | { error?: string };
        if (!response.ok) {
          throw new Error(
            "error" in json ? json.error || "Failed to load summary" : "Failed to load summary",
          );
        }
        setPayrollSummary(json as EmployeePayrollSummaryResponse);
        setPayrollSummaryError(null);
        setMagicBlockHealth(resolveMagicBlockHealth(json as EmployeePayrollSummaryResponse));
      } catch (err: unknown) {
        setMagicBlockHealth("error");
        if (!silent) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setPayrollSummaryError(message);
          toast.error(`Summary failed: ${message}`);
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
    liveNowMs,
    setInitializingPrivateAccount,
    setWithdrawing,
    setMagicBlockHealth,
    fetchPrivateInitStatus,
    fetchPrivateBalance,
    fetchEmployeePayrollSummary,
    getOrFetchToken,
  };
}
