<div align="center">

# 💸 Expaynse

### Privacy-First Real-Time Payroll Streaming on Solana

**Per-second salary accrual · MagicBlock TEE private settlements · Complete salary confidentiality**

[![Built on Solana](https://img.shields.io/badge/Built%20on-Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white)](https://solana.com)
[![Powered by MagicBlock](https://img.shields.io/badge/Powered%20by-MagicBlock-00D18C?style=for-the-badge)](https://magicblock.gg)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![Anchor 0.32](https://img.shields.io/badge/Anchor-0.32.1-blue?style=for-the-badge)](https://www.anchor-lang.com)
[![Live on Devnet](https://img.shields.io/badge/Status-Live%20on%20Devnet-00ff88?style=for-the-badge)]()

---

*Run payroll with complete financial privacy. Employers see everything — employees stay invisible to each other and the public chain.*

[Launch App](https://expaynse.vercel.app) · [Architecture](#architecture) · [Quick Start](#quick-start) · [MagicBlock Integration](#-magicblock-integration) · [API Reference](#api-routes)

</div>

---

## 🎯 The Problem

Traditional crypto payroll exposes **every salary on-chain**. Anyone with a block explorer can see who gets paid what. This is a dealbreaker for companies that need blockchain efficiency but can't sacrifice employee salary confidentiality.

## ✨ The Solution

Expaynse streams salaries **per-second** inside MagicBlock's Trusted Execution Environment (TEE), keeping accrual state private while maintaining full auditability for the employer. Settlement happens through MagicBlock's private payment rails — no public trace of individual salary amounts.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        EMPLOYER DASHBOARD                       │
│  Next.js 16 · React 19 · Tailwind 4 · Framer Motion · Recharts │
├───────────────┬─────────────────────────┬───────────────────────┤
│   People Mgmt │    Payroll Streaming    │   Treasury & Audit    │
│  Add/Edit/CSV │  Start/Pause/Resume/Stop│  Deposit · Swap · Pay │
└───────┬───────┴────────────┬────────────┴──────────┬────────────┘
        │                    │                       │
        ▼                    ▼                       ▼
┌──────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  MongoDB     │  │  Solana Program     │  │  MagicBlock APIs    │
│  Persistence │  │  (Anchor / Rust)    │  │  Payments · Swap    │
│              │  │                     │  │  TEE Auth · Vault   │
│  employees   │  │  create_employee    │  │                     │
│  streams     │  │  init_private_payroll│  │  /deposit           │
│  transfers   │  │  checkpoint_accrual │  │  /transfer/build    │
│  claims      │  │  pay_salary         │  │  /balance            │
│  audit_tokens│  │  request_withdrawal │  │  /swap/quote         │
│  company_keys│  │  mark_paid          │  │  /swap/build         │
└──────────────┘  │  pause/resume/stop  │  └─────────────────────┘
                  │  delegate/commit    │
                  │  schedule_crank     │
                  └─────────┬───────────┘
                            │
                  ┌─────────▼───────────┐
                  │   MagicBlock TEE    │
                  │  Ephemeral Rollup   │
                  │                     │
                  │  Private state      │
                  │  lives here during  │
                  │  active streaming   │
                  └─────────────────────┘
```

### Dual-Role Design

| Role | Portal | What They See |
|------|--------|---------------|
| **Employer** | `/dashboard` · `/people` · `/disburse` · `/treasury` | Full payroll state, all salaries, accrual rates, audit trail |
| **Employee** | `/claim/dashboard` · `/claim/balances` · `/claim/withdraw` | Only their own accrued balance, withdrawal history |
| **Auditor** | `/audit/[token]` | Read-only compliance view via time-limited token |

---

## ⚡ Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18 | Runtime |
| Rust | stable | Anchor program compilation |
| Solana CLI | ≥ 1.18 | Keypair management, devnet ops |
| Anchor | 0.32.1 | On-chain program framework |
| MongoDB | Atlas or local | App persistence |

### 1. Clone & Install

```bash
git clone https://github.com/shumhn/expaynse.git
cd expaynse
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in the required values:

```env
# Solana program deployed on devnet
NEXT_PUBLIC_EXPENSEE_PRIVATE_PAYROLL_PROGRAM_ID=HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6

# MagicBlock endpoints (pre-filled in .env.example)
NEXT_PUBLIC_MAGICBLOCK_ENDPOINT=https://devnet.magicblock.app
NEXT_PUBLIC_MAGICBLOCK_TEE_URL=https://tee.magicblock.app
NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL=https://devnet-tee.magicblock.app

# Solana RPC
NEXT_PUBLIC_SOLANA_CLUSTER=devnet
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com

# App persistence
MONGODB_URI=mongodb+srv://...
MONGODB_DB=expaynse
EXPENSEE_SESSION_SECRET=your-secret-here

# Payroll authority keypair
ANCHOR_WALLET=/path/to/payroll-authority.json
```

### 3. Build the Anchor Program

```bash
npm run payroll:build
```

### 4. Run the App

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and connect your Solana wallet.

---

## 🔐 MagicBlock Integration

Expaynse uses **three MagicBlock primitives** for private payroll execution:

### 1. Ephemeral Rollups (TEE)
Employee payroll state is **delegated** into MagicBlock's TEE validator, where per-second accrual runs privately. The on-chain `PrivatePayrollState` account holds rate, accrued balance, and claim status — all invisible to public RPCs while delegated.

### 2. Private Payments API
Salary disbursements use MagicBlock's `/v1/spl/transfer/build` endpoint with privacy config (split transfers, randomized delays) so settlement transactions cannot be correlated to individual salaries.

### 3. Private Swap API
Treasury funding supports SOL→USDC and USDT→USDC swaps routed through MagicBlock's `/v1/swap` endpoints with `visibility: "private"`, keeping company treasury operations confidential.

### On-Chain Program Instructions

| Instruction | Purpose |
|-------------|---------|
| `create_employee` | Deploy opaque PDA for employee on base layer |
| `create_permission` | Grant TEE access control for employer + employee |
| `delegate_employee` | Move employee account into TEE validator |
| `initialize_private_payroll` | Create private state inside ephemeral rollup |
| `checkpoint_accrual` | Tick accrued salary forward (crank-driven) |
| `pay_salary` | Settle accrued amount against private state |
| `request_withdrawal` | Employee-initiated claim from accrued balance |
| `mark_private_transfer_paid` | Settlement authority confirms off-chain payment |
| `cancel_pending_withdrawal` | Settlement authority cancels a pending claim |
| `update_private_terms` | Change rate while checkpointing accrued balance |
| `pause_stream` / `resume_stream` / `stop_stream` | Stream lifecycle |
| `schedule_checkpoint_accrual` | Register recurring crank via MagicBlock Magic Program |
| `commit_employee` / `undelegate_employee` | Sync state back to base layer |

### Reviewer Quick Path

```
Anchor.toml                          → workspace config, program ID
programs/payroll/Cargo.toml          → ephemeral-rollups-sdk, magicblock-magic-program-api
programs/payroll/src/lib.rs          → full instruction set (739 lines)
lib/magicblock-api.ts                → client-side MagicBlock API helpers (997 lines)
lib/server/payroll-program-client.ts → server-side Anchor client for TEE operations
scripts/payroll/                     → operational scripts, crank, onboarding, health checks
docs/MAGICBLOCK.md                   → detailed MagicBlock reviewer guide
```

---

## 📁 Project Structure

```
expaynse/
├── app/                          # Next.js App Router
│   ├── page.tsx                  # Landing page (Hero, FAQ, CTA, etc.)
│   ├── layout.tsx                # Root layout with WalletProvider
│   ├── globals.css               # Design system tokens + Tailwind 4
│   ├── dashboard/                # Employer dashboard (payroll overview)
│   ├── people/                   # Employee management (add, edit, CSV import)
│   ├── disburse/                 # Payroll disbursement (batch + manual)
│   ├── treasury/                 # Treasury management (deposit, swap, balances)
│   ├── activity/                 # Transaction activity log
│   ├── audit/                    # Auditor read-only portal
│   ├── claim/                    # Employee self-service portal
│   │   ├── dashboard/            #   ├─ Accrual dashboard
│   │   ├── balances/             #   ├─ Private balance view
│   │   └── withdraw/             #   └─ Withdrawal requests
│   ├── get-started/              # Onboarding wizard
│   └── api/                      # 14 API route groups
│       ├── auth/                 #   Wallet session management
│       ├── company/              #   Company setup + key vault
│       ├── employees/            #   Employee CRUD
│       ├── payroll/              #   Stream lifecycle + accrual
│       ├── payroll-runs/         #   Batch payroll execution
│       ├── streams/              #   Stream config + state
│       ├── private-payroll/      #   TEE state queries
│       ├── employee-private-init/#   Ephemeral vault initialization
│       ├── claim-salary/         #   Employee claim flow
│       ├── cashout-requests/     #   Employee cashout requests
│       ├── history/              #   Transfer history
│       ├── audit/                #   Audit data endpoints
│       ├── auditor-tokens/       #   Auditor token management
│       └── compliance/           #   Compliance reporting
│
├── components/
│   ├── landing/                  # Landing page sections (12 components)
│   ├── claim/                    # Employee claim helpers + hooks
│   ├── ui/                       # Shared UI primitives (charts, loaders)
│   ├── deposit-modal.tsx         # USDC deposit into ephemeral vault
│   ├── private-topup-modal.tsx   # Treasury top-up (deposit + swap)
│   ├── withdraw-modal.tsx        # Employee withdrawal modal
│   ├── setup-company-modal.tsx   # Company onboarding
│   ├── connect-wallet-btn.tsx    # Wallet connection with auth
│   ├── app-sidebar.tsx           # Employer navigation sidebar
│   └── app-bar.tsx               # Top navigation bar
│
├── lib/
│   ├── magicblock-api.ts         # MagicBlock Payments + Swap API client
│   ├── private-swap.ts           # Treasury swap builders
│   ├── payroll-math.ts           # Rate conversion, cycle calculations
│   ├── payroll-calendar.ts       # Pay schedule cycle logic
│   ├── wallet-request-auth.ts    # Ed25519 wallet-signed request auth
│   ├── checkpoint-sync.ts        # Crank sync state management
│   ├── storage.ts                # Client-side persistence helpers
│   ├── client/
│   │   ├── wallet-auth-fetch.ts  # Authenticated API fetch wrapper
│   │   └── tee-auth-cache.ts     # TEE JWT token cache
│   └── server/
│       ├── payroll-store.ts      # MongoDB payroll data layer (1688 lines)
│       ├── payroll-program-client.ts # Anchor program client for TEE
│       ├── payroll-idl.ts        # IDL loader + cache
│       ├── payroll-pdas.ts       # PDA derivation helpers
│       ├── company-key-vault.ts  # AES-256-GCM encrypted key storage
│       ├── company-service.ts    # Company business logic
│       ├── company-route-auth.ts # Route-level auth middleware
│       ├── treasury-payroll-transfer.ts # Private transfer orchestration
│       ├── monthly-cap.ts        # Monthly disbursement cap logic
│       ├── sponsor.ts            # Lamport sponsorship for new accounts
│       ├── history-store.ts      # Transfer history persistence
│       ├── compliance-store.ts   # Compliance data store
│       ├── mongodb.ts            # Shared MongoDB client
│       └── wallet-session.ts     # Session token management
│
├── programs/payroll/             # Anchor / Rust on-chain program
│   ├── Cargo.toml                # ephemeral-rollups-sdk 0.11, anchor-lang 0.32
│   └── src/
│       ├── lib.rs                # 17 instructions, full payroll lifecycle
│       ├── state.rs              # PrivatePayrollState, Employee, StreamStatus
│       ├── contexts.rs           # Anchor account contexts
│       ├── errors.rs             # Custom error codes
│       ├── helpers.rs            # Accrual math, claim hashing
│       └── constants.rs          # Seeds, lamport amounts, validator keys
│
├── scripts/payroll/              # Operational tooling
│   ├── crank.ts                  # Checkpoint accrual crank runner
│   ├── onboard-employee.ts       # CLI employee onboarding
│   ├── check-magicblock-health.ts# MagicBlock connectivity check
│   ├── verify-devnet.js          # End-to-end devnet verifier
│   ├── payroll-client.ts         # Shared script utilities
│   └── devnet/                   # Deployment + IDL repair scripts
│
├── tests/
│   ├── app/                      # Application-level tests
│   │   ├── payroll-end-to-end.e2e.ts    # Full payroll lifecycle E2E
│   │   ├── payroll-realtime.e2e.ts      # Realtime accrual verification
│   │   ├── route-smoke.ts               # API route smoke tests
│   │   ├── checkpoint-crank-logic.test.ts
│   │   ├── private-init-readiness.test.ts
│   │   └── stream-lifecycle-state.test.ts
│   ├── payroll/                  # On-chain program tests (devnet)
│   ├── treasury/                 # Treasury swap config tests
│   ├── magicblock/               # MagicBlock API E2E tests
│   └── helpers/                  # Test utilities + Next.js shims
│
├── hooks/useWallet.tsx           # Wallet connection hook
├── Anchor.toml                   # Anchor workspace config
├── Cargo.toml                    # Rust workspace root
└── docs/MAGICBLOCK.md            # MagicBlock reviewer guide
```

---

## 🔒 Security Model

### Wallet-Based Authentication
Every API request is authenticated via **Ed25519 wallet signatures**. The client signs a structured message containing the wallet address, HTTP method, path, timestamp, and body hash. The server verifies the signature against the claimed wallet's public key. Session tokens provide a lightweight alternative after initial auth.

### Company Key Vault
Treasury and settlement authority keypairs are encrypted at rest using **AES-256-GCM** with a server-side encryption secret. Keys never leave the server in plaintext.

### TEE Privacy Guarantees
Private payroll state (rates, accrued balances, claims) lives inside MagicBlock's TEE during active streaming. Only the employer authority and the linked employee wallet have permission-gated access.

### Auditor Access
Time-limited, revocable tokens grant read-only access to payroll data for compliance purposes — without exposing the employer's signing authority.

---

## 🧪 Testing

### App-Level Tests

```bash
# API route smoke tests
npm run test:app:smoke

# Full payroll lifecycle E2E (onboard → accrue → disburse → claim)
npm run test:app:e2e

# Realtime accrual verification (employer + employee actors)
npm run test:app:realtime

# Checkpoint crank logic
npm run test:checkpoint:logic

# Private init readiness
npm run test:app:init-readiness

# Stream lifecycle state machine
npm run test:app:stream-state
```

### On-Chain Program Tests

```bash
# Build the Anchor program
npm run payroll:build

# Run Anchor tests against devnet
npm run payroll:test

# Run devnet integration tests
npm run test:payroll:devnet
```

### Infrastructure Checks

```bash
# MagicBlock TEE/PER connectivity health check
npm run payroll:magicblock:health

# End-to-end devnet verification
npm run payroll:verify:devnet

# IDL parity check (on-chain vs local)
npm run check:payroll:idl-parity
```

### Treasury Tests

```bash
# Private swap configuration tests
npm run test:treasury:logic
```

---

## 🛠️ Common Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run payroll:build` | Compile Anchor program |
| `npm run payroll:test` | Run Anchor tests |
| `npm run payroll:crank` | Run checkpoint accrual crank |
| `npm run payroll:onboard-employee` | CLI employee onboarding |
| `npm run payroll:magicblock:health` | MagicBlock health check |
| `npm run payroll:verify:devnet` | Devnet E2E verifier |
| `npm run deploy:payroll:devnet` | Deploy program to devnet |

---

## 🌊 Payroll Lifecycle

```
  Employer                          MagicBlock TEE                    Employee
  ────────                          ──────────────                    ────────
     │                                    │                              │
     │ 1. Add Employee                    │                              │
     │──────────────────────────────►     │                              │
     │                                    │                              │
     │ 2. Create on-chain PDA            │                              │
     │ 3. Create permission              │                              │
     │ 4. Delegate to TEE ──────────────►│                              │
     │                                    │                              │
     │ 5. Initialize private payroll ───►│                              │
     │    (rate, mint, settlement auth)   │                              │
     │                                    │                              │
     │ 6. Resume stream ────────────────►│                              │
     │                                    │ ◄── Accrual ticks (crank) ──│
     │                                    │     per-second accumulation  │
     │                                    │                              │
     │ 7. Checkpoint accrual ───────────►│                              │
     │    (periodic state snapshot)       │                              │
     │                                    │                              │
     │                                    │ 8. Request Withdrawal ──────│
     │                                    │    (employee signs tx)       │
     │                                    │                              │
     │ 9. Build private transfer         │                              │
     │ 10. Sign + send settlement ──────►│                              │
     │                                    │                              │
     │ 11. Mark transfer paid ──────────►│──── Funds arrive ───────────►│
     │                                    │                              │
     │ 12. Commit state to base ────────►│                              │
     │                                    │                              │
```

---

## 📊 Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend** | Next.js (App Router) | 16.2 |
| **UI** | React | 19.2 |
| **Styling** | Tailwind CSS | 4.x |
| **Animations** | Framer Motion | 12.x |
| **Charts** | Recharts | 3.8 |
| **Blockchain** | Solana Web3.js | 1.98 |
| **Program Framework** | Anchor | 0.32.1 |
| **Privacy Layer** | MagicBlock Ephemeral Rollups SDK | 0.11 |
| **Scheduled Tasks** | MagicBlock Magic Program API | 0.8.8 |
| **Database** | MongoDB | 7.x |
| **Auth** | Ed25519 wallet signatures + sessions | — |
| **Encryption** | AES-256-GCM (company key vault) | — |
| **Validation** | Zod | 4.x |
| **Icons** | Lucide React + Phosphor Icons | — |

---

## 🚀 Deployment

The app is deployed on **Vercel** with environment variables synced via `vercel env pull`.

```bash
# Push env vars to Vercel
vercel env pull

# Deploy
vercel --prod
```

The Anchor program is deployed to **Solana Devnet**:

```
Program ID: HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6
Cluster:    devnet
```

---

## 📄 API Routes

| Endpoint Group | Methods | Purpose |
|----------------|---------|---------|
| `/api/auth` | POST | Wallet session creation + verification |
| `/api/company` | GET, POST | Company setup, key vault provisioning |
| `/api/employees` | GET, POST, PATCH, DELETE | Employee CRUD + CSV bulk import |
| `/api/payroll` | GET, POST, PATCH | Stream creation, status updates, config |
| `/api/payroll-runs` | GET, POST | Batch payroll run execution |
| `/api/streams` | GET, PATCH | Stream config + runtime state |
| `/api/private-payroll` | GET | TEE state queries (accrual preview) |
| `/api/employee-private-init` | POST | Initialize employee ephemeral vault |
| `/api/claim-salary` | POST | Employee-initiated salary claims |
| `/api/cashout-requests` | GET, POST, PATCH | Employee cashout request lifecycle |
| `/api/history` | GET | Transfer + disbursement history |
| `/api/audit` | GET | Auditor data endpoints |
| `/api/auditor-tokens` | GET, POST, DELETE | Auditor token CRUD + revocation |
| `/api/compliance` | GET | Compliance reporting data |

---

## 🤝 Contributing

1. Keep route files in `app/**/page.tsx` thin — heavy logic goes in sibling modules
2. Use kebab-case for asset filenames in `public/` and `assets/`
3. Run `npm run test:app:smoke` before pushing
4. Run `npm run check:payroll:idl-parity` after any program changes

---

<div align="center">

**Built for the [Colosseum Hackathon](https://www.colosseum.org/) 🏛️**

*Privacy is not a feature — it's a right.*

</div>
