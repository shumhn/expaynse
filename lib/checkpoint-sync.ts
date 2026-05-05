export type CheckpointCrankStatus =
  | "idle"
  | "pending"
  | "active"
  | "failed"
  | "stopped"
  | "stale";

export const CHECKPOINT_STALE_GRACE_MS = 15_000;

export function isCheckpointSyncRunning(
  status: CheckpointCrankStatus | null | undefined,
) {
  return status === "active" || status === "stale";
}

export function isCheckpointTimestampFresh(
  lastAccrualTimestamp: string | number | null | undefined,
  nowMs = Date.now(),
  graceMs = CHECKPOINT_STALE_GRACE_MS,
) {
  const lastAccrualMs = Number(lastAccrualTimestamp) * 1000;
  if (!Number.isFinite(lastAccrualMs) || lastAccrualMs <= 0) {
    return false;
  }

  return nowMs - lastAccrualMs <= graceMs;
}

export function deriveObservedCheckpointCrankStatus(args: {
  currentStatus: CheckpointCrankStatus | null | undefined;
  lastAccrualTimestamp: string | number | null | undefined;
  nowMs?: number;
}) {
  const currentStatus = args.currentStatus ?? undefined;

  if (currentStatus !== "active" && currentStatus !== "stale") {
    return currentStatus;
  }

  return isCheckpointTimestampFresh(args.lastAccrualTimestamp, args.nowMs)
    ? "active"
    : "stale";
}

