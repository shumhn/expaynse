# Rust Contract Freeze Checklist (Payroll Program)

## Scope

Program file: `/payroll1-rust/programs/payroll/src/lib.rs`  
Program ID: `HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6`

## Freeze Targets

The following instruction interface is treated as contract-critical and must stay stable unless versioned intentionally:

1. `create_employee`
2. `create_permission`
3. `delegate_employee`
4. `initialize_private_payroll`
5. `resume_stream`
6. `pause_stream`
7. `stop_stream`
8. `update_private_terms`
9. `checkpoint_accrual`
10. `pay_salary`
11. `request_withdrawal`
12. `mark_private_transfer_paid`
13. `cancel_pending_withdrawal`
14. `commit_employee`
15. `undelegate_employee`
16. `close_private_payroll`
17. `close_employee`
18. `schedule_checkpoint_accrual`
19. `cancel_checkpoint_accrual`

## Authority Model (Must Not Drift)

1. Employer authority controls stream lifecycle and settlement orchestration.
2. Employee wallet is the only valid signer for `request_withdrawal`.
3. Settlement authority is the only valid signer for `mark_private_transfer_paid` and `cancel_pending_withdrawal`.
4. Any fallback path that bypasses these signer checks is prohibited.

## State Invariants (Must Hold)

1. `payment_ref_hash` is always non-zero for mark-paid calls.
2. Only one pending claim per stream at any time.
3. `accrued_unpaid` never goes negative.
4. `close_private_payroll` allowed only when stream is stopped and accrued balance is zero.
5. `close_employee` allowed only after private payroll account is closed.

## App/Backend Integration Points

Primary app route callers:

1. `/app/api/streams/onboard/route.ts` (create/delegate/init/resume path)
2. `/app/api/streams/control/route.ts` (pause/resume/stop/update-rate path)
3. `/app/api/payroll/tick/route.ts` (pay + commit path)
4. `/app/api/claim-salary/request/route.ts` (request withdrawal)
5. `/app/api/claim-salary/process/route.ts` (mark paid)
6. `/app/api/claim-salary/cancel/route.ts` (cancel pending withdrawal)
7. `/app/api/streams/checkpoint-crank/route.ts` (schedule/cancel checkpoint)
8. `/app/api/streams/restart/route.ts` (close/undelegate/close flow)

If Rust signatures/accounts change, these files must be updated in the same PR.

## Required Verification Before Merge

1. `cargo check` in `payroll1-rust/`
2. Anchor IDL parity check
3. App typecheck (`npx tsc --noEmit`)
4. Critical route smoke (`npm run test:app:smoke`)
5. Claim + checkpoint logic tests (`npm run test:cashout:payout-mode`, `npm run test:checkpoint:logic`)

## Change Control Rule

Any change to Rust instruction signature, account ordering, PDA seed scheme, or error codes must include:

1. explicit migration note
2. updated integration callers
3. updated tests proving backward-safe behavior or intentional break
