# Expaynse

Privacy-first payroll and private salary payouts on Solana, with MagicBlock powering real-time execution.

## MagicBlock Review Path

If you are reviewing the MagicBlock integration, start here:

1. `Anchor.toml`
2. `programs/payroll/Cargo.toml`
3. `programs/payroll/src/lib.rs`
4. `scripts/payroll/`
5. `tests/payroll/`
6. `docs/MAGICBLOCK.md`
7. `lib/magicblock-api.ts`

### MagicBlock At A Glance

- `programs/payroll/Cargo.toml`: on-chain MagicBlock dependencies such as `ephemeral-rollups-sdk` and `magicblock-magic-program-api`
- `programs/payroll/src/lib.rs`: payroll lifecycle implemented on the Solana program side
- `scripts/payroll/check-magicblock-health.ts`: reviewer-friendly connectivity check
- `scripts/payroll/verify-devnet.js`: end-to-end devnet verifier for the private payroll flow
- `lib/magicblock-api.ts`: app-side MagicBlock API helpers used by the web product

## Repository Layout

- `app/`: Next.js routes and route handlers
- `components/`: shared UI and feature components
- `lib/`: client/server domain logic and MagicBlock-facing app helpers
- `programs/payroll/`: Anchor payroll program used for private, delegated payroll flows
- `scripts/payroll/`: devnet verification, crank, onboarding, and MagicBlock operational scripts
- `tests/`: app tests plus `tests/payroll/` devnet payroll integration coverage
- `public/`: static assets used by the web app
- `assets/`: non-runtime artifacts such as branding and pitch references

## Common Commands

- `npm run dev`: run the web app locally
- `npm run payroll:build`: build the Anchor payroll program
- `npm run payroll:test`: run Anchor payroll tests
- `npm run payroll:magicblock:health`: verify MagicBlock ER/PER connectivity
- `npm run payroll:verify:devnet`: run the end-to-end payroll verifier against devnet
- `npm run test:app:smoke`: route-level smoke with `.env`

## Notes

- Use kebab-case for asset file names in `public/` and `assets/`.
- Keep route files in `app/**/page.tsx` thin; place heavy logic in sibling feature modules.
- Keep temporary outputs out of tracked repo surfaces.
- Do not delete pitch materials; archive them under `assets/pitch/`.



