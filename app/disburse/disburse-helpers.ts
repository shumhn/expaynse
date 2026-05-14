import { clusterApiUrl } from "@solana/web3.js";

import {
  CHECKPOINT_STALE_GRACE_MS,
  isCheckpointSyncRunning,
  isCheckpointTimestampFresh,
} from "@/lib/checkpoint-sync";

import type {
  DataSourceBadge,
  ManagedEmployee,
  PayrollStream,
  PrivateInitStatus,
  PrivatePayrollStateResponse,
  StreamStatus,
} from "./disburse-types";

export const DEPARTMENT_OPTIONS = [
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

export const ROLE_OPTIONS_BY_DEPARTMENT: Record<string, string[]> = {
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

export const STREAM_STATUS_PRIORITY: Record<StreamStatus, number> = {
  active: 3,
  paused: 2,
  stopped: 1,
};

export const BASE_DEVNET_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("devnet");
export const BASE_DEVNET_RPC_FALLBACKS = Array.from(
  new Set([BASE_DEVNET_RPC_URL, clusterApiUrl("devnet")].filter(Boolean)),
);

export function resolvePrivateInitStatus(
  employee: ManagedEmployee,
  stream: PayrollStream | null | undefined,
): PrivateInitStatus {
  if (
    stream?.recipientPrivateInitializedAt ||
    employee.privateRecipientInitializedAt ||
    employee.privateRecipientInitConfirmedAt
  ) {
    return "confirmed";
  }

  return employee.privateRecipientInitStatus ?? "pending";
}

export function getPrivateInitBadge(status: PrivateInitStatus) {
  if (status === "confirmed") {
    return {
      label: "INIT READY",
      className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    };
  }

  if (status === "processing") {
    return {
      label: "INIT SYNCING",
      className: "bg-blue-500/10 text-blue-300 border-blue-400/30",
    };
  }

  if (status === "failed") {
    return {
      label: "INIT FAILED",
      className: "bg-rose-500/10 text-rose-300 border-rose-500/30",
    };
  }

  return {
    label: "INIT PENDING",
    className: "bg-amber-500/10 text-amber-400 border-amber-300",
  };
}

export function sourceBadgeMeta(source: DataSourceBadge) {
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

export function getEffectiveStreamStatus(
  stream: PayrollStream | null | undefined,
  preview?: PrivatePayrollStateResponse | null,
): StreamStatus | null {
  return preview?.state.status ?? preview?.stream.status ?? stream?.status ?? null;
}

export function isCheckpointStateFresh(
  stream: PayrollStream | null | undefined,
  preview: PrivatePayrollStateResponse | null | undefined,
  nowMs: number,
) {
  if (!stream || !isCheckpointSyncRunning(stream.checkpointCrankStatus) || !preview) {
    return false;
  }

  return isCheckpointTimestampFresh(
    preview.state.lastAccrualTimestamp,
    nowMs,
    CHECKPOINT_STALE_GRACE_MS,
  );
}

export function isMissingPrivateStateMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("private payroll state not found") ||
    normalized.includes("private payroll state account is not initialized") ||
    normalized.includes("private state expired")
  );
}

export function getRemainingPayrollState(
  preview?: PrivatePayrollStateResponse | null,
) {
  const accruedMicro = Number(preview?.state.accruedUnpaidMicro ?? "0");
  const claimableMicro = Number(preview?.state.effectiveClaimableAmountMicro ?? "0");
  const hasAccruedToSettle = Number.isFinite(accruedMicro) && accruedMicro > 0;
  const hasClaimableToSettle =
    Number.isFinite(claimableMicro) && claimableMicro > 0;
  return {
    accruedMicro,
    claimableMicro,
    hasAccruedToSettle,
    hasClaimableToSettle,
    hasRemainingPayrollToSettle: hasAccruedToSettle || hasClaimableToSettle,
  };
}

export function deriveStoppedLifecycleState(args: {
  effectiveStatus: StreamStatus | null | undefined;
  preview?: PrivatePayrollStateResponse | null;
  hasMissingPrivateState: boolean;
}) {
  if (args.effectiveStatus !== "stopped") {
    return {
      phase: "not_stopped" as const,
      isFullyClosed: false,
      mustSettleBeforeClose: false,
      ...getRemainingPayrollState(args.preview),
    };
  }

  if (args.hasMissingPrivateState) {
    return {
      phase: "fully_closed" as const,
      isFullyClosed: true,
      mustSettleBeforeClose: false,
      ...getRemainingPayrollState(args.preview),
    };
  }

  if (!args.preview) {
    return {
      phase: "needs_settlement" as const,
      isFullyClosed: false,
      mustSettleBeforeClose: true,
      ...getRemainingPayrollState(args.preview),
    };
  }

  const remaining = getRemainingPayrollState(args.preview);
  if (remaining.hasRemainingPayrollToSettle) {
    return {
      phase: "needs_settlement" as const,
      isFullyClosed: false,
      mustSettleBeforeClose: true,
      ...remaining,
    };
  }

  return {
    phase: "ready_to_close" as const,
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    ...remaining,
  };
}

export function resolveGoLiveReadiness(args: {
  stream: PayrollStream | null;
  effectiveStatus: StreamStatus;
  isFullyClosed: boolean;
  mustSettleBeforeClose: boolean;
  isOnboarded: boolean;
  isRecipientPrivateReady: boolean;
  privateInitStatus: PrivateInitStatus;
}) {
  if (!args.stream) {
    return {
      label: "Draft missing",
      copy: "Create the draft stream first, then PER onboarding and recipient readiness can complete.",
    };
  }

  if (args.effectiveStatus === "stopped") {
    return {
      label: args.isFullyClosed
        ? "Fresh stream required"
        : args.mustSettleBeforeClose
          ? "Close blocked"
          : "Ready to close",
      copy: args.isFullyClosed
        ? "This stream is fully closed. Create a fresh stream before payroll can go live again."
        : args.mustSettleBeforeClose
          ? "This stopped stream still has payroll left to settle. Settle the remaining amount first, then close the stream."
          : "Remaining payroll is cleared. Close this stopped stream to finish final cleanup.",
    };
  }

  if (!args.isOnboarded) {
    return {
      label: "PER setup needed",
      copy: "Create or re-onboard the employee shell and private payroll state inside MagicBlock PER.",
    };
  }

  if (!args.isRecipientPrivateReady) {
    return {
      label: "Employee init needed",
      copy:
        args.privateInitStatus === "failed"
          ? "The employee must retry private recipient setup from Claim > Withdraw before this stream can go live."
          : "The employee must initialize their private recipient before this stream can go live.",
    };
  }

  if (args.effectiveStatus === "paused") {
    return {
      label: "Ready to go live",
      copy: "Everything is staged correctly. Resume the stream to start live private accrual.",
    };
  }

  if (args.effectiveStatus === "active") {
    return {
      label: "Live now",
      copy: "The stream is already live in MagicBlock PER and accruing privately.",
    };
  }

  return {
    label: "State syncing",
    copy: "Refresh live state if this stream still looks out of sync.",
  };
}

export function isRpcRateLimitError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("429") || message.includes("too many requests");
}

export function formatMicroUsdc(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0.000000";
  return (parsed / 1_000_000).toFixed(6);
}

export function formatUnixTimestamp(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "—";
  return new Date(parsed * 1000).toLocaleTimeString();
}

const usdFormatterCache = new Map<number, Intl.NumberFormat>();

export function formatUsd(value: number, digits = 2) {
  const normalized = Number.isFinite(value) ? value : 0;
  const formatter =
    usdFormatterCache.get(digits) ??
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    });

  if (!usdFormatterCache.has(digits)) {
    usdFormatterCache.set(digits, formatter);
  }

  return formatter.format(normalized);
}
