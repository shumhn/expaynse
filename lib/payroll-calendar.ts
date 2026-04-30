export interface PayrollCycleSnapshot {
  label: string;
  start: Date;
  end: Date;
  nextStart: Date;
  totalDays: number;
  totalSeconds: number;
  elapsedSeconds: number;
}

export interface CalendarDayCell {
  isoDate: string;
  date: Date;
  dayOfMonth: number;
  inMonth: boolean;
}

function startOfUtcMonth(anchor: Date) {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
}

function endOfUtcMonth(anchor: Date) {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
}

export function getPayrollCycleSnapshot(
  anchor = new Date(),
  now = new Date(),
): PayrollCycleSnapshot {
  const start = startOfUtcMonth(anchor);
  const end = endOfUtcMonth(anchor);
  const nextStart = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
  );
  const totalDays = end.getUTCDate();
  const totalSeconds = totalDays * 86_400;
  const elapsedSeconds = Math.max(
    0,
    Math.min(totalSeconds, Math.floor((now.getTime() - start.getTime()) / 1000)),
  );

  return {
    label: start.toLocaleString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }),
    start,
    end,
    nextStart,
    totalDays,
    totalSeconds,
    elapsedSeconds,
  };
}

export function buildCalendarMonth(anchor = new Date()) {
  const monthStart = startOfUtcMonth(anchor);
  const monthEnd = endOfUtcMonth(anchor);
  const firstGridDay = new Date(monthStart);
  firstGridDay.setUTCDate(monthStart.getUTCDate() - monthStart.getUTCDay());

  const lastGridDay = new Date(monthEnd);
  lastGridDay.setUTCDate(monthEnd.getUTCDate() + (6 - monthEnd.getUTCDay()));

  const weeks: CalendarDayCell[][] = [];
  const cursor = new Date(firstGridDay);

  while (cursor <= lastGridDay) {
    const week: CalendarDayCell[] = [];

    for (let index = 0; index < 7; index += 1) {
      week.push({
        isoDate: cursor.toISOString().slice(0, 10),
        date: new Date(cursor),
        dayOfMonth: cursor.getUTCDate(),
        inMonth: cursor.getUTCMonth() === monthStart.getUTCMonth(),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    weeks.push(week);
  }

  return weeks;
}
