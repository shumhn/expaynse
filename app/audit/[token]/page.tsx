"use client";

import { useEffect, useState, use } from "react";
import { Download, ShieldCheck, CheckCircle2, History, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { Logo } from "@/components/landing/Logo";

export interface TreasuryHistoryItem {
  id: string;
  type: string;
  amount: number;
  date: string;
  status: string;
  meta: string;
  txSig?: string;
}

export default function AuditPage({ params }: { params: Promise<{ token: string }> }) {
  const resolvedParams = use(params);
  const token = resolvedParams.token;
  
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<TreasuryHistoryItem[]>([]);
  const [isValidating, setIsValidating] = useState(true);
  const [isValid, setIsValid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{
    employerWallet: string;
    label?: string;
    expiresAt: string;
  } | null>(null);

  const totalReviewedAmount = transactions.reduce((sum, item) => sum + item.amount, 0);

  useEffect(() => {
    const verifyToken = async () => {
      setIsValidating(true);
      
      try {
        // Validate token via API
        const response = await fetch(`/api/auditor-tokens/${token}`);
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Invalid or expired token");
        }
        
        setIsValid(true);
        const validation = (await response.json()) as {
          employerWallet: string;
          label?: string;
          expiresAt: string;
        };
        setTokenMeta(validation);
        
        // Fetch audit data
        const auditResponse = await fetch(`/api/audit?token=${token}`);
        if (auditResponse.ok) {
          const history = await auditResponse.json();
          
          const flatTransactions: TreasuryHistoryItem[] = [
            ...(history.setupActions || []).filter((a: any) => a.type === "fund-treasury").map((a: any) => ({
              id: a.id,
              date: a.date,
              type: "Private Vault Deposit",
              amount: a.amount || 0,
              status: a.status,
              meta: "From Base Wallet",
              txSig: a.txSig
            })),
            ...(history.payrollRuns || []).map((a: any) => ({
              id: a.id,
              date: a.date,
              type: "Payroll Disbursement",
              amount: a.totalAmount,
              status: a.status,
              meta: `${a.employeeCount} ${a.employeeCount === 1 ? 'Employee' : 'Employees'}`,
              txSig: a.depositSig || a.transferSig
            })),
            ...(history.claimRecords || []).map((a: any) => ({
              id: a.id,
              date: a.date,
              type: "Employee Claim",
              amount: a.amount,
              status: a.status,
              meta: "Streaming Withdrawal",
              txSig: a.txSig
            }))
          ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          
          setTransactions(flatTransactions);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to verify token");
      } finally {
        setIsValidating(false);
        setLoading(false);
      }
    };

    void verifyToken();
  }, [token]);

  const handleExportCSV = () => {
    const headers = ["Date", "Type", "Recipient/Meta", "Amount (USDC)", "Status", "Privacy", "Signature"];
    const csvContent = [
      headers.join(","),
      ...transactions.map(t => [
        new Date(t.date).toISOString(),
        t.type,
        `"${t.meta}"`,
        t.amount.toString(),
        t.status,
        "Scoped auditor view",
        t.txSig || "N/A"
      ].join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `expaynse_audit_ledger_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isValidating) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
        <ShieldCheck size={48} className="text-[#1eba98] animate-pulse mb-6" />
        <h2 className="text-xl font-bold text-white mb-2 tracking-tight">Checking auditor link</h2>
        <p className="text-sm text-[#a8a8aa] max-w-sm text-center">
          Verifying read-only access and loading the shared payroll records...
        </p>
      </div>
    );
  }

  if (!isValid || error) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 bg-red-500/10 rounded-2xl border border-red-500/20 flex items-center justify-center mb-6">
          <ShieldCheck size={28} className="text-red-500" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2 tracking-tight">Invalid or revoked link</h2>
        <p className="text-sm text-[#a8a8aa] max-w-sm text-center">
          {error || "This auditor access link is invalid or has been revoked by the employer."}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white selection:bg-[#1eba98]/30">
      <header className="h-20 border-b border-white/5 bg-[#0a0a0a] flex items-center justify-between px-6 sm:px-12 sticky top-0 z-30">
        <Logo />
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1eba98]/10 border border-[#1eba98]/20">
            <CheckCircle2 size={14} className="text-[#1eba98]" />
            <span className="text-xs font-bold text-[#1eba98] tracking-widest uppercase">Read-only auditor view</span>
          </div>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-black text-sm font-bold rounded-2xl hover:bg-white/90 transition-all shadow-sm active:scale-[0.98]"
          >
            <Download size={16} />
            Export CSV
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto py-12 px-4 sm:px-6">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Payroll review access</h1>
          <p className="text-[#a8a8aa] text-sm">
            Review the payroll records shared through this read-only auditor link. No funds can be moved and no data can be edited from this view.
          </p>
          {tokenMeta ? (
            <div className="mt-4 flex flex-wrap gap-3 text-xs text-[#8f8f95]">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                {tokenMeta.label?.trim() || "Auditor access link"}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                Employer {tokenMeta.employerWallet.slice(0, 4)}...{tokenMeta.employerWallet.slice(-4)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                Expires {new Date(tokenMeta.expiresAt).toLocaleDateString()}
              </span>
            </div>
          ) : null}
        </div>

        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/5 bg-[#0a0a0a] px-4 py-3">
            <div className="text-lg font-bold text-white">{transactions.length}</div>
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Shared records
            </div>
          </div>
          <div className="rounded-2xl border border-white/5 bg-[#0a0a0a] px-4 py-3">
            <div className="text-lg font-bold text-white">${totalReviewedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Total reviewed amount
            </div>
          </div>
          <div className="rounded-2xl border border-white/5 bg-[#0a0a0a] px-4 py-3">
            <div className="text-lg font-bold text-white">
              {tokenMeta ? new Date(tokenMeta.expiresAt).toLocaleDateString() : "—"}
            </div>
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
              Link expiry
            </div>
          </div>
        </div>

        <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="bg-[#0f0f0f] border-b border-white/5">
                <tr>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Record</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Notes</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest text-center">Amount</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Date</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Status</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest text-right">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-24 text-center text-[#8f8f95] text-sm font-medium">Loading shared payroll records...</td>
                  </tr>
                ) : transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-24 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-4">
                        <History size={20} className="text-[#a8a8aa]/40" />
                      </div>
                      <p className="text-sm font-bold text-white tracking-tight">No shared records found</p>
                    </td>
                  </tr>
                ) : (
                  transactions.map((item) => (
                    <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-4 px-6">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            item.type === "Vault Deposit" || item.type === "Private Vault Deposit" 
                              ? "bg-[#1eba98]/10 text-[#1eba98]" 
                              : "bg-amber-500/10 text-amber-500"
                          }`}>
                            {item.type === "Vault Deposit" || item.type === "Private Vault Deposit" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                          </div>
                          <span className="text-sm font-bold text-white">{item.type}</span>
                        </div>
                      </td>
                      <td className="py-4 px-6">
                        <div className="text-sm font-bold text-white">{item.meta}</div>
                        <div className="text-[10px] text-[#1eba98] font-bold mt-0.5 flex items-center gap-1">
                           <ShieldCheck size={10} /> Shared for auditor review
                        </div>
                      </td>
                      <td className="py-4 px-6 text-center">
                        <div className="text-sm font-bold text-white">
                          {(item.type === "Vault Deposit" || item.type === "Private Vault Deposit") ? "+" : "-"}${item.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </div>
                        <div className="text-[10px] text-[#8f8f95] mt-0.5">USDC</div>
                      </td>
                      <td className="py-4 px-6 whitespace-nowrap">
                        <span className="text-sm text-white font-medium">{new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span className="text-[10px] text-[#8f8f95] ml-2">{new Date(item.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                      </td>
                      <td className="py-4 px-6">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1eba98]/10 text-[#1eba98] text-[10px] font-bold uppercase tracking-widest">
                          {item.status || "Completed"}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-right">
                        {item.txSig ? (
                          <a
                            href={`https://solscan.io/tx/${item.txSig}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-[#a8a8aa] hover:text-[#1eba98] transition-colors cursor-pointer hover:underline"
                          >
                            Open tx
                          </a>
                        ) : (
                          <span className="text-[10px] font-mono text-[#8f8f95]">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
