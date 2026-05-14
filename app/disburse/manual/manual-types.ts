import type { PayrollMode } from "@/lib/payroll-mode";

export interface ManualPayrollEmployee {
  address: string;
  amount: number;
  employeeId?: string;
  name?: string;
  department?: string;
}

export type ManualPayrollStepStatus = "pending" | "active" | "done" | "error";

export interface ManualPayrollStep {
  label: string;
  status: ManualPayrollStepStatus;
  sig?: string;
}

export interface ManualPayrollSummary {
  totalAmount: number;
  employeeCount: number;
  transferSig?: string;
}

export interface EmployerEmployee {
  id: string;
  wallet: string;
  name: string;
  payrollMode?: PayrollMode;
  department?: string;
  role?: string;
  compensationAmountUsd?: number;
  monthlySalaryUsd?: number;
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  privateRecipientInitStatus?: "pending" | "processing" | "confirmed" | "failed";
}

export interface PayrollHistoryRun {
  id: string;
  date: string;
  mode?: "streaming" | "private_payroll";
  totalAmount: number;
  employeeCount: number;
  employeeIds?: string[];
  employeeNames?: string[];
  recipientAddresses: string[];
  depositSig?: string;
  transferSig?: string;
  status: "success" | "failed";
}

export interface CompanySummary {
  id: string;
  name: string;
  treasuryPubkey: string;
}
