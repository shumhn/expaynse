export const PAYROLL_RUNTIME_BOUNDARY = {
  base: {
    label: "Base Solana",
    shortLabel: "Base",
    description:
      "Company setup, treasury funding, and public wallet exits live on base Solana.",
  },
  per: {
    label: "MagicBlock PER",
    shortLabel: "PER",
    description:
      "Live salary accrual, private claimable state, and private balances live in MagicBlock PER.",
  },
  server: {
    label: "Expaynse Bridge",
    shortLabel: "Bridge",
    description:
      "Expaynse only bridges wallet auth, signed snapshot reads, and lifecycle actions between base and PER.",
  },
} as const;

export const PAYROLL_RUNTIME_BOUNDARY_PILLS = [
  {
    key: "base",
    label: PAYROLL_RUNTIME_BOUNDARY.base.label,
    copy: PAYROLL_RUNTIME_BOUNDARY.base.description,
  },
  {
    key: "per",
    label: PAYROLL_RUNTIME_BOUNDARY.per.label,
    copy: PAYROLL_RUNTIME_BOUNDARY.per.description,
  },
] as const;
