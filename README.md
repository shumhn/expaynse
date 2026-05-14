# Expaynse

Privacy-first payroll and private salary payouts on Solana.

## Repository Layout

- `app/`: Next.js routes and route handlers
- `components/`: shared UI and feature components
- `lib/`: client/server domain logic
- `tests/`: app and integration test flows
- `payroll1-rust/`: on-chain payroll program and Rust-side scripts
- `public/`: static assets used by the web app
- `assets/`: non-runtime artifacts (branding, pitch references)
- `docs/repo-standards/`: repository conventions and cleanup policy

## Development Scripts

- `npm run dev`: run app locally
- `npm run lint`: lint the codebase
- `npm run test:app:smoke`: route-level smoke with `.env`
- `npm run test:checkpoint:logic`: checkpoint logic tests
- `npm run test:cashout:payout-mode`: claim payout-mode e2e
- `npm run test:employee:init-reuse`: employee init-reuse smoke

## Naming & Hygiene

- Use kebab-case for asset file names in `public/` and `assets/`.
- Keep route files in `app/**/page.tsx` thin; place heavy logic in sibling feature modules.
- Keep temporary outputs out of root; place long-lived non-runtime files under `assets/`.
- Do not delete pitch materials; archive them under `assets/pitch/`.

See: `docs/repo-standards/repository-cleanup-policy.md`

## Production Finalization Docs

- `docs/repo-standards/rust-contract-freeze-checklist.md`
- `docs/repo-standards/web3-production-finalization-plan.md`







