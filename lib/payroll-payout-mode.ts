export type PayrollPayoutMode = "base" | "ephemeral";

export interface PayrollPayoutModeOption {
  value: PayrollPayoutMode;
  label: string;
  description: string;
}

export const DEFAULT_PAYROLL_PAYOUT_MODE: PayrollPayoutMode = "ephemeral";

export const PAYROLL_PAYOUT_MODE_OPTIONS: PayrollPayoutModeOption[] = [
  {
    value: "ephemeral",
    label: "Private stream (ephemeral)",
    description: "Private-to-private payroll settlement on PER.",
  },
];

export function allowedPayoutModesFor(mode: PayrollPayoutMode): PayrollPayoutMode[] {
  return ["ephemeral"];
}

export function payoutModeSummary(mode: PayrollPayoutMode): string {
  return mode === "ephemeral" ? "Private USDC stream" : "Direct base payout";
}
