import assert from "assert";

import {
  getPrivateInitBadge,
  resolveGoLiveReadiness,
  resolvePrivateInitStatus,
} from "../../app/disburse/disburse-helpers.ts";
import type {
  ManagedEmployee,
  PayrollStream,
  PrivateInitStatus,
} from "../../app/disburse/disburse-types.ts";

function makeEmployee(
  overrides: Partial<ManagedEmployee> = {},
): ManagedEmployee {
  return {
    id: "emp-1",
    employerWallet: "EmployerWallet111111111111111111111111111",
    wallet: "EmployeeWallet111111111111111111111111111",
    name: "Demo Employee",
    privateRecipientInitStatus: "pending",
    privateRecipientInitializedAt: null,
    privateRecipientInitConfirmedAt: null,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeStream(
  overrides: Partial<PayrollStream> = {},
): PayrollStream {
  return {
    id: "stream-1",
    employerWallet: "EmployerWallet111111111111111111111111111",
    employeeId: "emp-1",
    ratePerSecond: 0.02,
    lastPaidAt: null,
    totalPaid: 0,
    status: "paused",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function run() {
  const pendingEmployee = makeEmployee();
  const pendingStream = makeStream();

  assert.equal(
    resolvePrivateInitStatus(pendingEmployee, pendingStream),
    "pending",
    "pending employee without timestamps should stay pending",
  );

  const processingEmployee = makeEmployee({
    privateRecipientInitStatus: "processing",
  });
  assert.equal(
    resolvePrivateInitStatus(processingEmployee, pendingStream),
    "processing",
    "processing employee should stay processing while no init timestamp exists",
  );

  const confirmedFromEmployee = makeEmployee({
    privateRecipientInitStatus: "pending",
    privateRecipientInitializedAt: "2026-05-15T00:01:00.000Z",
  });
  assert.equal(
    resolvePrivateInitStatus(confirmedFromEmployee, pendingStream),
    "confirmed",
    "employee init timestamp should force confirmed status",
  );

  const confirmedFromStream = makeStream({
    recipientPrivateInitializedAt: "2026-05-15T00:02:00.000Z",
  });
  assert.equal(
    resolvePrivateInitStatus(pendingEmployee, confirmedFromStream),
    "confirmed",
    "stream init timestamp should force confirmed status",
  );

  const failedBadge = getPrivateInitBadge("failed");
  assert.equal(failedBadge.label, "INIT FAILED");

  const failedReadiness = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "paused",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: true,
    isRecipientPrivateReady: false,
    privateInitStatus: "failed",
  });
  assert.equal(failedReadiness.label, "Recipient setup failed");
  assert.match(
    failedReadiness.copy,
    /Server auto-init did not complete/i,
  );
  assert.match(
    failedReadiness.copy,
    /Claim > Withdraw/i,
  );

  const processingReadiness = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "paused",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: true,
    isRecipientPrivateReady: false,
    privateInitStatus: "processing",
  });
  assert.equal(processingReadiness.label, "Recipient setup in progress");
  assert.match(
    processingReadiness.copy,
    /Server auto-init is still running/i,
  );

  const pendingReadiness = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "paused",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: true,
    isRecipientPrivateReady: false,
    privateInitStatus: "pending",
  });
  assert.equal(pendingReadiness.label, "Recipient setup needed");
  assert.match(
    pendingReadiness.copy,
    /Server auto-init has not completed yet/i,
  );

  const readyReadiness = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "paused",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: true,
    isRecipientPrivateReady: true,
    privateInitStatus: "confirmed",
  });
  assert.equal(readyReadiness.label, "Ready to go live");

  const liveReadiness = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "active",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: true,
    isRecipientPrivateReady: true,
    privateInitStatus: "confirmed",
  });
  assert.equal(liveReadiness.label, "Live now");

  const setupNeeded = resolveGoLiveReadiness({
    stream: pendingStream,
    effectiveStatus: "paused",
    isFullyClosed: false,
    mustSettleBeforeClose: false,
    isOnboarded: false,
    isRecipientPrivateReady: false,
    privateInitStatus: "pending",
  });
  assert.equal(setupNeeded.label, "PER setup needed");

  console.log("private-init readiness tests passed");
}

run();
