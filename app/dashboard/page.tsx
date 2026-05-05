"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Wallet,
  RefreshCw,
  Layers,
  Users,
  PlayCircle,
  DollarSign,
  CalendarDays,
  AlertTriangle,
  Download,
  Plus,
  Building2,
} from "lucide-react";

import Link from "next/link";

import { toast } from "sonner";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import { RunwayProjectionChart } from "@/components/ui/payroll-chart";
import { CompensationBreakdownChart } from "@/components/ui/crypto-distribution-chart";
import { DepositModal } from "@/components/deposit-modal";
import { SetupCompanyModal } from "@/components/setup-company-modal";
import {
  fetchTeeAuthToken,
  getBalance,
  getPrivateBalance,
  isJwtExpired,
  type BalanceResponse,
} from "@/lib/magicblock-api";
import {
  clearCachedTeeToken,
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";

type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";

type CycleStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "processing"
  | "completed"
  | "cancelled";

interface RealPayrollRun {
  id: string;
  cycleId: string;
  status: RunStatus;
  totals?: {
    itemCount: number;
    paidCount: number;
    failedCount: number;
    grossAmount: number;
    netAmount: number;
  };
  createdAt: string;
}

interface RealPayrollCycle {
  id: string;
  label: string;
  payDate: string;
  status: CycleStatus;
  totals: {
    employeeCount: number;
    grossAmount: number;
    netAmount: number;
  };
  itemCount?: number;
  createdAt: string;
}

interface EmployeeProfilesPayload {
  employeeProfiles: Array<{
    employee: {
      id: string;
      name: string;
      wallet: string;
    };
    payrollProfile: {
      id: string;
      status: "active" | "inactive";
      baseSalaryMonthly: number;
      allowancesMonthly: number;
      fixedDeductionsMonthly: number;
    } | null;
  }>;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function statusChip(status: RunStatus | CycleStatus) {
  if (status === "running" || status === "processing") {
    return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  }
  if (status === "completed") {
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  }
  if (status === "approved") {
    return "bg-green-500/10 text-green-400 border-green-500/20";
  }
  if (status === "draft" || status === "queued" || status === "pending_approval") {
    return "bg-white/5 text-[#a8a8aa] border-white/10";
  }
  if (status === "partially_failed") {
    return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  }
  return "bg-red-500/10 text-red-400 border-red-500/20";
}

export default function DashboardPage() {
  const { connected, publicKey, signMessage } = useWallet();
  const walletAddr = publicKey?.toBase58() ?? "";

  const [runs, setRuns] = useState<RealPayrollRun[]>([]);
  const [cycles, setCycles] = useState<RealPayrollCycle[]>([]);
  const [employeeProfiles, setEmployeeProfiles] =
    useState<EmployeeProfilesPayload["employeeProfiles"]>([]);
  const [employees, setEmployees] = useState<Array<{
    id: string; wallet: string; name: string; monthlySalaryUsd?: number;
    compensationAmountUsd?: number; compensationUnit?: string;
  }>>([]);
  const [streams, setStreams] = useState<Array<{
    id: string; employeeId: string; status: "active" | "paused" | "stopped";
    ratePerSecond: number; totalPaid: number;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [vaultBalance, setVaultBalance] = useState<number>(0);
  const [baseBalance, setBaseBalance] = useState<number>(0);
  const [depositOpen, setDepositOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [company, setCompany] = useState<{ id: string; name: string; treasuryPubkey: string } | null>(null);

  const companyRef = useRef(company);
  companyRef.current = company;

  const tokenCache = useRef<string | null>(null);

  const getOrFetchToken = useCallback(async () => {
    if (tokenCache.current && !isJwtExpired(tokenCache.current)) {
      return tokenCache.current;
    }
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
    if (!publicKey || !signMessage) {
      throw new Error("Wallet does not support message signing");
    }
    const token = await getOrCreateCachedTeeToken(
      publicKey.toBase58(),
      async () => fetchTeeAuthToken(publicKey, signMessage),
    );
    tokenCache.current = token;
    return token;
  }, [publicKey, signMessage]);

  const refreshVaultBalance = useCallback(async () => {
    if (!walletAddr) return;
    try {
      // Always fetch the employer's base balance
      const baseBalRes = await getBalance(walletAddr).catch(() => null);
      if (baseBalRes) {
        setBaseBalance(parseInt(baseBalRes.balance ?? "0", 10) / 1_000_000);
      }

      // For the vault/private balance: use treasury if company exists, else personal
      const currentCompany = companyRef.current;
      if (currentCompany?.id) {
        if (!signMessage) return;
        const treasuryRes = await walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/company/${currentCompany.id}/balance?wallet=${walletAddr}`,
        }).catch(() => null);
        if (treasuryRes && treasuryRes.ok) {
          const data = await treasuryRes.json();
          setVaultBalance(parseInt(data.balance ?? "0", 10) / 1_000_000);
        }
      } else {
        const teeToken = await getOrFetchToken();
        const privBalRes = await getPrivateBalance(walletAddr, teeToken).catch(() => null);
        if (privBalRes) {
          setVaultBalance(parseInt(privBalRes.balance ?? "0", 10) / 1_000_000);
        }
      }
    } catch {
      // Balance fetch failed silently
    }
  }, [walletAddr, getOrFetchToken]);

  const loadDashboard = useCallback(async () => {
    if (!walletAddr || !signMessage) {
      setRuns([]);
      setCycles([]);
      setEmployeeProfiles([]);
      setCompany(null);
      return;
    }

    setLoading(true);
    try {
      const [runsRes, cyclesRes, profilesRes, empRes, strRes, compRes] = await Promise.all([
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/payroll-runs/runs?employerWallet=${walletAddr}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/payroll-runs/cycles?employerWallet=${walletAddr}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/payroll-runs/profiles?employerWallet=${walletAddr}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/employees?employerWallet=${walletAddr}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/streams?employerWallet=${walletAddr}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: `/api/company/me?employerWallet=${walletAddr}`,
        }),
      ]);

      const runsJson = (await runsRes.json()) as {
        runs?: RealPayrollRun[];
        error?: string;
      };
      const cyclesJson = (await cyclesRes.json()) as {
        cycles?: RealPayrollCycle[];
        error?: string;
      };
      const profilesJson = (await profilesRes.json()) as
        | EmployeeProfilesPayload
        | { error?: string };
      const empJson = (await empRes.json()) as { employees?: typeof employees };
      const strJson = (await strRes.json()) as { streams?: typeof streams };

      if (runsRes.ok) {
        setRuns(runsJson.runs ?? []);
      }
      if (cyclesRes.ok) {
        setCycles(cyclesJson.cycles ?? []);
      }
      if (profilesRes.ok) {
        setEmployeeProfiles(
          "employeeProfiles" in profilesJson ? profilesJson.employeeProfiles ?? [] : [],
        );
      }
      if (empRes.ok) {
        setEmployees(empJson.employees ?? []);
      }
      if (strRes.ok) {
        setStreams(strJson.streams ?? []);
      }
      if (compRes.ok) {
        const compJson = await compRes.json();
        setCompany(compJson.company || null);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Dashboard load failed");
    } finally {
      setLoading(false);
    }

    // Fetch vault balance independently so API failures don't block it
    void refreshVaultBalance();
  }, [walletAddr, signMessage, refreshVaultBalance]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  // Also try loading vault balance from cached TEE token on mount
  useEffect(() => {
    if (!walletAddr) return;
    const cached = loadCachedTeeToken(walletAddr);
    if (cached) {
      tokenCache.current = cached;
      const timer = window.setTimeout(() => {
        void refreshVaultBalance();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [walletAddr, refreshVaultBalance]);



  const totalGross = useMemo(
    () => runs.reduce((sum, run) => sum + (run.totals?.grossAmount ?? 0), 0),
    [runs],
  );

  const activeStreamsCount = useMemo(() => {
    let count = 0;
    for (const emp of employees) {
      const stream = streams.find((s) => s.employeeId === emp.id);
      if (stream && stream.status === "active") {
        count++;
      }
    }
    return count;
  }, [employees, streams]);

  const totalEmployees = employees.length;

  const monthlyBurnRate = useMemo(() => {
    let sum = 0;
    for (const emp of employees) {
      const stream = streams.find((s) => s.employeeId === emp.id);
      if (stream && stream.status === "active") {
        // First try to use the employee's configured salary
        if (emp.monthlySalaryUsd) {
          sum += emp.monthlySalaryUsd;
        } else if (emp.compensationAmountUsd && emp.compensationUnit === "monthly") {
          sum += emp.compensationAmountUsd;
        } else {
          // Fallback to calculating the monthly rate from the raw on-chain ratePerSecond
          sum += stream.ratePerSecond * 86400 * 30;
        }
      }
    }
    return sum;
  }, [employees, streams]);

  const totalDisbursed = useMemo(
    () => streams.reduce((sum, s) => sum + (s.totalPaid ?? 0), 0),
    [streams],
  );

  const failedRuns = useMemo(
    () =>
      runs.filter(
        (run) => run.status === "failed" || run.status === "partially_failed",
      ).length,
    [runs],
  );



  return (
    <EmployerLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">{company ? company.name : "Employer Dashboard"}</h1>
            <p className="text-sm text-[#a8a8aa] mt-1">
              {company ? `Treasury: ${company.treasuryPubkey.slice(0, 4)}...${company.treasuryPubkey.slice(-4)}` : "Real-time on-chain metrics, treasury health, and active stream analytics."}
            </p>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={() => void loadDashboard()}
              disabled={loading || !connected}
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-[#0a0a0a] p-3 text-white transition-colors hover:bg-white/5 disabled:opacity-40 shadow-sm h-[44px] w-[44px]"
              title="Refresh Dashboard"
            >
              {loading ? <RefreshCw size={18} className="animate-spin text-[#a8a8aa]" /> : <RefreshCw size={18} className="text-[#a8a8aa]" />}
            </button>
            
            <button
              onClick={() => setDepositOpen(true)}
              disabled={!company}
              className="inline-flex h-[44px] items-center gap-2 rounded-2xl border border-white/10 bg-[#0a0a0a] px-5 text-sm font-semibold text-white transition-colors hover:bg-white/5 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={16} className={company ? "text-[#a8a8aa]" : "text-[#a8a8aa]/50"} />
              Deposit
            </button>
            
            {company ? (
              <Link
                href="/disburse"
                className="inline-flex h-[44px] items-center gap-2 rounded-2xl bg-[#1eba98] px-5 text-sm font-semibold text-black transition-colors hover:bg-[#1eba98]/80 shadow-[0_0_20px_rgba(30,186,152,0.3)]"
              >
                <Plus size={16} />
                Run Payroll
              </Link>
            ) : (
              <button
                onClick={() => setSetupOpen(true)}
                className="inline-flex h-[44px] items-center gap-2 rounded-2xl bg-[#1eba98] px-5 text-sm font-semibold text-black transition-colors hover:bg-[#1eba98]/80 shadow-[0_0_20px_rgba(30,186,152,0.3)]"
              >
                <Building2 size={16} />
                Setup Company
              </button>
            )}
          </div>
        </div>

        {!connected ? (
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-14 text-center shadow-sm">
            <Wallet size={40} className="mx-auto mb-4 text-[#a8a8aa]" />
            <p className="text-lg font-semibold text-white">Connect wallet to load live on-chain treasury data</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Private Vault Balance</p>
                <p className="mt-2 text-2xl font-bold tracking-tight text-white">{formatUsd(vaultBalance)}</p>
                <p className="mt-1 text-xs text-[#a8a8aa]">Live USDC treasury liquidity</p>
              </div>

              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Total Employees</p>
                <p className="mt-2 text-2xl font-bold tracking-tight text-white">{totalEmployees}</p>
                <p className="mt-1 text-xs text-[#a8a8aa]">All registered team members</p>
              </div>

              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Total Payouts</p>
                <p className="mt-2 text-2xl font-bold tracking-tight text-white">{formatUsd(totalDisbursed)}</p>
                <p className="mt-1 text-xs text-[#a8a8aa]">All-time crypto paid to employees</p>
              </div>

              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Active Streams</p>
                <p className="mt-2 text-2xl font-bold tracking-tight text-white">
                  {activeStreamsCount}/{Math.max(totalEmployees, activeStreamsCount)}
                </p>
                <p className="mt-1 text-xs text-[#a8a8aa]">Employees actively receiving funds</p>
              </div>
            </div>

            {failedRuns > 0 ? (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                <AlertTriangle size={16} className="mt-0.5 text-amber-400" />
                <p className="text-sm text-amber-400">
                  {failedRuns} run(s) contain failures. Open Runs page to retry failed items.
                </p>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <RunwayProjectionChart vaultBalance={vaultBalance} monthlyBurnRate={monthlyBurnRate} />
              <CompensationBreakdownChart employees={employees} streams={streams} />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <PlayCircle size={16} className="text-[#a8a8aa]" />
                  <p className="text-sm font-bold text-white">Recent Payroll Runs</p>
                </div>
                <div className="space-y-3">
                  {runs.length === 0 ? (
                    <p className="text-sm text-[#a8a8aa]">No payroll runs yet.</p>
                  ) : (
                    runs.slice(0, 8).map((run) => (
                      <div
                        key={run.id}
                        className="rounded-2xl border border-white/5 bg-white/5 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">{run.id.slice(0, 8)}...</p>
                            <p className="text-xs text-[#a8a8aa]">{formatDate(run.createdAt)} • {run.cycleId.slice(0, 8)}...</p>
                          </div>
                          <span
                            className={`rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${statusChip(
                              run.status,
                            )}`}
                          >
                            {run.status.replace("_", " ")}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-4 text-xs text-[#a8a8aa]">
                          <span className="inline-flex items-center gap-1">
                            <Users size={12} />
                            {run.totals?.paidCount ?? 0}/{run.totals?.itemCount ?? 0}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <DollarSign size={12} />
                            {formatUsd(run.totals?.netAmount ?? 0)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <CalendarDays size={16} className="text-[#a8a8aa]" />
                  <p className="text-sm font-bold text-white">Payroll Cycles</p>
                </div>
                <div className="space-y-3">
                  {cycles.length === 0 ? (
                    <p className="text-sm text-[#a8a8aa]">No payroll cycles yet.</p>
                  ) : (
                    cycles.slice(0, 8).map((cycle) => (
                      <div
                        key={cycle.id}
                        className="rounded-2xl border border-white/5 bg-white/5 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">{cycle.label}</p>
                            <p className="text-xs text-[#a8a8aa]">Pay date {formatDate(cycle.payDate)}</p>
                          </div>
                          <span
                            className={`rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${statusChip(
                              cycle.status,
                            )}`}
                          >
                            {cycle.status.replace("_", " ")}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-4 text-xs text-[#a8a8aa]">
                          <span className="inline-flex items-center gap-1">
                            <Layers size={12} />
                            {cycle.itemCount ?? cycle.totals.employeeCount} item(s)
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <DollarSign size={12} />
                            Gross {formatUsd(cycle.totals.grossAmount)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0a0a0a] p-4 text-xs text-[#a8a8aa]">
              Data sources: <span className="font-semibold text-white">/api/payroll-runs/runs</span>,{" "}
              <span className="font-semibold text-white">/api/payroll-runs/cycles</span>,{" "}
              <span className="font-semibold text-white">/api/payroll-runs/profiles</span>.
              Total gross tracked: <span className="font-semibold text-white">{formatUsd(totalGross)}</span>.
            </div>
          </>
        )}
      </div>


      <DepositModal
        isOpen={depositOpen}
        onClose={() => setDepositOpen(false)}
        baseBalance={baseBalance}
        privateBalance={vaultBalance}
        treasuryPubkey={company?.treasuryPubkey}
        onDepositSuccess={() => {
          void refreshVaultBalance();
          void loadDashboard();
        }}
      />
      <SetupCompanyModal
        isOpen={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSuccess={() => {
          void loadDashboard();
        }}
      />
    </EmployerLayout>
  );
}
