# Expaynse

Privacy-first payroll and private salary payouts on Solana, with MagicBlock powering real-time execution.

## MagicBlock Review Path

If you are reviewing the MagicBlock integration, start here:

1. `Anchor.toml`
2. `programs/payroll/src/lib.rs`
3. `scripts/payroll/`
4. `tests/payroll/`
5. `docs/MAGICBLOCK.md`
6. `lib/magicblock-api.ts`

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




