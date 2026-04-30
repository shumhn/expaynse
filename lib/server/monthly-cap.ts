import { getScheduleCycleSnapshot, type PaySchedule } from "@/lib/payroll-math";
import type { EmployeeRecord, PayrollStreamRecord } from "@/lib/server/payroll-store";

const MICRO_USDC = BigInt(1_000_000);

function toMicroUsd(amountUsd: number) {
  const normalized = Number.isFinite(amountUsd) ? amountUsd : 0;
  return BigInt(Math.max(0, Math.round(normalized * 1_000_000)));
}

function parseBigIntSafe(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveMonthlyCapUsd(args: {
  stream: PayrollStreamRecord;
  employee: EmployeeRecord;
}) {
  const { stream, employee } = args;

  const candidates: Array<number | undefined> = [
    stream.compensationSnapshot?.monthlySalaryUsd,
    employee.monthlySalaryUsd,
    employee.compensationUnit === "monthly"
      ? employee.compensationAmountUsd
      : undefined,
  ];

  for (const candidate of candidates) {
    if (isFinitePositive(candidate)) {
      return candidate;
    }
  }

  return null;
}

export type MonthlyCapEvaluation = {
  monthlyCapUsd: number | null;
  monthlyCapMicro: string | null;
  cycleKey: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  paidThisCycleMicro: string | null;
  remainingCapMicro: string | null;
  effectiveClaimableAmountMicro: string;
  capReached: boolean;
  nextCapState: PayrollStreamRecord["monthlyCapState"] | undefined;
};

export function evaluateMonthlyCap(args: {
  stream: PayrollStreamRecord;
  employee: EmployeeRecord;
  rawClaimableAmountMicro: bigint;
  totalPaidPrivateMicro: bigint;
  now?: Date;
}): MonthlyCapEvaluation {
  const { stream, employee } = args;
  const now = args.now ?? new Date();

  const monthlyCapUsd = resolveMonthlyCapUsd({ stream, employee });

  if (!monthlyCapUsd) {
    return {
      monthlyCapUsd: null,
      monthlyCapMicro: null,
      cycleKey: null,
      cycleStart: null,
      cycleEnd: null,
      paidThisCycleMicro: null,
      remainingCapMicro: null,
      effectiveClaimableAmountMicro: args.rawClaimableAmountMicro.toString(),
      capReached: false,
      nextCapState: undefined,
    };
  }

  const schedule: PaySchedule =
    employee.paySchedule ?? stream.compensationSnapshot?.paySchedule ?? "monthly";
  const cycle = getScheduleCycleSnapshot(schedule, now);
  const cycleKey = `${schedule}:${cycle.start.toISOString()}`;

  const previousState = stream.monthlyCapState;
  const previousOpeningPaid =
    previousState && previousState.cycleKey === cycleKey
      ? parseBigIntSafe(previousState.openingTotalPaidPrivateMicro)
      : null;

  const openingTotalPaidPrivateMicro =
    previousOpeningPaid !== null && previousOpeningPaid <= args.totalPaidPrivateMicro
      ? previousOpeningPaid
      : args.totalPaidPrivateMicro;

  const paidThisCycleMicro =
    args.totalPaidPrivateMicro > openingTotalPaidPrivateMicro
      ? args.totalPaidPrivateMicro - openingTotalPaidPrivateMicro
      : BigInt(0);

  const monthlyCapMicro = toMicroUsd(monthlyCapUsd);
  const remainingCapMicro =
    paidThisCycleMicro >= monthlyCapMicro
      ? BigInt(0)
      : monthlyCapMicro - paidThisCycleMicro;

  const effectiveClaimableAmountMicro =
    args.rawClaimableAmountMicro <= remainingCapMicro
      ? args.rawClaimableAmountMicro
      : remainingCapMicro;

  const capReached = remainingCapMicro === BigInt(0);
  const cappedAt =
    capReached && previousState?.cycleKey === cycleKey
      ? previousState.cappedAt ?? now.toISOString()
      : capReached
        ? now.toISOString()
        : null;

  return {
    monthlyCapUsd,
    monthlyCapMicro: monthlyCapMicro.toString(),
    cycleKey,
    cycleStart: cycle.start.toISOString(),
    cycleEnd: cycle.end.toISOString(),
    paidThisCycleMicro: paidThisCycleMicro.toString(),
    remainingCapMicro: remainingCapMicro.toString(),
    effectiveClaimableAmountMicro: effectiveClaimableAmountMicro.toString(),
    capReached,
    nextCapState: {
      cycleKey,
      cycleStart: cycle.start.toISOString(),
      cycleEnd: cycle.end.toISOString(),
      openingTotalPaidPrivateMicro: openingTotalPaidPrivateMicro.toString(),
      monthlyCapUsd,
      cappedAt,
    },
  };
}

export function hasCapStateChanged(
  currentState: PayrollStreamRecord["monthlyCapState"] | undefined,
  nextState: PayrollStreamRecord["monthlyCapState"] | undefined,
) {
  if (!currentState && !nextState) {
    return false;
  }

  if (!currentState || !nextState) {
    return true;
  }

  return (
    currentState.cycleKey !== nextState.cycleKey ||
    currentState.cycleStart !== nextState.cycleStart ||
    currentState.cycleEnd !== nextState.cycleEnd ||
    currentState.openingTotalPaidPrivateMicro !==
      nextState.openingTotalPaidPrivateMicro ||
    currentState.monthlyCapUsd !== nextState.monthlyCapUsd ||
    (currentState.cappedAt ?? null) !== (nextState.cappedAt ?? null)
  );
}

export function clampClaimAmountToCap(args: {
  requestedAmountMicro: bigint;
  effectiveClaimableAmountMicro: bigint;
}) {
  if (args.requestedAmountMicro <= BigInt(0)) {
    return BigInt(0);
  }

  if (args.requestedAmountMicro <= args.effectiveClaimableAmountMicro) {
    return args.requestedAmountMicro;
  }

  return args.effectiveClaimableAmountMicro;
}

export const MICRO_USDC_FACTOR = MICRO_USDC;
