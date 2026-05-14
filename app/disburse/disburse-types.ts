import type { PaySchedule } from "@/lib/payroll-math";
import type {
  CheckpointCrankStatus,
} from "@/lib/checkpoint-sync";
import type { PayrollPayoutMode } from "@/lib/payroll-payout-mode";

export interface ManagedEmployee {
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
  privateRecipientInitStatus?: "pending" | "processing" | "confirmed" | "failed";
  privateRecipientInitRequestedAt?: string | null;
  privateRecipientInitLastAttemptAt?: string | null;
  privateRecipientInitConfirmedAt?: string | null;
  privateRecipientInitTxSignature?: string | null;
  privateRecipientInitError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StreamStatus = "active" | "paused" | "stopped";
export type PrivateInitStatus = "pending" | "processing" | "confirmed" | "failed";

export interface PayrollStream {
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
  checkpointCrankStatus?: CheckpointCrankStatus;
  checkpointCrankUpdatedAt?: string | null;
  lastPaidAt: string | null;
  totalPaid: number;
  status: StreamStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PrivatePayrollStateResponse {
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
    checkpointCrankStatus?: CheckpointCrankStatus | null;
    checkpointCrankUpdatedAt?: string | null;
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
    rawClaimableAmountMicro: string;
    pendingAccrualMicro: string;
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

export interface OnboardTransactionsResponse {
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
    resumeStream?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
}

export interface TickBuildResult {
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
  transferSignature?: string;
  transferSendTo?: string;
  accountingOnly?: boolean;
  settlementAlreadyApplied?: boolean;
  transactions?: {
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

export interface TickBuildResponse {
  employerWallet: string;
  processed: number;
  message?: string;
  results: TickBuildResult[];
}

export type StreamControlAction = "update-rate" | "pause" | "resume" | "stop";

export interface StreamControlBuildResponse {
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

export interface CheckpointCrankBuildResponse {
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

export interface RestartStreamBuildResponse {
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

export type MagicBlockHealthState = "checking" | "ok" | "error";

export type CashoutRequestStatus =
  | "pending"
  | "requested"
  | "paying"
  | "paid"
  | "failed"
  | "needs_sync"
  | "fulfilled"
  | "dismissed"
  | "cancelled";

export interface CashoutRequestRecord {
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
  isOnChain?: boolean;
  resolvedAt?: string | null;
  resolvedByWallet?: string | null;
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DataSourceBadge = "live-per" | "backend" | "unavailable";

export type StoppedLifecyclePhase =
  | "not_stopped"
  | "fully_closed"
  | "needs_settlement"
  | "ready_to_close";
