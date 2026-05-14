import type { PayrollPayoutMode, PayrollStreamStatus } from "@/lib/server/payroll-store";

export type PayrollTickBuildResult = {
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  cashoutRequestId?: string;
  requestedAmountMicro?: number;
  skipped: boolean;
  reason?: string;
  elapsedSeconds?: number;
  amountMicro?: number;
  payoutMode?: PayrollPayoutMode;
  destinationWallet?: string;
  transferFromBalance?: "base" | "ephemeral";
  transferToBalance?: "base" | "ephemeral";
  employeePda?: string;
  privatePayrollPda?: string;
  transferSignature?: string;
  transferSendTo?: string;
  accountingOnly?: boolean;
  settlementAlreadyApplied?: boolean;
  needsRecovery?: boolean;
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
};

export type PayrollTickFinalizeItem = {
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
  transferSignature?: string;
  accountingOnly?: boolean;
  settleSalarySignature?: string;
  commitSignature: string;
};

export type ExactPrivatePayrollState = {
  employeePda: string;
  privatePayrollPda: string;
  employee: string;
  streamId: string;
  status: PayrollStreamStatus;
  version: string;
  lastCheckpointTs: string;
  ratePerSecondMicro: string;
  lastAccrualTimestamp: string;
  accruedUnpaidMicro: string;
  totalPaidPrivateMicro: string;
};
