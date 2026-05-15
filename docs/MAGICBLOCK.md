# MagicBlock Integration

Expaynse uses MagicBlock as the real-time execution layer for private payroll.

## Where to Look

- `programs/payroll/Cargo.toml`
  Declares the on-chain MagicBlock dependencies: `ephemeral-rollups-sdk` and `magicblock-magic-program-api`.
- `programs/payroll/src/lib.rs`
  Anchor program entrypoints for employee creation, delegation, checkpoint accrual, and withdrawal lifecycle.
- `scripts/payroll/`
  Operational devnet scripts for onboarding, crank simulation, transfer testing, verifier flows, and deploy/IDL repair helpers under `scripts/payroll/devnet/`.
- `tests/payroll/`
  End-to-end devnet tests that exercise the delegated payroll lifecycle.
- `tests/app/payroll-end-to-end.e2e.ts`
  Canonical application-layer payroll flow that exercises the web routes around onboarding, accrual, tick, and settlement.
- `tests/app/payroll-realtime.e2e.ts`
  Canonical realtime payroll flow that proves autonomous checkpoint accrual progresses and stops correctly for employer and employee actors.
- `lib/magicblock-api.ts`
  App-side helpers for private payment API calls and settlement flows.

## Reviewer Flow

1. Read `Anchor.toml` to confirm the workspace and program id.
2. Open `programs/payroll/Cargo.toml` to see the MagicBlock crates wired into the program.
3. Open `programs/payroll/src/lib.rs` for the on-chain payroll lifecycle.
4. Inspect `scripts/payroll/onboard-employee.ts` and `scripts/payroll/crank.ts` for operational MagicBlock flows.
5. Run `npm run payroll:magicblock:health`, `npm run payroll:verify:devnet`, `npm run test:app:e2e`, or `npm run test:app:realtime` with the required environment variables.

## Why This Structure

The repo keeps the web product in `app/`, but exposes the Anchor workspace from the root so Solana and MagicBlock reviewers can immediately find:

- root `Anchor.toml`
- root `Cargo.toml`
- root `programs/payroll/Cargo.toml`
- root `programs/payroll`
- root payroll scripts and tests
