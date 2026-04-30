export type PaySchedule = "monthly" | "semi_monthly" | "biweekly" | "weekly";

const DAY_SECONDS = 86_400;
const AVERAGE_GREGORIAN_DAYS_PER_MONTH = 365.2425 / 12;
const BIWEEKLY_ANCHOR_UTC = Date.UTC(2026, 0, 5); // Monday anchor

export const AVERAGE_MONTH_SECONDS =
  AVERAGE_GREGORIAN_DAYS_PER_MONTH * DAY_SECONDS;

export interface ScheduleCycleSnapshot {
  schedule: PaySchedule;
  start: Date;
  end: Date;
  nextStart: Date;
  totalDays: number;
  totalSeconds: number;
  elapsedSeconds: number;
  label: string;
}

function toUtcDateStart(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function formatShortDate(value: Date) {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildCycleFromStartDays(
  schedule: PaySchedule,
  start: Date,
  totalDays: number,
  now: Date,
): ScheduleCycleSnapshot {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + totalDays - 1);

  const nextStart = new Date(start);
  nextStart.setUTCDate(nextStart.getUTCDate() + totalDays);

  const startMs = start.getTime();
  const elapsedSeconds = Math.max(
    0,
    Math.min(totalDays * DAY_SECONDS, Math.floor((now.getTime() - startMs) / 1000)),
  );

  return {
    schedule,
    start,
    end,
    nextStart,
    totalDays,
    totalSeconds: totalDays * DAY_SECONDS,
    elapsedSeconds,
    label:
      schedule === "monthly"
        ? start.toLocaleString("en-US", {
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          })
        : `${formatShortDate(start)} - ${formatShortDate(end)}`,
  };
}

export function getScheduleCycleSnapshot(
  schedule: PaySchedule | undefined,
  nowInput = new Date(),
): ScheduleCycleSnapshot {
  const now = new Date(nowInput);
  const normalized: PaySchedule = schedule ?? "monthly";

  if (normalized === "weekly") {
    const dayStart = toUtcDateStart(now);
    const mondayOffset = (dayStart.getUTCDay() + 6) % 7;
    const start = new Date(dayStart);
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    return buildCycleFromStartDays(normalized, start, 7, now);
  }

  if (normalized === "biweekly") {
    const dayStart = toUtcDateStart(now);
    const dayDelta = Math.floor(
      (dayStart.getTime() - BIWEEKLY_ANCHOR_UTC) / (DAY_SECONDS * 1000),
    );
    const fullCycles = Math.floor(dayDelta / 14);
    const start = new Date(BIWEEKLY_ANCHOR_UTC + fullCycles * 14 * DAY_SECONDS * 1000);
    return buildCycleFromStartDays(normalized, start, 14, now);
  }

  if (normalized === "semi_monthly") {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();
    const monthDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    if (day <= 15) {
      const start = new Date(Date.UTC(year, month, 1));
      return buildCycleFromStartDays(normalized, start, 15, now);
    }

    const start = new Date(Date.UTC(year, month, 16));
    return buildCycleFromStartDays(normalized, start, monthDays - 15, now);
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(year, month, 1));
  return buildCycleFromStartDays("monthly", start, monthDays, now);
}

export function monthlyUsdToRatePerSecond(monthlyUsd: number) {
  if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
    return 0;
  }
  return monthlyUsd / AVERAGE_MONTH_SECONDS;
}

export function ratePerSecondToMonthlyUsd(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    return 0;
  }
  return ratePerSecond * AVERAGE_MONTH_SECONDS;
}

export function getAccruedInCycle(args: {
  ratePerSecond: number;
  cycleStart: Date;
  cycleTotalSeconds: number;
  nowMs: number;
  startsAt?: string | null;
}) {
  const { ratePerSecond, cycleStart, cycleTotalSeconds, nowMs, startsAt } = args;

  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    return 0;
  }

  const cycleStartMs = cycleStart.getTime();
  const cycleEndMs = cycleStartMs + cycleTotalSeconds * 1000;
  const streamStartMs = startsAt ? new Date(startsAt).getTime() : cycleStartMs;
  const accrualStartMs = Math.max(cycleStartMs, streamStartMs);
  const accrualEndMs = Math.min(nowMs, cycleEndMs);
  const elapsedSeconds = Math.max(0, Math.floor((accrualEndMs - accrualStartMs) / 1000));

  return ratePerSecond * elapsedSeconds;
}
