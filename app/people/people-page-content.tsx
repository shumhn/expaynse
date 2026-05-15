"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Users,
  Search,
  Plus,
  Loader2,
  PauseCircle,
  Calendar,
  TrendingUp,
  Ban,
  Bell,
  Shield,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import {
  getOrCreateCachedTeeToken,
  loadCachedTeeToken,
} from "@/lib/client/tee-auth-cache";
import {
  fetchTeeAuthToken,
  isJwtExpired,
} from "@/lib/magicblock-api";
import {
  monthlyUsdToRatePerSecond,
} from "@/lib/payroll-math";
import {
  DEFAULT_PAYROLL_PAYOUT_MODE,
  allowedPayoutModesFor,
  type PayrollPayoutMode,
} from "@/lib/payroll-payout-mode";
import {
  PAYROLL_MODE_OPTIONS,
  payrollModeLabel,
  type PayrollMode,
} from "@/lib/payroll-mode";
import Link from "next/link";
import {
  InteractiveGuide,
  type GuideStep,
  useGuideStatus,
  useGuideTargetReady,
} from "@/components/ui/interactive-guide";

const PEOPLE_ONBOARDING_HANDOFF_KEY = "expaynse:people-onboarding-handoff";

interface Employee {
  id: string;
  wallet: string;
  name: string;
  payrollMode?: PayrollMode;
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
    teeObservedAt?: string;
    ratePerSecondMicro?: string;
    accruedUnpaidMicro: string;
    rawClaimableAmountMicro: string;
    pendingAccrualMicro?: string;
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

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
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

function isPerReady(stream: StreamInfo | null) {
  if (!stream) return false;
  return Boolean(stream.privatePayrollPda && stream.employeePda && stream.delegatedAt);
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

const PAYROLL_MODE_GUIDE_STEPS: GuideStep[] = [
  {
    id: "mode-picker",
    target: '[data-guide="payroll-mode-picker"]',
    title: "Choose the payroll mode",
    description: "Start here. Pick whether this employee should receive instant private payroll or live real-time streaming.",
    position: "right",
  },
  {
    id: "private-payroll",
    target: '[data-guide="mode-private-payroll"]',
    title: "Instant private payroll",
    description: "Use this when you want private salary payouts without running a live stream.",
    position: "right",
  },
  {
    id: "streaming-payroll",
    target: '[data-guide="mode-streaming"]',
    title: "Real-time streaming",
    description: "Use this when salary should accrue every second and the employee can access pay continuously.",
    position: "right",
  },
  {
    id: "salary-input",
    target: '[data-guide="salary-input"]',
    title: "Set the monthly salary",
    description: "Enter the employee's monthly amount here. We compute the live per-second rate automatically for streaming mode.",
    position: "left",
  },
  {
    id: "create-employee",
    target: '[data-guide="create-employee"]',
    title: "Create the employee flow",
    description: "Finish here. Once the employee is added, the selected payroll mode takes over the rest of the onboarding path.",
    position: "top",
  },
];

const PAYROLL_MODE_CTA_LABEL: Record<PayrollMode, string> = {
  private_payroll: "Add Employee",
  streaming: "Add Employee & Start Stream",
};

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
    const rawClaimable =
      Number(preview.state.rawClaimableAmountMicro) / 1_000_000;
    const totalPaidPrivate =
      Number(preview.state.totalPaidPrivateMicro) / 1_000_000;
    if (Number.isFinite(rawClaimable) && Number.isFinite(totalPaidPrivate)) {
      return Math.max(0, rawClaimable + totalPaidPrivate);
    }
  }
  return null;
}

