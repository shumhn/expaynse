"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  Bell,
  Wallet,
  BarChart2,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import {
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";
import { fetchTeeAuthToken, isJwtExpired } from "@/lib/magicblock-api";
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
  privateRecipientInitializedAt?: string | null;
  privateRecipientInitStatus?: "pending" | "processing" | "confirmed" | "failed";
  privateRecipientInitRequestedAt?: string | null;
  privateRecipientInitLastAttemptAt?: string | null;
  privateRecipientInitConfirmedAt?: string | null;
  privateRecipientInitTxSignature?: string | null;
  privateRecipientInitError?: string | null;
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
  checkpointCrankStatus?: "idle" | "pending" | "active" | "failed" | "stopped" | "stale" | null;
}

interface PrivatePayrollStateResponse {
  stream: {
    id: string;
    status: "active" | "paused" | "stopped";
    lastPaidAt: string | null;
    totalPaid: number;
    employeePda?: string | null;
    privatePayrollPda?: string | null;
    permissionPda?: string | null;
    delegatedAt?: string | null;
  };
  state: {
    status: "active" | "paused" | "stopped";
    accruedUnpaidMicro: string;
    totalPaidPrivateMicro: string;
    effectiveClaimableAmountMicro: string;
    lastAccrualTimestamp: string;
  };
  syncedAt: string;
}

const PER_CHECKPOINT_STALE_MS = 15_000;

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

function getPrivateInitStatus(employee: Employee, stream: StreamInfo | null) {
  if (
    stream?.recipientPrivateInitializedAt ||
    employee.privateRecipientInitializedAt ||
    employee.privateRecipientInitConfirmedAt
  ) {
    return "confirmed" as const;
  }

  return employee.privateRecipientInitStatus ?? "pending";
}

