import assert from "assert";

import {
  deriveStoppedLifecycleState,
  getRemainingPayrollState,
  isMissingPrivateStateMessage,
} from "../../app/disburse/disburse-helpers.ts";
import type { PrivatePayrollStateResponse } from "../../app/disburse/disburse-types.ts";

function makePreview(
  overrides: Partial<PrivatePayrollStateResponse["state"]> = {},
): PrivatePayrollStateResponse {
  return {
    employerWallet: "EmployerWallet111111111111111111111111111",
    streamId: "stream-1",
    employee: {
      id: "emp-1",
      wallet: "EmployeeWallet111111111111111111111111111",
      name: "Demo Employee",
    },
    stream: {
      id: "stream-1",
      status: "stopped",
      ratePerSecond: 0.02,
      employeePda: "employee-pda",
      privatePayrollPda: "private-payroll-pda",
      permissionPda: "permission-pda",
      delegatedAt: "2026-05-15T00:00:00.000Z",
      lastPaidAt: null,
      totalPaid: 0,
    },
    state: {
      employeePda: "employee-pda",
      privatePayrollPda: "private-payroll-pda",
      employee: "employee-wallet",
      streamId: "stream-1",
      status: "stopped",
      version: "1",
      lastCheckpointTs: "0",
      ratePerSecondMicro: "20000",
      lastAccrualTimestamp: "0",
      accruedUnpaidMicro: "0",
      rawClaimableAmountMicro: "0",
      pendingAccrualMicro: "0",
      totalPaidPrivateMicro: "0",
      effectiveClaimableAmountMicro: "0",
      monthlyCapUsd: null,
      monthlyCapMicro: null,
      cycleKey: null,
      cycleStart: null,
      cycleEnd: null,
      paidThisCycleMicro: null,
      remainingCapMicro: null,
      capReached: false,
      ...overrides,
    },
    syncedAt: "2026-05-15T00:00:00.000Z",
  };
}

function run() {
  const remaining = getRemainingPayrollState(
    makePreview({
      accruedUnpaidMicro: "1500000",
      effectiveClaimableAmountMicro: "500000",
    }),
  );
  assert.equal(remaining.hasAccruedToSettle, true);
  assert.equal(remaining.hasClaimableToSettle, true);
  assert.equal(remaining.hasRemainingPayrollToSettle, true);

  const fullyClosed = deriveStoppedLifecycleState({
    effectiveStatus: "stopped",
    preview: undefined,
    hasMissingPrivateState: true,
  });
  assert.equal(fullyClosed.phase, "fully_closed");
  assert.equal(fullyClosed.isFullyClosed, true);

  const needsSettlement = deriveStoppedLifecycleState({
    effectiveStatus: "stopped",
    preview: makePreview({
      accruedUnpaidMicro: "1200000",
      effectiveClaimableAmountMicro: "0",
    }),
    hasMissingPrivateState: false,
  });
  assert.equal(needsSettlement.phase, "needs_settlement");
  assert.equal(needsSettlement.mustSettleBeforeClose, true);
  assert.equal(needsSettlement.hasRemainingPayrollToSettle, true);

  const readyToClose = deriveStoppedLifecycleState({
    effectiveStatus: "stopped",
    preview: makePreview(),
    hasMissingPrivateState: false,
  });
  assert.equal(readyToClose.phase, "ready_to_close");
  assert.equal(readyToClose.mustSettleBeforeClose, false);

  const activeStream = deriveStoppedLifecycleState({
    effectiveStatus: "active",
    preview: makePreview({
      status: "active",
    }),
    hasMissingPrivateState: false,
  });
  assert.equal(activeStream.phase, "not_stopped");
  assert.equal(activeStream.isFullyClosed, false);

  assert.equal(
    isMissingPrivateStateMessage("Private payroll state not found for employee"),
    true,
    "missing private payroll state text should be recognized",
  );
  assert.equal(
    isMissingPrivateStateMessage("private state expired after inactivity"),
    true,
    "expired private state text should be recognized",
  );
  assert.equal(
    isMissingPrivateStateMessage("some unrelated transport error"),
    false,
    "non-private-state errors should not be treated as missing state",
  );

  console.log("stream lifecycle state tests passed");
}

run();
