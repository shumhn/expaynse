"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DEVNET_USDC,
  buildSwap,
  checkHealth,
  deposit,
  getBalance,
  getSwapQuote,
  signAndSend,
} from "@/lib/magicblock-api";

const DEVNET_CONNECTION = new Connection(clusterApiUrl("devnet"), "confirmed");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEVNET_USDT_MINT =
  process.env.NEXT_PUBLIC_DEVNET_USDT_MINT?.trim() || "";
const HAS_DEVNET_USDT = DEVNET_USDT_MINT.length > 0;

type FundingMode = "deposit" | "swap-sol" | "swap-usdt";

const FUNDING_MODE_META: Record<
  FundingMode,
  {
    label: string;
    inputLabel: string;
    inputSymbol: string;
    buttonLabel: string;
    balanceLabel: string;
    inputMint?: string;
  }
> = {
  deposit: {
    label: "Deposit USDC",
    inputLabel: "Amount (USDC)",
    inputSymbol: "USDC",
    buttonLabel: "Top Up Private Balance",
    balanceLabel: "Your Wallet Balance",
  },
  "swap-sol": {
    label: "Swap SOL",
    inputLabel: "Amount (SOL)",
    inputSymbol: "SOL",
    buttonLabel: "Swap to Private Balance",
    balanceLabel: "Your SOL Balance",
    inputMint: SOL_MINT,
  },
  "swap-usdt": {
    label: "Swap USDT",
    inputLabel: "Amount (USDT)",
    inputSymbol: "USDT",
    buttonLabel: "Swap to Private Balance",
    balanceLabel: "Your USDT Balance",
    inputMint: DEVNET_USDT_MINT,
  },
};

