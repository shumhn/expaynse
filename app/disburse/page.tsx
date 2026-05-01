"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { useSearchParams } from "next/navigation";

import { toast } from "sonner";
import {
  checkHealth,
  fetchTeeAuthToken,
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
import {
  Plus,
  Loader2,
  Wallet,
  ChevronLeft,
  Pause,
  PlayCircle,
  ShieldCheck,
  RefreshCw,
  Sparkles,
  Zap,
  Save,
  Square,
  Users,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  CalendarDays,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { EmployerLayout } from "@/components/employer-layout";
import {
  getAccruedInCycle,
  getScheduleCycleSnapshot,
  monthlyUsdToRatePerSecond,
  ratePerSecondToMonthlyUsd,
  type PaySchedule,
} from "@/lib/payroll-math";
import {
  DEFAULT_PAYROLL_PAYOUT_MODE,
  allowedPayoutModesFor,
  payoutModeSummary,
  type PayrollPayoutMode,
} from "@/lib/payroll-payout-mode";
interface ManagedEmployee {
  id: string;
  employerWallet: string;
  wallet: string;
  name: string;
  notes?: string;
  department?: string;
  role?: string;
  employmentType?: "full_time" | "part_time" | "contract";
  paySchedule?: PaySchedule;
  compensationUnit?: "monthly" | "weekly" | "hourly";
  compensationAmountUsd?: number;
  monthlySalaryUsd?: number;
  startDate?: string | null;
  privateRecipientInitializedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

type StreamStatus = "active" | "paused" | "stopped";

interface PayrollStream {
  id: string;
  employerWallet: string;
  employeeId: string;
  ratePerSecond: number;
  startsAt?: string | null;
  payoutMode?: PayrollPayoutMode;
  allowedPayoutModes?: PayrollPayoutMode[];
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  delegatedAt?: string | null;
  recipientPrivateInitializedAt?: string | null;
  checkpointCrankTaskId?: string | null;
  checkpointCrankSignature?: string | null;
  checkpointCrankStatus?: "idle" | "pending" | "active" | "failed" | "stopped";
  checkpointCrankUpdatedAt?: string | null;
  lastPaidAt: string | null;
  totalPaid: number;
  status: StreamStatus;
  createdAt: string;
  updatedAt: string;
}

interface PrivatePayrollStateResponse {
  employerWallet: string;
  streamId: string;
  employee: {
    id: string;
    wallet: string;
    name: string;
  };
  stream: {
    id: string;
    status: StreamStatus;
    ratePerSecond: number;
    employeePda: string | null;
    privatePayrollPda: string | null;
    permissionPda: string | null;
    delegatedAt: string | null;
    lastPaidAt: string | null;
    totalPaid: number;
  };
  state: {
    employeePda: string;
    privatePayrollPda: string;
    employee: string;
    streamId: string;
    status: StreamStatus;
    version: string;
    lastCheckpointTs: string;
    ratePerSecondMicro: string;
    lastAccrualTimestamp: string;
    accruedUnpaidMicro: string;
    totalPaidPrivateMicro: string;
    effectiveClaimableAmountMicro: string;
    monthlyCapUsd: number | null;
    monthlyCapMicro: string | null;
    cycleKey: string | null;
    cycleStart: string | null;
    cycleEnd: string | null;
    paidThisCycleMicro: string | null;
    remainingCapMicro: string | null;
    capReached: boolean;
  };
  syncedAt: string;
}

interface OnboardTransactionsResponse {
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  alreadyOnboarded?: boolean;
  transactions: {
    baseSetup?: {
      transactionBase64: string;
      sendTo: "base";
    };
    initializePrivatePayroll?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
}

interface TickBuildResult {
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  cashoutRequestId?: string;
  requestedAmountMicro?: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  transferFromBalance?: "base" | "ephemeral";
  transferToBalance?: "base" | "ephemeral";
  skipped: boolean;
  reason?: string;
  elapsedSeconds?: number;
  amountMicro?: number;
  employeePda?: string;
  privatePayrollPda?: string;
  transactions?: {
    transfer?: {
      transactionBase64: string;
      sendTo: string;
    };
    settleSalary?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    commitEmployee?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
}

interface TickBuildResponse {
  employerWallet: string;
  processed: number;
  message?: string;
  results: TickBuildResult[];
}

type StreamControlAction = "update-rate" | "pause" | "resume" | "stop";

interface StreamControlBuildResponse {
  employerWallet: string;
  streamId: string;
  action: StreamControlAction;
  employeePda: string;
  privatePayrollPda: string;
  nextStatus: StreamStatus;
  transactions: {
    control: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    commitEmployee: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
}

interface CheckpointCrankBuildResponse {
  employerWallet: string;
  streamId: string;
  mode: "schedule" | "cancel";
  taskId: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  transactions: {
    checkpointCrank: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
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
  Design: [
    "Product Designer",
    "UX Designer",
    "UI Designer",
    "Design Lead",
  ],
  Sales: ["Sales Executive", "Account Executive", "Sales Manager"],
  Marketing: ["Marketing Manager", "Growth Manager", "Content Specialist"],
  Operations: ["Operations Manager", "Program Manager", "Office Manager"],
  Finance: ["Finance Manager", "Accountant", "Payroll Specialist"],
  HR: ["HR Manager", "People Operations", "Talent Acquisition"],
  Legal: ["Legal Counsel", "Compliance Officer", "Legal Operations"],
  Support: ["Support Specialist", "Customer Success", "Support Lead"],
};

interface RestartStreamBuildResponse {
  employerWallet: string;
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  status: "ready" | "already-reset";
  actualAccruedUnpaidMicro: string;
  actualTotalPaidPrivateMicro: string;
  message?: string;
  stream?: PayrollStream;
  transactions: {
    closePrivatePayroll?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    undelegateEmployee?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    closeEmployee?: {
      transactionBase64: string;
      sendTo: "base";
    };
  };
}

type MagicBlockHealthState = "checking" | "ok" | "error";

type CashoutRequestStatus = "pending" | "fulfilled" | "dismissed" | "cancelled";

interface CashoutRequestRecord {
  id: string;
  employerWallet: string;
  employeeId: string;
  employeeWallet: string;
  streamId: string;
  requestedAmount: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  note?: string;
  status: CashoutRequestStatus;
  resolvedAt?: string | null;
  resolvedByWallet?: string | null;
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

const STREAM_STATUS_PRIORITY: Record<StreamStatus, number> = {
  active: 3,
  paused: 2,
  stopped: 1,
};

type DataSourceBadge = "live-per" | "backend" | "unavailable";

function sourceBadgeMeta(source: DataSourceBadge) {
  if (source === "live-per") {
    return {
      label: "Live PER",
      className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    };
  }
  if (source === "backend") {
    return {
      label: "Backend",
      className: "bg-blue-500/10 text-blue-300 border-blue-500/30",
    };
  }
  return {
    label: "Unavailable",
    className: "bg-[#111111] text-[#a8a8aa] border-white/10",
  };
}

function getEffectiveStreamStatus(
  stream: PayrollStream | null | undefined,
  preview?: PrivatePayrollStateResponse | null,
): StreamStatus | null {
  return preview?.state.status ?? preview?.stream.status ?? stream?.status ?? null;
}

function isMissingPrivateStateMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("private payroll state not found") ||
    normalized.includes("private payroll state account is not initialized") ||
    normalized.includes("private state expired")
  );
}

function EmployerPageContent() {
  const searchParams = useSearchParams();
  const { publicKey, connected, signTransaction, signMessage } = useWallet();
  const [managedEmployees, setManagedEmployees] = useState<ManagedEmployee[]>(
    [],
  );
  const [streams, setStreams] = useState<PayrollStream[]>([]);
  const [loadingPayrollConfig, setLoadingPayrollConfig] = useState(false);
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [savingStream, setSavingStream] = useState<string | null>(null);
  const [applyingRateStream, setApplyingRateStream] = useState<string | null>(
    null,
  );
  const [controllingStream, setControllingStream] = useState<string | null>(
    null,
  );
  const [onboardingStream, setOnboardingStream] = useState<string | null>(null);
  const [restartingStream, setRestartingStream] = useState<string | null>(null);
  const [refreshingPreview, setRefreshingPreview] = useState<string | null>(
    null,
  );
  const [runningTick, setRunningTick] = useState(false);
  const [runningTickStream, setRunningTickStream] = useState<string | null>(
    null,
  );
  const [settlingTickStream, setSettlingTickStream] = useState<string | null>(
    null,
  );
  const [privateStates, setPrivateStates] = useState<
    Record<string, PrivatePayrollStateResponse>
  >({});
  const [missingPrivateStates, setMissingPrivateStates] = useState<
    Record<string, boolean>
  >({});
  const [newEmployeeName, setNewEmployeeName] = useState("");
  const [newEmployeeWallet, setNewEmployeeWallet] = useState("");
  const [newEmployeeDepartment, setNewEmployeeDepartment] = useState<
    (typeof DEPARTMENT_OPTIONS)[number]
  >(DEPARTMENT_OPTIONS[0]);
  const [newEmployeeRole, setNewEmployeeRole] = useState(
    ROLE_OPTIONS_BY_DEPARTMENT[DEPARTMENT_OPTIONS[0]][0],
  );
  const [newEmployeeNotes, setNewEmployeeNotes] = useState("");
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [monthlySalaryInputs, setMonthlySalaryInputs] = useState<
    Record<string, string>
  >({});
  const [tickAmountInputs, setTickAmountInputs] = useState<
    Record<string, string>
  >({});
  const [cashoutRequests, setCashoutRequests] = useState<CashoutRequestRecord[]>(
    [],
  );
  const [loadingCashoutRequests, setLoadingCashoutRequests] = useState(false);
  const [resolvingCashoutRequestId, setResolvingCashoutRequestId] = useState<
    string | null
  >(null);
  const [magicBlockHealth, setMagicBlockHealth] =
    useState<MagicBlockHealthState>("checking");
  const [nowMs, setNowMs] = useState(Date.now());
  const tokenCache = useRef<string | null>(null);
  const walletAddress = publicKey?.toBase58() ?? "";
  const focusedEmployeeId = searchParams?.get("employee")?.trim() || null;
  const cycleInfo = useMemo(
    () => getScheduleCycleSnapshot("monthly", new Date(nowMs)),
    [nowMs],
  );
  const [treasuryPrivateBalance, setTreasuryPrivateBalance] = useState<
    number | null
  >(null);
  const [refreshingTreasuryBalance, setRefreshingTreasuryBalance] =
    useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const employeeStreamMap = useMemo(() => {
    const map = new Map<string, PayrollStream>();
    for (const stream of streams) {
      const existing = map.get(stream.employeeId);
      if (!existing) {
        map.set(stream.employeeId, stream);
        continue;
      }

      const existingStatus = getEffectiveStreamStatus(
        existing,
        privateStates[existing.id],
      );
      const nextStatus = getEffectiveStreamStatus(
        stream,
        privateStates[stream.id],
      );

      const existingPriority = existingStatus
        ? STREAM_STATUS_PRIORITY[existingStatus]
        : 0;
      const nextPriority = nextStatus ? STREAM_STATUS_PRIORITY[nextStatus] : 0;

      if (nextPriority > existingPriority) {
        map.set(stream.employeeId, stream);
        continue;
      }

      if (
        nextPriority === existingPriority &&
        new Date(stream.updatedAt).getTime() >
        new Date(existing.updatedAt).getTime()
      ) {
        map.set(stream.employeeId, stream);
      }
    }
    return map;
  }, [streams, privateStates]);

  const cashoutRequestsByStream = useMemo(() => {
    const grouped = new Map<string, CashoutRequestRecord[]>();
    for (const request of cashoutRequests) {
      const existing = grouped.get(request.streamId) ?? [];
      existing.push(request);
      grouped.set(request.streamId, existing);
    }
    return grouped;
  }, [cashoutRequests]);

  const focusedEmployee = useMemo(
    () =>
      focusedEmployeeId
        ? managedEmployees.find((employee) => employee.id === focusedEmployeeId) ?? null
        : null,
    [managedEmployees, focusedEmployeeId],
  );

  const resolveStatusWithMissing = useCallback(
    (
      stream: PayrollStream | null | undefined,
      preview?: PrivatePayrollStateResponse | null,
    ): StreamStatus | null => {
      if (!stream) return null;
      if (missingPrivateStates[stream.id]) return "stopped";
      return getEffectiveStreamStatus(stream, preview);
    },
    [missingPrivateStates],
  );

  const salaryAllocationRows = useMemo(() => {
    return managedEmployees.map((employee) => {
      const stream = employeeStreamMap.get(employee.id) ?? null;
      const preview = stream ? (privateStates[stream.id] ?? null) : null;
      const status = resolveStatusWithMissing(stream, preview) ?? "paused";
      const ratePerSecond = stream?.ratePerSecond ?? 0;
      const employeeCycle = getScheduleCycleSnapshot(
        employee.paySchedule,
        new Date(nowMs),
      );
      const monthlySalary = ratePerSecondToMonthlyUsd(ratePerSecond);
      const cycleTarget =
        ratePerSecond > 0 ? ratePerSecond * employeeCycle.totalSeconds : 0;
      const streamedSoFar = Math.min(
        Math.max(cycleTarget, 0),
        getAccruedInCycle({
          ratePerSecond,
          cycleStart: employeeCycle.start,
          cycleTotalSeconds: employeeCycle.totalSeconds,
          nowMs,
          startsAt: stream?.startsAt ?? employee.startDate ?? null,
        }),
      );
      const claimableNow = preview
        ? Number(preview.state.effectiveClaimableAmountMicro) / 1_000_000
        : null;
      const remainingThisCycle = Math.max(cycleTarget - streamedSoFar, 0);
      const perStatus = status === "active" ? "active" : status === "paused" ? "paused" : "stopped";

      return {
        employee,
        cycleLabel: employeeCycle.label,
        status: perStatus,
        ratePerSecond,
        monthlySalary,
        cycleTarget,
        streamedSoFar,
        claimableNow,
        remainingThisCycle,
      };
    });
  }, [
    managedEmployees,
    employeeStreamMap,
    privateStates,
    resolveStatusWithMissing,
    nowMs,
  ]);

  const visibleSalaryAllocationRows = useMemo(
    () =>
      focusedEmployeeId
        ? salaryAllocationRows.filter((row) => row.employee.id === focusedEmployeeId)
        : salaryAllocationRows,
    [salaryAllocationRows, focusedEmployeeId],
  );

  const visibleManagedEmployees = useMemo(
    () =>
      focusedEmployeeId
        ? managedEmployees.filter((employee) => employee.id === focusedEmployeeId)
        : managedEmployees,
    [managedEmployees, focusedEmployeeId],
  );

  const monthlyLiability = useMemo(
    () =>
      visibleSalaryAllocationRows.reduce(
        (sum, row) => sum + (Number.isFinite(row.monthlySalary) ? row.monthlySalary : 0),
        0,
      ),
    [visibleSalaryAllocationRows],
  );

  const activeDailyBurn = useMemo(
    () =>
      visibleSalaryAllocationRows.reduce(
        (sum, row) =>
          row.status === "active" ? sum + row.ratePerSecond * 86_400 : sum,
        0,
      ),
    [visibleSalaryAllocationRows],
  );

  const treasuryRunwayDays = useMemo(() => {
    if (treasuryPrivateBalance === null || activeDailyBurn <= 0) {
      return null;
    }
    return treasuryPrivateBalance / activeDailyBurn;
  }, [treasuryPrivateBalance, activeDailyBurn]);

  const readinessSummary = useMemo(() => {
    let perMissing = 0;
    let recipientMissing = 0;
    let paused = 0;

    for (const employee of visibleManagedEmployees) {
      const stream = employeeStreamMap.get(employee.id) ?? null;
      const preview = stream ? (privateStates[stream.id] ?? null) : null;
      const status = resolveStatusWithMissing(stream, preview);

      if (!stream?.employeePda || !stream?.privatePayrollPda || !stream?.permissionPda) {
        perMissing += 1;
      }

      if (!stream?.recipientPrivateInitializedAt && !employee.privateRecipientInitializedAt) {
        recipientMissing += 1;
      }

      if (status === "paused") {
        paused += 1;
      }
    }

    return {
      perMissing,
      recipientMissing,
      paused,
    };
  }, [visibleManagedEmployees, employeeStreamMap, privateStates, resolveStatusWithMissing]);

  const formatMicroUsdc = useCallback((value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "0.000000";
    return (parsed / 1_000_000).toFixed(6);
  }, []);

  const formatUnixTimestamp = useCallback((value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return "—";
    return new Date(parsed * 1000).toLocaleTimeString();
  }, []);

  const formatUsd = useCallback((value: number, digits = 2) => {
    const normalized = Number.isFinite(value) ? value : 0;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(normalized);
  }, []);

  const renderSourceBadge = useCallback((source: DataSourceBadge) => {
    const meta = sourceBadgeMeta(source);
    return (
      <span
        className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${meta.className}`}
      >
        {meta.label}
      </span>
    );
  }, []);

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
  }, [publicKey]);

  useEffect(() => {
    void refreshMagicBlockHealth();
  }, [refreshMagicBlockHealth]);

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
        toast.info("Please sign the message to access PER private payroll state");
        return fetchTeeAuthToken(publicKey, signMessage);
      },
    );
    tokenCache.current = token;
    return token;
  }, [publicKey, signMessage]);

  const getTeeRpcUrl = useCallback(
    (teeAuthToken: string) =>
      `https://devnet-tee.magicblock.app?token=${encodeURIComponent(teeAuthToken)}`,
    [],
  );

  const refreshTreasuryPrivateBalance = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!walletAddress) {
        setTreasuryPrivateBalance(null);
        return;
      }

      if (!options?.silent) {
        setRefreshingTreasuryBalance(true);
      }

      try {
        const token = await getOrFetchToken();
        const res = (await getPrivateBalance(
          walletAddress,
          token,
        )) as BalanceResponse;

        if (res.location !== "ephemeral") {
          throw new Error(
            `Expected treasury from ephemeral location, received ${res.location}`,
          );
        }

        const raw = Number.parseInt(res.balance ?? "0", 10);
        const normalized = Number.isFinite(raw) ? raw / 1_000_000 : 0;
        setTreasuryPrivateBalance(normalized);
      } catch (err: unknown) {
        setTreasuryPrivateBalance(null);
        if (!options?.silent) {
          toast.error(
            `Treasury sync failed: ${err instanceof Error ? err.message : "Unknown"}`,
          );
        }
      } finally {
        if (!options?.silent) {
          setRefreshingTreasuryBalance(false);
        }
      }
    },
    [walletAddress, getOrFetchToken],
  );

  const waitForEmployeeOwnership = useCallback(async (employeePda: string) => {
    const payrollProgramId = new PublicKey(
      "EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR",
    );
    const employeeAddress = new PublicKey(employeePda);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const attempts = 12;
    const delayMs = 1500;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accountInfo = await connection.getAccountInfo(
        employeeAddress,
        "confirmed",
      );

      if (accountInfo?.owner?.equals(payrollProgramId)) {
        return;
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(
      "Employee account is still delegated on base. Wait a moment and retry restart.",
    );
  }, []);

  const fetchPrivatePreview = useCallback(
    async (
      stream: PayrollStream,
      options?: { silent?: boolean },
    ): Promise<PrivatePayrollStateResponse | "missing" | null> => {
      const silent = options?.silent === true;

      if (!walletAddress) {
        return null;
      }

      if (!stream.privatePayrollPda) {
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
        return null;
      }

      if (!silent) {
        setRefreshingPreview(stream.id);
      }

      try {
        const token = await getOrFetchToken();
        const response = await fetch(
          `/api/payroll/state?employerWallet=${walletAddress}&streamId=${stream.id}`,
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
          throw new Error(
            "error" in json
              ? json.error || "Failed to load exact PER payroll state"
              : "Failed to load exact PER payroll state",
          );
        }

        const stateResponse = json as PrivatePayrollStateResponse;

        setPrivateStates((prev) => ({
          ...prev,
          [stream.id]: stateResponse,
        }));
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
                status: stateResponse.stream.status,
                employeePda:
                  stateResponse.stream.employeePda ?? existing.employeePda,
                privatePayrollPda:
                  stateResponse.stream.privatePayrollPda ??
                  existing.privatePayrollPda,
                permissionPda:
                  stateResponse.stream.permissionPda ??
                  existing.permissionPda,
                delegatedAt:
                  stateResponse.stream.delegatedAt ?? existing.delegatedAt,
                lastPaidAt: stateResponse.stream.lastPaidAt,
                totalPaid: stateResponse.stream.totalPaid,
              }
              : existing,
          ),
        );
        return stateResponse;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown";
        const missingPrivateState = isMissingPrivateStateMessage(message);

        if (missingPrivateState) {
          setPrivateStates((prev) => {
            const next = { ...prev };
            delete next[stream.id];
            return next;
          });
          setMissingPrivateStates((prev) => ({
            ...prev,
            [stream.id]: true,
          }));
          setStreams((prev) =>
            prev.map((existing) =>
              existing.id === stream.id ? { ...existing, status: "stopped" } : existing,
            ),
          );

          if (!silent) {
            if (stream.status === "stopped") {
              toast.info(
                "This stopped stream no longer has a private payroll state in PER. Restart can proceed now.",
              );
            } else {
              toast.info(
                "PER state is missing for this stream (not initialized, cleaned up, or replaced).",
              );
            }
          }

          return "missing";
        }

        if (!silent) {
          toast.error(
            `TEE state load failed: ${message}`,
          );
        }
        return null;
      } finally {
        if (!silent) {
          setRefreshingPreview((current) =>
            current === stream.id ? null : current,
          );
        }
      }
    },
    [walletAddress, getOrFetchToken],
  );

  const fetchPayrollConfig = useCallback(async () => {
    if (!walletAddress) {
      setManagedEmployees([]);
      setStreams([]);
      return;
    }

    setLoadingPayrollConfig(true);
    try {
      if (!signMessage) {
        throw new Error(
          "Wallet message signing is required to load payroll configuration",
        );
      }

      const [employeesRes, streamsRes] = await Promise.all([
        walletAuthenticatedFetch({
          wallet: walletAddress,
          signMessage,
          path: `/api/employees?employerWallet=${walletAddress}`,
        }),
        walletAuthenticatedFetch({
          wallet: walletAddress,
          signMessage,
          path: `/api/streams?employerWallet=${walletAddress}`,
        }),
      ]);

      const employeesJson = (await employeesRes.json()) as {
        employees?: ManagedEmployee[];
        error?: string;
      };
      const streamsJson = (await streamsRes.json()) as {
        streams?: PayrollStream[];
        error?: string;
      };

      if (!employeesRes.ok) {
        throw new Error(employeesJson.error || "Failed to load employees");
      }

      if (!streamsRes.ok) {
        throw new Error(streamsJson.error || "Failed to load payroll streams");
      }

      const nextEmployees = employeesJson.employees ?? [];
      const nextStreams = streamsJson.streams ?? [];

      setManagedEmployees(nextEmployees);
      setStreams(nextStreams);
      setRateInputs((prev) => {
        const next = { ...prev };
        for (const employee of nextEmployees) {
          const existingStream =
            [...nextStreams]
              .reverse()
              .find((stream) => stream.employeeId === employee.id) ?? null;
          if (!next[employee.id] && existingStream) {
            next[employee.id] = existingStream.ratePerSecond.toString();
          }
        }
        return next;
      });
      setMonthlySalaryInputs((prev) => {
        const next = { ...prev };
        for (const employee of nextEmployees) {
          const existingStream =
            [...nextStreams]
              .reverse()
              .find((stream) => stream.employeeId === employee.id) ?? null;
          if (!next[employee.id] && existingStream) {
            const monthly = ratePerSecondToMonthlyUsd(existingStream.ratePerSecond);
            next[employee.id] = monthly.toFixed(2);
          }
        }
        return next;
      });

      setPrivateStates((prev) => {
        const next = { ...prev };
        const validIds = new Set(nextStreams.map((stream) => stream.id));
        for (const key of Object.keys(next)) {
          if (!validIds.has(key)) {
            delete next[key];
          }
        }
        return next;
      });
      setMissingPrivateStates((prev) => {
        const next = { ...prev };
        const validIds = new Set(nextStreams.map((stream) => stream.id));
        for (const key of Object.keys(next)) {
          if (!validIds.has(key)) {
            delete next[key];
          }
        }
        return next;
      });

      if (tokenCache.current && !isJwtExpired(tokenCache.current)) {
        await Promise.all(
          nextStreams
            .filter((stream) => !!stream.privatePayrollPda)
            .map(async (stream) => {
              try {
                const response = await fetch(
                  `/api/payroll/state?employerWallet=${walletAddress}&streamId=${stream.id}`,
                  {
                    headers: {
                      Authorization: `Bearer ${tokenCache.current}`,
                    },
                  },
                );
                const json = (await response.json()) as
                  | PrivatePayrollStateResponse
                  | { error?: string };

                if (!response.ok) {
                  const message =
                    "error" in json
                      ? json.error || "Failed to load exact PER payroll state"
                      : "Failed to load exact PER payroll state";
                  const missingPrivateState =
                    response.status === 404 || isMissingPrivateStateMessage(message);

                  if (missingPrivateState) {
                    setPrivateStates((prev) => {
                      const next = { ...prev };
                      delete next[stream.id];
                      return next;
                    });
                    setMissingPrivateStates((prev) => ({
                      ...prev,
                      [stream.id]: true,
                    }));
                    setStreams((prev) =>
                      prev.map((existing) =>
                        existing.id === stream.id
                          ? { ...existing, status: "stopped" }
                          : existing,
                      ),
                    );
                  }
                  return;
                }

                const stateResponse = json as PrivatePayrollStateResponse;

                setPrivateStates((prev) => ({
                  ...prev,
                  [stream.id]: stateResponse,
                }));
                setStreams((prev) =>
                  prev.map((existing) =>
                    existing.id === stream.id
                      ? {
                        ...existing,
                        status: stateResponse.stream.status,
                        employeePda:
                          stateResponse.stream.employeePda ??
                          existing.employeePda,
                        privatePayrollPda:
                          stateResponse.stream.privatePayrollPda ??
                          existing.privatePayrollPda,
                        permissionPda:
                          stateResponse.stream.permissionPda ??
                          existing.permissionPda,
                        delegatedAt:
                          stateResponse.stream.delegatedAt ??
                          existing.delegatedAt,
                        lastPaidAt: stateResponse.stream.lastPaidAt,
                        totalPaid: stateResponse.stream.totalPaid,
                      }
                      : existing,
                  ),
                );
              } catch {
                // Preview is best-effort during dashboard refresh
              }
            }),
        );
      }
    } catch (err: unknown) {
      toast.error(
        `Payroll config failed: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    } finally {
      setLoadingPayrollConfig(false);
    }
  }, [walletAddress, signMessage]);

  const fetchCashoutRequests = useCallback(async () => {
    if (!walletAddress) {
      setCashoutRequests([]);
      return;
    }

    if (!signMessage) {
      return;
    }

    setLoadingCashoutRequests(true);
    try {
      const response = await walletAuthenticatedFetch({
        wallet: walletAddress,
        signMessage,
        path: `/api/cashout-requests?scope=employer&employerWallet=${walletAddress}`,
      });

      const json = (await response.json()) as {
        requests?: CashoutRequestRecord[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(json.error || "Failed to load cashout requests");
      }

      setCashoutRequests(json.requests ?? []);
    } catch (err: unknown) {
      toast.error(
        `Cashout requests failed: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    } finally {
      setLoadingCashoutRequests(false);
    }
  }, [walletAddress, signMessage]);

  useEffect(() => {
    fetchPayrollConfig();
  }, [fetchPayrollConfig]);

  useEffect(() => {
    void fetchCashoutRequests();
  }, [fetchCashoutRequests]);

  useEffect(() => {
    if (!walletAddress) {
      setTreasuryPrivateBalance(null);
      return;
    }

    void refreshTreasuryPrivateBalance({ silent: true });
  }, [walletAddress, refreshTreasuryPrivateBalance]);

  useEffect(() => {
    if (!walletAddress) {
      return;
    }

    const hasValidToken =
      !!tokenCache.current && !isJwtExpired(tokenCache.current);
    if (!hasValidToken) {
      return;
    }

    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      const tokenStillValid =
        !!tokenCache.current && !isJwtExpired(tokenCache.current);
      if (!tokenStillValid) {
        return;
      }

      void refreshTreasuryPrivateBalance({ silent: true });
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [walletAddress, refreshTreasuryPrivateBalance]);

  useEffect(() => {
    if (!walletAddress) {
      return;
    }

    const hasValidToken =
      !!tokenCache.current && !isJwtExpired(tokenCache.current);
    if (!hasValidToken) {
      return;
    }

    const activeStreams = streams.filter(
      (stream) =>
        getEffectiveStreamStatus(stream, privateStates[stream.id]) ===
        "active" &&
        !!stream.privatePayrollPda &&
        !!stream.employeePda &&
        !!stream.delegatedAt,
    );

    if (activeStreams.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      const tokenStillValid =
        !!tokenCache.current && !isJwtExpired(tokenCache.current);
      if (!tokenStillValid) {
        return;
      }

      for (const stream of activeStreams) {
        void fetchPrivatePreview(stream, { silent: true });
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [walletAddress, streams, privateStates, fetchPrivatePreview]);

  const handleAddManagedEmployee = useCallback(async () => {
    if (!walletAddress) {
      toast.error("Connect your wallet first");
      return;
    }

    if (newEmployeeName.trim() === "" || newEmployeeWallet.trim().length < 32) {
      toast.error("Enter a valid employee name and wallet");
      return;
    }

    setSavingEmployee(true);
    try {
      if (!signMessage) {
        throw new Error(
          "Wallet message signing is required to update payroll roster",
        );
      }

      const response = await walletAuthenticatedFetch({
        wallet: walletAddress,
        signMessage,
        path: "/api/employees",
        method: "POST",
        body: {
          employerWallet: walletAddress,
          wallet: newEmployeeWallet.trim(),
          name: newEmployeeName.trim(),
          department: newEmployeeDepartment.trim(),
          role: newEmployeeRole.trim(),
          notes: newEmployeeNotes.trim(),
        },
      });

      const json = (await response.json()) as {
        employee?: ManagedEmployee;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(json.error || "Failed to create employee");
      }

      toast.success("Employee added to payroll roster");
      setNewEmployeeName("");
      setNewEmployeeWallet("");
      setNewEmployeeDepartment(DEPARTMENT_OPTIONS[0]);
      setNewEmployeeRole(ROLE_OPTIONS_BY_DEPARTMENT[DEPARTMENT_OPTIONS[0]][0]);
      setNewEmployeeNotes("");
      await fetchPayrollConfig();
    } catch (err: unknown) {
      toast.error(
        `Create employee failed: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    } finally {
      setSavingEmployee(false);
    }
  }, [
    walletAddress,
    newEmployeeName,
    newEmployeeWallet,
    newEmployeeDepartment,
    newEmployeeRole,
    newEmployeeNotes,
    signMessage,
    fetchPayrollConfig,
  ]);

  const handleSaveDraftStream = useCallback(
    async (employee: ManagedEmployee, overrideRate?: number) => {
      if (!walletAddress) {
        toast.error("Connect your wallet first");
        return;
      }

      const currentRate =
        typeof overrideRate === "number"
          ? overrideRate
          : parseFloat(rateInputs[employee.id] || "0");
      if (!Number.isFinite(currentRate) || currentRate <= 0) {
        toast.error("Enter a valid rate per second");
        return;
      }

      setSavingStream(employee.id);
      try {
        const existingStream = employeeStreamMap.get(employee.id);
        if (!signMessage) {
          throw new Error(
            "Wallet message signing is required to update payroll streams",
          );
        }

        if (existingStream) {
          const response = await walletAuthenticatedFetch({
            wallet: walletAddress,
            signMessage,
            path: "/api/streams",
            method: "PATCH",
            body: {
              employerWallet: walletAddress,
              streamId: existingStream.id,
              ratePerSecond: currentRate,
            },
          });

          const json = (await response.json()) as {
            stream?: PayrollStream;
            error?: string;
          };

          if (!response.ok) {
            throw new Error(json.error || "Failed to update stream draft");
          }

          toast.success("Stream draft updated");
        } else {
          const response = await walletAuthenticatedFetch({
            wallet: walletAddress,
            signMessage,
            path: "/api/streams",
            method: "POST",
            body: {
              employerWallet: walletAddress,
              employeeId: employee.id,
              ratePerSecond: currentRate,
              status: "paused",
              payoutMode: DEFAULT_PAYROLL_PAYOUT_MODE,
              allowedPayoutModes: allowedPayoutModesFor(
                DEFAULT_PAYROLL_PAYOUT_MODE,
              ),
            },
          });

          const json = (await response.json()) as {
            stream?: PayrollStream;
            error?: string;
          };

          if (!response.ok) {
            throw new Error(json.error || "Failed to create payroll stream");
          }

          toast.success(
            "Realtime payroll draft created. Onboard PER, ask the employee to initialize their private account, then Resume to start accrual.",
          );
        }

        await fetchPayrollConfig();
        await fetchCashoutRequests();
      } catch (err: unknown) {
        toast.error(
          `Payroll stream failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      } finally {
        setSavingStream(null);
      }
    },
    [
      walletAddress,
      signMessage,
      rateInputs,
      employeeStreamMap,
      fetchPayrollConfig,
      fetchCashoutRequests,
    ],
  );

  const handleApplyMonthlySalary = useCallback(
    async (employee: ManagedEmployee) => {
      const monthly = Number.parseFloat(monthlySalaryInputs[employee.id] ?? "");
      if (!Number.isFinite(monthly) || monthly <= 0) {
        toast.error("Enter a valid monthly salary");
        return;
      }

      const ratePerSecond = monthlyUsdToRatePerSecond(monthly);
      setRateInputs((prev) => ({
        ...prev,
        [employee.id]: ratePerSecond.toFixed(8),
      }));
      await handleSaveDraftStream(employee, ratePerSecond);
    },
    [monthlySalaryInputs, handleSaveDraftStream],
  );

  const buildCheckpointCrankAndFinalize = useCallback(
    async (args: {
      employerWallet: string;
      streamId: string;
      teeAuthToken: string;
      mode: "schedule" | "cancel";
      executionIntervalMillis?: number;
      iterations?: number;
    }) => {
      if (!publicKey || !signTransaction || !signMessage) {
        throw new Error(
          "Connect a wallet that supports transaction signing and message signing",
        );
      }

      const buildResponse = await fetch("/api/streams/checkpoint-crank", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          employerWallet: args.employerWallet,
          streamId: args.streamId,
          teeAuthToken: args.teeAuthToken,
          mode: args.mode,
          executionIntervalMillis: args.executionIntervalMillis,
          iterations: args.iterations,
        }),
      });

      const buildJson = (await buildResponse.json()) as
        | CheckpointCrankBuildResponse
        | { error?: string };

      if (!buildResponse.ok) {
        throw new Error(
          "error" in buildJson
            ? buildJson.error || "Failed to build checkpoint crank transaction"
            : "Failed to build checkpoint crank transaction",
        );
      }

      const crankBuild = buildJson as CheckpointCrankBuildResponse;

      const signature = await signAndSend(
        crankBuild.transactions.checkpointCrank.transactionBase64,
        signTransaction,
        {
          sendTo: crankBuild.transactions.checkpointCrank.sendTo,
          rpcUrl: getTeeRpcUrl(args.teeAuthToken),
          signMessage,
          publicKey,
        },
      );

      const finalizeResponse = await fetch("/api/streams/checkpoint-crank", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          employerWallet: args.employerWallet,
          streamId: args.streamId,
          mode: args.mode,
          taskId: crankBuild.taskId,
          signature,
          status: args.mode === "schedule" ? "active" : "stopped",
        }),
      });

      const finalizeJson = (await finalizeResponse.json()) as {
        error?: string;
      };

      if (!finalizeResponse.ok) {
        throw new Error(
          finalizeJson.error ||
          "Failed to finalize checkpoint crank transaction",
        );
      }

      return {
        build: crankBuild,
        signature,
      };
    },
    [publicKey, signTransaction, signMessage, getTeeRpcUrl],
  );

  const handleResolveCashoutRequest = useCallback(
    async (
      request: CashoutRequestRecord,
      status: Extract<CashoutRequestStatus, "dismissed" | "fulfilled" | "cancelled">,
      resolutionNote?: string,
    ) => {
      if (!walletAddress || !signMessage) {
        toast.error("Connect a wallet that supports message signing");
        return;
      }

      setResolvingCashoutRequestId(request.id);
      try {
        const response = await walletAuthenticatedFetch({
          wallet: walletAddress,
          signMessage,
          path: "/api/cashout-requests",
          method: "PATCH",
          body: {
            employerWallet: walletAddress,
            requestId: request.id,
            status,
            resolutionNote,
          },
        });

        const json = (await response.json()) as {
          request?: CashoutRequestRecord;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(json.error || "Failed to resolve cashout request");
        }

        toast.success(
          status === "dismissed"
            ? "Cashout request dismissed"
            : "Cashout request updated",
        );
        await fetchCashoutRequests();
      } catch (err: unknown) {
        toast.error(
          `Cashout request update failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      } finally {
        setResolvingCashoutRequestId(null);
      }
    },
    [walletAddress, signMessage, fetchCashoutRequests],
  );

  const handleApplyRateUpdate = useCallback(
    async (stream: PayrollStream) => {
      if (!walletAddress || !publicKey || !signTransaction || !signMessage) {
        toast.error(
          "Connect a wallet that supports transaction signing and message signing",
        );
        return;
      }

      const employee = managedEmployees.find(
        (item) => item.id === stream.employeeId,
      );
      if (!employee) {
        toast.error("Employee record not found");
        return;
      }

      if (
        !stream.employeePda ||
        !stream.privatePayrollPda ||
        !stream.delegatedAt
      ) {
        toast.error(
          "Onboard this stream to PER before applying a private rate",
        );
        return;
      }

      const currentRate = parseFloat(rateInputs[employee.id] || "0");
      if (!Number.isFinite(currentRate) || currentRate <= 0) {
        toast.error("Enter a valid rate per second");
        return;
      }

      setApplyingRateStream(stream.id);
      try {
        const teeAuthToken = await getOrFetchToken();

        const response = await fetch("/api/streams/control", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            action: "update-rate",
            ratePerSecond: currentRate,
            teeAuthToken,
          }),
        });

        const json = (await response.json()) as
          | StreamControlBuildResponse
          | { error?: string };

        if (!response.ok) {
          throw new Error(
            "error" in json
              ? json.error || "Failed to build rate update transactions"
              : "Failed to build rate update transactions",
          );
        }

        const controlBuild = json as StreamControlBuildResponse;

        toast.info(
          "Approve 2 employer transactions to update the private rate",
        );

        const controlSignature = await signAndSend(
          controlBuild.transactions.control.transactionBase64,
          signTransaction,
          {
            sendTo: controlBuild.transactions.control.sendTo,
            rpcUrl: getTeeRpcUrl(teeAuthToken),
            signMessage,
            publicKey,
          },
        );

        const commitSignature = await signAndSend(
          controlBuild.transactions.commitEmployee.transactionBase64,
          signTransaction,
          {
            sendTo: controlBuild.transactions.commitEmployee.sendTo,
            rpcUrl: getTeeRpcUrl(teeAuthToken),
            signMessage,
            publicKey,
          },
        );

        const finalizeResponse = await fetch("/api/streams/control", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            action: "update-rate",
            ratePerSecond: currentRate,
            employeePda: controlBuild.employeePda,
            privatePayrollPda: controlBuild.privatePayrollPda,
            controlSignature,
            commitSignature,
          }),
        });

        const finalizeJson = (await finalizeResponse.json()) as {
          error?: string;
        };

        if (!finalizeResponse.ok) {
          throw new Error(
            finalizeJson.error || "Failed to finalize private rate update",
          );
        }

        toast.success("Private payroll rate updated with employer wallet");
        await fetchPayrollConfig();
        await fetchCashoutRequests();
        await fetchPrivatePreview({
          ...stream,
          ratePerSecond: currentRate,
        });
      } catch (err: unknown) {
        toast.error(
          `Rate update failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      } finally {
        setApplyingRateStream(null);
      }
    },
    [
      walletAddress,
      publicKey,
      signTransaction,
      signMessage,
      managedEmployees,
      rateInputs,
      getOrFetchToken,
      getTeeRpcUrl,
      fetchPayrollConfig,
      fetchCashoutRequests,
      fetchPrivatePreview,
    ],
  );

  const handleControlStream = useCallback(
    async (stream: PayrollStream, action: StreamControlAction) => {
      if (!walletAddress || !publicKey || !signTransaction || !signMessage) {
        toast.error(
          "Connect a wallet that supports transaction signing and message signing",
        );
        return;
      }

      const employee = managedEmployees.find(
        (item) => item.id === stream.employeeId,
      );
      if (!employee) {
        toast.error("Employee record not found");
        return;
      }

      if (
        !stream.employeePda ||
        !stream.privatePayrollPda ||
        !stream.delegatedAt
      ) {
        toast.error("Onboard this stream to PER before controlling it");
        return;
      }

      setControllingStream(stream.id);
      try {
        const teeAuthToken = await getOrFetchToken();
        const cachedPreview = privateStates[stream.id] ?? null;
        const isKnownMissing = !!missingPrivateStates[stream.id];
        let effectiveStatus = getEffectiveStreamStatus(stream, cachedPreview);

        if (isKnownMissing) {
          if (action === "stop") {
            setStreams((prev) =>
              prev.map((existing) =>
                existing.id === stream.id
                  ? {
                    ...existing,
                    status: "stopped",
                  }
                  : existing,
              ),
            );
            await fetchPayrollConfig();
            toast.info(
              "No private payroll state remains in PER for this stream. Marked as stopped locally.",
            );
            return;
          }

          toast.info(
            "Private payroll state is missing in PER. Restart/onboard this stream before resume or pause.",
          );
          return;
        }

        if (action === "stop") {
          const preStopPreview = await fetchPrivatePreview(stream, {
            silent: true,
          });
          if (preStopPreview === "missing") {
            setStreams((prev) =>
              prev.map((existing) =>
                existing.id === stream.id
                  ? {
                    ...existing,
                    status: "stopped",
                  }
                  : existing,
              ),
            );
            await fetchPayrollConfig();
            toast.info(
              "Private payroll state is already absent in PER. Nothing left to stop.",
            );
            return;
          }
          effectiveStatus = getEffectiveStreamStatus(stream, preStopPreview);
        }

        if (
          (action === "resume" && effectiveStatus !== "paused") ||
          (action === "pause" && effectiveStatus !== "active") ||
          (action === "stop" && effectiveStatus === "stopped")
        ) {
          const syncedPreview = await fetchPrivatePreview(stream, {
            silent: true,
          });
          effectiveStatus =
            getEffectiveStreamStatus(
              stream,
              syncedPreview === "missing" ? null : syncedPreview,
            ) ?? effectiveStatus;
        }

        if (action === "resume" && effectiveStatus !== "paused") {
          await fetchPayrollConfig();
          toast.info(
            "This stream is not paused in PER right now. The dashboard is syncing the live status first.",
          );
          return;
        }

        if (action === "pause" && effectiveStatus !== "active") {
          await fetchPayrollConfig();
          toast.info(
            "This stream is not active in PER right now. The dashboard is syncing the live status first.",
          );
          return;
        }

        if (action === "stop" && effectiveStatus === "stopped") {
          await fetchPayrollConfig();
          toast.info(
            "This stream is already stopped in PER. The dashboard is syncing the live status first.",
          );
          return;
        }

        const response = await fetch("/api/streams/control", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            action,
            teeAuthToken,
          }),
        });

        const json = (await response.json()) as
          | StreamControlBuildResponse
          | { error?: string };

        if (!response.ok) {
          throw new Error(
            "error" in json
              ? json.error || "Failed to build stream control transactions"
              : "Failed to build stream control transactions",
          );
        }

        const controlBuild = json as StreamControlBuildResponse;

        toast.info("Approve 2 employer transactions to control this stream");

        const controlSignature = await signAndSend(
          controlBuild.transactions.control.transactionBase64,
          signTransaction,
          {
            sendTo: controlBuild.transactions.control.sendTo,
            rpcUrl: getTeeRpcUrl(teeAuthToken),
            signMessage,
            publicKey,
          },
        );

        const commitSignature = await signAndSend(
          controlBuild.transactions.commitEmployee.transactionBase64,
          signTransaction,
          {
            sendTo: controlBuild.transactions.commitEmployee.sendTo,
            rpcUrl: getTeeRpcUrl(teeAuthToken),
            signMessage,
            publicKey,
          },
        );

        const finalizeResponse = await fetch("/api/streams/control", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            action,
            employeePda: controlBuild.employeePda,
            privatePayrollPda: controlBuild.privatePayrollPda,
            controlSignature,
            commitSignature,
          }),
        });

        const finalizeJson = (await finalizeResponse.json()) as {
          error?: string;
        };

        if (!finalizeResponse.ok) {
          throw new Error(
            finalizeJson.error || "Failed to finalize stream control",
          );
        }
        const nextStatus = controlBuild.nextStatus;

        setStreams((prev) =>
          prev.map((existing) =>
            existing.id === stream.id
              ? {
                ...existing,
                status: nextStatus,
              }
              : existing,
          ),
        );
        setPrivateStates((prev) => {
          const current = prev[stream.id];
          if (!current) {
            return prev;
          }

          return {
            ...prev,
            [stream.id]: {
              ...current,
              stream: {
                ...current.stream,
                status: nextStatus,
              },
              state: {
                ...current.state,
                status: nextStatus,
              },
              syncedAt: new Date().toISOString(),
            },
          };
        });

        toast.success(
          action === "pause"
            ? "Payroll stream paused with employer wallet"
            : action === "resume"
              ? "Payroll stream resumed with employer wallet"
              : "Payroll stream stopped with employer wallet",
        );
        setControllingStream(null);

        void (async () => {
          try {
            if (action === "resume") {
              await buildCheckpointCrankAndFinalize({
                employerWallet: walletAddress,
                streamId: stream.id,
                teeAuthToken,
                mode: "schedule",
                executionIntervalMillis: 1000,
                iterations: 999_999_999,
              });
            } else if (action === "pause" || action === "stop") {
              await buildCheckpointCrankAndFinalize({
                employerWallet: walletAddress,
                streamId: stream.id,
                teeAuthToken,
                mode: "cancel",
              });
            }
          } catch (backgroundError: unknown) {
            const message =
              backgroundError instanceof Error
                ? backgroundError.message
                : "Unknown checkpoint task error";
            toast.info(
              `Stream state changed, but background checkpoint sync still needs attention: ${message}`,
            );
          } finally {
            await Promise.allSettled([
              fetchPayrollConfig(),
              fetchCashoutRequests(),
              fetchPrivatePreview(
                {
                  ...stream,
                  status: nextStatus,
                },
                { silent: true },
              ),
            ]);
          }
        })();
        return;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown control error";

        if (
          action === "resume" &&
          (message.includes("0x1779") || message.includes("EmployeeNotPaused"))
        ) {
          await fetchPrivatePreview(stream);
          await fetchPayrollConfig();
          toast.info(
            "This stream is not paused on-chain. The dashboard is refreshing to sync the real status.",
          );
        } else if (
          action === "pause" &&
          (message.includes("0x1778") || message.includes("EmployeeNotActive"))
        ) {
          await fetchPrivatePreview(stream);
          await fetchPayrollConfig();
          toast.info(
            "This stream is not active on-chain. The dashboard is refreshing to sync the real status.",
          );
        } else if (
          action === "stop" &&
          (message.includes("0xbc4") ||
            message.includes("custom program error: 0xbc4") ||
            message.includes("already stopped") ||
            message.includes("not active"))
        ) {
          await fetchPrivatePreview(stream);
          await fetchPayrollConfig();
          toast.info(
            "Stop was rejected by current on-chain state. Synced latest stream status from PER.",
          );
        } else {
          toast.error(`Stream control failed: ${message}`);
        }
      } finally {
        setControllingStream(null);
      }
    },
    [
      walletAddress,
      publicKey,
      signTransaction,
      signMessage,
      managedEmployees,
      getOrFetchToken,
      getTeeRpcUrl,
      privateStates,
      fetchPayrollConfig,
      fetchCashoutRequests,
      fetchPrivatePreview,
      buildCheckpointCrankAndFinalize,
      missingPrivateStates,
    ],
  );

  const handleBatchResume = useCallback(async () => {
    const pausedStreams = streams.filter((stream) => {
      const preview = privateStates[stream.id] ?? null;
      const status = getEffectiveStreamStatus(stream, preview);
      return status === "paused";
    });

    if (pausedStreams.length === 0) {
      toast.info("No paused streams available to resume");
      return;
    }

    for (const stream of pausedStreams) {
      await handleControlStream(stream, "resume");
    }
  }, [streams, privateStates, handleControlStream]);

  const handleBatchPause = useCallback(async () => {
    const activeStreams = streams.filter((stream) => {
      const preview = privateStates[stream.id] ?? null;
      const status = getEffectiveStreamStatus(stream, preview);
      return status === "active";
    });

    if (activeStreams.length === 0) {
      toast.info("No active streams available to pause");
      return;
    }

    for (const stream of activeStreams) {
      await handleControlStream(stream, "pause");
    }
  }, [streams, privateStates, handleControlStream]);

  const handleRestartStoppedStream = useCallback(
    async (stream: PayrollStream) => {
      if (!walletAddress || !publicKey || !signTransaction || !signMessage) {
        toast.error(
          "Connect a wallet that supports transaction signing and message signing",
        );
        return;
      }

      setRestartingStream(stream.id);
      try {
        const teeAuthToken = await getOrFetchToken();

        const response = await fetch("/api/streams/restart", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            teeAuthToken,
          }),
        });

        const json = (await response.json()) as
          | RestartStreamBuildResponse
          | { error?: string; message?: string; stream?: PayrollStream };

        if (!response.ok) {
          throw new Error(
            "error" in json
              ? json.error || "Failed to build stopped-stream restart"
              : "Failed to build stopped-stream restart",
          );
        }

        const restartBuild = json as RestartStreamBuildResponse;

        if (restartBuild.status === "already-reset") {
          toast.success(
            restartBuild.message ||
            "A fresh replacement stream already exists for this employee.",
          );
          await fetchPayrollConfig();
          return;
        }

        const transactionCount = [
          restartBuild.transactions.closePrivatePayroll,
          restartBuild.transactions.undelegateEmployee,
          restartBuild.transactions.closeEmployee,
        ].filter(Boolean).length;

        if (transactionCount > 0) {
          toast.info(
            `Approve ${transactionCount} restart transaction${transactionCount === 1 ? "" : "s"} in your wallet`,
          );
        }

        const signatures: {
          closePrivatePayroll?: string;
          undelegateEmployee?: string;
          closeEmployee?: string;
        } = {};

        if (restartBuild.transactions.closePrivatePayroll) {
          signatures.closePrivatePayroll = await signAndSend(
            restartBuild.transactions.closePrivatePayroll.transactionBase64,
            signTransaction,
            {
              sendTo: restartBuild.transactions.closePrivatePayroll.sendTo,
              rpcUrl: getTeeRpcUrl(teeAuthToken),
              signMessage,
              publicKey,
            },
          );
        }

        if (restartBuild.transactions.undelegateEmployee) {
          signatures.undelegateEmployee = await signAndSend(
            restartBuild.transactions.undelegateEmployee.transactionBase64,
            signTransaction,
            {
              sendTo: restartBuild.transactions.undelegateEmployee.sendTo,
              rpcUrl: getTeeRpcUrl(teeAuthToken),
              signMessage,
              publicKey,
            },
          );
        }

        if (restartBuild.transactions.closeEmployee) {
          await waitForEmployeeOwnership(restartBuild.employeePda);

          signatures.closeEmployee = await signAndSend(
            restartBuild.transactions.closeEmployee.transactionBase64,
            signTransaction,
            {
              sendTo: restartBuild.transactions.closeEmployee.sendTo,
              signMessage,
              publicKey,
            },
          );
        }

        const finalizeResponse = await fetch("/api/streams/restart", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            employeePda: restartBuild.employeePda,
            privatePayrollPda: restartBuild.privatePayrollPda,
            permissionPda: restartBuild.permissionPda,
            teeAuthToken,
            signatures,
          }),
        });

        const finalizeJson = (await finalizeResponse.json()) as {
          error?: string;
          message?: string;
        };

        if (!finalizeResponse.ok) {
          throw new Error(
            finalizeJson.error || "Failed to finalize stopped-stream restart",
          );
        }

        toast.success(
          finalizeJson.message ||
          "Stopped stream reset complete. A fresh paused stream is ready.",
        );
        await fetchPayrollConfig();
      } catch (err: unknown) {
        toast.error(
          `Restart stream failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      } finally {
        setRestartingStream(null);
      }
    },
    [
      walletAddress,
      publicKey,
      signTransaction,
      signMessage,
      getOrFetchToken,
      getTeeRpcUrl,
      waitForEmployeeOwnership,
      fetchPayrollConfig,
    ],
  );

  const handleOnboardToPer = useCallback(
    async (stream: PayrollStream) => {
      if (!walletAddress || !publicKey || !signTransaction || !signMessage) {
        toast.error(
          "Connect a wallet that supports transaction signing and message signing",
        );
        return;
      }

      setOnboardingStream(stream.id);
      try {
        const teeAuthToken = await getOrFetchToken();

        const response = await fetch("/api/streams/onboard", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            teeAuthToken,
          }),
        });

        let json: OnboardTransactionsResponse | { error?: string; message?: string };
        const responseText = await response.text();

        try {
          json = JSON.parse(responseText) as
            | OnboardTransactionsResponse
            | { error?: string; message?: string };
        } catch {
          throw new Error(
            `Server returned non-JSON response (status ${response.status}): ${responseText.slice(0, 200)}`
          );
        }

        if (!response.ok) {
          throw new Error(
            "error" in json
              ? json.error || "Failed to build PER onboarding transactions"
              : "Failed to build PER onboarding transactions",
          );
        }

        if ("message" in json && !("transactions" in json)) {
          toast.success(json.message || "Stream is already onboarded to PER");
          await fetchPayrollConfig();
          return;
        }

        const onboarding = json as OnboardTransactionsResponse;
        const transactionCount = [
          onboarding.transactions.baseSetup,
          onboarding.transactions.initializePrivatePayroll,
        ].filter(Boolean).length;

        if (transactionCount === 2) {
          toast.info("Approve Step 1/2 (base setup), then Step 2/2 (PER init)");
        } else {
          toast.info(
            `Approve ${transactionCount} onboarding transaction${transactionCount === 1 ? "" : "s"} in your wallet`,
          );
        }

        if (onboarding.transactions.baseSetup) {
          await signAndSend(
            onboarding.transactions.baseSetup.transactionBase64,
            signTransaction,
            {
              sendTo: onboarding.transactions.baseSetup.sendTo,
              signMessage,
              publicKey,
            },
          );
        }

        if (onboarding.transactions.initializePrivatePayroll) {
          await signAndSend(
            onboarding.transactions.initializePrivatePayroll.transactionBase64,
            signTransaction,
            {
              sendTo: onboarding.transactions.initializePrivatePayroll.sendTo,
              rpcUrl: getTeeRpcUrl(teeAuthToken),
              signMessage,
              publicKey,
              retrySendCount: 3,
              retryDelayMs: 5_000,
            },
          );
        }

        const finalizeResponse = await fetch("/api/streams/onboard", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            streamId: stream.id,
            employeePda: onboarding.employeePda,
            privatePayrollPda: onboarding.privatePayrollPda,
            permissionPda: onboarding.permissionPda,
          }),
        });

        const finalizeJson = (await finalizeResponse.json()) as {
          error?: string;
        };

        if (!finalizeResponse.ok) {
          throw new Error(
            finalizeJson.error || "Failed to finalize PER onboarding",
          );
        }

        toast.success(
          onboarding.alreadyOnboarded
            ? "Stream is already onboarded to PER"
            : "Stream onboarded to MagicBlock PER with employer wallet",
        );
        await fetchPayrollConfig();
      } catch (err: unknown) {
        toast.error(
          `PER onboarding failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      } finally {
        setOnboardingStream(null);
      }
    },
    [
      walletAddress,
      publicKey,
      signTransaction,
      signMessage,
      getOrFetchToken,
      getTeeRpcUrl,
      fetchPayrollConfig,
    ],
  );

  const handleRunTick = useCallback(
    async (
      stream?: PayrollStream,
      options?: {
        cashoutRequest?: CashoutRequestRecord;
        settlementAmountMicro?: number;
      },
    ) => {
      if (!walletAddress || !publicKey || !signTransaction || !signMessage) {
        toast.error(
          "Connect a wallet that supports transaction signing and message signing",
        );
        return;
      }

      if (stream) {
        setRunningTickStream(stream.id);
      } else {
        setRunningTick(true);
      }

      try {
        const teeAuthToken = await getOrFetchToken();

        if (stream && getEffectiveStreamStatus(stream, privateStates[stream.id]) === "stopped") {
          const previewResult =
            (await fetchPrivatePreview(stream, { silent: true })) ??
            privateStates[stream.id] ??
            null;

          if (previewResult === "missing") {
            toast.info(
              "This stopped stream no longer has a private payroll state in PER. There is nothing left to settle; use Restart Stream instead.",
            );
            return;
          }
        }

        const tickBuildResponse = await fetch("/api/payroll/tick", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            teeAuthToken,
            streamId: stream?.id,
            cashoutRequestId: options?.cashoutRequest?.id,
            maxSettlementAmountMicro: options?.cashoutRequest
              ? Math.round(options.cashoutRequest.requestedAmount * 1_000_000)
              : options?.settlementAmountMicro,
          }),
        });

        const tickBuildJson = (await tickBuildResponse.json()) as
          | TickBuildResponse
          | { error?: string };

        if (!tickBuildResponse.ok) {
          throw new Error(
            "error" in tickBuildJson
              ? tickBuildJson.error || "Failed to build payroll tick"
              : "Failed to build payroll tick",
          );
        }

        const tickBuild = tickBuildJson as TickBuildResponse;

        if (tickBuild.processed === 0) {
          await fetchPayrollConfig();
          toast.info(
            stream
              ? "This stream is not active yet"
              : "No active streams to process",
          );
          return;
        }

        const actionableResults = tickBuild.results.filter(
          (result) =>
            !result.skipped &&
            result.transactions?.transfer &&
            result.transactions?.settleSalary &&
            result.transactions?.commitEmployee &&
            typeof result.amountMicro === "number" &&
            result.employeePda &&
            result.privatePayrollPda,
        );

        if (actionableResults.length === 0) {
          await fetchPayrollConfig();
          const firstReason = tickBuild.results.find(
            (result) => result.reason,
          )?.reason;
          toast.info(firstReason || "No accrued payroll amount to settle yet");
          return;
        }

        toast.info(
          `Approve ${actionableResults.length * 3} settlement transaction(s) in your wallet`,
        );

        const finalizedResults: Array<{
          streamId: string;
          employeeId: string;
          employeeWallet: string;
          cashoutRequestId?: string;
          requestedAmountMicro?: number;
          amountMicro: number;
          payoutMode?: PayrollPayoutMode;
          destinationWallet?: string;
          transferFromBalance?: "base" | "ephemeral";
          transferToBalance?: "base" | "ephemeral";
          transferSendTo?: string;
          employeePda: string;
          privatePayrollPda: string;
          transferSignature: string;
          settleSalarySignature: string;
          commitSignature: string;
        }> = [];

        if (stream) {
          setRunningTickStream(null);
          setSettlingTickStream(stream.id);
        } else {
          setRunningTick(false);
        }

        for (const result of actionableResults) {
          let transferSignature: string;
          try {
            transferSignature = await signAndSend(
              result.transactions!.transfer!.transactionBase64,
              signTransaction,
              {
                sendTo: result.transactions!.transfer!.sendTo,
                signMessage,
                publicKey,
              },
            );
          } catch (error: unknown) {
            throw new Error(
              `Run Tick failed at private transfer for ${result.employeeWallet}: ${error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }

          let settleSalarySignature: string;
          try {
            settleSalarySignature = await signAndSend(
              result.transactions!.settleSalary!.transactionBase64,
              signTransaction,
              {
                sendTo: result.transactions!.settleSalary!.sendTo,
                rpcUrl: getTeeRpcUrl(teeAuthToken),
                signMessage,
                publicKey,
              },
            );
          } catch (error: unknown) {
            throw new Error(
              `Run Tick failed at settleSalary for ${result.employeeWallet}: ${error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }

          let commitSignature: string;
          try {
            commitSignature = await signAndSend(
              result.transactions!.commitEmployee!.transactionBase64,
              signTransaction,
              {
                sendTo: result.transactions!.commitEmployee!.sendTo,
                rpcUrl: getTeeRpcUrl(teeAuthToken),
                signMessage,
                publicKey,
              },
            );
          } catch (error: unknown) {
            throw new Error(
              `Run Tick failed at commitEmployee for ${result.employeeWallet}: ${error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }

          finalizedResults.push({
            streamId: result.streamId,
            employeeId: result.employeeId,
            employeeWallet: result.employeeWallet,
            cashoutRequestId: result.cashoutRequestId,
            requestedAmountMicro: result.requestedAmountMicro,
            amountMicro: result.amountMicro!,
            payoutMode: result.payoutMode,
            destinationWallet: result.destinationWallet,
            transferFromBalance: result.transferFromBalance,
            transferToBalance: result.transferToBalance,
            transferSendTo: result.transactions?.transfer?.sendTo,
            employeePda: result.employeePda!,
            privatePayrollPda: result.privatePayrollPda!,
            transferSignature,
            settleSalarySignature,
            commitSignature,
          });
        }

        if (finalizedResults.length === 0) {
          toast.info("No payroll settlements were signed");
          return;
        }

        const finalizeResponse = await fetch("/api/payroll/tick", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            employerWallet: walletAddress,
            results: finalizedResults,
          }),
        });

        const finalizeJson = (await finalizeResponse.json()) as {
          error?: string;
          totalTransferredMicro?: number;
          processed?: number;
        };

        if (!finalizeResponse.ok) {
          throw new Error(
            finalizeJson.error || "Failed to finalize payroll tick",
          );
        }

        const amount = finalizeJson.totalTransferredMicro
          ? (finalizeJson.totalTransferredMicro / 1_000_000).toFixed(6)
          : "0.000000";

        toast.success(
          stream
            ? `Tick complete: Transferred ${amount} USDC`
            : `Tick complete: Processed ${finalizeJson.processed ?? finalizedResults.length} stream(s), Transferred ${amount} USDC`,
        );

        if (stream && !options?.cashoutRequest) {
          setTickAmountInputs((prev) => ({
            ...prev,
            [stream.id]: "",
          }));
        }

        await fetchPayrollConfig();
      } catch (err: unknown) {
        toast.error(
          `Payroll tick failed: ${err instanceof Error ? err.message : "Unknown error"
          }`,
        );
      } finally {
        if (stream) {
          setRunningTickStream((current) =>
            current === stream.id ? null : current,
          );
          setSettlingTickStream((current) =>
            current === stream.id ? null : current,
          );
        } else {
          setRunningTick(false);
        }
      }
    },
    [
      walletAddress,
      publicKey,
      signTransaction,
      signMessage,
      getOrFetchToken,
      getTeeRpcUrl,
      privateStates,
      fetchPrivatePreview,
      fetchPayrollConfig,
    ],
  );

  return (
    <EmployerLayout>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={focusedEmployeeId ? "/people" : "/dashboard"}
            className="inline-flex items-center gap-1.5 text-xs text-[#a8a8aa] hover:text-white transition-colors font-bold uppercase tracking-wider group"
          >
            <ChevronLeft
              size={14}
              className="group-hover:-translate-x-0.5 transition-transform"
            />{" "}
            {focusedEmployeeId ? "Back to People" : "Back"}
          </Link>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#0a0a0a] px-3 py-1.5 shadow-sm">
            <ShieldCheck
              size={12}
              className={
                magicBlockHealth === "ok"
                  ? "text-emerald-500"
                  : magicBlockHealth === "error"
                    ? "text-amber-500"
                    : "text-[#8f8f95]"
              }
            />
            <span
              className={`text-[9px] font-bold uppercase tracking-[0.15em] ${magicBlockHealth === "ok"
                ? "text-emerald-300"
                : magicBlockHealth === "error"
                  ? "text-amber-300"
                  : "text-[#a8a8aa]"
                }`}
            >
              MagicBlock {magicBlockHealth === "ok" ? "Online" : magicBlockHealth === "error" ? "Degraded" : "Checking"}
            </span>
          </div>
        </div>

        {!connected ? (
          <div className="flex flex-col items-center justify-center py-24 text-center bg-[#111111] rounded-[2.5rem] border border-white/10">
            <div className="w-20 h-20 rounded-3xl bg-[#0a0a0a] border border-white/10 shadow-sm flex items-center justify-center mb-6">
              <Wallet size={32} className="text-white" />
            </div>
            <p className="text-white text-xl mb-1 font-semibold tracking-tight">
              Connect your wallet to continue
            </p>
          </div>
        ) : (
          <>
            {!focusedEmployeeId ? (
              <div className="mb-8 rounded-3xl border border-emerald-500/30 bg-emerald-500/10 p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">
                      {focusedEmployee ? "Focused Payroll View" : "Stream Operations"}
                    </p>
                    <p className="max-w-2xl text-sm text-[#b6b6bc]">
                      {focusedEmployee
                        ? "All the realtime payroll controls for this employee now live here. You can keep People for setup, then manage the live stream from this focused page."
                        : "Use People for employee setup, salary, role, and monthly terms. This page stays focused on PER health, settlement, onboarding status, and stream controls."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href="/people"
                      className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-[#0a0a0a] px-5 py-2.5 text-xs font-bold text-white transition-all hover:border-white/30 shadow-sm"
                    >
                      Open People Directory
                    </Link>
                    <Link
                      href="/disburse/manual"
                      className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-[#0a0a0a] px-5 py-2.5 text-xs font-bold text-white transition-all hover:border-white/30 shadow-sm"
                    >
                      Legacy Manual Batch Payroll
                    </Link>
                  </div>
                </div>
              </div>
            ) : null}

            {!focusedEmployeeId ? (
              <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                    Current cycle
                  </p>
                  <p className="mt-2 text-lg font-bold tracking-tight text-white">
                    {cycleInfo.label}
                  </p>
                  <div className="mt-2">{renderSourceBadge("backend")}</div>
                  <p className="mt-1 text-xs text-[#a8a8aa]">
                    {cycleInfo.start.toLocaleDateString()} -{" "}
                    {cycleInfo.end.toLocaleDateString()} · {cycleInfo.totalDays} days
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                    Monthly liability
                  </p>
                  <p className="mt-2 text-lg font-bold tracking-tight text-white">
                    {formatUsd(monthlyLiability)}
                  </p>
                  <div className="mt-2">{renderSourceBadge("backend")}</div>
                  <p className="mt-1 text-xs text-[#a8a8aa]">
                    Projected salary allocation for this cycle
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                    Active daily burn
                  </p>
                  <p className="mt-2 text-lg font-bold tracking-tight text-white">
                    {formatUsd(activeDailyBurn)}
                  </p>
                  <div className="mt-2">{renderSourceBadge("backend")}</div>
                  <p className="mt-1 text-xs text-[#a8a8aa]">
                    Based on active stream rates × 86,400 sec
                  </p>
                </div>
                <div
                  className={`rounded-3xl border p-5 shadow-sm ${treasuryPrivateBalance !== null &&
                    monthlyLiability > 0 &&
                    treasuryPrivateBalance < monthlyLiability
                    ? "border-amber-500/30 bg-amber-500/10"
                    : "border-white/10 bg-[#0a0a0a]"
                    }`}
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                    Treasury runway
                  </p>
                  <p className="mt-2 text-lg font-bold tracking-tight text-white">
                    {treasuryRunwayDays === null
                      ? "n/a"
                      : `${treasuryRunwayDays.toFixed(1)} days`}
                  </p>
                  <div className="mt-2">
                    {renderSourceBadge(
                      treasuryPrivateBalance === null ? "unavailable" : "live-per",
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[#a8a8aa]">
                    Treasury:{" "}
                    {treasuryPrivateBalance === null
                      ? "not synced"
                      : formatUsd(treasuryPrivateBalance)}
                  </p>
                  <button
                    type="button"
                    onClick={() => void refreshTreasuryPrivateBalance()}
                    disabled={refreshingTreasuryBalance}
                    className="mt-3 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[#a8a8aa] hover:text-white disabled:opacity-40"
                  >
                    {refreshingTreasuryBalance ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <RefreshCw size={11} />
                    )}
                    Sync treasury
                  </button>
                </div>
              </div>
            ) : null}

            {!focusedEmployeeId && (readinessSummary.perMissing > 0 ||
              readinessSummary.recipientMissing > 0 ||
              readinessSummary.paused > 0 ||
              (treasuryPrivateBalance !== null &&
                monthlyLiability > treasuryPrivateBalance)) && (
                <div className="mb-8 rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={18} className="mt-0.5 text-amber-300" />
                    <div>
                      <p className="text-sm font-bold text-amber-300">
                        Payroll readiness needs attention
                      </p>
                      <p className="mt-1 text-xs text-amber-300">
                        PER missing: {readinessSummary.perMissing} · Recipient init
                        pending: {readinessSummary.recipientMissing} · Paused streams:{" "}
                        {readinessSummary.paused}
                        {treasuryPrivateBalance !== null &&
                          monthlyLiability > treasuryPrivateBalance
                          ? " · Treasury appears underfunded for this cycle."
                          : ""}
                      </p>
                    </div>
                  </div>
                </div>
              )}

            {!focusedEmployeeId ? (
              <div className="mb-8 rounded-[2rem] border border-white/10 bg-[#0a0a0a] p-6 shadow-sm">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <CalendarDays size={15} className="text-[#8f8f95]" />
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                      Salary allocation board
                    </p>
                  </div>
                  {!focusedEmployeeId ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleBatchResume()}
                        disabled={controllingStream !== null}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-500/10 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-emerald-300 disabled:opacity-40"
                      >
                        <PlayCircle size={12} />
                        Resume paused
                      </button>
                      <button
                        onClick={() => void handleBatchPause()}
                        disabled={controllingStream !== null}
                        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#0a0a0a] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#b6b6bc] disabled:opacity-40"
                      >
                        <Pause size={12} />
                        Pause active
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left">
                    <thead>
                      <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.2em] text-[#8f8f95]">
                        <th className="py-2 pr-3 font-bold">Employee</th>
                        <th className="py-2 pr-3 font-bold">Monthly eq.</th>
                        <th className="py-2 pr-3 font-bold">Streamed so far</th>
                        <th className="py-2 pr-3 font-bold">Claimable now</th>
                        <th className="py-2 pr-3 font-bold">Remaining cycle</th>
                        <th className="py-2 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSalaryAllocationRows.map((row) => (
                        <tr key={row.employee.id} className="border-b border-white/5 text-sm">
                          <td className="py-3 pr-3">
                            <Link
                              href={`/people/${row.employee.id}`}
                              className="inline-flex flex-col gap-1 no-underline"
                            >
                              <span className="font-semibold text-white transition-colors hover:text-[#b6b6bc]">
                                {row.employee.name}
                              </span>
                              {(row.employee.role || row.employee.department) && (
                                <span className="text-[11px] text-[#8f8f95]">
                                  {[row.employee.role, row.employee.department]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              )}
                            </Link>
                          </td>
                          <td className="py-3 pr-3 font-mono text-white">
                            {formatUsd(row.monthlySalary)}
                            <div className="mt-1 text-[10px] text-[#8f8f95]">
                              {row.cycleLabel}
                            </div>
                            <div className="mt-1">{renderSourceBadge("backend")}</div>
                          </td>
                          <td className="py-3 pr-3 font-mono text-[#b6b6bc]">
                            {formatUsd(row.streamedSoFar)}
                            <div className="mt-1">{renderSourceBadge("backend")}</div>
                          </td>
                          <td className="py-3 pr-3 font-mono text-[#00A647]">
                            {row.claimableNow === null
                              ? "n/a"
                              : formatUsd(row.claimableNow)}
                            <div className="mt-1">
                              {renderSourceBadge(
                                row.claimableNow === null ? "unavailable" : "live-per",
                              )}
                            </div>
                          </td>
                          <td className="py-3 pr-3 font-mono text-[#b6b6bc]">
                            {formatUsd(row.remainingThisCycle)}
                            <div className="mt-1 text-[10px] text-[#8f8f95]">
                              Target: {formatUsd(row.cycleTarget)}
                            </div>
                            <div className="mt-1">{renderSourceBadge("backend")}</div>
                          </td>
                          <td className="py-3">
                            <span
                              className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${row.status === "active"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : row.status === "paused"
                                  ? "bg-amber-500/10 text-amber-400"
                                  : "bg-rose-500/10 text-rose-400"
                                }`}
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {/* Realtime Payroll Manager */}
            <div className="border border-white/10 rounded-[2rem] bg-[#0a0a0a] shadow-sm mb-12 overflow-hidden">
              {/* Section header */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-8 pt-8 pb-6">
                <div className="flex items-center gap-3">
                  {visibleManagedEmployees.some(
                    (employee) => {
                      const activeStream =
                        employeeStreamMap.get(employee.id) ?? null;
                      return (
                        resolveStatusWithMissing(
                          activeStream,
                          activeStream
                            ? (privateStates[activeStream.id] ?? null)
                            : null,
                        ) === "active"
                      );
                    },
                  ) && (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00E559] opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00E559]" />
                      </span>
                    )}
                  <div>
                    <h3 className="font-bold text-[10px] text-white uppercase tracking-[0.2em]">
                      {focusedEmployee ? "Payroll Stream" : "Realtime Payroll Streams"}
                    </h3>
                    <p className="text-[11px] text-[#8f8f95] mt-0.5">
                      {focusedEmployee
                        ? "Live stream controls and private payroll state for this employee"
                        : "Employer-signed private payroll on MagicBlock PER"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!focusedEmployeeId ? (
                    <button
                      onClick={() => handleRunTick()}
                      disabled={
                        loadingPayrollConfig ||
                        runningTick ||
                        runningTickStream !== null ||
                        settlingTickStream !== null ||
                        !walletAddress
                      }
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 transition-all text-[11px] font-bold disabled:opacity-40 cursor-pointer shadow-sm uppercase tracking-wider"
                    >
                      {runningTick ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Zap size={13} />
                      )}
                      Run Active Ticks
                    </button>
                  ) : null}
                  <button
                    onClick={fetchPayrollConfig}
                    disabled={loadingPayrollConfig}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-[#111111]/70 text-[#a8a8aa] hover:text-white hover:border-white/15 transition-all text-[11px] font-bold disabled:opacity-40 cursor-pointer uppercase tracking-wider"
                  >
                    {loadingPayrollConfig ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    Refresh
                  </button>
                </div>
              </div>

              {/* Divider */}
              {!focusedEmployeeId ? <div className="h-px bg-white/10 mx-8" /> : null}

              {/* Setup routing note */}
              {!focusedEmployeeId ? (
                <div className="px-8 py-6">
                  <div className="rounded-[1.75rem] border border-white/10 bg-[#111111]/80 p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8f8f95]">
                          Employee setup lives in People
                        </p>
                        <p className="mt-2 max-w-2xl text-sm text-[#a8a8aa]">
                          Add employees, define salary, set start time, and manage department or role from the People flow. This stream dashboard is now reserved for PER onboarding, private-state checks, and run controls.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Link
                          href="/people"
                          className="inline-flex items-center justify-center gap-2 rounded-full bg-black px-5 py-3 text-sm font-bold text-white transition-all hover:bg-neutral-800 no-underline"
                        >
                          Open People
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Divider */}
              {!focusedEmployeeId ? <div className="h-px bg-white/10 mx-8" /> : null}

              {/* Employee list */}
              <div className="px-8 py-6 space-y-4">
                {/* List header */}
                {!focusedEmployeeId ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Users size={14} className="text-[#8f8f95]" />
                      <span className="text-[10px] text-[#8f8f95] uppercase tracking-[0.2em] font-bold">
                        {visibleManagedEmployees.length} Employee
                        {visibleManagedEmployees.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                ) : null}

                {/* Empty state */}
                {visibleManagedEmployees.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <div className="w-12 h-12 rounded-2xl border border-dashed border-white/10 flex items-center justify-center">
                      <Users size={20} className="text-[#8f8f95]" />
                    </div>
                    <p className="text-sm text-[#8f8f95] text-center">
                      {focusedEmployeeId
                        ? "This employee was not found in your payroll roster"
                        : "Add your first employee above to get started"}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleManagedEmployees.map((employee) => {
                      const stream =
                        employeeStreamMap.get(employee.id) ?? null;
                      const pendingRequests = stream
                        ? (cashoutRequestsByStream.get(stream.id) ?? []).filter(
                          (request) => request.status === "pending",
                        )
                        : [];
                      const currentRate = rateInputs[employee.id] ?? "";
                      const preview = stream
                        ? (privateStates[stream.id] ?? null)
                        : null;
                      const employeeInitializedAtFromAnyStream =
                        streams.find(
                          (candidate) =>
                            managedEmployees.find(
                              (managed) =>
                                managed.id === candidate.employeeId &&
                                managed.wallet === employee.wallet,
                            ) &&
                            !!candidate.recipientPrivateInitializedAt,
                        )?.recipientPrivateInitializedAt ?? null;
                      const hasMissingPrivateState = !!(
                        stream && missingPrivateStates[stream.id]
                      );
                      const effectiveStatus =
                        resolveStatusWithMissing(stream, preview) ?? "stopped";
                      const hasStatusMismatch =
                        !!stream &&
                        !!preview &&
                        preview.state.status !== stream.status;
                      const isOnboarded = !!(
                        !hasMissingPrivateState &&
                        stream?.employeePda &&
                        stream?.privatePayrollPda &&
                        stream?.permissionPda &&
                        stream?.delegatedAt
                      );
                      const isRecipientPrivateReady =
                        !!(
                          stream?.recipientPrivateInitializedAt ??
                          employee.privateRecipientInitializedAt ??
                          employeeInitializedAtFromAnyStream
                        );
                      const previewAccruedMicro = Number(
                        preview?.state.accruedUnpaidMicro ?? "0",
                      );
                      const hasAccruedToSettle =
                        Number.isFinite(previewAccruedMicro) &&
                        previewAccruedMicro > 0;
                      const mustSettleBeforeRestart =
                        effectiveStatus === "stopped" &&
                        !hasMissingPrivateState &&
                        (!preview || hasAccruedToSettle);

                      const statusAccent =
                        effectiveStatus === "active"
                          ? "border-l-[#00E559]"
                          : effectiveStatus === "paused"
                            ? "border-l-amber-400"
                            : effectiveStatus === "stopped"
                              ? "border-l-red-500"
                              : "border-l-white/10";

                      return (
                        <div
                          key={employee.id}
                          className="rounded-sm border border-white/15 bg-[#0a0a0a] overflow-hidden shadow-sm hover:shadow-md transition-shadow"
                        >
                          {/* Card top row */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 pt-5 pb-4">
                            {!focusedEmployeeId ? (
                              <div className="min-w-0">
                                <p className="text-white font-bold text-base tracking-tight truncate">
                                  {employee.name}
                                </p>
                                {(employee.role || employee.department) && (
                                  <p className="text-[11px] text-[#a8a8aa] mt-0.5 truncate">
                                    {[employee.role, employee.department]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </p>
                                )}
                                <p className="font-mono text-[10px] text-[#8f8f95] mt-0.5 tracking-wider">
                                  {employee.wallet.slice(0, 6)}...
                                  {employee.wallet.slice(-6)}
                                </p>
                                {employee.notes &&
                                  employee.notes !== "__open__" && (
                                    <p className="text-[11px] text-[#a8a8aa] mt-1 truncate italic">
                                      {employee.notes}
                                    </p>
                                  )}
                              </div>
                            ) : (
                              <p className="font-mono text-[11px] text-[#8f8f95] tracking-[0.18em]">
                                {employee.wallet.slice(0, 6)}...
                                {employee.wallet.slice(-6)}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                              <span
                                className={`px-3 py-1 rounded-sm text-[9px] font-bold uppercase tracking-widest border shadow-sm ${effectiveStatus === "active"
                                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                  : effectiveStatus === "paused"
                                    ? "bg-amber-500/10 text-amber-400 border-amber-300"
                                    : effectiveStatus === "stopped"
                                      ? "bg-red-500/10 text-red-400 border-red-500/30"
                                      : "bg-[#111111] text-[#a8a8aa] border-white/15"
                                  }`}
                              >
                                {effectiveStatus ?? "draft"}
                              </span>
                              <span
                                className={`px-3 py-1 rounded-sm text-[9px] font-bold uppercase tracking-widest border shadow-sm ${isOnboarded
                                  ? "bg-[#0f0f10] text-white border-white/10"
                                  : "bg-[#111111] text-[#a8a8aa] border-white/15"
                                  }`}
                              >
                                {isOnboarded ? "PER LIVE" : "PER PENDING"}
                              </span>
                              <span
                                className={`px-3 py-1 rounded-sm text-[9px] font-bold uppercase tracking-widest border shadow-sm ${isRecipientPrivateReady
                                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                  : "bg-amber-500/10 text-amber-400 border-amber-300"
                                  }`}
                              >
                                {isRecipientPrivateReady
                                  ? "INIT ✓"
                                  : "INIT PENDING"}
                              </span>
                              {stream && pendingRequests.length > 0 ? (
                                <span className="px-3 py-1 rounded-sm text-[9px] font-bold uppercase tracking-widest border bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30 shadow-sm animate-pulse">
                                  CASHOUT ×{pendingRequests.length}
                                </span>
                              ) : null}
                              {effectiveStatus === "stopped" ? (
                                <p className="w-full text-right text-[10px] text-red-500 font-medium">
                                  Terminal state.
                                </p>
                              ) : null}
                            </div>
                          </div>

                          {hasStatusMismatch ? (
                            <div className="px-5 pb-1">
                              <p className="text-[10px] text-[#8f8f95]">
                                Live PER state:{" "}
                                <span className="font-bold uppercase text-white">
                                  {preview?.state.status}
                                </span>
                              </p>
                            </div>
                          ) : null}

                          {/* Divider */}
                          <div className="h-px bg-[#111111] mx-5" />

                          {/* Employee snapshot + PER preview grid */}
                          <div className="grid md:grid-cols-2 gap-4 px-5 py-4">
                            {/* Employee profile snapshot */}
                            <div>
                              <label className="block text-[10px] text-[#8f8f95] uppercase tracking-[0.2em] font-bold mb-2">
                                {focusedEmployeeId
                                  ? "Payroll Terms"
                                  : "Employee Profile Snapshot"}
                              </label>
                              <div className="rounded-sm border border-white/10 bg-[#111111] p-4">
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div className="rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-3 shadow-sm">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa]">
                                      Monthly salary
                                    </p>
                                    <p className="mt-2 text-lg font-bold text-white">
                                      {formatUsd(
                                        employee.monthlySalaryUsd ??
                                        ratePerSecondToMonthlyUsd(
                                          stream?.ratePerSecond ?? 0,
                                        ),
                                      )}
                                    </p>
                                  </div>
                                  <div className="rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-3 shadow-sm">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa]">
                                      Statement cycle
                                    </p>
                                    <p className="mt-2 text-sm font-semibold capitalize text-white">
                                      {(employee.paySchedule ?? "monthly").replaceAll(
                                        "_",
                                        " ",
                                      )}
                                    </p>
                                  </div>
                                  <div className="rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-3 shadow-sm">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa]">
                                      Stream starts
                                    </p>
                                    <p className="mt-2 text-sm font-semibold text-white">
                                      {new Date(
                                        stream?.startsAt ??
                                        employee.startDate ??
                                        employee.createdAt,
                                      ).toLocaleString()}
                                    </p>
                                  </div>
                                  <div className="rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-3 shadow-sm">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa]">
                                      Rate / second
                                    </p>
                                    <p className="mt-2 font-mono text-sm font-semibold text-white">
                                      {stream
                                        ? `${stream.ratePerSecond.toFixed(8)} USDC/s`
                                        : "Draft not created"}
                                    </p>
                                    {stream ? (
                                      <p className="mt-1 text-[10px] text-[#a8a8aa]">
                                        {payoutModeSummary(
                                          stream.payoutMode ??
                                          DEFAULT_PAYROLL_PAYOUT_MODE,
                                        )}
                                      </p>
                                    ) : null}
                                  </div>
                                </div>
                                {!focusedEmployeeId ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Link
                                      href={`/people/${employee.id}`}
                                      className="inline-flex items-center justify-center rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-white transition-all hover:border-white/30 no-underline"
                                    >
                                      Open employee page
                                    </Link>
                                    <Link
                                      href="/people"
                                      className="inline-flex items-center justify-center rounded-sm border border-white/10 bg-[#0a0a0a] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa] transition-all hover:border-white/30 hover:text-white no-underline"
                                    >
                                      People directory
                                    </Link>
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            {/* PER preview panel */}
                            <div>
                              <div className="flex items-center gap-1.5 mb-2">
                                <ShieldCheck
                                  size={12}
                                  className="text-emerald-300"
                                />
                                <label className="text-[10px] text-[#8f8f95] uppercase tracking-[0.2em] font-bold">
                                  Private Payroll State
                                </label>
                              </div>
                              {preview ? (
                                <div className="rounded-sm bg-[#111111] border border-white/10 px-4 py-3 space-y-1.5 shadow-sm">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Accrued
                                    </span>
                                    <span className="font-mono text-xs text-emerald-300 font-bold">
                                      {formatMicroUsdc(
                                        preview.state.accruedUnpaidMicro,
                                      )}{" "}
                                      USDC
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Claimable now
                                    </span>
                                    <span className="font-mono text-xs text-white font-bold">
                                      {formatMicroUsdc(
                                        preview.state
                                          .effectiveClaimableAmountMicro,
                                      )}{" "}
                                      USDC
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Last checkpoint
                                    </span>
                                    <span className="font-mono text-xs text-white font-bold">
                                      {formatUnixTimestamp(
                                        preview.state.lastAccrualTimestamp,
                                      )}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Total paid
                                    </span>
                                    <span className="font-mono text-xs text-[#8f8f95]">
                                      {formatMicroUsdc(
                                        preview.state.totalPaidPrivateMicro,
                                      )}{" "}
                                      USDC
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Rate
                                    </span>
                                    <span className="font-mono text-[11px] text-[#8f8f95]">
                                      {formatMicroUsdc(
                                        preview.state.ratePerSecondMicro,
                                      )}{" "}
                                      USDC/s
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-[#a8a8aa] font-medium">
                                      Synced
                                    </span>
                                    <span className="font-mono text-[11px] text-[#8f8f95]">
                                      {new Date(
                                        preview.syncedAt,
                                      ).toLocaleTimeString()}
                                    </span>
                                  </div>
                                </div>
                              ) : hasMissingPrivateState ? (
                                <div className="bg-red-500/10 border border-red-500/30 px-4 py-4 space-y-3">
                                  <p className="text-[12px] text-red-300 font-bold">
                                    ⚠ PER state missing
                                  </p>
                                  <p className="text-[11px] text-red-400 leading-relaxed">
                                    This stream has no active private state in PER right now. Follow these steps to recover:
                                  </p>
                                  <ol className="text-[11px] text-red-300 font-medium space-y-1.5 list-decimal list-inside">
                                    <li><strong>Save Draft</strong> → re-creates the stream</li>
                                    <li><strong>Onboard PER</strong> → re-initializes private state</li>
                                    <li><strong>Resume</strong> → activates the stream again</li>
                                  </ol>
                                </div>
                              ) : (
                                <div className="bg-[#111111] border border-white/15 px-4 py-4 space-y-2">
                                  {isOnboarded ? (
                                    <>
                                      <p className="text-[12px] text-[#d0d0d4] font-bold">
                                        State not loaded
                                      </p>
                                      <p className="text-[11px] text-[#a8a8aa] leading-relaxed">
                                        Click <strong>Refresh State</strong> below to load the current payroll data.
                                      </p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-[12px] text-[#d0d0d4] font-bold">
                                        Not onboarded yet
                                      </p>
                                      <ol className="text-[11px] text-[#b6b6bc] font-medium space-y-1.5 list-decimal list-inside">
                                        <li><strong>Save Draft</strong> → creates the stream on-chain</li>
                                        <li><strong>Onboard PER</strong> → enables private payroll</li>
                                        <li><strong>Refresh State</strong> → loads the data here</li>
                                      </ol>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {stream && pendingRequests.length > 0 ? (
                            <>
                              <div className="h-px bg-[#111111] mx-5" />
                              <div className="px-5 py-4 space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[10px] text-fuchsia-300 uppercase tracking-[0.2em] font-bold">
                                    Pending Cashout Requests
                                  </p>
                                  <p className="text-[10px] text-[#8f8f95] font-bold uppercase tracking-wider">
                                    {loadingCashoutRequests
                                      ? "Refreshing..."
                                      : `${pendingRequests.length} open`}
                                  </p>
                                </div>
                                {pendingRequests.map((request) => (
                                  <div
                                    key={request.id}
                                    className="rounded-sm border border-white/10 bg-[#111111] px-4 py-3"
                                  >
                                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                      <div className="min-w-0">
                                        <p className="text-sm text-white font-bold tracking-tight">
                                          {request.requestedAmount.toFixed(2)} USDC requested
                                        </p>
                                        <p className="font-mono text-[10px] text-[#8f8f95] mt-1">
                                          {new Date(request.createdAt).toLocaleString()} •{" "}
                                          {request.employeeWallet.slice(0, 6)}...
                                          {request.employeeWallet.slice(-6)}
                                        </p>
                                        {request.note ? (
                                          <p className="text-[11px] text-[#a8a8aa] mt-2 leading-relaxed italic">
                                            {request.note}
                                          </p>
                                        ) : null}
                                      </div>
                                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                                        <button
                                          onClick={() =>
                                            handleRunTick(stream, {
                                              cashoutRequest: request,
                                            })
                                          }
                                          disabled={
                                            runningTick ||
                                            runningTickStream !== null ||
                                            settlingTickStream !== null ||
                                            !isOnboarded ||
                                            !isRecipientPrivateReady
                                          }
                                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 text-[11px] font-bold transition-all disabled:opacity-30 uppercase tracking-wider shadow-sm"
                                        >
                                          <Zap size={13} />
                                          Settle Now
                                        </button>
                                        <button
                                          onClick={() =>
                                            handleResolveCashoutRequest(
                                              request,
                                              "dismissed",
                                              "Dismissed by employer from the payroll dashboard.",
                                            )
                                          }
                                          disabled={
                                            resolvingCashoutRequestId === request.id
                                          }
                                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm bg-[#0a0a0a] border border-white/10 text-[#a8a8aa] hover:text-white hover:border-white/30 text-[11px] font-bold transition-all disabled:opacity-30 uppercase tracking-wider shadow-sm"
                                        >
                                          {resolvingCashoutRequestId === request.id ? (
                                            <Loader2
                                              size={13}
                                              className="animate-spin"
                                            />
                                          ) : (
                                            <Square size={13} />
                                          )}
                                          Dismiss
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          ) : null}

                          {/* Divider */}
                          <div className="h-px bg-[#111111] mx-5" />

                          {/* Action bar */}
                          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
                            {/* Save Draft / Create Draft / Restart Stream */}
                            <button
                              onClick={() =>
                                effectiveStatus === "stopped"
                                  ? stream &&
                                  handleRestartStoppedStream(stream)
                                  : handleSaveDraftStream(employee)
                              }
                              disabled={
                                !walletAddress ||
                                savingStream === employee.id ||
                                restartingStream === stream?.id ||
                                mustSettleBeforeRestart
                              }
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0f0f10] text-white hover:bg-black text-[11px] font-bold transition-all disabled:opacity-50 uppercase tracking-wider border border-white/10"
                            >
                              {savingStream === employee.id ||
                                restartingStream === stream?.id ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : effectiveStatus === "stopped" ? (
                                <RotateCcw size={13} />
                              ) : (
                                <Save size={13} />
                              )}
                              {effectiveStatus === "stopped"
                                ? "Restart Stream"
                                : stream
                                  ? "Save Draft"
                                  : "Create Draft"}
                            </button>

                            <Link
                              href={`/people/${employee.id}`}
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0a0a0a] border border-white/15 text-[#b6b6bc] hover:text-white hover:border-white/30 text-[11px] font-bold transition-all uppercase tracking-wider no-underline"
                            >
                              <Users size={13} />
                              Open Profile
                            </Link>

                            {/* Separator */}
                            <div className="w-px h-5 bg-neutral-300" />

                            {/* Run Tick */}
                            {stream && (
                              <>
                                <div className="inline-flex items-center gap-2 rounded-sm border border-white/15 bg-[#0a0a0a] px-4 py-2">
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min={0}
                                    step={0.01}
                                    value={tickAmountInputs[stream.id] ?? ""}
                                    onChange={(event) =>
                                      setTickAmountInputs((prev) => ({
                                        ...prev,
                                        [stream.id]: event.target.value,
                                      }))
                                    }
                                    placeholder={
                                      preview
                                        ? `Max ${formatMicroUsdc(
                                          preview.state.effectiveClaimableAmountMicro,
                                        )}`
                                        : "Full accrued"
                                    }
                                    className="w-28 bg-transparent font-mono text-[11px] text-white placeholder:text-[#8f8f95] outline-none"
                                    style={{ MozAppearance: "textfield" }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!preview) {
                                        toast.error(
                                          "Refresh State first to load the current accrued amount",
                                        );
                                        return;
                                      }

                                      const maxAmount =
                                        Number(
                                          preview.state
                                            .effectiveClaimableAmountMicro,
                                        ) /
                                        1_000_000;

                                      if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
                                        toast.error(
                                          "No accrued private payroll is available to settle",
                                        );
                                        return;
                                      }

                                      setTickAmountInputs((prev) => ({
                                        ...prev,
                                        [stream.id]: maxAmount.toFixed(6),
                                      }));
                                    }}
                                    disabled={!preview || hasMissingPrivateState}
                                    className="inline-flex min-h-8 items-center justify-center rounded-sm px-2 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300 transition-colors hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    Max
                                  </button>
                                  <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#8f8f95]">
                                    USDC
                                  </span>
                                </div>
                                <button
                                  onClick={() => {
                                    const rawAmount =
                                      tickAmountInputs[stream.id] ?? "";
                                    const parsedAmount = rawAmount.trim()
                                      ? Number.parseFloat(rawAmount)
                                      : undefined;

                                    if (
                                      parsedAmount !== undefined &&
                                      (!Number.isFinite(parsedAmount) ||
                                        parsedAmount <= 0)
                                    ) {
                                      toast.error(
                                        "Enter a valid settlement amount",
                                      );
                                      return;
                                    }

                                    if (
                                      parsedAmount !== undefined &&
                                      preview
                                    ) {
                                      const maxClaimableNow =
                                        Number(
                                          preview.state
                                            .effectiveClaimableAmountMicro,
                                        ) / 1_000_000;
                                      if (
                                        Number.isFinite(maxClaimableNow) &&
                                        parsedAmount > maxClaimableNow
                                      ) {
                                        toast.error(
                                          `Amount exceeds claimable cap (${maxClaimableNow.toFixed(6)} USDC)`,
                                        );
                                        return;
                                      }
                                    }

                                    handleRunTick(stream, {
                                      settlementAmountMicro:
                                        parsedAmount !== undefined
                                          ? Math.round(parsedAmount * 1_000_000)
                                          : undefined,
                                    });
                                  }}
                                  disabled={
                                    !walletAddress ||
                                    runningTick ||
                                    runningTickStream !== null ||
                                    settlingTickStream !== null ||
                                    !isOnboarded ||
                                    !isRecipientPrivateReady ||
                                    (effectiveStatus === "stopped" &&
                                      hasMissingPrivateState)
                                  }
                                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0f0f10] border border-white/10 text-white hover:bg-black text-[11px] font-bold transition-all disabled:opacity-60 shadow-sm uppercase tracking-wider"
                                >
                                  {runningTickStream === stream.id ||
                                    settlingTickStream === stream.id ? (
                                    <Loader2
                                      size={13}
                                      className="animate-spin"
                                    />
                                  ) : (
                                    <Zap size={13} />
                                  )}
                                  {settlingTickStream === stream.id
                                    ? "Settling Tick"
                                    : (tickAmountInputs[stream.id] ?? "").trim() !== ""
                                      ? `Settle ${Number.parseFloat(
                                        tickAmountInputs[stream.id] ?? "",
                                      ) > 0
                                        ? Number.parseFloat(
                                          tickAmountInputs[stream.id] ?? "",
                                        ).toFixed(2)
                                        : "..."
                                      } USDC`
                                      : effectiveStatus === "stopped" &&
                                        hasMissingPrivateState
                                        ? "No PER State"
                                        : effectiveStatus === "stopped"
                                          ? "Settle Remaining"
                                          : "Settle All"}
                                </button>
                              </>
                            )}

                            {/* Onboard PER */}
                            <button
                              onClick={() =>
                                stream && handleOnboardToPer(stream)
                              }
                              disabled={
                                !walletAddress ||
                                onboardingStream === stream?.id ||
                                isOnboarded ||
                                !stream
                              }
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0f0f10] border border-white/10 text-white hover:bg-black text-[11px] font-bold transition-all disabled:opacity-60 shadow-sm uppercase tracking-wider"
                            >
                              {onboardingStream === stream?.id ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <Sparkles size={13} />
                              )}
                              {isOnboarded ? "PER Onboarded" : "Onboard PER"}
                            </button>



                            {/* Resume */}
                            <button
                              onClick={() =>
                                stream &&
                                handleControlStream(stream, "resume")
                              }
                              disabled={
                                !walletAddress ||
                                controllingStream === stream?.id ||
                                !stream ||
                                !isOnboarded ||
                                effectiveStatus !== "paused"
                              }
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0a0a0a] border border-white/15 text-emerald-300 hover:bg-emerald-500/10 text-[11px] font-bold transition-all disabled:opacity-60 uppercase tracking-wider shadow-sm"
                            >
                              {controllingStream === stream?.id ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <PlayCircle size={13} />
                              )}
                              Resume
                            </button>

                            {/* Pause */}
                            <button
                              onClick={() =>
                                stream && handleControlStream(stream, "pause")
                              }
                              disabled={
                                !walletAddress ||
                                controllingStream === stream?.id ||
                                !stream ||
                                !isOnboarded ||
                                effectiveStatus !== "active"
                              }
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0a0a0a] border border-white/15 text-[#b6b6bc] hover:text-white hover:border-white/30 text-[11px] font-bold transition-all disabled:opacity-60 uppercase tracking-wider shadow-sm"
                            >
                              <Pause size={13} />
                              Pause
                            </button>

                            {/* Stop */}
                            <button
                              onClick={() =>
                                stream && handleControlStream(stream, "stop")
                              }
                              disabled={
                                !walletAddress ||
                                controllingStream === stream?.id ||
                                !stream ||
                                !isOnboarded ||
                                effectiveStatus === "stopped"
                              }
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0a0a0a] border border-white/15 text-red-400 hover:bg-red-500/10 text-[11px] font-bold transition-all disabled:opacity-60 uppercase tracking-wider shadow-sm"
                            >
                              <Square size={13} />
                              Stop
                            </button>


                            {effectiveStatus === "stopped" ? (
                              <p className="w-full text-[10px] text-[#8f8f95] font-medium">
                                Stopped on-chain. Cannot be resumed. Use Restart Stream to reset.
                              </p>
                            ) : null}

                            {/* Refresh Preview */}
                            {stream && (
                              <button
                                onClick={() => fetchPrivatePreview(stream)}
                                disabled={
                                  !walletAddress ||
                                  refreshingPreview === stream.id ||
                                  !isOnboarded
                                }
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#0a0a0a] border border-white/15 text-[#b6b6bc] hover:text-white hover:border-white/30 text-[11px] font-bold transition-all disabled:opacity-60 uppercase tracking-wider shadow-sm"
                              >
                                {refreshingPreview === stream.id ? (
                                  <Loader2
                                    size={13}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <RefreshCw size={13} />
                                )}
                                Refresh State
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </EmployerLayout>
  );
}

export default function EmployerPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center"><div className="animate-pulse text-[#a8a8aa] text-sm font-medium">Loading...</div></div>}>
      <EmployerPageContent />
    </Suspense>
  );
}
