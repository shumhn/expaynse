"use client";

import { Suspense, useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useSearchParams, useRouter } from "next/navigation";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Loader2, Landmark, TrendingUp, Zap, AlertTriangle, Users, RefreshCw, Plus, ArrowDownLeft, ArrowUpRight, History, CalendarDays, CheckCircle2, XCircle, Search, Calendar, ShieldCheck, Clock, Download, ArrowUpFromLine } from "lucide-react";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import { DepositModal } from "@/components/deposit-modal";
import { WithdrawModal } from "@/components/withdraw-modal";
import { AuditorModal } from "@/components/auditor-modal";
import { getPrivateBalance, getBalance, fetchTeeAuthToken, isJwtExpired } from "@/lib/magicblock-api";
import { getOrCreateCachedTeeToken, loadCachedTeeToken, clearCachedTeeToken } from "@/lib/client/tee-auth-cache";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { toast } from "sonner";

interface StreamInfo { id: string; status: "active" | "paused" | "stopped" | "pending"; ratePerSecond: number; totalPaid: number; accruedUnpaid: number; }
interface SetupAction { id: string; type: "initialize-mint" | "fund-treasury"; date: string; amount?: number; txSig?: string; status: "success" | "failed"; }
interface PayrollRun {
  id: string;
  date: string;
  mode?: "streaming" | "private_payroll";
  totalAmount: number;
  employeeCount: number;
  employeeNames?: string[];
  recipientAddresses?: string[];
  depositSig?: string;
  transferSig?: string;
  status: "success" | "failed";
}
interface ClaimRecord { id: string; date: string; amount: number; recipient: string; txSig?: string; status: "success" | "failed"; }

type Transaction = {
  id: string;
  date: string;
  type: "Private Vault Deposit" | "Payroll Disbursement" | "Employee Claim";
  amount: number;
  status: "success" | "failed";
  meta: string;
  txSig?: string;
  payrollMode?: "streaming" | "private_payroll";
};

