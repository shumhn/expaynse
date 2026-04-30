"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Loader2, Landmark, TrendingUp, Zap, AlertTriangle, Users, RefreshCw } from "lucide-react";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

interface StreamInfo { id: string; status: "active" | "paused" | "stopped" | "pending"; ratePerSecond: number; totalPaid: number; accruedUnpaid: number; }

export default function TreasuryPage() {
  const { publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const walletAddr = publicKey?.toBase58();

  const fetchData = useCallback(async () => {
    if (!walletAddr || !signMessage || !publicKey) return;
    setLoading(true);
    try {
      const bal = await connection.getBalance(publicKey);
      setBalance(bal / LAMPORTS_PER_SOL);
      const res = await walletAuthenticatedFetch({ path: `/api/streams?employerWallet=${walletAddr}`, method: "GET", signMessage, wallet: walletAddr });
      if (res.ok) { const s = await res.json(); setStreams(s.streams ?? []); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [walletAddr, signMessage, publicKey, connection]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const active = streams.filter((s) => s.status === "active");
  const totalAccrued = streams.reduce((sum, s) => sum + s.accruedUnpaid, 0);
  const totalPaid = streams.reduce((sum, s) => sum + s.totalPaid, 0);
  const dailyBurn = active.reduce((sum, s) => sum + s.ratePerSecond * 86400, 0);

  return (
    <EmployerLayout>
      <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tighter">Treasury</h1>
            <p className="text-sm text-[#a8a8aa] mt-1.5 leading-relaxed max-w-sm">
              Overview of your treasury vault balance, recent transactions, and funding health.
            </p>
          </div>
          <button
            onClick={() => void fetchData()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1eba98] hover:bg-[#1eba98]/80 text-black text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh treasury
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 mb-8">
          <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl p-6 sm:p-8 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa] mb-4">Total Balance</p>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-bold text-white tracking-tighter">
                {balance !== null ? balance.toLocaleString(undefined, { minimumFractionDigits: 2 }) : loading ? <Loader2 size={20} className="animate-spin text-gray-300" /> : "--"}
              </span>
              <span className="text-sm text-[#a8a8aa] font-medium ml-2">SOL</span>
            </div>
            <p className="text-xs text-[#a8a8aa] mt-3">Available for payroll disbursement</p>
          </div>

          <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl p-6 sm:p-8 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa] mb-4">Active Streams</p>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-bold text-white tracking-tighter">{active.length}</span>
            </div>
            <p className="text-xs text-[#a8a8aa] mt-3">{streams.length} total employees</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 mb-8">
          <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl p-6 sm:p-8 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa] mb-4">Total Disbursed</p>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-bold text-white tracking-tighter">{totalPaid.toFixed(2)} USDC</span>
            </div>
          </div>

          <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl p-6 sm:p-8 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa] mb-4">Daily Burn</p>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-bold text-white tracking-tighter">{dailyBurn.toFixed(2)} USDC</span>
            </div>
            <p className="text-xs text-[#a8a8aa] mt-3">Live accrual rate</p>
          </div>
        </div>

        {totalAccrued > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-8 flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Unclaimed Accruals</p>
              <p className="text-sm text-amber-700 mt-0.5">Employees have accrued <span className="font-bold">{totalAccrued.toFixed(2)} USDC</span> in unpaid balances across active streams.</p>
            </div>
          </div>
        )}
      </div>
    </EmployerLayout>
  );
}