export default function PeoplePage() {
  const { publicKey, signMessage } = useWallet();
  const walletAddr = publicKey?.toBase58();
  const payrollGuideScope = walletAddr || "guest";
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
  const [newPayrollMode, setNewPayrollMode] = useState<PayrollMode>("streaming");
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
  const [initializingWallets, setInitializingWallets] = useState<string[]>([]);
  const tokenCache = useRef<string | null>(null);
  const autoInitAttemptedWallets = useRef<Set<string>>(new Set());
  const [payrollGuideOpenForWallet, setPayrollGuideOpenForWallet] = useState<string | null>(null);
  const [hasShownPayrollGuideForWallet, setHasShownPayrollGuideForWallet] = useState<string | null>(null);
  const hasShownPayrollGuide = !!walletAddr && hasShownPayrollGuideForWallet === walletAddr;
  const isPayrollGuideOpen = !!walletAddr && payrollGuideOpenForWallet === walletAddr;
  const { hasCompleted: hasCompletedPayrollGuide } = useGuideStatus(
    "payroll-modes",
    payrollGuideScope,
  );
  const firstPayrollGuideTarget = PAYROLL_MODE_GUIDE_STEPS[0]?.target;
  const isPayrollGuideTargetReady = useGuideTargetReady(firstPayrollGuideTarget, {
    enabled: showAdd && !hasCompletedPayrollGuide && !hasShownPayrollGuide,
  });
  const [streamModalEmployee, setStreamModalEmployee] = useState<Employee | null>(null);
  const [streamSalaryInput, setStreamSalaryInput] = useState("");
  const [startingStream, setStartingStream] = useState(false);

  // Keep a local clock so live accrued values update without a server round trip.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (
      !showAdd ||
      hasCompletedPayrollGuide ||
      hasShownPayrollGuide ||
      !isPayrollGuideTargetReady
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setPayrollGuideOpenForWallet(walletAddr ?? null);
      setHasShownPayrollGuideForWallet(walletAddr ?? null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    showAdd,
    hasCompletedPayrollGuide,
    hasShownPayrollGuide,
    walletAddr,
    isPayrollGuideTargetReady,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const shouldHandoff = window.sessionStorage.getItem(PEOPLE_ONBOARDING_HANDOFF_KEY);
    if (!shouldHandoff) return;

    window.sessionStorage.removeItem(PEOPLE_ONBOARDING_HANDOFF_KEY);
    const frame = window.requestAnimationFrame(() => {
      setShowAdd(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  const [adding, setAdding] = useState(false);

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
  const selectedPayrollModeCtaLabel = PAYROLL_MODE_CTA_LABEL[newPayrollMode];

  const initializePrivatePayrollRecipient = useCallback(
    async (
      employee: Employee,
      options?: {
        showSuccessToast?: boolean;
        showFailureToast?: boolean;
      },
    ) => {
      if (!walletAddr) {
        throw new Error("Connect your wallet first");
      }

      if (!signMessage) {
        throw new Error("Wallet message signing is required");
      }

      setInitializingWallets((prev) =>
        prev.includes(employee.wallet) ? prev : [...prev, employee.wallet],
      );
      setEmployees((prev) =>
        prev.map((row) =>
          row.wallet === employee.wallet
            ? {
                ...row,
                privateRecipientInitStatus: "processing",
                privateRecipientInitError: null,
              }
            : row,
        ),
      );

      try {
        const autoInitResponse = await walletAuthenticatedFetch({
          wallet: walletAddr,
          signMessage,
          path: "/api/employees/auto-init",
          method: "POST",
          body: {
            employerWallet: walletAddr,
            employeeWallet: employee.wallet,
          },
        });

        const autoInitJson = (await autoInitResponse.json()) as {
          employee?: Employee;
          error?: string;
        };

        if (!autoInitResponse.ok || !autoInitJson.employee) {
          throw new Error(
            autoInitJson.error || "Failed to auto-initialize private account",
          );
        }

        setEmployees((prev) =>
          prev.map((row) =>
            row.id === autoInitJson.employee?.id ? autoInitJson.employee : row,
          ),
        );

        if (options?.showSuccessToast !== false) {
          toast.success("Private payroll account initialized.");
        }

        return autoInitJson.employee;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Private payroll initialization failed";

        setEmployees((prev) =>
          prev.map((row) =>
            row.wallet === employee.wallet
              ? {
                  ...row,
                  privateRecipientInitStatus: "failed",
                  privateRecipientInitError: message,
                }
              : row,
          ),
        );

        if (options?.showFailureToast !== false) {
          toast.error(message);
        }

        return null;
      } finally {
        setInitializingWallets((prev) =>
          prev.filter((wallet) => wallet !== employee.wallet),
        );
      }
    },
    [signMessage, walletAddr],
  );

  const handleStartStream = async (employee: Employee, monthlySalary: number) => {
    if (!walletAddr || !signMessage) return;

    setStartingStream(true);
    try {
      const ratePerSecond = monthlyUsdToRatePerSecond(monthlySalary);
          
      if (ratePerSecond <= 0) {
        toast.error("Monthly salary must be a positive number.");
        return;
      }

      const startDateTimeIso = new Date().toISOString();

      // Persist streaming mode first so downstream flows (stream creation, UI state)
      // use a single canonical payroll mode.
      const empRes = await walletAuthenticatedFetch({
        wallet: walletAddr,
        signMessage,
        path: `/api/employees/${employee.id}`,
        method: "PATCH",
        body: {
          employerWallet: walletAddr,
          payrollMode: "streaming",
        },
      });

      if (!empRes.ok) {
        const empJson = await empRes.json();
        throw new Error(empJson.error || "Failed to update employee mode");
      }

      setEmployees((prev) =>
        prev.map((e) => (e.id === employee.id ? { ...e, payrollMode: "streaming", monthlySalaryUsd: monthlySalary } : e))
      );

      // Create and activate the stream with a fresh compensation snapshot.
      const streamRes = await walletAuthenticatedFetch({
        wallet: walletAddr,
        signMessage,
        path: "/api/streams",
        method: "POST",
        body: {
          employerWallet: walletAddr,
          employeeId: employee.id,
          ratePerSecond,
          startsAt: startDateTimeIso,
          status: "active",
          payoutMode: DEFAULT_PAYROLL_PAYOUT_MODE,
          allowedPayoutModes: allowedPayoutModesFor(),
          compensationSnapshot: {
            employmentType: employee.employmentType,
            paySchedule: employee.paySchedule,
            compensationUnit: "monthly",
            compensationAmountUsd: monthlySalary,
            monthlySalaryUsd: monthlySalary,
            startsAt: startDateTimeIso,
          },
        },
      });

      const streamJson = await streamRes.json();
      if (!streamRes.ok) {
        throw new Error(streamJson.error || "Failed to start stream");
      }

      if (streamJson.stream) {
        setStreams((prev) => [streamJson.stream, ...prev]);
        toast.success(`Stream started for ${employee.name} at $${monthlySalary.toFixed(2)}/month`);
      }

      setStreamModalEmployee(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to start stream");
    } finally {
      setStartingStream(false);
    }
  };

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
          payrollMode: newPayrollMode,
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

      let employee = employeeJson.employee as Employee;
      if (
        employee.privateRecipientInitStatus !== "confirmed" &&
        !!signMessage
      ) {
        employee =
          (await initializePrivatePayrollRecipient(employee, {
            showSuccessToast: false,
            showFailureToast: false,
          })) ?? employee;
      }
      if (employee.payrollMode !== "private_payroll") {
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
            allowedPayoutModes: allowedPayoutModesFor(),
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

        if (streamRes.ok && streamJson.stream) {
          setStreams((prev) => [streamJson.stream, ...prev]);
        } else {
          toast.warning("Employee added, but stream setup needs attention");
        }
      }

      setEmployees((prev) => [employee, ...prev]);

      setShowAdd(false);
      setNewName("");
      setNewWallet("");
      setNewDepartment(DEPARTMENT_OPTIONS[0]);
      setNewRole(ROLE_OPTIONS_BY_DEPARTMENT[DEPARTMENT_OPTIONS[0]][0]);
      setNewCompensationAmount("");
      setNewPayrollMode("streaming");
      setNewPayoutMode(DEFAULT_PAYROLL_PAYOUT_MODE);
      if (employee.payrollMode === "private_payroll") {
        if (employee.privateRecipientInitStatus === "confirmed") {
          toast.success("Employee added and private payroll is ready.");
        } else {
          toast.success(
            "Employee added in private payroll mode. Private setup can finish from the employer flow if needed.",
          );
        }
      } else if (employee.privateRecipientInitStatus === "confirmed") {
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

  useEffect(() => {
    if (!walletAddr || !signMessage) return;
    if (initializingWallets.length > 0) return;

    const nextAutoInitEmployee = employees.find((employee) => {
      if (employee.privateRecipientInitStatus === "confirmed") return false;
      if (autoInitAttemptedWallets.current.has(employee.wallet)) return false;
      return true;
    });

    if (!nextAutoInitEmployee) return;

    autoInitAttemptedWallets.current.add(nextAutoInitEmployee.wallet);
    void initializePrivatePayrollRecipient(nextAutoInitEmployee, {
      showSuccessToast: false,
      showFailureToast: false,
    });
  }, [
    employees,
    initializePrivatePayrollRecipient,
    initializingWallets.length,
    signMessage,
    walletAddr,
  ]);

  return (
    <EmployerLayout>
      <div className="max-w-6xl mx-auto">
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

        <div className="bg-[#0a0a0a] border border-white/5 rounded-3xl overflow-hidden shadow-sm">
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

          {!loading && filtered.length > 0 && (
            <div className="grid grid-cols-[1.8fr_0.8fr_0.8fr_1fr_0.8fr_1.8fr] gap-4 items-center px-6 py-4 border-b border-white/5 bg-white/[0.02]">
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Employee</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Start Date</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Salary</div>
              <div className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">Accrued Live</div>
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
                const privateInitStatus = getPrivateInitStatus(emp, stream);
                const isStreamingLive =
                  emp.payrollMode !== "private_payroll" &&
                  Boolean(stream) &&
                  status === "active" &&
                  perReady &&
                  !hasFutureStart &&
                  !hasMissingPrivateState &&
                  hasFreshPreview &&
                  hasFreshCheckpointProgress;
                const statusLabel =
                  emp.payrollMode === "private_payroll"
                    ? privateInitStatus === "confirmed"
                      ? "Ready"
                      : privateInitStatus === "processing"
                        ? "Syncing"
                        : "Setup"
                    : isStreamingLive
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
                  emp.payrollMode === "private_payroll"
                    ? privateInitStatus === "confirmed"
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                      : privateInitStatus === "processing"
                        ? "bg-blue-500/15 text-blue-300 border-blue-400/30"
                        : "bg-amber-500/15 text-amber-300 border-amber-400/30"
                    : isStreamingLive
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
                return (
                  <div
                    key={emp.id}
                    className="grid grid-cols-[1.8fr_0.8fr_0.8fr_1fr_0.8fr_1.8fr] gap-4 items-center px-6 py-5 hover:bg-white/5 transition-all duration-200"
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
                        <div className="mt-1 flex items-center gap-2">
                          <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#a8a8aa]">
                            {payrollModeLabel(emp.payrollMode)}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#8f8f95] font-mono truncate">
                          {shorten(emp.wallet)}
                        </p>
                      </div>
                    </div>

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
                            {emp.payrollMode === "private_payroll"
                              ? "Manual payout"
                              : stream?.checkpointCrankStatus === "active" && hasFreshPreview
                              ? "Checkpoint stale"
                              : status === "active"
                                ? "Needs sync"
                                : "—"}
                          </span>
                        </>
                      )}
                    </div>

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
                        ) : emp.payrollMode === "private_payroll" ? (
                          <>
                            <Shield size={10} />
                            {statusLabel}
                          </>
                        ) : (
                          <>
                            <Ban size={10} />
                            {statusLabel}
                          </>
                        )}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-2.5 flex-wrap">
                      {emp.payrollMode === "private_payroll" &&
                      getPrivateInitStatus(emp, stream) !== "confirmed" ? (
                        <button
                          onClick={() => {
                            void initializePrivatePayrollRecipient(emp);
                          }}
                          disabled={
                            !signMessage ||
                            initializingWallets.includes(emp.wallet)
                          }
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#1eba98] bg-[#1eba98]/10 border border-[#1eba98]/30 rounded-xl hover:bg-[#1eba98]/15 transition-colors disabled:opacity-50"
                        >
                          {initializingWallets.includes(emp.wallet) ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            "Init"
                          )}
                        </button>
                      ) : null}
                      {!stream ? (
                        <button
                          onClick={() => {
                            const defaultSalary = emp.monthlySalaryUsd ?? emp.compensationAmountUsd ?? 0;
                            setStreamSalaryInput(defaultSalary > 0 ? defaultSalary.toString() : "");
                            setStreamModalEmployee(emp);
                          }}
                          disabled={!signMessage}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#1eba98] bg-[#1eba98]/10 border border-[#1eba98]/30 rounded-xl hover:bg-[#1eba98]/15 transition-colors disabled:opacity-50"
                        >
                          <Play size={12} />
                          Stream
                        </button>
                      ) : null}
                      <Link
                        href={`/people/${emp.id}`}
                        title="View Profile"
                        className="inline-flex items-center justify-center w-9 h-9 text-[#a8a8aa] bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 hover:text-white transition-colors no-underline"
                      >
                        <Users size={15} />
                      </Link>
                      {stream ? (
                        <Link
                          href={`/disburse?employee=${emp.id}`}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-colors no-underline"
                        >
                          <TrendingUp size={13} />
                          Stream
                        </Link>
                      ) : null}
                      <Link
                        href={`/disburse/manual?employee=${emp.id}`}
                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl hover:bg-amber-500/15 transition-colors no-underline"
                      >
                        <Shield size={13} />
                        Private
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          onClick={() => {
            setShowAdd(false);
            setPayrollGuideOpenForWallet(null);
          }}
        >
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
          <div
            className="relative w-full max-w-lg bg-[#0a0a0a] border border-white/10 rounded-3xl shadow-2xl p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Add employee</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPayrollGuideOpenForWallet(walletAddr ?? null)}
                  className="rounded-full border border-[#1eba98]/25 bg-[#1eba98]/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#1eba98] transition-colors hover:bg-[#1eba98]/15"
                >
                  Quick guide
                </button>
                <button
                  onClick={() => {
                    setShowAdd(false);
                    setPayrollGuideOpenForWallet(null);
                  }}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 text-[#8f8f95] hover:text-white hover:bg-white/10 transition-colors"
                >
                  &times;
                </button>
              </div>
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
              <div className="grid grid-cols-2 items-start gap-4">
                <div data-guide="payroll-mode-picker">
                  <label className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[#8f8f95]">
                    Payroll Mode
                  </label>
                  <div className="space-y-3">
                    {PAYROLL_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setNewPayrollMode(option.value)}
                        data-guide={
                          option.value === "private_payroll"
                            ? "mode-private-payroll"
                            : option.value === "streaming"
                              ? "mode-streaming"
                              : undefined
                        }
                        className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                          newPayrollMode === option.value
                            ? "border-[#1eba98]/50 bg-[#1eba98]/10"
                            : "border-white/10 bg-white/5 hover:bg-white/10"
                        } min-h-[88px]`}
                      >
                        <p className="text-sm font-semibold text-white">
                          {option.label}
                        </p>
                        <p className="mt-1 text-[11px] text-[#8f8f95]">
                          {option.description}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-4">
                  <div data-guide="salary-input" className="min-h-[120px]">
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[#8f8f95]">
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
                        className="w-full pl-8 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#8f8f95] focus:outline-none focus:border-[#1eba98]/30 focus:ring-1 focus:ring-[#1eba98]/12"
                      />
                    </div>
                    <div className="mt-2 min-h-[16px]">
                      {parsedAmount > 0 ? (
                        <p className="text-[11px] font-mono text-[#8f8f95]">
                          {previewRatePerSecond.toFixed(8)} USDC/sec
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="min-h-[120px]">
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[#8f8f95]">
                      {newPayrollMode === "private_payroll" ? "Payout mode" : "Settlement mode"}
                    </label>
                    <div className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/50 cursor-not-allowed">
                      {newPayrollMode === "private_payroll"
                        ? "Private payroll payouts"
                        : "Private stream (ephemeral)"}
                    </div>
                    <div className="mt-2 min-h-[16px]" />
                  </div>
                </div>
              </div>
              {newPayrollMode !== "private_payroll" && (
                <div>
                  <label className="text-[11px] font-bold text-[#8f8f95] uppercase tracking-wider mb-1.5 block">
                    Stream starts at
                  </label>
                  <div className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/50 cursor-not-allowed">
                    Immediately upon onboarding
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={handleAdd}
              data-guide="create-employee"
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
                selectedPayrollModeCtaLabel
              )}
            </button>
          </div>
        </div>
      )}
      <InteractiveGuide
        steps={PAYROLL_MODE_GUIDE_STEPS}
        isOpen={showAdd && isPayrollGuideOpen}
        onClose={() => setPayrollGuideOpenForWallet(null)}
        onComplete={() => setPayrollGuideOpenForWallet(null)}
        storageKeyPrefix="payroll-modes"
        storageScopeKey={payrollGuideScope}
      />

      {streamModalEmployee && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          onClick={() => { if (!startingStream) setStreamModalEmployee(null); }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-md rounded-[2rem] border border-white/10 bg-[#0a0a0a] p-8 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold text-white tracking-tight mb-1">
              Start Streaming
            </h2>
            <p className="text-sm text-[#8f8f95] mb-6">
              Set the monthly salary for <span className="text-white font-semibold">{streamModalEmployee.name}</span> and start real-time per-second streaming.
            </p>

            <div className="space-y-5">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-[#8f8f95]">Employee</span>
                  <span className="text-xs text-[#8f8f95] font-mono">
                    {streamModalEmployee.wallet.slice(0, 6)}...{streamModalEmployee.wallet.slice(-4)}
                  </span>
                </div>
                <p className="text-base font-bold text-white">{streamModalEmployee.name}</p>
                {streamModalEmployee.department && (
                  <p className="text-xs text-[#8f8f95] mt-1">{streamModalEmployee.department} · {streamModalEmployee.role || "—"}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-[#8f8f95] mb-2">
                  Monthly Salary (USDC)
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8f8f95] font-bold text-sm">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={streamSalaryInput}
                    onChange={(e) => setStreamSalaryInput(e.target.value)}
                    placeholder="e.g. 3000"
                    className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pl-8 pr-4 text-white text-lg font-bold outline-none focus:border-[#1eba98]/40 focus:ring-2 focus:ring-[#1eba98]/10 transition-all placeholder:text-[#555]"
                    autoFocus
                  />
                </div>
                {parseFloat(streamSalaryInput) > 0 && (
                  <p className="mt-2 text-xs text-[#8f8f95]">
                    Rate: <span className="text-white font-mono">${(monthlyUsdToRatePerSecond(parseFloat(streamSalaryInput)) * 86400).toFixed(6)}</span> USDC/day
                  </p>
                )}
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setStreamModalEmployee(null)}
                disabled={startingStream}
                className="flex-1 rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-[#8f8f95] hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const salary = parseFloat(streamSalaryInput);
                  if (!salary || salary <= 0) {
                    toast.error("Enter a valid monthly salary");
                    return;
                  }
                  void handleStartStream(streamModalEmployee, salary);
                }}
                disabled={startingStream || !parseFloat(streamSalaryInput)}
                className="flex-1 rounded-xl bg-[#1eba98] py-3 text-sm font-bold text-black hover:bg-[#1eba98]/80 transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(30,186,152,0.25)] flex items-center justify-center gap-2"
              >
                {startingStream ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    Start Stream
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </EmployerLayout>
  );
}
