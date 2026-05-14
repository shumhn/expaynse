import type { PayrollPayoutMode } from "@/lib/payroll-payout-mode";
import type { PayrollMode } from "@/lib/payroll-mode";

export interface EmployeePrivateInitStatusResponse {
  employeeWallet: string;
  registered: boolean;
  initialized: boolean;
  status?: "pending" | "processing" | "confirmed" | "failed";
  requestedAt?: string | null;
  lastAttemptAt?: string | null;
  confirmedAt?: string | null;
  txSignature?: string | null;
  error?: string | null;
  message: string;
}

export interface EmployeePayrollSummaryResponse {
  employeeWallet: string;
  employees: Array<{
    id: string;
    employerWallet: string;
    name: string;
    payrollMode: PayrollMode;
    privateRecipientInitializedAt: string | null;
  }>;
  streams: Array<{
    employerWallet: string;
    employee: {
      id: string;
      wallet: string;
      name: string;
      privateRecipientInitializedAt: string | null;
    };
    stream: {
      id: string;
      status: "active" | "paused" | "stopped";
      ratePerSecond: number;
      payoutMode: PayrollPayoutMode;
      allowedPayoutModes: PayrollPayoutMode[];
      employeePda: string | null;
      privatePayrollPda: string | null;
      permissionPda: string | null;
      delegatedAt: string | null;
      recipientPrivateInitializedAt: string | null;
      lastPaidAt: string | null;
      totalPaid: number;
      checkpointCrankStatus:
        | "idle"
        | "pending"
        | "active"
        | "failed"
        | "stopped"
        | null;
      checkpointCrankUpdatedAt: string | null;
      updatedAt: string;
    };
    liveState: {
      ready: boolean;
      source: "per-snapshot" | "stream-metadata";
      reason:
        | "snapshot-available"
        | "tee-token-missing"
        | "stream-not-delegated"
        | "private-account-not-initialized"
        | "private-state-missing"
        | "snapshot-unavailable";
    };
    snapshot: {
      employeePda: string;
      privatePayrollPda: string;
      employee: string;
      streamId: string;
      teeObservedAt: string;
      status: "active" | "paused" | "stopped";
      version: string;
      lastCheckpointTs: string;
      ratePerSecondMicro: string;
      lastAccrualTimestamp: string;
      accruedUnpaidMicro: string;
      totalPaidPrivateMicro: string;
      pendingAccrualMicro: string;
      rawClaimableAmountMicro: string;
      effectiveClaimableAmountMicro: string;
      monthlyCapUsd: number | null;
      monthlyCapMicro: string | null;
      cycleKey: string | null;
      cycleStart: string | null;
      cycleEnd: string | null;
      paidThisCycleMicro: string | null;
      remainingCapMicro: string | null;
      capReached: boolean;
    } | null;
  }>;
  syncedAt: string;
}

export type MagicBlockHealthState = "checking" | "ok" | "error";

export type ClaimCashoutRequest = {
  id: string;
  requestedAmount: number;
  status: "pending" | "fulfilled" | "dismissed" | "cancelled";
  payoutMode?: "base" | "ephemeral";
  createdAt: string;
  note?: string;
};

export type ClaimWithdrawHistoryRecord = {
  id: string;
  date: string;
  amount: number;
  recipient: string;
  txSig?: string;
  status: "success" | "failed" | "submitted";
  providerMeta?: {
    action?:
      | "employee-withdrawal"
      | "employee-external-transfer"
      | "employee-private-transfer"
      | "claim";
    destinationWallet?: string;
    creditVerified?: boolean;
    errorMessage?: string;
  };
  privacyConfig?: {
    fromBalance?: "base" | "ephemeral";
    toBalance?: "base" | "ephemeral";
  };
};

export type OnChainPendingClaim = {
  id: string;
  status: "requested" | "paying" | "needs_sync" | "failed" | "cancelled" | "paid";
  amountMicro?: number;
  claimId?: number;
  paymentTxSignature?: string | null;
  markPaidTxSignature?: string | null;
  errorMessage?: string | null;
};
