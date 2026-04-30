"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { History, Loader2, CheckCircle2, XCircle, Wallet, CalendarDays, Users } from "lucide-react";
import { toast } from "sonner";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import { format } from "date-fns";

interface PayrollRun { id: string; date: string; totalAmount: number; employeeCount: number; status: "success" | "failed"; }
interface ClaimRecord { id: string; date: string; amount: number; recipient: string; status: "success" | "failed"; }
type Tab = "payroll" | "claims";

export default function HistoryPage() {
  const { publicKey, signMessage } = useWallet();
  const [tab, setTab] = useState<Tab>("payroll");
  const [payrollHistory, setPayrollHistory] = useState<PayrollRun[]>([]);
  const [claimHistory, setClaimHistory] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const walletAddr = publicKey?.toBase58();

  useEffect(() => {
    if (!walletAddr || !signMessage) return;
    const load = async () => {
      setLoading(true);
      try {
        const res = await walletAuthenticatedFetch({ wallet: walletAddr, signMessage, path: `/api/history?wallet=${walletAddr}` });
        const json = await res.json();
        if (res.ok) { setPayrollHistory(json.payrollRuns ?? []); setClaimHistory(json.claimRecords ?? []); }
      } catch { toast.error("Failed to load history"); } finally { setLoading(false); }
    };
    void load();
  }, [walletAddr, signMessage]);

  const data = tab === "payroll" ? payrollHistory : claimHistory;

  return (
    <EmployerLayout>
      <div className="max-w-5xl mx-auto py-4 px-4 sm:px-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tighter">History</h1>
            <p className="text-sm text-[#8f8f95] mt-1.5 leading-relaxed max-w-md">
              Review your past payroll disbursements and private claim activity in one place.
            </p>
          </div>

          <div className="flex p-1 rounded-[14px] border border-white/10 bg-white/5 backdrop-blur-xl w-fit">
            <button
              onClick={() => setTab("payroll")}
              className={`px-4 py-1.5 rounded-[10px] text-[10px] font-bold uppercase tracking-wider transition-all ${
                tab === "payroll"
                  ? "bg-[#1eba98] text-black shadow-sm"
                  : "text-[#8f8f95] hover:text-white hover:bg-white/5"
              }`}
            >
              Payroll Runs
            </button>
            <button
              onClick={() => setTab("claims")}
              className={`px-4 py-1.5 rounded-[10px] text-[10px] font-bold uppercase tracking-wider transition-all ${
                tab === "claims"
                  ? "bg-[#1eba98] text-black shadow-sm"
                  : "text-[#8f8f95] hover:text-white hover:bg-white/5"
              }`}
            >
              Claims
            </button>
          </div>
        </div>

        <div className="bg-[#0b0f14] border border-white/10 rounded-3xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_100px] gap-4 px-6 py-4 text-[9px] font-bold text-[#8f8f95] uppercase tracking-[0.15em] border-b border-white/10 bg-black/20">
            <span>{tab === "payroll" ? "Reference" : "Claim Type"}</span>
            <span>Date</span>
            <span>{tab === "payroll" ? "Recipients" : "Destination"}</span>
            <span>Amount</span>
            <span className="text-right">Status</span>
          </div>

          <div className="divide-y divide-white/5">
            {loading ? (
              <div className="py-24 flex flex-col items-center justify-center">
                <Loader2 size={24} className="text-[#1eba98] animate-spin mb-4" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">Loading History...</p>
              </div>
            ) : data.length === 0 ? (
              <div className="py-24 flex flex-col items-center justify-center text-center px-6">
                <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-6">
                  <History size={24} className="text-[#a8a8aa]/40" />
                </div>
                <p className="text-base font-bold text-white tracking-tight">No {tab} records found</p>
                <p className="text-xs text-[#a8a8aa] mt-1 max-w-[240px] leading-relaxed">
                  Completed payroll runs and claims will appear here automatically.
                </p>
              </div>
            ) : (
              data.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[1.5fr_1fr_1fr_1fr_100px] gap-4 px-6 py-5 hover:bg-white/[0.03] transition-colors items-center"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10">
                      {tab === "payroll" ? (
                        <Users size={16} className="text-[#8f8f95]" />
                      ) : (
                        <Wallet size={16} className="text-[#8f8f95]" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white tracking-tight">
                        {tab === "payroll" ? "Payroll Run" : "Claim Withdrawal"}
                      </p>
                      <p className="text-[10px] text-[#a8a8aa] font-mono mt-0.5">
                        {item.id.slice(0, 12)}...
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CalendarDays size={14} className="text-[#8f8f95]" />
                    <span className="text-xs font-medium text-[#8f8f95]">
                      {format(new Date(item.date), "MMM d, yyyy")}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-[#8f8f95]">
                      {tab === "payroll"
                        ? (item as PayrollRun).employeeCount + " Employees"
                        : (item as ClaimRecord).recipient.slice(0, 6) +
                          "..." +
                          (item as ClaimRecord).recipient.slice(-4)}
                    </span>
                  </div>
                  <div>
                    <span className="text-sm font-bold text-white">
                      ${tab === "payroll"
                        ? (item as PayrollRun).totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })
                        : (item as ClaimRecord).amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      <span className="ml-1 text-[10px] text-[#a8a8aa] font-medium">USDC</span>
                    </span>
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider ${
                        item.status === "success"
                          ? "bg-[#1eba98]/10 text-[#1eba98]"
                          : "bg-red-500/10 text-red-400"
                      }`}
                    >
                      {item.status === "success" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      {item.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </EmployerLayout>
  );
}
