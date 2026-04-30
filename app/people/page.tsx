"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Users,
  Search,
  Plus,
  Loader2,
  PauseCircle,
  ArrowUpRight,
  Calendar,
  DollarSign,
  TrendingUp,
  Ban,
} from "lucide-react";
import { toast } from "sonner";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import {
  monthlyUsdToRatePerSecond,
} from "@/lib/payroll-math";
import {
  DEFAULT_PAYROLL_PAYOUT_MODE,
  PAYROLL_PAYOUT_MODE_OPTIONS,
  allowedPayoutModesFor,
  payoutModeSummary,
  type PayrollPayoutMode,
} from "@/lib/payroll-payout-mode";
import Link from "next/link";

interface Employee {
  id: string;
  wallet: string;
  name: string;
  notes?: string;
  department?: string;
  role?: string;
  employmentType?: "full_time" | "part_time" | "contract";
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  compensationUnit?: "monthly" | "weekly" | "hourly";
  compensationAmountUsd?: number;
  weeklyHours?: number;
  monthlySalaryUsd?: number;
  startDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StreamInfo {
  id: string;
  employeeId: string;
  status: "active" | "paused" | "stopped";
  ratePerSecond: number;
  startsAt?: string | null;
  payoutMode?: PayrollPayoutMode;
  employeePda?: string | null;
  privatePayrollPda?: string | null;
  permissionPda?: string | null;
  totalPaid: number;
  lastPaidAt: string | null;
  delegatedAt: string | null;
  recipientPrivateInitializedAt?: string | null;
  checkpointCrankStatus?: "idle" | "pending" | "active" | "failed" | "stopped" | null;
}

function shorten(addr: string) {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function formatSolRate(rps: number) {
  return (rps * 86400).toFixed(6);
}

function getDefaultStartDateTime() {
  const value = new Date();
  value.setMinutes(0, 0, 0);
  value.setHours(value.getHours() + 1);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  const hours = `${value.getHours()}`.padStart(2, "0");
  const minutes = `${value.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatCompensationBasis(employee: Employee) {
  if (
    !Number.isFinite(employee.compensationAmountUsd) ||
    !employee.compensationAmountUsd
  ) {
    return null;
  }

  if (employee.compensationUnit === "hourly") {
    return `${formatCurrency(employee.compensationAmountUsd)}/hr`;
  }

  if (employee.compensationUnit === "weekly") {
    return `${formatCurrency(employee.compensationAmountUsd)}/week`;
  }

  return `${formatCurrency(employee.compensationAmountUsd)}/month`;
}

function getPrivateReadiness(stream: StreamInfo | null) {
  if (!stream) {
    return {
      label: "Not wired",
      className: "bg-white/[0.04] text-[#8f8f95] border-white/10",
    };
  }

  if (stream.privatePayrollPda && stream.employeePda && stream.delegatedAt) {
    return {
      label: "PER Ready",
      className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    };
  }

  if (stream.checkpointCrankStatus === "pending" || stream.checkpointCrankStatus === "active") {
    return {
      label: "Syncing",
      className: "bg-blue-500/15 text-blue-300 border-blue-400/30",
    };
  }

  return {
    label: "Needs sync",
    className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  };
}

function isPerReady(stream: StreamInfo | null) {
  if (!stream) return false;
  return Boolean(stream.privatePayrollPda && stream.employeePda && stream.delegatedAt);
}

function getEmploymentTypeLabel(type: Employee["employmentType"] | undefined) {
  if (type === "contract") return "Contractor";
  if (type === "part_time") return "Part-time";
  return "Full-time";
}

const DEPARTMENT_OPTIONS = [
  "Engineering",
  "Product",
  "Design",
  "Sales",
  "Marketing",
  "Operations",
  "Finance",
  "HR",
  "Legal",
  "Support",
] as const;

const ROLE_OPTIONS_BY_DEPARTMENT: Record<string, string[]> = {
  Engineering: [
    "Frontend Engineer",
    "Backend Engineer",
    "Full Stack Engineer",
    "Mobile Engineer",
    "DevOps Engineer",
    "QA Engineer",
    "Engineering Manager",
  ],
  Product: [
    "Product Manager",
    "Product Analyst",
    "Technical Product Manager",
    "Head of Product",
  ],
  Design: ["Product Designer", "UX Designer", "UI Designer", "Design Lead"],
  Sales: ["Sales Executive", "Account Executive", "Sales Manager"],
  Marketing: ["Marketing Manager", "Growth Manager", "Content Specialist"],
  Operations: ["Operations Manager", "Program Manager", "Office Manager"],
  Finance: ["Finance Manager", "Accountant", "Payroll Specialist"],
  HR: ["HR Manager", "People Operations", "Talent Acquisition"],
  Legal: ["Legal Counsel", "Compliance Officer", "Legal Operations"],
  Support: ["Support Specialist", "Customer Success", "Support Lead"],
};

export default function PeoplePage() {
  const { publicKey, signMessage } = useWallet();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWallet, setNewWallet] = useState("");
  const [newDepartment, setNewDepartment] = useState<(typeof DEPARTMENT_OPTIONS)[number]>(
    DEPARTMENT_OPTIONS[0],
  );
  const [newRole, setNewRole] = useState(
    ROLE_OPTIONS_BY_DEPARTMENT[DEPARTMENT_OPTIONS[0]][0] ?? "",
  );
  const [newCompensationAmount, setNewCompensationAmount] = useState("");
  const [newPayoutMode, setNewPayoutMode] = useState<PayrollPayoutMode>(
    DEFAULT_PAYROLL_PAYOUT_MODE,
  );
  const [newStartDateTime, setNewStartDateTime] = useState(
    getDefaultStartDateTime(),
  );
  const [now, setNow] = useState(() => Date.now());

  // Live ticker: update every second for real-time accruing display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  function getLiveAccrued(stream: StreamInfo, canAccrue: boolean) {
    if (stream.status !== "active" || !canAccrue) return stream.totalPaid;
    const anchor = stream.lastPaidAt ?? stream.startsAt;
    if (!anchor) return stream.totalPaid;
    const elapsedSec = Math.max(0, (now - new Date(anchor).getTime()) / 1000);
    return stream.totalPaid + elapsedSec * stream.ratePerSecond;
  }
  const [adding, setAdding] = useState(false);

  const walletAddr = publicKey?.toBase58();

  useEffect(() => {
    if (!walletAddr || !signMessage) {
      const timeoutId = window.setTimeout(() => {
        setEmployees([]);
        setStreams([]);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [empRes, strRes] = await Promise.all([
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
        ]);
        const empJson = await empRes.json();
        const strJson = await strRes.json();
        if (!cancelled && empRes.ok) setEmployees(empJson.employees ?? []);
        if (!cancelled && strRes.ok) setStreams(strJson.streams ?? []);
      } catch {
        if (!cancelled) toast.error("Failed to load people");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [walletAddr, signMessage]);

  const filtered = employees.filter(
    (e) =>
      e.name.toLowerCase().includes(search.toLowerCase()) ||
      e.wallet.toLowerCase().includes(search.toLowerCase()),
  );

  const getStream = (empId: string) =>
    streams.find((s) => s.employeeId === empId);
  const parsedAmount = Number.parseFloat(newCompensationAmount || "0");
  const startDateTimeIso = newStartDateTime
    ? new Date(newStartDateTime).toISOString()
    : "";
  const previewRatePerSecond = monthlyUsdToRatePerSecond(parsedAmount);

  const handleAdd = async () => {
    if (
      !walletAddr ||
      !signMessage ||
      !newName.trim() ||
      !newWallet.trim() ||
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0 ||
      !newStartDateTime
    ) {
      return;
    }
    setAdding(true);
    try {
      const employeeRes = await walletAuthenticatedFetch({
        wallet: walletAddr,
        signMessage,
        path: "/api/employees",
        method: "POST",
        body: {
          employerWallet: walletAddr,
          wallet: newWallet.trim(),
          name: newName.trim(),
          department: newDepartment.trim(),
          role: newRole.trim() || undefined,
          employmentType: "full_time",
          paySchedule: "monthly",
          compensationUnit: "monthly",
          compensationAmountUsd: parsedAmount,
          monthlySalaryUsd: parsedAmount,
          startDate: startDateTimeIso,
        },
      });
      const employeeJson = await employeeRes.json();
      if (!employeeRes.ok) {
        throw new Error(employeeJson.error || "Failed to add employee");
      }

      const employee = employeeJson.employee as Employee;
      const shouldStartImmediately = new Date(startDateTimeIso).getTime() <= now;
      const streamRes = await walletAuthenticatedFetch({
        wallet: walletAddr,
        signMessage,
        path: "/api/streams",
        method: "POST",
        body: {
          employerWallet: walletAddr,
          employeeId: employee.id,
          ratePerSecond: previewRatePerSecond,
          startsAt: startDateTimeIso,
          status: shouldStartImmediately ? "active" : "paused",
          payoutMode: newPayoutMode,
          allowedPayoutModes: allowedPayoutModesFor(newPayoutMode),
          compensationSnapshot: {
            employmentType: "full_time",
            paySchedule: "monthly",
            compensationUnit: "monthly",
            compensationAmountUsd: parsedAmount,
            monthlySalaryUsd: parsedAmount,
            startsAt: startDateTimeIso,
          },
        },
      });
      const streamJson = await streamRes.json();

      setEmployees((prev) => [employee, ...prev]);
      if (streamRes.ok && streamJson.stream) {
        setStreams((prev) => [streamJson.stream, ...prev]);
      } else {
        toast.warning("Employee added, but stream setup needs attention");
      }

      setShowAdd(false);
      setNewName("");
      setNewWallet("");
      setNewDepartment(DEPARTMENT_OPTIONS[0]);
      setNewRole(ROLE_OPTIONS_BY_DEPARTMENT[DEPARTMENT_OPTIONS[0]][0]);
      setNewCompensationAmount("");
      setNewPayoutMode(DEFAULT_PAYROLL_PAYOUT_MODE);
      setNewStartDateTime(getDefaultStartDateTime());
      toast.success("Employee added to payroll");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  };

  return (
    <EmployerLayout>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Payroll
            </h1>
            <p className="text-sm text-[#8f8f95] mt-1">
              {filtered.length} employee{filtered.length !== 1 ? "s" : ""} on payroll
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a8a8aa]" size={16} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search team..."
                className="pl-9 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#a8a8aa] focus:outline-none focus:border-[#1eba98] focus:ring-1 focus:ring-[#1eba98]/20 w-48"
              />
            </div>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1eba98] hover:bg-[#1eba98]/80 text-black text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
            >
              <Plus size={14} />
              Add employee
            </button>
          </div>
        </div>

        <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl overflow-hidden shadow-sm">
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center">
              <Loader2 size={24} className="text-[#1eba98] animate-spin mb-4" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">Syncing team data...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-24 flex flex-col items-center justify-center text-center px-6">
              <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-6">
                <Users size={24} className="text-[#a8a8aa]/40" />
              </div>
              <p className="text-base font-bold text-white tracking-tight">No team members yet</p>
              <p className="text-xs text-[#a8a8aa] mt-1 max-w-[240px] leading-relaxed">
                Employees will appear here once they are onboarded to payroll.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {filtered.map((emp) => {
                const stream = getStream(emp.id) ?? null;
                const status = stream?.status ?? "stopped";
                const hasFutureStart = Boolean(
                  stream?.startsAt && new Date(stream.startsAt).getTime() > now,
                );
                const perReady = isPerReady(stream);
                const isStreamingLive =
                  Boolean(stream) && status === "active" && perReady && !hasFutureStart;
                const statusLabel =
                  isStreamingLive
                    ? "Streaming"
                    : hasFutureStart
                      ? "Scheduled"
                      : status === "active"
                        ? "Needs sync"
                        : status === "paused"
                          ? "Paused"
                          : "Stopped";
                const statusColor =
                  isStreamingLive
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                    : hasFutureStart
                      ? "bg-blue-500/15 text-blue-300 border-blue-400/30"
                      : status === "active"
                        ? "bg-amber-500/15 text-amber-300 border-amber-400/30"
                        : status === "paused"
                          ? "bg-amber-500/15 text-amber-300 border-amber-400/30"
                          : "bg-rose-500/15 text-rose-300 border-rose-400/30";
                const compensationBasis = formatCompensationBasis(emp);
                const dailyRate = emp.monthlySalaryUsd
                  ? formatSolRate(monthlyUsdToRatePerSecond(emp.monthlySalaryUsd))
                  : null;

                return (
                  <div
                    key={emp.id}
                    className="flex items-center justify-between px-6 py-5 hover:bg-white/5 transition-all duration-200"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center shrink-0">
                        <span className="text-sm font-bold text-[#a8a8aa]">
                          {emp.name?.charAt(0)?.toUpperCase() ?? "?"}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">
                          {emp.name}
                        </p>
                        <p className="text-[11px] text-[#8f8f95] font-mono truncate">
                          {shorten(emp.wallet)}
                        </p>
                        {(emp.role || emp.department) && (
                          <p className="text-[11px] text-[#7a7a82] truncate mt-0.5">
                            {[emp.role, emp.department].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Type */}
                    <div>
                      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-500/15 text-blue-300 border border-blue-400/30">
                        {getEmploymentTypeLabel(emp.employmentType)}
                      </span>
                    </div>

                    {/* Start Date */}
                    <div className="flex items-center gap-1.5 text-sm text-[#b6b6bc]">
                      <Calendar size={12} className="text-[#8f8f95]" />
                      {new Date(emp.startDate ?? emp.createdAt).toLocaleDateString(
                        "en-US",
                        {
                          month: "short",
                          day: "2-digit",
                          year: "numeric",
                        },
                      )}
                    </div>

                    {/* Salary */}
                    <div>
                      {emp.monthlySalaryUsd ? (
                        <div>
                          <div className="flex items-center gap-1">
                            <DollarSign size={12} className="text-emerald-500" />
                            <span className="text-sm font-semibold text-white">
                              {formatCurrency(emp.monthlySalaryUsd)}
                            </span>
                          </div>
                          {compensationBasis && (
                            <p className="text-[10px] text-[#8f8f95] mt-1">
                              Input: {compensationBasis}
                            </p>
                          )}
                          {dailyRate && (
                            <p className="text-[10px] text-[#8f8f95] mt-1">
                              {dailyRate} USDC/day
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-[#8f8f95]">—</span>
                      )}
                    </div>

                    {/* Accrued Live */}
                    <div className="flex items-center gap-1.5">
                      {stream && isStreamingLive ? (
                        <>
                          <span className="relative flex h-2 w-2 mr-1">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                          </span>
                          <span className="text-sm font-semibold text-emerald-700 font-mono tabular-nums">
                            {getLiveAccrued(stream, isStreamingLive).toFixed(6)}
                          </span>
                        </>
                      ) : (
                        <>
                          <TrendingUp size={12} className="text-[#8f8f95]" />
                          <span className="text-sm font-semibold text-white font-mono">
                            {stream ? stream.totalPaid.toFixed(4) : "0"}
                          </span>
                        </>
                      )}
                      <span className="text-[10px] text-[#8f8f95]">USDC</span>
                    </div>

                    {/* Private */}
                    <div>
                      {(() => {
                        const readiness = getPrivateReadiness(stream);
                        return (
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border ${readiness.className}`}
                          >
                            {readiness.label}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Stream status */}
                    <div>
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border ${statusColor}`}
                      >
                        {isStreamingLive ? (
                          <>
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                            </span>
                            Streaming
                          </>
                        ) : hasFutureStart ? (
                          <>
                            <Calendar size={10} />
                            Scheduled
                          </>
                        ) : status === "active" ? (
                          <>
                            <PauseCircle size={10} />
                            Needs sync
                          </>
                        ) : status === "paused" ? (
                          <>
                            <PauseCircle size={10} />
                            Paused
                          </>
                        ) : (
                          <>
                            <Ban size={10} />
                            {statusLabel}
                          </>
                        )}
                      </span>
                    </div>

                    {/* Action */}
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/people/${emp.id}`}
                        className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold text-white bg-white/5 border border-white/15 rounded-lg hover:bg-white/10 transition-colors no-underline"
                      >
                        Profile
                      </Link>
                      <Link
                        href={`/disburse?employee=${emp.id}`}
                        className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-black rounded-lg hover:bg-gray-800 transition-colors no-underline"
                      >
                        Payroll
                        <ArrowUpRight size={10} />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          onClick={() => setShowAdd(false)}
        >
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
          <div
            className="relative w-full max-w-lg bg-[#0a0a0a] border border-white/10 rounded-3xl shadow-2xl p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Add employee</h2>
              <button 
                onClick={() => setShowAdd(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 text-[#8f8f95] hover:text-white hover:bg-white/10 transition-colors"
              >
                &times;
              </button>
            </div>
            
            <div className="space-y-5">
              <div>
                <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                  Full name
                </label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. John Doe"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#8f8f95] focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                  Solana wallet
                </label>
                <input
                  value={newWallet}
                  onChange={(e) => setNewWallet(e.target.value)}
                  placeholder="Enter wallet address..."
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#8f8f95] focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                    Department
                  </label>
                  <select
                    value={newDepartment}
                    onChange={(e) => {
                      const nextDepartment = e.target.value as (typeof DEPARTMENT_OPTIONS)[number];
                      const roleOptions = ROLE_OPTIONS_BY_DEPARTMENT[nextDepartment] ?? [];
                      setNewDepartment(nextDepartment);
                      setNewRole(roleOptions[0] ?? "");
                    }}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                  >
                    {DEPARTMENT_OPTIONS.map((department) => (
                      <option key={department} value={department}>{department}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                    Role
                  </label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                  >
                    {(ROLE_OPTIONS_BY_DEPARTMENT[newDepartment] ?? []).map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                    Monthly Salary
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8f8f95] text-sm">$</span>
                    <input
                      value={newCompensationAmount}
                      onChange={(e) => setNewCompensationAmount(e.target.value)}
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="3000"
                      className="w-full pl-8 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#8f8f95] focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                    />
                  </div>
                  {parsedAmount > 0 && (
                    <p className="text-[11px] text-[#8f8f95] mt-2 font-mono">
                      {previewRatePerSecond.toFixed(8)} USDC/sec
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                    Settlement mode
                  </label>
                  <select
                    value={newPayoutMode}
                    onChange={(e) => setNewPayoutMode(e.target.value as PayrollPayoutMode)}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                  >
                    {PAYROLL_PAYOUT_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-[#8f8f95] mt-2">
                    {payoutModeSummary(newPayoutMode)}
                  </p>
                </div>
              </div>
              <div>
                <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                  Stream starts at
                </label>
                <input
                  value={newStartDateTime}
                  onChange={(e) => setNewStartDateTime(e.target.value)}
                  type="datetime-local"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#1eba98]/25"
                />
              </div>
            </div>

            <button
              onClick={handleAdd}
              disabled={
                adding ||
                !newName.trim() ||
                !newWallet.trim() ||
                !newStartDateTime ||
                !Number.isFinite(parsedAmount) ||
                parsedAmount <= 0
              }
              className="w-full mt-8 py-3.5 bg-[#1eba98] text-black rounded-xl text-sm font-bold hover:bg-[#1eba98]/85 transition-colors disabled:opacity-50"
            >
              {adding ? (
                <Loader2 size={16} className="animate-spin mx-auto" />
              ) : (
                "Add Employee"
              )}
            </button>
          </div>
        </div>
      )}
    </EmployerLayout>
  );
}
