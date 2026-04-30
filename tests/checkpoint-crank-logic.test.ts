import assert from "assert";

import {
  canResumeStreamNow,
  deriveCheckpointCrankMode,
  isFutureIsoTimestamp,
  normalizeCheckpointTaskId,
} from "../lib/server/checkpoint-crank.ts";

function run() {
  assert.equal(
    deriveCheckpointCrankMode({ requestedMode: "schedule", streamStatus: "paused" }),
    "schedule",
    "explicit schedule mode should win",
  );

  assert.equal(
    deriveCheckpointCrankMode({ requestedMode: "cancel", streamStatus: "active" }),
    "cancel",
    "explicit cancel mode should win",
  );

  assert.equal(
    deriveCheckpointCrankMode({ streamStatus: "active" }),
    "schedule",
    "active stream should auto-schedule crank",
  );

  assert.equal(
    deriveCheckpointCrankMode({ streamStatus: "paused" }),
    "cancel",
    "paused stream should auto-cancel crank",
  );

  const deterministicTaskId = normalizeCheckpointTaskId(undefined, "stream-demo-123");
  assert.equal(
    deterministicTaskId,
    normalizeCheckpointTaskId(undefined, "stream-demo-123"),
    "derived task id should be deterministic for same stream id",
  );

  const explicitTaskId = normalizeCheckpointTaskId("42", "ignored");
  assert.equal(explicitTaskId, BigInt(42), "explicit task id should parse");

  assert.throws(
    () => normalizeCheckpointTaskId("not-a-number", "stream-x"),
    /taskId must be a base-10 unsigned integer string/,
  );

  const now = Date.UTC(2026, 3, 28, 10, 0, 0);
  const future = new Date(now + 60_000).toISOString();
  const past = new Date(now - 60_000).toISOString();

  assert.equal(isFutureIsoTimestamp(future, now), true, "future start should be true");
  assert.equal(isFutureIsoTimestamp(past, now), false, "past start should be false");

  assert.equal(canResumeStreamNow(future, now), false, "resume should be blocked before start");
  assert.equal(canResumeStreamNow(past, now), true, "resume should be allowed after start");
  assert.equal(canResumeStreamNow(null, now), true, "resume should be allowed without startsAt");

  console.log("checkpoint-crank logic tests passed");
}

run();