export function PrivateTopUpModal({
  isOpen,
  onClose,
  privateBalance = 0,
  onTopUpSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  privateBalance?: number;
  onTopUpSuccess?: () => void;
}) {
  const { publicKey, signTransaction, signMessage } = useWallet();
  const [amount, setAmount] = useState("");
  const [fundingMode, setFundingMode] = useState<FundingMode>("deposit");
  const [loading, setLoading] = useState(false);
  const [successSig, setSuccessSig] = useState<string | null>(null);
  const [depositedAmount, setDepositedAmount] = useState<number | null>(null);
  const [magicBlockHealth, setMagicBlockHealth] = useState<"checking" | "ok" | "error">("checking");
  const [liveBaseBalance, setLiveBaseBalance] = useState(0);
  const [liveSolBalance, setLiveSolBalance] = useState(0);
  const [liveUsdtBalance, setLiveUsdtBalance] = useState(0);
  const [swapQuoteOutUsdc, setSwapQuoteOutUsdc] = useState<number | null>(null);
  const [swapQuoteLoading, setSwapQuoteLoading] = useState(false);
  const [swapQuoteError, setSwapQuoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const frameId = requestAnimationFrame(() => {
      setSuccessSig(null);
      setDepositedAmount(null);
      setAmount("");
      setFundingMode("deposit");
      setSwapQuoteOutUsdc(null);
      setSwapQuoteError(null);
      setMagicBlockHealth("checking");
    });

    checkHealth()
      .then((res) => setMagicBlockHealth(res.status === "ok" ? "ok" : "error"))
      .catch(() => setMagicBlockHealth("error"));

    if (publicKey) {
      void getBalance(publicKey.toBase58())
        .then((res) => {
          const next = parseInt(res.balance ?? "0", 10) / 1_000_000;
          if (Number.isFinite(next)) setLiveBaseBalance(next);
        })
        .catch(() => setLiveBaseBalance(0));

      void DEVNET_CONNECTION.getBalance(publicKey)
        .then((lamports) => setLiveSolBalance(lamports / 1_000_000_000))
        .catch(() => setLiveSolBalance(0));

      if (HAS_DEVNET_USDT) {
        void getBalance(publicKey.toBase58(), undefined, DEVNET_USDT_MINT)
          .then((res) => {
            const next = parseInt(res.balance ?? "0", 10) / 1_000_000;
            if (Number.isFinite(next)) setLiveUsdtBalance(next);
          })
          .catch(() => setLiveUsdtBalance(0));
      }
    }

    return () => cancelAnimationFrame(frameId);
  }, [isOpen, publicKey]);

  useEffect(() => {
    if (!isOpen || fundingMode === "deposit") return;

    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const frameId = requestAnimationFrame(() => {
        setSwapQuoteOutUsdc(null);
        setSwapQuoteError(null);
        setSwapQuoteLoading(false);
      });
      return () => cancelAnimationFrame(frameId);
    }

    const amountLamports = Math.round(parsed * 1_000_000_000);
    if (fundingMode === "swap-sol" && amountLamports <= 0) {
      const frameId = requestAnimationFrame(() => {
        setSwapQuoteOutUsdc(null);
        setSwapQuoteError("Enter a larger SOL amount.");
        setSwapQuoteLoading(false);
      });
      return () => cancelAnimationFrame(frameId);
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setSwapQuoteLoading(true);
      setSwapQuoteError(null);
      void getSwapQuote({
        inputMint: FUNDING_MODE_META[fundingMode].inputMint || SOL_MINT,
        outputMint: DEVNET_USDC,
        amount:
          fundingMode === "swap-sol"
            ? String(amountLamports)
            : String(Math.round(parsed * 1_000_000)),
        swapMode: "ExactIn",
        slippageBps: 50,
        restrictIntermediateTokens: true,
        asLegacyTransaction: false,
      })
        .then((quote) => {
          if (cancelled) return;
          setSwapQuoteOutUsdc(parseInt(quote.outAmount, 10) / 1_000_000);
        })
        .catch((err) => {
          if (cancelled) return;
          const message =
            err instanceof Error ? err.message : "Failed to fetch swap quote.";
          setSwapQuoteOutUsdc(null);
          setSwapQuoteError(message);
        })
        .finally(() => {
          if (!cancelled) setSwapQuoteLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amount, fundingMode, isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    setSuccessSig(null);
    setDepositedAmount(null);
    setAmount("");
    onClose();
  };

  const handleTopUp = async () => {
    if (!publicKey || !signTransaction) {
      toast.error("Wallet not connected");
      return;
    }

    const val = parseFloat(amount);
    if (!Number.isFinite(val) || val <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    let latestBaseBalance = liveBaseBalance;
    let latestSolBalance = liveSolBalance;
    let latestUsdtBalance = liveUsdtBalance;

    try {
      const balanceRes = await getBalance(publicKey.toBase58());
      latestBaseBalance = parseInt(balanceRes.balance ?? "0", 10) / 1_000_000;
      if (Number.isFinite(latestBaseBalance)) setLiveBaseBalance(latestBaseBalance);
    } catch {
      // keep last known balance
    }

    try {
      latestSolBalance =
        (await DEVNET_CONNECTION.getBalance(publicKey)) / 1_000_000_000;
      setLiveSolBalance(latestSolBalance);
    } catch {
      // keep last known balance
    }

    if (HAS_DEVNET_USDT) {
      try {
        const usdtRes = await getBalance(
          publicKey.toBase58(),
          undefined,
          DEVNET_USDT_MINT,
        );
        latestUsdtBalance = parseInt(usdtRes.balance ?? "0", 10) / 1_000_000;
        if (Number.isFinite(latestUsdtBalance)) setLiveUsdtBalance(latestUsdtBalance);
      } catch {
        // keep last known balance
      }
    }

    setLoading(true);
    try {
      const owner = publicKey.toBase58();
      let transactionBase64: string | undefined;
      let sendTo: string | undefined;

      if (fundingMode === "deposit") {
        if (val > latestBaseBalance) {
          toast.error("Insufficient base balance");
          return;
        }
        if (latestBaseBalance <= 0) {
          toast.error("Current wallet has no live base USDC. Fund this wallet with devnet USDC first.");
          return;
        }

        const depositRes = await deposit(owner, val);
        transactionBase64 = depositRes.transactionBase64;
        sendTo = depositRes.sendTo;
      } else {
        const isSolSwap = fundingMode === "swap-sol";
        const liveInputBalance = isSolSwap ? latestSolBalance : latestUsdtBalance;
        const assetLabel = isSolSwap ? "devnet SOL" : "devnet USDT";

        if (val > liveInputBalance) {
          toast.error(`Insufficient ${assetLabel} balance.`);
          return;
        }
        if (liveInputBalance <= 0) {
          toast.error(`Current wallet has no ${assetLabel}. Fund this wallet first.`);
          return;
        }

        const quote = await getSwapQuote({
          inputMint: FUNDING_MODE_META[fundingMode].inputMint || SOL_MINT,
          outputMint: DEVNET_USDC,
          amount: String(Math.round(val * (isSolSwap ? 1_000_000_000 : 1_000_000))),
          swapMode: "ExactIn",
          slippageBps: 50,
          restrictIntermediateTokens: true,
          asLegacyTransaction: false,
        });

        const swapRes = await buildSwap({
          userPublicKey: owner,
          payer: owner,
          quoteResponse: quote,
          wrapAndUnwrapSol: isSolSwap,
          useSharedAccounts: true,
          dynamicComputeUnitLimit: true,
          visibility: "private",
          privateOptions: {
            destination: owner,
            minDelayMs: "0",
            maxDelayMs: "60000",
            split: 3,
          },
        });

        transactionBase64 = swapRes.swapTransaction;
        sendTo = "base";
      }

      if (transactionBase64 && sendTo) {
        const sig = await signAndSend(transactionBase64, signTransaction, {
          sendTo,
          signMessage: signMessage || undefined,
          publicKey: publicKey || undefined,
        });

        toast.success(
          fundingMode === "swap-sol"
            ? `Successfully swapped ${val} SOL into your private USDC balance`
            : fundingMode === "swap-usdt"
              ? `Successfully swapped ${val} USDT into your private USDC balance`
              : `Successfully topped up ${val} USDC`
        );
        setDepositedAmount(val);
        setSuccessSig(sig);
        onTopUpSuccess?.();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Top up failed: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md rounded-[2.5rem] border border-white/10 bg-[#0a0a0a] p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          className="absolute right-6 top-6 rounded-xl p-2 text-[#a8a8aa] transition-colors hover:bg-white/5 hover:text-white"
        >
          <X size={18} />
        </button>

        {successSig ? (
          <>
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
              <CheckCircle2 size={28} className="text-emerald-400" />
            </div>

            <h2 className="mb-1 text-2xl font-bold tracking-tight text-white">Private Top Up Complete</h2>
            <p className="mb-8 text-sm text-[#a8a8aa]">
              Your funds have been routed into your private PER balance.
            </p>

            <div className="mb-8 rounded-2xl border border-white/5 bg-white/5 p-4">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                Amount Added
              </p>
              <p className="text-xl font-bold text-white">
                {depositedAmount?.toFixed(2)}{" "}
                <span className="text-sm text-emerald-400">USDC</span>
              </p>
            </div>

            <a
              href={`https://solscan.io/tx/${successSig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="group mb-8 flex w-full items-center justify-between rounded-xl border border-white/5 bg-[#111111] px-4 py-3 transition-all hover:border-white/10 hover:bg-white/5"
            >
              <span className="font-mono text-xs text-[#a8a8aa] transition-colors group-hover:text-white">
                View on Solscan
              </span>
              <div className="flex items-center gap-1.5 font-mono text-xs text-[#1eba98]">
                {successSig.slice(0, 8)}...
                <ExternalLink size={11} />
              </div>
            </a>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleClose}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#111111] border border-white/10 py-4 text-sm font-bold text-white transition-all hover:bg-white/5"
              >
                Close
              </button>
              <Link
                href="/claim/withdraw"
                onClick={handleClose}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-white py-4 text-sm font-bold text-black transition-all hover:bg-white/90"
              >
                Open Withdraw
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="mb-6 mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Wallet size={28} className="text-white" />
            </div>

            <div className="mb-6 flex justify-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#111111] px-3 py-1.5 shadow-sm">
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
                  className={`text-[10px] font-bold uppercase tracking-widest ${
                    magicBlockHealth === "ok"
                      ? "text-[#1eba98]"
                      : magicBlockHealth === "error"
                        ? "text-amber-400"
                        : "text-[#a8a8aa]"
                  }`}
                >
                  {magicBlockHealth === "ok"
                    ? "Private Rail Ready"
                    : magicBlockHealth === "error"
                      ? "Network Degraded"
                      : "Checking Route"}
                </span>
              </div>
            </div>

            <div className="text-center">
              <h2 className="mb-1 text-2xl font-bold tracking-tight text-white">Top Up Private Balance</h2>
              <p className="mb-8 text-sm text-[#a8a8aa]">
                Move USDC directly into PER, or privately swap SOL or USDT into your private USDC balance.
              </p>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-4">
              <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                  {FUNDING_MODE_META[fundingMode].balanceLabel}
                </p>
                <p className="text-xl font-bold text-white">
                  {(fundingMode === "swap-sol"
                    ? liveSolBalance
                    : fundingMode === "swap-usdt"
                      ? liveUsdtBalance
                      : liveBaseBalance).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: fundingMode === "swap-sol" ? 4 : 2,
                  })}{" "}
                  <span className="text-xs text-[#a8a8aa]">
                    {FUNDING_MODE_META[fundingMode].inputSymbol}
                  </span>
                </p>
              </div>
              <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                  Private Balance
                </p>
                <p className="text-xl font-bold text-white">
                  {privateBalance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  <span className="text-xs text-[#a8a8aa]">USDC</span>
                </p>
              </div>
            </div>

            <div
              className={`mb-6 grid gap-2 rounded-2xl border border-white/10 bg-[#111111] p-1 ${
                HAS_DEVNET_USDT ? "grid-cols-3" : "grid-cols-2"
              }`}
            >
              <button
                onClick={() => {
                  setFundingMode("deposit");
                  setSwapQuoteError(null);
                }}
                className={`rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest transition-all ${
                  fundingMode === "deposit"
                    ? "bg-white text-black"
                    : "text-[#a8a8aa] hover:text-white"
                }`}
              >
                Deposit USDC
              </button>
              <button
                onClick={() => {
                  setFundingMode("swap-sol");
                  setSwapQuoteError(null);
                }}
                className={`rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest transition-all ${
                  fundingMode === "swap-sol"
                    ? "bg-white text-black"
                    : "text-[#a8a8aa] hover:text-white"
                }`}
              >
                Swap SOL
              </button>
              {HAS_DEVNET_USDT ? (
                <button
                  onClick={() => {
                    setFundingMode("swap-usdt");
                    setSwapQuoteError(null);
                  }}
                  className={`rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest transition-all ${
                    fundingMode === "swap-usdt"
                      ? "bg-white text-black"
                      : "text-[#a8a8aa] hover:text-white"
                  }`}
                >
                  Swap USDT
                </button>
              ) : null}
            </div>

            <div className="mb-6 relative">
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                  {FUNDING_MODE_META[fundingMode].inputLabel}
                </label>
                <button
                  onClick={() =>
                    setAmount(
                      fundingMode === "swap-sol"
                        ? liveSolBalance.toString()
                        : fundingMode === "swap-usdt"
                          ? liveUsdtBalance.toString()
                          : liveBaseBalance.toString(),
                    )
                  }
                  className="text-[10px] font-bold uppercase tracking-widest text-[#1eba98] transition-colors hover:text-[#1eba98]/80"
                >
                  Max
                </button>
              </div>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-2xl border border-white/10 bg-[#111111] px-5 py-4 font-mono text-xl text-white outline-none transition-colors focus:border-[#1eba98]/50 focus:bg-[#1eba98]/5"
                min={0}
                step={fundingMode === "swap-sol" ? 0.0001 : 0.01}
                max={
                  fundingMode === "swap-sol"
                    ? liveSolBalance
                    : fundingMode === "swap-usdt"
                      ? liveUsdtBalance
                      : liveBaseBalance
                }
              />
            </div>

            {fundingMode !== "deposit" ? (
              <div className="mb-6 rounded-2xl border border-white/10 bg-[#111111] px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                      Private Balance Output
                    </p>
                    <p className="text-lg font-bold text-white">
                      {swapQuoteLoading
                        ? "Fetching quote..."
                        : swapQuoteOutUsdc !== null
                          ? `${swapQuoteOutUsdc.toFixed(4)} USDC`
                          : "—"}
                    </p>
                  </div>
                  <div className="text-right text-xs text-[#a8a8aa]">
                    <p>Output lands privately in PER.</p>
                    <p className="mt-1 text-[#1eba98]">
                      {FUNDING_MODE_META[fundingMode].inputSymbol} to private USDC
                    </p>
                  </div>
                </div>
                {swapQuoteError ? (
                  <p className="mt-3 text-xs text-rose-300">{swapQuoteError}</p>
                ) : null}
              </div>
            ) : null}

            <button
              onClick={handleTopUp}
              disabled={
                loading ||
                !amount ||
                parseFloat(amount) <= 0 ||
                (fundingMode !== "deposit"
                  ? parseFloat(amount) >
                      (fundingMode === "swap-sol"
                        ? liveSolBalance
                        : liveUsdtBalance) ||
                    swapQuoteLoading ||
                    !!swapQuoteError
                  : parseFloat(amount) > liveBaseBalance)
              }
              className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#1eba98] py-4 text-sm font-bold text-black transition-all hover:bg-[#1eba98]/80 disabled:opacity-40"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : null}
              {loading
                ? fundingMode === "deposit"
                  ? "Processing Top Up..."
                  : "Processing Swap..."
                : FUNDING_MODE_META[fundingMode].buttonLabel}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
