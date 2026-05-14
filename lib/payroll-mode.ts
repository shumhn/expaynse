export type PayrollMode = "streaming" | "private_payroll";

export const PAYROLL_MODE_OPTIONS = [
  {
    value: "streaming" as const,
    label: "Realtime Streaming",
    description: "Live private accrual.",
  },
  {
    value: "private_payroll" as const,
    label: "Private Payroll Only",
    description: "Private one-off or batch payouts.",
  },
] satisfies ReadonlyArray<{
  value: PayrollMode;
  label: string;
  description: string;
}>;

export function normalizePayrollMode(
  value: PayrollMode | string | null | undefined,
): PayrollMode {
  return value === "private_payroll" ? "private_payroll" : "streaming";
}

export function payrollModeLabel(mode: PayrollMode | string | null | undefined) {
  return normalizePayrollMode(mode) === "private_payroll"
    ? "Private Payroll"
    : "Realtime Streaming";
}