function getPrivateReadinessState(
  employee: Employee,
  stream: StreamInfo | null,
  hasMissingPrivateState: boolean,
) {
  const initStatus = getPrivateInitStatus(employee, stream);

  if (hasMissingPrivateState) {
    return {
      label: "Expired",
      className: "bg-rose-500/15 text-rose-300 border-rose-400/30",
    };
  }

  if (initStatus === "failed") {
    return {
      label: "Init failed",
      className: "bg-rose-500/15 text-rose-300 border-rose-400/30",
    };
  }

  if (initStatus === "processing") {
    return {
      label: "Init syncing",
      className: "bg-blue-500/15 text-blue-300 border-blue-400/30",
    };
  }

  if (initStatus !== "confirmed") {
    return {
      label: "Init pending",
      className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
    };
  }

  return getPrivateReadiness(stream);
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

const PER_PREVIEW_MAX_STALENESS_MS = 15_000;

export default function PeoplePage() {
  const { publicKey, signMessage } = useWallet();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterDepartment, setFilterDepartment] = useState<string>("All Departments");
  const [filterStatus, setFilterStatus] = useState<"All" | "Active" | "Inactive">("All");
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
  const [now, setNow] = useState(() => Date.now());
  const [privateStates, setPrivateStates] = useState<
    Record<string, PrivatePayrollStateResponse>
  >({});
  const [missingPrivateStates, setMissingPrivateStates] = useState<
    Record<string, boolean>
  >({});
  const tokenCache = useRef<string | null>(null);

  // Live ticker: update every second for real-time accruing display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  function isFreshPrivatePreview(
    preview: PrivatePayrollStateResponse | null | undefined,
    nowMs: number,
  ) {
    if (!preview?.syncedAt) return false;
    const syncedAtMs = Date.parse(preview.syncedAt);
    if (!Number.isFinite(syncedAtMs)) return false;
    return nowMs - syncedAtMs <= PER_PREVIEW_MAX_STALENESS_MS;
  }

  function isCheckpointProgressFresh(
    stream: StreamInfo | null | undefined,
    preview: PrivatePayrollStateResponse | null | undefined,
    nowMs: number,
  ) {
    if (!stream || stream.checkpointCrankStatus !== "active" || !preview) {
      return false;
    }

    const lastAccrualMs = Number(preview.state.lastAccrualTimestamp) * 1000;
    if (!Number.isFinite(lastAccrualMs) || lastAccrualMs <= 0) {
      return false;
    }

    return nowMs - lastAccrualMs <= PER_CHECKPOINT_STALE_MS;
  }

  function getLiveAccrued(preview?: PrivatePayrollStateResponse | null) {
    if (preview) {
      const accruedUnpaid = Number(preview.state.accruedUnpaidMicro) / 1_000_000;
      const totalPaidPrivate =
        Number(preview.state.totalPaidPrivateMicro) / 1_000_000;
      if (Number.isFinite(accruedUnpaid) && Number.isFinite(totalPaidPrivate)) {
        return Math.max(0, accruedUnpaid + totalPaidPrivate);
      }
    }
    return null;
  }
  const [adding, setAdding] = useState(false);

  const walletAddr = publicKey?.toBase58();

  useEffect(() => {
    tokenCache.current = null;
  }, [publicKey]);

  const getOrFetchToken = useCallback(async () => {
    if (tokenCache.current && !isJwtExpired(tokenCache.current)) {
      return tokenCache.current;
    }

    if (!publicKey || !signMessage) {
      throw new Error("Wallet does not support message signing");
    }

    const wallet = publicKey.toBase58();
    const persisted = loadCachedTeeToken(wallet);
    if (persisted && !isJwtExpired(persisted)) {
      tokenCache.current = persisted;
      return persisted;
    }

    const token = await getOrCreateCachedTeeToken(wallet, async () =>
      fetchTeeAuthToken(publicKey, signMessage),
    );
    tokenCache.current = token;
    return token;
  }, [publicKey, signMessage]);

  const fetchPrivatePreview = useCallback(
    async (stream: StreamInfo, options?: { silent?: boolean }) => {
      if (!walletAddr) return;
      if (!stream.privatePayrollPda || !stream.employeePda || !stream.delegatedAt) {
        return;
      }

      try {
        const token = await getOrFetchToken();
        const response = await fetch(
          `/api/payroll/state?employerWallet=${walletAddr}&streamId=${stream.id}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const json = (await response.json()) as
          | PrivatePayrollStateResponse
          | { error?: string };

        if (!response.ok) {
          const message =
            "error" in json ? json.error || "Failed to load PER state" : "Failed to load PER state";
          const normalized = message.toLowerCase();
          const missing =
            response.status === 404 ||
            normalized.includes("private payroll state not found") ||
            normalized.includes("private payroll state account is not initialized") ||
            normalized.includes("private state expired");
          if (missing) {
            setPrivateStates((prev) => {
              const next = { ...prev };
              delete next[stream.id];
              return next;
            });
            setMissingPrivateStates((prev) => ({ ...prev, [stream.id]: true }));
            setStreams((prev) =>
              prev.map((existing) =>
                existing.id === stream.id ? { ...existing, status: "stopped" } : existing,
              ),
            );
            if (!options?.silent) {
              toast.info(
                "PER state is missing for this stream (not initialized, cleaned up, or replaced).",
              );
            }
            return;
          }
          throw new Error(message);
        }

        const preview = json as PrivatePayrollStateResponse;
        setPrivateStates((prev) => ({ ...prev, [stream.id]: preview }));
        setMissingPrivateStates((prev) => {
          const next = { ...prev };
          delete next[stream.id];
          return next;
        });
        setStreams((prev) =>
          prev.map((existing) =>
            existing.id === stream.id
              ? {
                ...existing,
                status: preview.state.status,
                lastPaidAt: preview.stream.lastPaidAt ?? existing.lastPaidAt,
                totalPaid: preview.stream.totalPaid ?? existing.totalPaid,
              }
              : existing,
          ),
        );
      } catch (error: unknown) {
        setPrivateStates((prev) => {
          const next = { ...prev };
          delete next[stream.id];
          return next;
        });
        setMissingPrivateStates((prev) => {
          const next = { ...prev };
          delete next[stream.id];
          return next;
        });
        if (!options?.silent) {
          toast.error(error instanceof Error ? error.message : "Failed to sync PER state");
        }
      }
    },
    [walletAddr, getOrFetchToken],
  );

  const loadPeople = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!walletAddr || !signMessage) {
        setEmployees([]);
        setStreams([]);
        setPrivateStates({});
        setMissingPrivateStates({});
        return;
      }

      if (!options?.silent) {
        setLoading(true);
      }

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
        if (!empRes.ok) {
          throw new Error(empJson.error || "Failed to load employees");
        }
        if (!strRes.ok) {
          throw new Error(strJson.error || "Failed to load streams");
        }
        setEmployees(empJson.employees ?? []);
        setStreams(strJson.streams ?? []);
      } catch (error: unknown) {
        if (!options?.silent) {
          toast.error(error instanceof Error ? error.message : "Failed to load people");
        }
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [walletAddr, signMessage],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPeople();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadPeople]);

  useEffect(() => {
    if (!walletAddr || !signMessage) return;
    const hasInitInFlight = employees.some((employee) => {
      const status = employee.privateRecipientInitStatus ?? "pending";
      return status === "pending" || status === "processing";
    });
    if (!hasInitInFlight) return;

    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadPeople({ silent: true });
    }, 4_000);

    return () => window.clearInterval(timer);
  }, [employees, loadPeople, signMessage, walletAddr]);

  useEffect(() => {
    if (!walletAddr || !signMessage) return;
    const active = streams.filter(
      (stream) =>
        stream.status === "active" &&
        !!stream.privatePayrollPda &&
        !!stream.employeePda &&
        !!stream.delegatedAt,
    );
    if (active.length === 0) return;

    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const stream of active) {
        void fetchPrivatePreview(stream, { silent: true });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [walletAddr, signMessage, streams, fetchPrivatePreview]);

  const resolveEffectiveStatus = (
    stream: StreamInfo | null | undefined,
    preview?: PrivatePayrollStateResponse | null,
  ) => {
    if (!stream) return "stopped" as const;
    if (missingPrivateStates[stream.id]) return "stopped" as const;
    return (preview?.state.status ?? stream.status) as StreamInfo["status"];
  };

  const filtered = employees.filter((e) => {
    const matchesSearch = e.name.toLowerCase().includes(search.toLowerCase()) || e.wallet.toLowerCase().includes(search.toLowerCase());
    const matchesDepartment = filterDepartment === "All Departments" || e.department === filterDepartment;

    let matchesStatus = true;
    if (filterStatus !== "All") {
      const stream = streams.find((s) => s.employeeId === e.id);
      const preview = stream ? (privateStates[stream.id] ?? null) : null;
      const hasFutureStart = Boolean(
        stream?.startsAt && new Date(stream.startsAt).getTime() > now,
      );
      const isActive =
        !!stream &&
        resolveEffectiveStatus(stream, preview) === "active" &&
        isPerReady(stream) &&
        !hasFutureStart &&
        !missingPrivateStates[stream.id] &&
        isFreshPrivatePreview(preview, now);
      matchesStatus = filterStatus === "Active" ? isActive : !isActive;
    }

    return matchesSearch && matchesDepartment && matchesStatus;
  });

  const activeCount = employees.filter(e => {
    const stream = streams.find(s => s.employeeId === e.id);
    if (!stream) return false;
    const preview = privateStates[stream.id] ?? null;
    const hasFutureStart = Boolean(
      stream.startsAt && new Date(stream.startsAt).getTime() > now,
    );
    return (
      resolveEffectiveStatus(stream, preview) === "active" &&
      isPerReady(stream) &&
      !hasFutureStart &&
      !missingPrivateStates[stream.id] &&
      isFreshPrivatePreview(preview, now)
    );
  }).length;

  const totalPayroll = employees.reduce((sum, e) => {
    const stream = streams.find(s => s.employeeId === e.id);
    const preview = stream ? (privateStates[stream.id] ?? null) : null;
    const hasFutureStart = Boolean(
      stream?.startsAt && new Date(stream.startsAt).getTime() > now,
    );
    const isActive =
      !!stream &&
      resolveEffectiveStatus(stream, preview) === "active" &&
      isPerReady(stream) &&
      !hasFutureStart &&
      !missingPrivateStates[stream.id] &&
      isFreshPrivatePreview(preview, now);
    if (isActive && stream) {
      if (e.monthlySalaryUsd) {
        return sum + e.monthlySalaryUsd;
      } else if (e.compensationAmountUsd && e.compensationUnit === "monthly") {
        return sum + e.compensationAmountUsd;
      } else {
        return sum + (stream.ratePerSecond * 86400 * 30);
      }
    }
    return sum;
  }, 0);

  const uniqueDepartments = new Set(employees.map(e => e.department).filter(Boolean)).size;

  const perReadyCount = employees.filter(e => {
    const stream = streams.find(s => s.employeeId === e.id);
    return isPerReady(stream ?? null) && !(stream && missingPrivateStates[stream.id]);
  }).length;

  const perReadyPercentage = employees.length > 0 ? Math.round((perReadyCount / employees.length) * 100) : 0;


  const getStream = (empId: string) =>
    streams.find((s) => s.employeeId === empId);
  const parsedAmount = Number.parseFloat(newCompensationAmount || "0");
  const startDateTimeIso = new Date().toISOString();
  const previewRatePerSecond = monthlyUsdToRatePerSecond(parsedAmount);

  const handleAdd = async () => {
    if (
      !walletAddr ||
      !signMessage ||
      !newName.trim() ||
      !newWallet.trim() ||
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0
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
      if (employee.privateRecipientInitStatus === "confirmed") {
        toast.success("Employee added and private init completed.");
      } else if (employee.privateRecipientInitStatus === "failed") {
        toast.warning(
          employee.privateRecipientInitError
            ? `Employee added, but private init failed: ${employee.privateRecipientInitError}. Ask the employee to open Claim > Withdraw and initialize their private account.`
            : "Employee added, but private init failed. Ask the employee to open Claim > Withdraw and initialize their private account.",
        );
      } else {
        toast.success(
          "Employee added. Auto-init is syncing; if it does not finish, the employee can self-initialize from Claim > Withdraw.",
        );
      }
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
              Employees
            </h1>
            <p className="text-sm text-[#8f8f95] mt-1">
              Manage your team and payroll settings
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button className="w-[42px] h-[42px] flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-colors">
              <Bell size={18} className="text-[#a8a8aa]" />
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 px-5 py-[11px] bg-[#1eba98] hover:bg-[#1eba98]/80 text-black text-xs font-bold rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
            >
              <Plus size={16} />
              Add Employee
            </button>
          </div>
        </div>

        {/* Stat Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Total Employees</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{employees.length}</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">{activeCount} active</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Monthly Payroll</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{formatCurrency(totalPayroll)}</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">All employees</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">Departments</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{uniqueDepartments}</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">Across the company</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">TEE Secured</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-white">{perReadyPercentage}%</p>
            <p className="mt-1 text-xs text-[#a8a8aa]">PER active streams</p>
          </div>
        </div>

        {/* Table Section */}
        <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl overflow-hidden shadow-sm">
          {/* Table Toolbar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-6 border-b border-white/5">
            <h2 className="text-lg font-bold text-white tracking-tight">All Employees</h2>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a8a8aa]" size={16} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search employees..."
                  className="pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#a8a8aa] focus:outline-none focus:border-[#1eba98] focus:ring-1 focus:ring-[#1eba98]/20 w-48 lg:w-56"
                />
              </div>

              <div className="relative">
                <select
                  value={filterDepartment}
                  onChange={(e) => setFilterDepartment(e.target.value)}
                  className="pl-4 pr-10 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none appearance-none cursor-pointer hover:bg-white/10 transition-colors"
                >
                  <option value="All Departments">All Departments</option>
                  {DEPARTMENT_OPTIONS.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#a8a8aa]">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                </div>
              </div>

              <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
                {(["All", "Active", "Inactive"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setFilterStatus(tab)}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${filterStatus === tab
                      ? "bg-white text-black shadow-sm"
                      : "text-[#a8a8aa] hover:text-white"
                      }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Table Headers */}
          {!loading && filtered.length > 0 && (
            <div className="grid grid-cols-[1.5fr_1fr_1fr_1.2fr_1fr_1fr_1fr] gap-4 items-center px-6 py-4 border-b border-white/5 bg-white/[0.02]">
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Employee</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Start Date</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Salary</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Accrued Live</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Privacy</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Status</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest text-right">Actions</div>
            </div>
          )}


          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center border-t border-white/5">
              <Loader2 size={24} className="text-[#1eba98] animate-spin mb-4" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">Syncing team data...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-24 flex flex-col items-center justify-center text-center px-6">
              <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-6">
                <Users size={24} className="text-[#a8a8aa]/40" />
              </div>
              <p className="text-base font-bold text-white tracking-tight">No employees found</p>
              <p className="text-xs text-[#a8a8aa] mt-1 max-w-[240px] leading-relaxed">
                Try adjusting your search or filters
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {filtered.map((emp) => {
                const stream = getStream(emp.id) ?? null;
                const preview = stream ? (privateStates[stream.id] ?? null) : null;
                const hasFreshPreview = isFreshPrivatePreview(preview, now);
                const hasFreshCheckpointProgress = isCheckpointProgressFresh(
                  stream,
                  preview,
                  now,
                );
                const hasMissingPrivateState = !!(stream && missingPrivateStates[stream.id]);
                const status = resolveEffectiveStatus(stream, preview);
                const hasFutureStart = Boolean(
                  stream?.startsAt && new Date(stream.startsAt).getTime() > now,
                );
                const perReady = isPerReady(stream);
                const isStreamingLive =
                  Boolean(stream) &&
                  status === "active" &&
                  perReady &&
                  !hasFutureStart &&
                  !hasMissingPrivateState &&
                  hasFreshPreview &&
                  hasFreshCheckpointProgress;
                const statusLabel =
                  isStreamingLive
                    ? "Streaming"
                    : hasMissingPrivateState
                      ? "State missing"
                      : stream?.checkpointCrankStatus === "active" && hasFreshPreview
                        ? "Checkpoint stale"
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
                    : hasMissingPrivateState
                      ? "bg-rose-500/15 text-rose-300 border-rose-400/30"
                      : stream?.checkpointCrankStatus === "active" && hasFreshPreview
                        ? "bg-amber-500/15 text-amber-300 border-amber-400/30"
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
                    className="grid grid-cols-[1.5fr_1fr_1fr_1.2fr_1fr_1fr_1fr] gap-4 items-center px-6 py-5 hover:bg-white/5 transition-all duration-200"
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
                      </div>
                    </div>

                    {/* Start Date */}
                    <div className="flex items-center gap-1.5 text-sm text-[#b6b6bc] whitespace-nowrap">
                      <Calendar size={12} className="text-[#8f8f95] shrink-0" />
                      {new Date(emp.startDate ?? emp.createdAt).toLocaleDateString(
                        "en-US",
                        {
                          month: "2-digit",
                          day: "2-digit",
                          year: "2-digit",
                        },
                      )}
                    </div>

                    {/* Salary */}
                    <div className="min-w-0">
                      {emp.monthlySalaryUsd ? (
                        <div>
                          <div className="flex items-center gap-1">
                            <span className="text-sm font-semibold text-white truncate">
                              {formatCurrency(emp.monthlySalaryUsd)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-sm text-[#8f8f95]">—</span>
                      )}
                    </div>

                    {/* Accrued Live */}
                    <div className="flex items-center gap-1.5 whitespace-nowrap min-w-0">
                      {stream && isStreamingLive ? (
                        <>
                          <span className="relative flex h-2 w-2 mr-1">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                          </span>
                          <span className="text-sm font-semibold text-emerald-700 font-mono tabular-nums">
                            {getLiveAccrued(preview)?.toFixed(6) ?? "—"}
                          </span>
                        </>
                      ) : (
                        <>
                          <TrendingUp size={12} className="text-[#8f8f95]" />
                          <span className={status === "active" ? "font-bold text-amber-300" : "text-[#b6b6bc]"}>
                            {stream?.checkpointCrankStatus === "active" && hasFreshPreview
                              ? "Checkpoint stale"
                              : status === "active"
                                ? "Needs sync"
                                : "—"}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Private */}
                    <div>
                      {(() => {
                        const readiness = getPrivateReadinessState(
                          emp,
                          stream,
                          hasMissingPrivateState,
                        );
                        return (
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border ${readiness.className}`}
                          >
                            {readiness.label}
                          </span>
                        );
                      })()}
                      {emp.privateRecipientInitStatus === "failed" ? (
                        <p className="mt-1 text-[10px] text-rose-300">
                          {emp.privateRecipientInitError
                            ? `${emp.privateRecipientInitError} Ask the employee to open Claim > Withdraw and initialize.`
                            : "Auto-init failed. Ask the employee to open Claim > Withdraw and initialize."}
                        </p>
                      ) : emp.privateRecipientInitStatus === "pending" ||
                        emp.privateRecipientInitStatus === "processing" ? (
                        <p className="mt-1 text-[10px] text-[#8f8f95]">
                          Employee can finish setup later from Claim &gt; Withdraw if needed.
                        </p>
                      ) : null}
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
                            {stream?.checkpointCrankStatus === "active" && hasFreshPreview
                              ? "Checkpoint stale"
                              : "Needs sync"}
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
                  <div className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/50 cursor-not-allowed">
                    Private stream (ephemeral)
                  </div>
                  <p className="text-[11px] text-[#8f8f95] mt-2">
                    {payoutModeSummary(newPayoutMode)}
                  </p>
                </div>
              </div>
              <div>
                <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                  Stream starts at
                </label>
                <div className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/50 cursor-not-allowed">
                  Immediately upon onboarding
                </div>
              </div>
            </div>

            <button
              onClick={handleAdd}
              disabled={
                adding ||
                !newName.trim() ||
                !newWallet.trim() ||
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
