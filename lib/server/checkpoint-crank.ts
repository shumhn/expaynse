export type CheckpointCrankMode = "schedule" | "cancel";

export type DeriveCheckpointCrankModeArgs = {
  requestedMode?: CheckpointCrankMode | null;
  streamStatus: "active" | "paused" | "stopped";
};

export const DEFAULT_CHECKPOINT_CRANK_INTERVAL_MS = 1000;
export const DEFAULT_CHECKPOINT_CRANK_ITERATIONS = 999_999_999;

export function deriveCheckpointCrankMode(
  args: DeriveCheckpointCrankModeArgs,
): CheckpointCrankMode {
  if (args.requestedMode === "cancel") {
    return "cancel";
  }

  if (args.requestedMode === "schedule") {
    return "schedule";
  }

  return args.streamStatus === "active" ? "schedule" : "cancel";
}

export function normalizeCheckpointTaskId(
  explicitTaskId: string | undefined,
  streamId: string,
): bigint {
  const raw = explicitTaskId?.trim();
  if (raw) {
    if (/^\d+$/.test(raw)) {
      return BigInt(raw);
    }

    throw new Error("taskId must be a base-10 unsigned integer string");
  }

  const seed = Buffer.from(streamId, "utf8");
  const slice = Buffer.alloc(8, 0);
  seed.copy(slice, 0, 0, Math.min(seed.length, 8));
  return slice.readBigUInt64LE(0);
}

export function isFutureIsoTimestamp(
  value: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!value) {
    return false;
  }

  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return parsed > nowMs;
}

export function canResumeStreamNow(
  startsAt: string | null | undefined,
  nowMs = Date.now(),
) {
  return !isFutureIsoTimestamp(startsAt, nowMs);
}
