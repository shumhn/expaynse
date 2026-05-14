# Web3 Production Finalization Plan

## Current Architecture

This repository is a single repo with two production surfaces:

1. Next.js app + API routes at root
2. Solana Rust program in `payroll1-rust/`

This is valid for a professional Web3 stack when release gates are strict.

## Finalization Gates

## 1) Contract Gate (Rust)

1. Freeze instruction surface (see `rust-contract-freeze-checklist.md`)
2. Freeze authority model (employer / employee / settlement authority)
3. Freeze state invariants for claim lifecycle

## 2) Integration Gate (Backend + App)

1. Every program-facing route maps to exact instruction semantics
2. `needs_sync` recovery path remains deterministic and auditable
3. No signer ambiguity in wallet-auth flow

## 3) Quality Gate (Tooling)

1. `npx tsc --noEmit`
2. Focused eslint on critical payroll routes
3. `cargo check` in `payroll1-rust`
4. critical route/e2e smoke tests

## 4) Release Gate (Repo Hygiene)

1. One package manager per project root (`npm`)
2. No duplicate lockfiles in Rust workspace
3. Clean commit history (small, atomic, reviewable)
4. No root-level scratch artifacts

## Suggested Commit Sequence

1. `chore(repo): normalize package manager and lockfile policy`
2. `refactor(app): split heavy page routes into page-content modules`
3. `chore(docs): add rust contract freeze and release checklist`
4. `chore(code): comment quality and invariant documentation pass`
5. `test(verif): pass critical typecheck/lint/rust checks`

## Definition of Done (Ready for Next Level)

Project is considered next-level ready when:

1. critical gates pass
2. contract/integration docs are in repo
3. release branch has clean atomic commits
4. deploy path is reproducible without ad-hoc manual fixes
