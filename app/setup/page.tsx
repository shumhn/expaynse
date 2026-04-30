"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { toast } from "sonner";
import Link from "next/link";
import {
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wallet,
  ArrowUpRight,
} from "lucide-react";

import { EmployerLayout } from "@/components/employer-layout";
import {
  checkHealth,
  deposit,
  fetchTeeAuthToken,
  getBalance,
  getPrivateBalance,
  isJwtExpired,
  signAndSend,
  type BalanceResponse,
} from "@/lib/magicblock-api";
import {
  clearCachedTeeToken,
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

interface BalanceDebugState {
  response: BalanceResponse | null;
  checkedAt: string | null;
  error: string | null;
}
interface SetupAction {
  id: string;
  date: string;
  type: "initialize-mint" | "fund-treasury";
  wallet: string;
  amount?: number;
  txSig?: string;
  status: "success" | "failed";
}

type MagicBlockHealthState = "checking" | "ok" | "error";

function getPrivateBalanceCacheKey(wallet: string) {
  return `expaynse-private-treasury-balance:${wallet}`;
}

export default function SetupPage() {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();

  const [amount, setAmount] = useState("");
  const [fundingTreasury, setFundingTreasury] = useState(false);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [refreshingBaseBalance, setRefreshingBaseBalance] = useState(false);
  const [privateBalance, setPrivateBalance] = useState<string | null>(null);
  const [baseBalance, setBaseBalance] = useState<string | null>(null);

  const [fundingVerificationState, setFundingVerificationState] = useState<
    "idle" | "verified" | "unverified"
  >("idle");
  const [fundingVerificationMessage, setFundingVerificationMessage] = useState<
    string | null
  >(null);

  const [magicBlockHealth, setMagicBlockHealth] =
    useState<MagicBlockHealthState>("checking");

  const tokenCache = useRef<string | null>(null);
  const historyRequestIdRef = useRef(0);

  const walletAddress = publicKey?.toBase58() ?? "";
  const devnetConnection = useMemo(
    () => new Connection(clusterApiUrl("devnet"), "confirmed"),
    [],
  );

  const canSign = !!publicKey && !!signTransaction;
  const canReadPrivateState = !!publicKey && !!signMessage;

  const amountNumber = useMemo(() => {
    const parsed = parseFloat(amount);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [amount]);

  const baseBalanceNumber = useMemo(() => {
    if (!baseBalance) return null;
    const parsed = parseFloat(baseBalance);
    return Number.isFinite(parsed) ? parsed : null;
  }, [baseBalance]);

  const privateBalanceNumber = useMemo(() => {
    if (!privateBalance) return null;
    const parsed = parseFloat(privateBalance);
    return Number.isFinite(parsed) ? parsed : null;
  }, [privateBalance]);

  const hasFundedTreasury = useMemo(
    () => (privateBalanceNumber ?? 0) > 0,
    [privateBalanceNumber],
  );

  const hasInsufficientBaseBalance =
    baseBalanceNumber !== null && amountNumber > baseBalanceNumber;

  const refreshMagicBlockHealth = useCallback(async () => {
    try {
      const health = await checkHealth();
      setMagicBlockHealth(health.status === "ok" ? "ok" : "error");
    } catch {
      setMagicBlockHealth("error");
    }
  }, []);

  useEffect(() => {
    tokenCache.current = null;

    if (!walletAddress) {
      setPrivateBalance(null);
      setBaseBalance(null);
      setFundingVerificationState("idle");
      setFundingVerificationMessage(null);
    }
  }, [walletAddress]);


  const getOrFetchToken = useCallback(async () => {
    if (tokenCache.current && !isJwtExpired(tokenCache.current)) {
      return tokenCache.current;
    }

    if (tokenCache.current && isJwtExpired(tokenCache.current)) {
      tokenCache.current = null;
      if (publicKey) {
        clearCachedTeeToken(publicKey.toBase58());
      }
    }

    if (!tokenCache.current && publicKey) {
      const persisted = loadCachedTeeToken(publicKey.toBase58());
      if (persisted) {
        tokenCache.current = persisted;
        return persisted;
      }
    }

    if (!publicKey || !signMessage) {
      throw new Error("Wallet does not support message signing");
    }

    const token = await getOrCreateCachedTeeToken(
      publicKey.toBase58(),
      async () => {
        toast.info("Please sign the message to access your private treasury view");
        return fetchTeeAuthToken(publicKey, signMessage);
      },
    );
    tokenCache.current = token;
    return token;
  }, [publicKey, signMessage]);

  const loadPersistedPrivateBalance = useCallback((wallet: string) => {
    if (typeof window === "undefined") return null;

    try {
      const raw = window.sessionStorage.getItem(getPrivateBalanceCacheKey(wallet));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { balance?: string };
      return typeof parsed.balance === "string" ? parsed.balance : null;
    } catch {
      return null;
    }
  }, []);

  const persistPrivateBalance = useCallback((wallet: string, balance: string) => {
    if (typeof window === "undefined") return;

    try {
      window.sessionStorage.setItem(
        getPrivateBalanceCacheKey(wallet),
        JSON.stringify({ balance }),
      );
    } catch {
      // no-op
    }
  }, []);

  const refreshTreasuryBalance = useCallback(async () => {
    if (!publicKey) return null;

    setRefreshingBalance(true);
    try {
      const token = await getOrFetchToken();
      const res = (await getPrivateBalance(
        publicKey.toBase58(),
        token,
      )) as BalanceResponse;



      if (res.location !== "ephemeral") {
        throw new Error(
          `Expected private treasury balance from ephemeral location, received ${res.location}`,
        );
      }

      const raw = parseInt(res.balance ?? "0", 10);
      const normalized = (raw / 1_000_000).toFixed(2);
      setPrivateBalance(normalized);
      persistPrivateBalance(publicKey.toBase58(), normalized);
      return normalized;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";

      toast.error(`Treasury balance fetch failed: ${msg}`);
      return null;
    } finally {
      setRefreshingBalance(false);
    }
  }, [publicKey, getOrFetchToken, persistPrivateBalance]);

  const refreshBaseBalance = useCallback(async () => {
    if (!publicKey) return null;

    setRefreshingBaseBalance(true);
    try {
      const res = (await getBalance(publicKey.toBase58())) as BalanceResponse;



      if (res.location !== "base") {
        throw new Error(
          `Expected base wallet balance from base location, received ${res.location}`,
        );
      }

      const raw = parseInt(res.balance ?? "0", 10);
      const normalized = (raw / 1_000_000).toFixed(2);
      setBaseBalance(normalized);
      return normalized;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";

      toast.error(`Base wallet balance fetch failed: ${msg}`);
      return null;
    } finally {
      setRefreshingBaseBalance(false);
    }
  }, [publicKey]);

  const refreshAllBalances = useCallback(async () => {
    const [baseResult, treasuryResult] = await Promise.all([
      refreshBaseBalance(),
      refreshTreasuryBalance(),
    ]);
    return { baseResult, treasuryResult };
  }, [refreshBaseBalance, refreshTreasuryBalance]);

  const syncBalancesAfterFunding = useCallback(
    async (
      previousBase: number,
      previousPrivate: number,
      expectedFundingAmount: number,
    ) => {
      if (!publicKey) {
        return { state: "unverified" as const };
      }

      let lastBase: number | null = null;
      let lastPrivate: number | null = null;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const { baseResult, treasuryResult } = await refreshAllBalances();

        const nextBase =
          typeof baseResult === "string" ? parseFloat(baseResult) : null;
        const nextPrivate =
          typeof treasuryResult === "string"
            ? parseFloat(treasuryResult)
            : null;

        lastBase = nextBase;
        lastPrivate = nextPrivate;

        const baseMoved =
          nextBase !== null &&
          nextBase <= previousBase - expectedFundingAmount + 0.01;

        const privateMoved =
          nextPrivate !== null &&
          nextPrivate >= previousPrivate + expectedFundingAmount - 0.01;

        if (baseMoved && privateMoved) {
          setFundingVerificationState("verified");
          setFundingVerificationMessage(
            `Verified: Base is ${nextBase?.toFixed(2) ?? "n/a"} USDC, Treasury is ${nextPrivate?.toFixed(2) ?? "n/a"} USDC.`,
          );
          return { state: "verified" as const };
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      setFundingVerificationState("unverified");
      setFundingVerificationMessage(
        `Funding sent but not verified locally. Try refreshing balances manually.`,
      );
      return { state: "unverified" as const };
    },
    [publicKey, refreshAllBalances],
  );



  const handleFundTreasury = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      toast.error("Connect a wallet that supports transaction signing");
      return;
    }

    if (!signMessage) {
      toast.error(
        "Connect a wallet that supports message signing so the private treasury can be verified after funding",
      );
      return;
    }

    if (amountNumber <= 0) {
      toast.error("Enter a valid funding amount");
      return;
    }

    if (baseBalanceNumber !== null && amountNumber > baseBalanceNumber) {
      toast.error(
        `Funding amount exceeds your available base USDC of ${baseBalanceNumber.toFixed(2)}`,
      );
      return;
    }

    setFundingTreasury(true);
    setFundingVerificationState("idle");
    setFundingVerificationMessage(null);

    let submittedFundingSig: string | undefined;

    try {
      const token = await getOrFetchToken();
      const [freshBaseRes, freshPrivateRes] = await Promise.all([
        getBalance(publicKey.toBase58()),
        getPrivateBalance(publicKey.toBase58(), token),
      ]);

      const baseSnapshot = freshBaseRes as BalanceResponse;
      const privateSnapshot = freshPrivateRes as BalanceResponse;



      if (baseSnapshot.location !== "base") {
        throw new Error(
          `Expected base wallet balance from base location, received ${baseSnapshot.location}`,
        );
      }

      if (privateSnapshot.location !== "ephemeral") {
        throw new Error(
          `Expected private treasury balance from ephemeral location, received ${privateSnapshot.location}`,
        );
      }

      const previousBase =
        parseInt(baseSnapshot.balance ?? "0", 10) / 1_000_000;
      const previousPrivate =
        parseInt(privateSnapshot.balance ?? "0", 10) / 1_000_000;

      setBaseBalance(previousBase.toFixed(2));
      setPrivateBalance(previousPrivate.toFixed(2));

      const res = await deposit(publicKey.toBase58(), amountNumber, token);

      if (!res.transactionBase64) {
        throw new Error("No treasury funding transaction returned");
      }

      toast.info("Approve the treasury funding transaction in your wallet");

      const sig = await signAndSend(res.transactionBase64, signTransaction, {
        sendTo: res.sendTo || "base",
        signMessage: signMessage || undefined,
        publicKey,
      });
      submittedFundingSig = sig;

      const verificationResult = await syncBalancesAfterFunding(
        previousBase,
        previousPrivate,
        amountNumber,
      );

      const historyResponse = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage: signMessage!,
        path: "/api/history",
        method: "POST",
        body: {
          kind: "setup-action",
          wallet: publicKey.toBase58(),
          type: "fund-treasury",
          amount: amountNumber,
          txSig: sig,
          status: "success",
        },
      });

      const historyJson = (await historyResponse.json()) as {
        setupAction?: SetupAction;
        error?: string;
      };

      if (!historyResponse.ok) {
        throw new Error(
          historyJson.error || "Failed to save setup action history",
        );
      }



      if (verificationResult.state === "verified") {
        toast.success(`Treasury funded with ${amountNumber.toFixed(2)} USDC`);
      } else {
        toast.success(
          `Treasury funding confirmed on-chain for ${amountNumber.toFixed(2)} USDC`,
        );
        toast.info("Balances may take a moment to catch up in the UI");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";

      if (!submittedFundingSig && publicKey) {
        try {
          await walletAuthenticatedFetch({
            wallet: publicKey.toBase58(),
            signMessage: signMessage!,
            path: "/api/history",
            method: "POST",
            body: {
              kind: "setup-action",
              wallet: publicKey.toBase58(),
              type: "fund-treasury",
              amount: amountNumber,
              txSig: submittedFundingSig,
              status: "failed",
            },
          });


        } catch (historyErr: unknown) {
          const historyMsg =
            historyErr instanceof Error ? historyErr.message : "Unknown error";
          toast.error(
            `Failed to record unverified funding attempt: ${historyMsg}`,
          );
        }
      }

      toast.error(`Treasury funding failed: ${msg}`);
    } finally {
      setFundingTreasury(false);
    }
  }, [
    publicKey,
    signTransaction,
    signMessage,
    amountNumber,
    syncBalancesAfterFunding,
    baseBalanceNumber,
    getOrFetchToken,
  ]);

  useEffect(() => {
    if (!walletAddress) return;
    void refreshBaseBalance();
  }, [walletAddress, refreshBaseBalance]);

  useEffect(() => {
    if (!walletAddress) return;

    const persistedBalance = loadPersistedPrivateBalance(walletAddress);
    if (persistedBalance !== null) {
      setPrivateBalance(persistedBalance);
    }

    const persistedToken = loadCachedTeeToken(walletAddress);
    if (!persistedToken) {
      return;
    }

    tokenCache.current = persistedToken;
    void refreshTreasuryBalance();
  }, [
    walletAddress,
    loadPersistedPrivateBalance,
    refreshTreasuryBalance,
  ]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refreshMagicBlockHealth();
    }, 0);
    return () => clearTimeout(t);
  }, [refreshMagicBlockHealth]);

  return (
    <EmployerLayout>
      <div className="max-w-3xl mx-auto min-h-[calc(100vh-120px)] flex flex-col justify-center py-8">
        <header className="text-center space-y-2 mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
            Treasury Deposit
          </h1>
          <div className="flex items-center justify-center gap-3 pt-1">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
              <ShieldCheck
                size={14}
                className={
                  magicBlockHealth === "ok"
                    ? "text-[#1eba98]"
                    : magicBlockHealth === "error"
                      ? "text-amber-400"
                      : "text-[#a8a8aa]"
                }
              />
              <span
                className={`text-[10px] font-bold uppercase tracking-widest ${magicBlockHealth === "ok"
                  ? "text-[#1eba98]"
                  : magicBlockHealth === "error"
                    ? "text-amber-400"
                    : "text-[#a8a8aa]"
                  }`}
              >
                MagicBlock{" "}
                {magicBlockHealth === "ok"
                  ? "Online"
                  : magicBlockHealth === "error"
                    ? "Degraded"
                    : "Checking"}
              </span>
            </div>
          </div>
        </header>

        {!connected ? (
          <div className="rounded-[2rem] border border-white/10 bg-[#0a0a0a] p-12 text-center shadow-sm flex flex-col items-center max-w-xl mx-auto">
            <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-6">
              <Wallet size={24} className="text-white" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Connect your wallet</h3>
            <p className="text-sm text-[#a8a8aa] max-w-sm mb-6 leading-relaxed">
              Please connect your employer wallet to access and fund your private treasury.
            </p>
          </div>
        ) : (
          <div className="bg-[#0a0a0a] border border-white/10 rounded-[2rem] overflow-hidden shadow-sm max-w-2xl mx-auto">
            {/* Unified Balance Banner */}
            <div className="bg-white/5 border-b border-white/5 p-6 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex gap-6 w-full sm:w-auto">
                <div>
                  <p className="text-[10px] text-[#a8a8aa] font-bold uppercase tracking-widest mb-1">Base Wallet</p>
                  <p className="text-sm font-bold text-white">{baseBalance ?? "0.00"} USDC</p>
                </div>
                <div className="w-px bg-white/10 h-8 self-center hidden sm:block"></div>
                <div>
                  <p className="text-[10px] text-[#a8a8aa] font-bold uppercase tracking-widest mb-1">Private Treasury</p>
                  <p className="text-sm font-bold text-[#1eba98]">{privateBalance ?? "0.00"} USDC</p>
                </div>
              </div>
              <button
                onClick={refreshAllBalances}
                disabled={!canReadPrivateState || refreshingBalance || refreshingBaseBalance}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-[10px] font-bold text-white uppercase tracking-widest hover:bg-white/10 disabled:opacity-50 transition-colors shadow-sm"
              >
                {refreshingBalance || refreshingBaseBalance ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Refresh
              </button>
            </div>

            {/* Funding Workflow */}
            <div className="p-5 sm:p-6 space-y-6">
              <div>
                <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-end">
                  <div className="flex-1">
                    <label className="block text-[10px] text-[#a8a8aa] uppercase tracking-widest font-bold mb-2">
                      Amount to fund
                    </label>
                    <div className="relative">
                      <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-[#1eba98] transition-colors shadow-sm">
                        <input
                          type="number"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          min={0}
                          step={0.01}
                          placeholder="100.00"
                          className="flex-1 bg-transparent text-base text-white font-bold placeholder:text-[#a8a8aa]/50 outline-none"
                        />
                        <span className="text-[10px] text-[#a8a8aa] font-bold uppercase tracking-widest">USDC</span>
                      </div>
                      {hasInsufficientBaseBalance && (
                        <p className="absolute top-full left-0 mt-2 text-[10px] text-red-400 font-bold uppercase tracking-wider">
                          Insufficient base balance
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={handleFundTreasury}
                    disabled={!canSign || fundingTreasury || amountNumber <= 0 || hasInsufficientBaseBalance || fundingVerificationState === "unverified"}
                    className="inline-flex items-center justify-center gap-2 h-[50px] px-8 bg-[#1eba98] text-black text-[11px] font-bold rounded-xl disabled:opacity-50 transition-colors cursor-pointer uppercase tracking-widest shadow-md hover:bg-[#1eba98]/80"
                  >
                    {fundingTreasury ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpRight size={16} />}
                    Fund
                  </button>
                </div>
              </div>

              {fundingVerificationMessage && (
                <div className={`rounded-xl px-4 py-3 text-center ${fundingVerificationState === "verified" ? "bg-[#1eba98]/10 border border-[#1eba98]/20" :
                  fundingVerificationState === "unverified" ? "bg-amber-500/10 border border-amber-500/20" :
                    "bg-white/5 border border-white/10"
                  }`}>
                  <p className={`text-[11px] font-bold uppercase tracking-wider ${fundingVerificationState === "verified" ? "text-[#1eba98]" :
                    fundingVerificationState === "unverified" ? "text-amber-400" :
                      "text-[#a8a8aa]"
                    }`}>
                    {fundingVerificationMessage}
                  </p>
                </div>
              )}

              {hasFundedTreasury && (
                <div className="pt-6 border-t border-white/5">
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-[#1eba98]/10 rounded-2xl p-4 border border-[#1eba98]/20">
                    <div>
                      <h4 className="text-sm font-bold text-white">Deposit Complete</h4>
                    </div>
                    <Link
                      href="/people"
                      className="inline-flex items-center justify-center px-6 py-2.5 rounded-full bg-white/5 border border-white/10 text-white text-[11px] font-bold uppercase tracking-widest hover:border-[#1eba98] transition-colors shadow-sm whitespace-nowrap"
                    >
                      Go to People
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </EmployerLayout>
  );
}
