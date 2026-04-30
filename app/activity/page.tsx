"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Loader2,
  Clock,
  ArrowDownLeft,
  Zap,
  Ban,
  RefreshCw,
} from "lucide-react";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

interface ActivityItem {
  _id: string;
  type: "payroll-run" | "claim";
  amount?: number;
  status?: string;
  employeeName?: string;
  createdAt: string;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function activityIcon(type: string, status?: string) {
  if (type === "claim") {
    return (
      <div className="w-10 h-10 rounded-xl bg-[#1eba98]/12 flex items-center justify-center shrink-0 border border-[#1eba98]/25 shadow-sm">
        <ArrowDownLeft size={16} className="text-[#1eba98]" />
      </div>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <div className="w-10 h-10 rounded-xl bg-red-500/12 flex items-center justify-center shrink-0 border border-red-500/25 shadow-sm">
        <Ban size={16} className="text-red-400" />
      </div>
    );
  }
  return (
    <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center shrink-0 border border-white/10 shadow-sm">
      <Zap size={16} className="text-[#8f8f95]" />
    </div>
  );
}

export default function ActivityPage() {
  const { publicKey, signMessage } = useWallet();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const walletAddr = publicKey?.toBase58();

  const fetchActivity = useCallback(async () => {
    if (!walletAddr || !signMessage) return;
    setLoading(true);
    try {
      const res = await walletAuthenticatedFetch({
        path: `/api/history?wallet=${walletAddr}`,
        method: "GET",
        signMessage,
        wallet: walletAddr,
      });
      if (!res.ok) throw new Error("Failed to fetch activity");
      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [walletAddr, signMessage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchActivity();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchActivity]);

  return (
    <EmployerLayout>
      <div className="max-w-4xl mx-auto py-4 px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tighter">
              Activity
            </h1>
            <p className="text-sm text-[#a8a8aa] mt-1.5 leading-relaxed max-w-sm">
              Real-time feed of payroll events, notifications, and claim status
              updates.
            </p>
          </div>
          <button
            onClick={() => void fetchActivity()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1eba98] hover:bg-[#1eba98]/80 text-black text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh feed
          </button>
        </div>

        <div className="bg-[#0b0f14] border border-white/10 rounded-3xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center">
              <Loader2 size={24} className="text-[#1eba98] animate-spin mb-4" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                Syncing live activity...
              </p>
            </div>
          ) : items.length === 0 ? (
            <div className="py-24 flex flex-col items-center justify-center text-center px-6">
              <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-6">
                <Clock size={24} className="text-[#a8a8aa]/40" />
              </div>
              <p className="text-base font-bold text-white tracking-tight">
                No activity recorded
              </p>
              <p className="text-xs text-[#a8a8aa] mt-1 max-w-[240px] leading-relaxed">
                New events will appear here as soon as they are processed
                on-chain.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {items.map((item) => (
                <div
                  key={item._id}
                  className="flex items-center gap-4 px-6 py-6 hover:bg-white/[0.03] transition-all duration-200"
                >
                  {activityIcon(item.type, item.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-bold text-white tracking-tight">
                        {item.type === "payroll-run"
                          ? "Payroll Run Disbursed"
                          : item.employeeName
                            ? `Claim by ${item.employeeName}`
                            : "Private Claim Withdrawal"}
                      </p>
                      {item.status && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-wider ${
                            item.status === "completed" ||
                            item.status === "success"
                              ? "bg-[#1eba98]/10 text-[#1eba98] border border-[#1eba98]/20"
                              : item.status === "failed"
                                ? "bg-red-500/10 text-red-400 border border-red-500/20"
                                : "bg-white/5 text-[#a8a8aa] border border-white/10"
                          }`}
                        >
                          {item.status}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] font-medium text-[#a8a8aa] uppercase tracking-widest">
                      {formatDate(item.createdAt)}
                    </p>
                  </div>
                  {typeof item.amount === "number" && (
                    <div className="text-right shrink-0">
                      <p
                        className={`text-sm font-bold ${
                          item.type === "claim"
                            ? "text-[#1eba98]"
                            : "text-white"
                        }`}
                      >
                        {item.type === "claim" ? "-" : "+"}
                        {item.amount.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                        })}
                        <span className="ml-1 text-[9px] text-[#a8a8aa] font-medium tracking-tight">
                          USDC
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </EmployerLayout>
  );
}