function TreasuryPageContent() {
  const { publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [balance, setBalance] = useState<number | null>(null);
  const [baseBalance, setBaseBalance] = useState<number>(0);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [auditorModalOpen, setAuditorModalOpen] = useState(false);

  const [setupActions, setSetupActions] = useState<SetupAction[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [claimRecords, setClaimRecords] = useState<ClaimRecord[]>([]);
  const [employees, setEmployees] = useState<{wallet: string, name: string}[]>([]);

  const [filterTab, setFilterTab] = useState<"All" | "Deposits" | "Payouts">("All");
  const [payrollModeFilter, setPayrollModeFilter] = useState<"All" | "Streaming" | "Private Payroll">("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [chartRange, setChartRange] = useState<"24H" | "7D" | "30D" | "All">("30D");

  const [company, setCompany] = useState<{ id: string; name: string; treasuryPubkey: string } | null>(null);
  const companyRef = useRef(company);
  companyRef.current = company;

  const walletAddr = publicKey?.toBase58();
  const tokenCache = useRef<string | null>(null);
  const depositIntent = searchParams.get("deposit") === "1";

  const getOrFetchToken = useCallback(async () => {
    if (tokenCache.current && !isJwtExpired(tokenCache.current)) return tokenCache.current;
    if (tokenCache.current && isJwtExpired(tokenCache.current)) {
      tokenCache.current = null;
      if (publicKey) clearCachedTeeToken(publicKey.toBase58());
    }
    if (!tokenCache.current && publicKey) {
      const persisted = loadCachedTeeToken(publicKey.toBase58());
      if (persisted) { tokenCache.current = persisted; return persisted; }
    }
    if (!publicKey || !signMessage) throw new Error("Wallet does not support message signing");
    const token = await getOrCreateCachedTeeToken(publicKey.toBase58(), async () => fetchTeeAuthToken(publicKey, signMessage));
    tokenCache.current = token;
    return token;
  }, [publicKey, signMessage]);

  const fetchData = useCallback(async () => {
    if (!walletAddr || !signMessage || !publicKey) return;
    setLoading(true);
    try {
      // 1. Fetch company data first
      let currentCompany = companyRef.current;
      if (!currentCompany) {
        const cRes = await walletAuthenticatedFetch({
          path: `/api/company/me?employerWallet=${walletAddr}`,
          method: "GET",
          signMessage,
          wallet: walletAddr,
        });
        if (cRes.ok) {
          const cData = await cRes.json();
          if (cData.company) {
            setCompany(cData.company);
            currentCompany = cData.company;
          }
        }
      }

      // 2. Fetch parallel data
      const [baseBalRes, streamsRes, historyRes, employeesRes] = await Promise.all([
        getBalance(walletAddr).catch(() => null),
        walletAuthenticatedFetch({ path: `/api/streams?employerWallet=${walletAddr}`, method: "GET", signMessage, wallet: walletAddr }),
        walletAuthenticatedFetch({ path: `/api/history?wallet=${walletAddr}`, method: "GET", signMessage, wallet: walletAddr }),
        walletAuthenticatedFetch({ path: `/api/employees?employerWallet=${walletAddr}`, method: "GET", signMessage, wallet: walletAddr })
      ]);

      if (baseBalRes) {
        setBaseBalance(parseInt(baseBalRes.balance ?? "0", 10) / 1_000_000);
      }

      // 3. Fetch private balance depending on if we have a company
      if (currentCompany?.id) {
        const treasuryRes = await walletAuthenticatedFetch({
          path: `/api/company/${currentCompany.id}/balance?wallet=${walletAddr}`,
          method: "GET",
          signMessage,
          wallet: walletAddr,
        }).catch(() => null);
        if (treasuryRes && treasuryRes.ok) {
          const data = await treasuryRes.json();
          setBalance(parseInt(data.balance ?? "0", 10) / 1_000_000);
        }
      } else {
        const teeToken = await getOrFetchToken();
        const privBalRes = await getPrivateBalance(walletAddr, teeToken).catch(() => null);
        if (privBalRes) {
          setBalance(parseInt(privBalRes.balance ?? "0", 10) / 1_000_000);
        }
      }

      if (streamsRes.ok) {
        const s = await streamsRes.json();
        setStreams(s.streams ?? []);
      }
      if (historyRes.ok) {
        const h = await historyRes.json();
        setSetupActions(h.setupActions ?? []);
        setPayrollRuns(h.payrollRuns ?? []);
        setClaimRecords(h.claimRecords ?? []);
      }
      if (employeesRes.ok) {
        const e = await employeesRes.json();
        setEmployees(e.employeeProfiles?.map((p: any) => ({ wallet: p.employee.wallet, name: p.employee.name })) ?? []);
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [walletAddr, signMessage, publicKey, getOrFetchToken]);

  const getEmployeeName = (walletAddress: string) => {
    const emp = employees.find(e => e.wallet === walletAddress);
    return emp ? emp.name : `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  };

  useEffect(() => { void fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!depositIntent) return;
    if (!publicKey || !company) return;

    setDepositOpen(true);
    router.replace("/treasury");
  }, [company, depositIntent, publicKey, router]);

  const active = streams.filter((s) => s.status === "active");
  const totalAccrued = streams.reduce((sum, s) => sum + s.accruedUnpaid, 0);
  const totalPaid = streams.reduce((sum, s) => sum + s.totalPaid, 0);
  const dailyBurn = active.reduce((sum, s) => sum + s.ratePerSecond * 86400, 0);

  const transactions: Transaction[] = [
    ...setupActions.filter(a => a.type === "fund-treasury").map(a => ({
      id: a.id,
      date: a.date,
      type: "Private Vault Deposit" as const,
      amount: a.amount || 0,
      status: a.status,
      meta: "From Base Wallet",
      txSig: a.txSig
    })),
    ...payrollRuns.map(a => ({
      id: a.id,
      date: a.date,
      type: "Payroll Disbursement" as const,
      amount: a.totalAmount,
      status: a.status,
      meta: a.employeeNames && a.employeeNames.length > 0
        ? a.employeeNames.join(", ")
        : a.recipientAddresses && a.recipientAddresses.length === 1 
        ? getEmployeeName(a.recipientAddresses[0])
        : `${a.employeeCount} ${a.employeeCount === 1 ? 'Employee' : 'Employees'}`,
      txSig: a.depositSig || a.transferSig,
      payrollMode: (a.mode === "private_payroll" ? "private_payroll" : "streaming") as
        | "streaming"
        | "private_payroll",
    })),
    ...claimRecords.map(a => ({
      id: a.id,
      date: a.date,
      type: "Employee Claim" as const,
      amount: a.amount,
      status: a.status,
      meta: getEmployeeName(a.recipient),
      txSig: a.txSig
    }))
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => {
      if (filterTab === "Deposits" && t.type !== "Private Vault Deposit") return false;
      if (filterTab === "Payouts" && t.type !== "Payroll Disbursement" && t.type !== "Employee Claim") return false;
      if (payrollModeFilter !== "All" && t.type === "Payroll Disbursement") {
        const targetMode =
          payrollModeFilter === "Private Payroll" ? "private_payroll" : "streaming";
        if ((t.payrollMode ?? "streaming") !== targetMode) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          t.type.toLowerCase().includes(q) ||
          t.meta.toLowerCase().includes(q) ||
          t.amount.toString().includes(q) ||
          (t.txSig && t.txSig.toLowerCase().includes(q)) ||
          new Date(t.date).toLocaleDateString().toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [filterTab, payrollModeFilter, searchQuery, transactions]);

  const totalDeposited = setupActions.filter(a => a.type === "fund-treasury").reduce((sum, a) => sum + (a.amount || 0), 0);

  const handleExportCSV = () => {
    if (filteredTransactions.length === 0) {
      toast.error("No transactions to export");
      return;
    }

    const headers = ["Date", "Type", "Recipient/Info", "Amount (USDC)", "Status", "Transaction Signature"];
    
    const csvContent = [
      headers.join(","),
      ...filteredTransactions.map(t => {
        return [
          new Date(t.date).toISOString(),
          t.type,
          `"${t.meta.replace(/"/g, '""')}"`,
          t.amount,
          t.status,
          t.txSig || ""
        ].join(",");
      })
    ].join("\\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const modeSuffix =
      payrollModeFilter === "All"
        ? "all"
        : payrollModeFilter === "Private Payroll"
          ? "private-payroll"
          : "streaming";
    link.setAttribute("download", `expaynse_treasury_${modeSuffix}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Ledger exported to CSV");
  };

  // Analytics Data — dynamic range
  const allTxDates = useMemo(() => {
    const items: { date: string; amount: number }[] = [
      ...setupActions.filter(a => a.type === "fund-treasury").map(a => ({ date: a.date, amount: a.amount || 0 })),
      ...payrollRuns.map(a => ({ date: a.date, amount: a.totalAmount })),
    ];
    return items;
  }, [setupActions, payrollRuns]);

  const volumeData = useMemo(() => {
    const now = new Date();

    if (chartRange === "24H") {
      // Group by hour, last 24 hours
      const result = Array.from({ length: 24 }, (_, i) => {
        const h = new Date(now);
        h.setHours(now.getHours() - 23 + i, 0, 0, 0);
        return { name: `${h.getHours().toString().padStart(2, '0')}:00`, total: 0, _ts: h.getTime() };
      });
      const cutoff = new Date(now);
      cutoff.setHours(cutoff.getHours() - 24);
      allTxDates.filter(tx => new Date(tx.date) >= cutoff).forEach(tx => {
        const txH = new Date(tx.date).getHours();
        const slot = result.find(r => r.name === `${txH.toString().padStart(2, '0')}:00`);
        if (slot) slot.total += tx.amount;
      });
      return result.map(({ name, total }) => ({ name, total }));
    }

    if (chartRange === "7D") {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const result = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now);
        d.setDate(now.getDate() - 6 + i);
        return { name: `${days[d.getDay()]}`, total: 0, _date: d.toDateString() };
      });
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - 7);
      allTxDates.filter(tx => new Date(tx.date) >= cutoff).forEach(tx => {
        const txDate = new Date(tx.date).toDateString();
        const slot = result.find(r => r._date === txDate);
        if (slot) slot.total += tx.amount;
      });
      return result.map(({ name, total }) => ({ name, total }));
    }

    if (chartRange === "30D") {
      const result = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(now);
        d.setDate(now.getDate() - 29 + i);
        return { name: `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`, total: 0, _date: d.toDateString() };
      });
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - 30);
      allTxDates.filter(tx => new Date(tx.date) >= cutoff).forEach(tx => {
        const txDate = new Date(tx.date).toDateString();
        const slot = result.find(r => r._date === txDate);
        if (slot) slot.total += tx.amount;
      });
      return result.map(({ name, total }) => ({ name, total }));
    }

    // All — group by month (last 6)
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const result = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now);
      d.setMonth(now.getMonth() - 5 + i);
      return { name: months[d.getMonth()], total: 0 };
    });
    allTxDates.forEach(tx => {
      const mName = months[new Date(tx.date).getMonth()];
      const slot = result.find(r => r.name === mName);
      if (slot) slot.total += tx.amount;
    });
    return result;
  }, [chartRange, allTxDates]);

  const distributionData = useMemo(() => {
    const depositsTotal = totalDeposited;
    const payrollTotal = payrollRuns.reduce((sum, a) => sum + a.totalAmount, 0);
    const claimsTotal = claimRecords.reduce((sum, a) => sum + a.amount, 0);

    return [
      { name: "Deposits", value: depositsTotal, color: "#1eba98" },
      { name: "Payroll", value: payrollTotal, color: "#3b82f6" },
      { name: "Claims", value: claimsTotal, color: "#3b3b3b" },
    ].filter(d => d.value > 0);
  }, [totalDeposited, payrollRuns, claimRecords]);

  return (
    <EmployerLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">History & Analytics</h1>
            <p className="text-sm text-[#a8a8aa] mt-1">
              View and export your premium transaction history.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void fetchData()}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-[#0a0a0a] p-3 text-white transition-colors hover:bg-white/5 disabled:opacity-40 shadow-sm h-[44px] w-[44px]"
              title="Refresh Data"
            >
              {loading ? <Loader2 size={18} className="animate-spin text-[#a8a8aa]" /> : <RefreshCw size={18} className="text-[#a8a8aa]" />}
            </button>
            <button
              onClick={() => setWithdrawOpen(true)}
              className="inline-flex h-[44px] items-center gap-2 rounded-2xl border border-white/10 bg-[#0a0a0a] px-5 text-sm font-semibold text-white transition-colors hover:bg-white/5 shadow-sm"
            >
              <ArrowUpFromLine size={16} className="text-[#a8a8aa]" />
              Withdraw
            </button>
            <button
              onClick={() => setDepositOpen(true)}
              className="inline-flex h-[44px] items-center gap-2 rounded-2xl bg-[#1eba98] px-5 text-sm font-semibold text-black transition-colors hover:bg-[#1eba98]/80 shadow-[0_0_20px_rgba(30,186,152,0.3)]"
            >
              <Plus size={16} />
              Deposit
            </button>
          </div>
        </div>

        <DepositModal
          isOpen={depositOpen}
          onClose={() => setDepositOpen(false)}
          baseBalance={baseBalance}
          privateBalance={balance ?? 0}
          treasuryPubkey={company?.treasuryPubkey}
          onDepositSuccess={() => { void fetchData(); }}
        />

        <WithdrawModal
          isOpen={withdrawOpen}
          onClose={() => setWithdrawOpen(false)}
          baseBalance={baseBalance}
          privateBalance={balance ?? 0}
          treasuryPubkey={company?.treasuryPubkey}
          companyId={company?.id}
          onWithdrawSuccess={() => { void fetchData(); }}
        />

        <AuditorModal
          isOpen={auditorModalOpen}
          onClose={() => setAuditorModalOpen(false)}
        />

        {/* TOP METRICS CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm relative overflow-hidden">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Total Payouts</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">All-time payroll volume</p>
            <div className="absolute top-5 right-5 text-[#8f8f95]">
              <ArrowUpRight size={20} />
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm relative overflow-hidden">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Total Deposited</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{totalDeposited.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">Funds added to private vault</p>
            <div className="absolute top-5 right-5 text-[#1eba98]">
              <ArrowDownLeft size={20} />
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Transactions</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{transactions.length}</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">Total ledger events</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">On-Chain Privacy</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">
              {transactions.length > 0 ? ((transactions.filter(t => t.txSig).length / transactions.length) * 100).toFixed(1) : "0.0"}%
            </p>
            <p className="mt-1 text-xs text-[#a8a8aa]">{transactions.filter(t => t.txSig).length} of {transactions.length} verified</p>
          </div>
        </div>

        {/* CHARTS SECTION */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-[#0a0a0a] rounded-3xl p-8 shadow-sm border border-white/5">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-bold text-white">Treasury Volume</h3>
              <div className="flex gap-1">
                {(["24H", "7D", "30D", "All"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setChartRange(r)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${chartRange === r ? "text-[#1eba98] bg-[#1eba98]/10" : "text-[#555] hover:text-[#8f8f95]"
                      }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-[#8f8f95] mb-6">{chartRange === "24H" ? "Hourly" : chartRange === "7D" ? "Daily (7 days)" : chartRange === "30D" ? "Daily (30 days)" : "Monthly"} volume (USDC)</p>
            <div className="h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={volumeData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1eba98" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#1eba98" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#8f8f95" }} dy={10} interval={chartRange === "30D" ? 4 : "preserveStartEnd"} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#8f8f95" }} tickFormatter={(val) => `$${val.toFixed(0)}`} />
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)", background: "#111", color: "#fff", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }} />
                  <Area type="monotone" dataKey="total" stroke="#1eba98" strokeWidth={2} fillOpacity={1} fill="url(#colorTotal)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-[#0a0a0a] rounded-3xl p-8 shadow-sm border border-white/5">
            <h3 className="text-sm font-bold text-white mb-1">Transaction Distribution</h3>
            <p className="text-xs text-[#8f8f95] mb-8">Volume breakdown by type</p>
            <div className="h-[240px] w-full flex items-center justify-center relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={distributionData}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {distributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)", background: "#111", color: "#fff", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute bottom-[-10px] w-full flex justify-center gap-6">
                {distributionData.map((d, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: d.color }}></div>
                    <span className="text-[10px] font-bold text-[#8f8f95]">{d.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* TRANSACTIONS TABLE */}
        <div className="bg-[#0b0f14] border border-white/10 rounded-3xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.35)] flex flex-col" style={{ maxHeight: "calc(100vh - 120px)" }}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-6 border-b border-white/10 gap-4 shrink-0">
            <h2 className="text-lg font-bold text-white tracking-tight">All Transactions</h2>

            <div className="flex items-center gap-4">
              <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
                {["All", "Payouts", "Deposits"].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setFilterTab(tab as any)}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${filterTab === tab
                        ? "bg-[#1eba98] text-black shadow-sm"
                        : "text-[#8f8f95] hover:text-white"
                      }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
                {["All", "Streaming", "Private Payroll"].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setPayrollModeFilter(tab as typeof payrollModeFilter)}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      payrollModeFilter === tab
                        ? "bg-[#1eba98]/15 text-[#84f7dc]"
                        : "text-[#8f8f95] hover:text-white"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div className="relative hidden md:block">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8f8f95]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search transactions..."
                  className="pl-9 pr-4 py-2 bg-white/5 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-[#1eba98]/20 border border-white/10 focus:border-[#1eba98]/30 transition-all w-[200px] placeholder:text-[#8f8f95]"
                />
              </div>

              <button
                onClick={() => setAuditorModalOpen(true)}
                className="hidden sm:flex items-center gap-2 px-4 py-2 bg-[#1eba98]/10 hover:bg-[#1eba98]/20 border border-[#1eba98]/20 text-[#1eba98] text-xs font-bold rounded-xl transition-colors shadow-sm"
              >
                <ShieldCheck size={14} />
                Auditor Link
              </button>

              <button
                onClick={handleExportCSV}
                className="hidden sm:flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold rounded-xl transition-colors shadow-sm"
              >
                <Download size={14} />
                Export CSV
              </button>
            </div>
          </div>

          <div className="overflow-auto flex-1">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#0b0f14]">
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10">Type</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10">Recipient</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10 text-center">Amount</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10">Date & Time</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10">Privacy</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10">Status</th>
                  <th className="py-4 px-6 text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest border-b border-white/10 text-right">TX Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-24 text-center">
                      <Loader2 size={24} className="animate-spin text-[#1eba98] mx-auto mb-4" />
                    </td>
                  </tr>
                ) : filteredTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-24 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-4">
                        <History size={20} className="text-[#a8a8aa]/40" />
                      </div>
                      <p className="text-sm font-bold text-white tracking-tight">No transactions found</p>
                      <p className="text-xs text-[#8f8f95] mt-1">
                        Deposits, payroll runs, and claims will appear here.
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredTransactions.map((item) => (
                    <tr key={item.id} className="hover:bg-white/[0.03] transition-colors">
                      <td className="py-4 px-6">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${item.type === "Private Vault Deposit" ? "bg-[#1eba98]/10 text-[#1eba98]" :
                              "bg-amber-500/10 text-amber-500"
                            }`}>
                            {item.type === "Private Vault Deposit" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                          </div>
                          <span className="text-sm font-bold text-white">{item.type}</span>
                        </div>
                      </td>
                      <td className="py-4 px-6">
                        <div className="text-sm font-bold text-white">{item.meta}</div>
                        {item.txSig && <div className="text-[10px] text-[#8f8f95] font-mono mt-0.5">{item.txSig.slice(0, 8)}...</div>}
                      </td>
                      <td className="py-4 px-6 text-center">
                        <div className="text-sm font-bold text-white">
                          {item.type === "Private Vault Deposit" ? "+" : "-"}${item.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </div>
                        <div className="text-[10px] text-[#8f8f95] mt-0.5">USDC</div>
                      </td>
                      <td className="py-4 px-6 whitespace-nowrap">
                        <span className="text-sm text-white font-medium">{new Date(item.date).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '-')}</span>
                        <span className="text-[10px] text-[#8f8f95] ml-2">{new Date(item.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                      </td>
                      <td className="py-4 px-6">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1eba98]/10 text-[#1eba98] text-[10px] font-bold">
                          <ShieldCheck size={10} />
                          Secured
                        </span>
                      </td>
                      <td className="py-4 px-6">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold ${item.status === "success" ? "bg-[#1eba98]/10 text-[#1eba98]" : "bg-red-500/10 text-red-400"
                          }`}>
                          {item.status === "success" ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                          {item.status === "success" ? "Completed" : "Failed"}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-right">
                        {item.txSig ? (
                          <a
                            href={`https://solscan.io/tx/${item.txSig}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-mono text-[#1eba98] hover:text-[#1eba98]/70 transition-colors cursor-pointer hover:underline"
                          >
                            {item.txSig.slice(0, 4)}...{item.txSig.slice(-4)}
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
      </div>
    </EmployerLayout>
  );
}

export default function TreasuryPage() {
  return (
    <Suspense fallback={null}>
      <TreasuryPageContent />
    </Suspense>
  );
}
