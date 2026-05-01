
import { Waves, PauseCircle, Ban } from "lucide-react";
import { type EmployeePayrollSummaryResponse } from "./use-claim-data";

export function getCurrentCycleSnapshot() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  const nextStart = new Date(Date.UTC(year, month + 1, 1));
  const totalDays = end.getUTCDate();
  const totalSeconds = totalDays * 86_400;
  const elapsedSeconds = Math.max(0, Math.min(totalSeconds, Math.floor((Date.now() - start.getTime()) / 1000)));

  return {
    label: start.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
    start, end, nextStart, totalDays, totalSeconds, elapsedSeconds,
  };
}

export function formatUsdc(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits }).format(value);
}

export function formatMicroUsdc(value: string | null | undefined, digits = 4) {
  if (!value) return "0";
  const normalized = Number(value) / 1_000_000;
  if (!Number.isFinite(normalized)) return "0";
  return formatUsdc(normalized, digits);
}

export function formatPayrollRate(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond)) return "0 USDC/sec";
  if (ratePerSecond === 0) return "0 USDC/sec";
  if (Math.abs(ratePerSecond) < 0.000001) {
    return `${ratePerSecond.toExponential(3)} USDC/sec`;
  }
  return `${formatUsdc(ratePerSecond, 8)} USDC/sec`;
}

export function formatLastPrivateUpdate(value: string | null | undefined) {
  if (!value) return "Not yet";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Unknown";
  return new Date(numeric * 1000).toLocaleString();
}

export function getStatusMeta(status: "active" | "paused" | "stopped") {
  switch (status) {
    case "active":
      return { label: "Payroll Active", copy: "Your salary is accruing privately right now.", icon: Waves, className: "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" };
    case "paused":
      return { label: "Payroll Paused", copy: "This stream is paused, so no new private accrual is being added.", icon: PauseCircle, className: "bg-amber-400/10 border-amber-400/20 text-amber-300" };
    case "stopped":
      return { label: "Payroll Stopped", copy: "This stream has been stopped. No future accruals will be added.", icon: Ban, className: "bg-neutral-400/10 border-neutral-400/20 text-neutral-300" };
  }
}

export function getLiveStateCopy(liveState: EmployeePayrollSummaryResponse["streams"][number]["liveState"] | undefined) {
  if (!liveState || liveState.ready) return "Live private accrual based on your stream rate and the latest TEE timestamp.";
  switch (liveState.reason) {
    case "private-account-not-initialized": return "Your private payroll account is not initialized yet. Complete the one-time setup below to receive private salary and unlock live PER payroll visibility.";
    case "private-state-missing": return "Private payroll state is missing/expired in PER for this stream. Ask employer to re-onboard the stream and sync again.";
    case "stream-not-delegated": return "Your employer has not finished PER onboarding for this stream yet. Live private payroll data will appear here once delegation completes.";
    case "tee-token-missing": return "Live private payroll needs an authenticated TEE session. Refresh payroll and approve the message prompt to load live PER state.";
    case "preview-unavailable": return "Live PER preview is unavailable right now. UI values stay locked until a signed refresh fetches current on-chain private state.";
    default: return "Live private accrual based on your stream rate and the latest TEE timestamp.";
  }
}

export function computeAnimatedClaimableAmountMicro(args: {
  preview: EmployeePayrollSummaryResponse["streams"][number]["preview"] | null | undefined;
  liveState: EmployeePayrollSummaryResponse["streams"][number]["liveState"];
  syncedAt: string | null | undefined;
  nowMs: number;
}) {
  if (!args.preview) return null;
  let claimableMicro: bigint;
  let ratePerSecondMicro: bigint;
  try {
    claimableMicro = BigInt(args.preview.effectiveClaimableAmountMicro);
    ratePerSecondMicro = BigInt(args.preview.ratePerSecondMicro);
  } catch {
    return args.preview.effectiveClaimableAmountMicro;
  }
  if (!args.liveState.ready || args.preview.status !== "active") return claimableMicro.toString();
  const syncedAtMs = Date.parse(args.syncedAt ?? "");
  if (!Number.isFinite(syncedAtMs)) return claimableMicro.toString();
  const elapsedMs = Math.max(0, Math.floor(args.nowMs - syncedAtMs));
  if (elapsedMs <= 0) return claimableMicro.toString();
  const accruedSinceSync = (ratePerSecondMicro * BigInt(elapsedMs)) / BigInt(1000);
  return (claimableMicro + accruedSinceSync).toString();
}

export function microToUsdc(value: string | null | undefined) {
  if (!value) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric / 1_000_000;
}
