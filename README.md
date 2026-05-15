<div align="center">

# Expaynse

**Private Real-Time Payroll on Solana — Powered by MagicBlock TEE**

[Problem](#the-problem) • [Market](#market-opportunity) • [Competitors](#competitive-landscape) • [GTM](#go-to-market-strategy) • [Business Model](#business-model) • [MagicBlock](#magicblock-integration) • [How It Works](#how-it-works) • [Architecture](#architecture) • [Roadmap](#roadmap) • [Getting Started](#getting-started)

Expaynse — Private, real-time payroll infrastructure on Solana.

</div>

## Overview

Expaynse is a confidential, real-time salary streaming protocol on Solana. Employers fund a private treasury, add employees with per-second salary rates, and salaries accrue autonomously inside MagicBlock TEE enclaves. Employees can view their live earnings and withdraw — all without exposing compensation data on-chain.

Expaynse uses MagicBlock as the real-time execution layer, specifically through Ephemeral Rollups, TEE execution, router-based scheduling, and delegated stream settlement.

MagicBlock is not a decorative dependency in Expaynse. It powers the real-time streaming path end-to-end:

1. The employer delegates an employee stream to a MagicBlock validator.
2. The payroll program schedules the autonomous crank on the MagicBlock router.
3. The TEE accrues salary in the delegated execution environment.
4. The stream is committed back to Solana base layer when settlement or mutation is needed.
5. The stream is redelegated so real-time payroll resumes.

If you want the fastest way to understand the integration, start here:

- [docs/MAGICBLOCK.md](docs/MAGICBLOCK.md)
- [lib/magicblock-api.ts](lib/magicblock-api.ts)
- [lib/server/payroll-program-client.ts](lib/server/payroll-program-client.ts)
- [programs/payroll/src/lib.rs](programs/payroll/src/lib.rs)
- [app/dashboard/](app/dashboard/)
- [app/claim/](app/claim/)
- [scripts/payroll/](scripts/payroll/)

```
flowchart LR
  Employer --> Delegate["Delegate stream"]
  Delegate --> Router["MagicBlock router"]
  Router --> TEE["TEE crank / accrual"]
  TEE --> Commit["Commit + undelegate"]
  Commit --> Base["Solana base layer"]
  Base --> Redelegate["Redelegate to ER"]
```

---

## The Problem

### Salary Transparency Destroys Companies From the Inside

On a public blockchain, every salary is visible. When employees discover compensation gaps — even justified ones — it breeds resentment and attrition.

- Employee A discovers Employee B earns 30% more. Morale collapses.
- Top performers leave when they learn junior hires negotiated higher.
- Private bonuses become public knowledge. Everyone expects one.
- Every raise is visible — compensation becomes office gossip.

### Outsiders Can Read Your Entire Payroll

- Competitors see your burn rate and poach talent by outbidding exact salaries
- Investors reverse-engineer your runway from payment flows
- Bad actors identify high earners and target them
- Every payout creates a permanent employer-to-employee link on-chain

### Workers Earn Every Second But Get Paid Every 30 Days

Traditional payroll forces a 30-day liquidity gap. Workers generate value from minute one but only access earnings weeks later. Cross-border teams wait 3–5 days for SWIFT settlements, losing 3–7% to fees.

---

## Market Opportunity

The on-chain payroll market is accelerating as crypto compensation goes mainstream.

**Why now:** By 2026, stablecoin payroll has crossed the early-adopter chasm. Regulatory clarity is improving, enterprise blockchain adoption is maturing, and Gen-Z workforce expectations are shifting toward real-time, crypto-native compensation. Yet no protocol offers salary privacy — until Expaynse.

| Segment | Size | Pain Point |
|---------|------|------------|
| Crypto-native companies | 50,000+ globally | Every salary is public on-chain |
| Remote-first teams | 70M+ workers | 3–7% cross-border fees, 3–5 day waits |
| Freelancer platforms | $1.5T gig economy | 30-day payment gaps, platform lock-in |
| DAOs & treasuries | $25B+ managed | No privacy tooling for contributor payments |

---

## Competitive Landscape

Expaynse is the only protocol that combines TEE-private salary state, per-second streaming, and private settlement through MagicBlock. Here's how we compare:

| Protocol | Streaming | Privacy | Settlement | Chain |
|----------|-----------|---------|------------|-------|
| **Superfluid / Sablier** | Per-second | None — all public | Public transfers | EVM |
| **Zebec** | Per-second | None — all public | TradFi integration | Solana |
| **Streamflow** | Per-second | None — all public | Public transfers | Solana |
| **Expaynse** | Per-second | TEE-private state | MagicBlock private payments | Solana |

- **Superfluid / Sablier:** Great streaming primitives, but all salary data is fully public on-chain. Any explorer can see who pays whom and how much. No privacy at all.
- **Zebec:** Closest in ambition (real payroll on Solana), but focuses on TradFi integration and compliance — salaries are still transparent on-chain, and it relies on centralized infrastructure.
- **Expaynse:** The privacy-first payroll protocol. TEE means salary rates and balances are computationally invisible. Private payment rails mean even the employer-employee link is obscured. Nobody else does this.

---

## Go-to-Market Strategy

### Phase 1 — Web3 Startups & DAOs (now)
- **Why first:** Treasury already on-chain, crypto-native teams, immediate product-market fit
- **Wedge:** "Your contributor salaries are public right now — competitors can see your entire org chart and burn rate"
- **Distribution:** Solana ecosystem partnerships, hackathon demos, developer content, DAO governance proposals

### Phase 2 — Remote-First Companies (next)
- **Why:** 70M+ global remote workers, cross-border payroll is painful (3–7% fees, 3–5 day waits)
- **Wedge:** "Pay your global team in seconds for <$0.01 per transaction — no SWIFT, no intermediaries"
- **Distribution:** HR/payroll platform integrations, stablecoin on-ramp partnerships

### Phase 3 — Freelancer Platforms & Contractor Networks
- **Why:** Gig economy workers earn every second but get paid every 30 days
- **Wedge:** "Real-time salary streaming — withdraw your earnings the moment you earn them"
- **Distribution:** Platform SDK, white-label integration for freelancer marketplaces

### Growth Levers
- **Employee self-service UX** — Zero-config employee onboarding lowers adoption friction to near zero
- **Privacy as a moat** — Once a company runs payroll through TEE-private streams, switching cost is high
- **Treasury management** — Built-in deposit, swap (SOL/USDT → USDC), and private balance management

---

## Business Model

Expaynse generates revenue through protocol-level fees and premium services — no rent-seeking middlemen, just infrastructure that earns as it scales.

| Revenue Stream | Model |
|----------------|-------|
| Streaming fee | Basis points on accrued salary volume |
| Settlement fee | Per-withdrawal flat fee |
| Treasury swap spread | Spread on SOL/USDT → USDC private swaps |
| Enterprise tier | Monthly SaaS for audit, compliance, multi-sig |
| Auditor access | Per-token compliance portal access |

### Unit Economics
- **Cost to serve:** Near-zero marginal cost — all logic is on-chain, no off-chain servers to maintain beyond metadata
- **Revenue scales with volume:** More businesses × more employees × more withdrawals = compounding protocol fees
- **Privacy creates lock-in:** Once payroll runs through TEE-private streams, migration cost is high — strong retention moat

### Why This Works
Traditional payroll processors (ADP, Gusto, Deel) charge $6–$12 per employee per month. Expaynse's protocol fee model is 10–100× cheaper for the employer while generating sustainable revenue at scale. A single DAO with 50 contributors streaming $5K/month each = $250K monthly volume → $250–$1,250/month in protocol fees, growing linearly with adoption.

---

## MagicBlock Integration

Expaynse uses three MagicBlock primitives for private payroll execution:

### 1. Ephemeral Rollups (TEE)
Employee payroll state is delegated into MagicBlock's TEE validator, where per-second accrual runs privately. The on-chain `PrivatePayrollState` account holds rate, accrued balance, and claim status — all invisible to public RPCs while delegated.

### 2. Private Payments API
Salary disbursements use MagicBlock's `/v1/spl/transfer/build` endpoint with privacy config (split transfers, randomized delays) so settlement transactions cannot be correlated to individual salaries.

### 3. Private Swap API
Treasury funding supports SOL → USDC and USDT → USDC swaps routed through MagicBlock's `/v1/swap` endpoints with `visibility: "private"`, keeping company treasury operations confidential.

### On-Chain Instruction Set

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
| `pause_stream` / `resume_stream` / `stop_stream` | Stream lifecycle control |
| `schedule_checkpoint_accrual` | Register recurring crank via MagicBlock Magic Program |
| `cancel_checkpoint_accrual` | Cancel a scheduled crank task |
| `commit_employee` / `undelegate_employee` | Sync state back to base layer |
| `close_private_payroll` / `close_employee` | Clean up terminated streams |

### PDA Derivation Map

```
Employee        → ["employee", employer_pubkey, stream_id]
PrivatePayroll  → ["private_payroll", employee_pda]
Permission      → derived via permissionPdaFromAccount(employee_pda)
```

### Key Design: Keeper-Free Architecture

Unlike traditional streaming protocols that rely on off-chain keeper services, Expaynse is fully on-chain:

- **Crank-based settlements** — The MagicBlock router schedules `checkpoint_accrual` autonomously via `schedule_checkpoint_accrual`
- **No relayer needed** — Employees claim payouts directly against the TEE state
- **Private treasury** — MagicBlock ephemeral vault holds funds with private balance visibility
- **Schedule + execute pattern** — `schedule_checkpoint_accrual` queues work, the MagicBlock Magic Program executes it permissionlessly

### Account Model

```
Employee (PDA on base layer)
├── stream_id: [u8; 32]
└── employer: Pubkey

PrivatePayrollState (PDA in TEE)
├── employee: Pubkey
├── employee_wallet: Pubkey
├── stream_id: [u8; 32]
├── mint: Pubkey
├── payroll_treasury: Pubkey
├── settlement_authority: Pubkey
├── status: u8                     (Active / Paused / Stopped)
├── version: u64                   (monotonic state version)
├── rate_per_second: u64           (salary rate in micro-units)
├── last_accrual_timestamp: i64
├── accrued_unpaid: u64
├── total_paid_private: u64
├── total_cancelled: u64
├── pending_claim_id: u64
├── pending_amount: u64
├── pending_client_ref_hash: [u8; 32]
├── pending_requested_at: i64
├── pending_status: u8             (None / Requested)
└── bump: u8
```

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Program | Anchor 0.32.1 · Rust · `ephemeral-rollups-sdk` 0.11 · `magicblock-magic-program-api` 0.8.8 |
| Frontend | Next.js 16.2 · React 19.2 · Tailwind CSS 4 · Framer Motion 12 · Recharts 3.8 |
| Blockchain | Solana Web3.js 1.98 · `@solana/spl-token` · `@solana/wallet-adapter` |
| Database | MongoDB 7 |
| Auth | Ed25519 wallet signatures · HMAC sessions · AES-256-GCM key vault |
| Validation | Zod 4 |

Program ID: `HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6`

---

## How It Works

### For Employers

1. **Connect Wallet** — Sign in with Phantom or Solflare
2. **Set Up Company** — Creates encrypted company keypairs (treasury + settlement authority) stored in AES-256-GCM vault
3. **Fund Treasury** — Deposit USDC directly, or swap SOL/USDT into private treasury via MagicBlock swap API
4. **Add Employees** — Define name, wallet, salary rate, pay schedule, employment type (supports CSV bulk import)
5. **Activate Streams** — On-chain employee PDA is created, delegated to TEE, private payroll state initialized
6. **Done** — Salary streams automatically, checkpoint crank runs autonomously, disbursements happen through private payment rails

### For Employees

1. **Connect Wallet** — Sign in with your wallet
2. **View Dashboard** — See live accrued balance ticking up in real-time
3. **Check Balances** — View private ephemeral balance and base-layer balance
4. **Request Withdrawal** — One-click withdrawal request, signed by your wallet against TEE state
5. **Receive Funds** — Settlement authority processes the claim, funds arrive through private transfer

### Real-Time Streaming Flow

```
sequenceDiagram
  participant E as Employer
  participant P as Payroll Program
  participant MB as MagicBlock TEE
  participant W as Employee

  E->>P: create_employee()
  E->>P: create_permission()
  E->>P: delegate_employee()
  P->>MB: Delegate to TEE enclave
  E->>MB: initialize_private_payroll(rate, mint, treasury, settlement_auth)
  E->>MB: resume_stream()

  loop Every Second (inside TEE)
    MB->>MB: checkpoint_accrual: accrued += rate × elapsed
  end

  W->>MB: request_withdrawal(amount)
  E->>P: build_private_transfer()
  E->>MB: mark_private_transfer_paid(claim_id, amount, payment_ref)
  MB-->>W: Funds arrive via private payment rails
  E->>MB: commit_employee()
```

### Security Model

- **Wallet-based authentication** — Every API request is authenticated via Ed25519 wallet signatures. The client signs a structured message containing wallet address, HTTP method, path, timestamp, and body SHA-256 hash. The server verifies against the claimed wallet's public key.
- **Company key vault** — Treasury and settlement authority keypairs are encrypted at rest using AES-256-GCM with a server-side encryption secret. Keys never leave the server in plaintext.
- **TEE privacy guarantees** — Private payroll state (rates, accrued balances, claims) lives inside MagicBlock's TEE during active streaming. Only the employer authority and the linked employee wallet have permission-gated access.
- **Auditor access** — Time-limited, revocable tokens grant read-only access to payroll data for compliance purposes without exposing the employer's signing authority.
- **Monthly caps** — Configurable per-employee monthly disbursement caps prevent overpayment.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js 16)                    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Employer   │  │   Employee   │  │     Treasury         │  │
│  │  Dashboard   │  │    Portal    │  │   Management         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐  │
│  │              Wallet Adapter (Phantom / Solflare)           │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                             │  Ed25519 Signed Requests          │
│  ┌──────────────────────────┴────────────────────────────────┐  │
│  │            Next.js API Routes (14 route groups)            │  │
│  │  /api/payroll · /api/employees · /api/streams · /api/auth  │  │
│  └──────────────────────────┬────────────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │            SOLANA DEVNET                 │
          │                                         │
          │  ┌───────────────▼──────────────────┐   │
          │  │     Payroll Program (Anchor)      │   │
          │  │     HoDcH6ocPxqHt5yEQ...         │   │
          │  │     17 instructions · Rust        │   │
          │  └──┬──────────┬───────────┬────────┘   │
          │     │          │           │             │
          │     ▼          ▼           ▼             │
          │  ┌────────┐ ┌────────┐ ┌──────────┐     │
          │  │MongoDB │ │MagicBl.│ │MagicBlock│     │
          │  │        │ │Payments│ │   TEE    │     │
          │  │metadata│ │  API   │ │(Ephemeral│     │
          │  │store   │ │private │ │ Rollups) │     │
          │  │        │ │transfer│ │          │     │
          │  └────────┘ └────────┘ └──────────┘     │
          │                                         │
          └─────────────────────────────────────────┘

Legend:
  Payroll Program  — all on-chain payroll logic
  MagicBlock TEE   — private state execution, per-second accrual
  MagicBlock Payments — private transfers, swaps, vault management
  MongoDB          — off-chain metadata (employee records, transfers, audit tokens)
```

### Dual-Role Design

| Role | Portal | Access |
|------|--------|--------|
| Employer | `/dashboard` · `/people` · `/disburse` · `/treasury` | Full payroll state, all salaries, audit trail |
| Employee | `/claim/dashboard` · `/claim/balances` · `/claim/withdraw` | Own accrued balance, withdrawal history only |
| Auditor | `/audit/[token]` | Read-only compliance view via time-limited token |

---

## Repository Structure

```
expaynse/
├── programs/payroll/                 # Anchor program (Rust)
│   └── src/
│       ├── lib.rs                    # 17 instructions — full payroll lifecycle
│       ├── state.rs                  # PrivatePayrollState, Employee, StreamStatus
│       ├── contexts.rs               # Anchor account contexts
│       ├── constants.rs              # PDA seeds, lamport amounts, validator keys
│       ├── errors.rs                 # Custom error codes
│       └── helpers.rs                # Accrual math, claim ref hashing
│
├── app/                              # Next.js application (App Router)
│   ├── page.tsx                      # Landing page
│   ├── dashboard/                    # Employer payroll overview
│   ├── people/                       # Employee management (add, edit, CSV bulk)
│   ├── disburse/                     # Payroll disbursement (batch + manual)
│   ├── treasury/                     # Treasury management (deposit, swap)
│   ├── activity/                     # Transaction activity log
│   ├── audit/                        # Auditor read-only portal
│   ├── claim/                        # Employee self-service portal
│   │   ├── dashboard/                #   Live accrual dashboard
│   │   ├── balances/                 #   Private balance view
│   │   └── withdraw/                 #   Withdrawal requests
│   ├── get-started/                  # Onboarding wizard
│   └── api/                          # 14 API route groups
│       ├── auth/                     #   Wallet session management
│       ├── company/                  #   Company setup + key vault
│       ├── employees/                #   Employee CRUD
│       ├── payroll/                  #   Stream lifecycle + accrual
│       ├── payroll-runs/             #   Batch payroll execution
│       ├── streams/                  #   Stream config + runtime state
│       ├── private-payroll/          #   TEE state queries
│       ├── employee-private-init/    #   Ephemeral vault init
│       ├── claim-salary/             #   Employee claim flow
│       ├── cashout-requests/         #   Cashout lifecycle
│       ├── history/                  #   Transfer history
│       ├── audit/                    #   Audit data endpoints
│       ├── auditor-tokens/           #   Auditor token CRUD
│       └── compliance/               #   Compliance reporting
│
├── components/
│   ├── landing/                      # 12 landing page sections
│   ├── claim/                        # Employee claim hooks + helpers
│   ├── ui/                           # Shared primitives (charts, loaders)
│   ├── deposit-modal.tsx             # USDC deposit into ephemeral vault
│   ├── private-topup-modal.tsx       # Treasury top-up (deposit + swap)
│   ├── withdraw-modal.tsx            # Employee withdrawal modal
│   └── connect-wallet-btn.tsx        # Wallet connection with auth
│
├── lib/
│   ├── magicblock-api.ts             # MagicBlock Payments + Swap API client
│   ├── private-swap.ts               # Treasury swap builders
│   ├── payroll-math.ts               # Rate conversion, pay cycle calculations
│   ├── wallet-request-auth.ts        # Ed25519 wallet-signed request auth
│   ├── client/
│   │   ├── wallet-auth-fetch.ts      # Authenticated API fetch wrapper
│   │   └── tee-auth-cache.ts         # TEE JWT token cache
│   └── server/
│       ├── payroll-store.ts          # MongoDB data layer
│       ├── payroll-program-client.ts # Anchor program client for TEE ops
│       ├── company-key-vault.ts      # AES-256-GCM encrypted key storage
│       ├── treasury-payroll-transfer.ts # Private transfer orchestration
│       ├── monthly-cap.ts            # Monthly disbursement cap logic
│       └── wallet-session.ts         # Session token management
│
├── scripts/payroll/                  # Operational tooling
│   ├── crank.ts                      # Checkpoint accrual crank runner
│   ├── onboard-employee.ts           # CLI employee onboarding
│   ├── check-magicblock-health.ts    # MagicBlock connectivity check
│   ├── verify-devnet.js              # End-to-end devnet verifier
│   └── devnet/                       # Deployment + IDL repair scripts
│
├── tests/
│   ├── app/                          # Application-level tests
│   │   ├── payroll-end-to-end.e2e.ts #   Full payroll lifecycle E2E
│   │   ├── payroll-realtime.e2e.ts   #   Realtime accrual verification
│   │   └── route-smoke.ts            #   API route smoke tests
│   ├── payroll/                      # On-chain program tests (devnet)
│   ├── treasury/                     # Treasury swap config tests
│   └── magicblock/                   # MagicBlock API E2E tests
│
├── docs/MAGICBLOCK.md                # MagicBlock reviewer guide
├── Anchor.toml                       # Anchor workspace config
└── package.json                      # Scripts + dependencies
```

---

## Roadmap

| Phase | Status | Milestone |
|-------|--------|-----------|
| V1 — Core streaming | Done | Per-second salary accrual, employer dashboard, employee portal |
| V2 — MagicBlock TEE | Done | Delegated execution, private state, checkpoint cranks |
| V3 — Private settlements | Done | MagicBlock private payments, split transfers, treasury swaps |
| V4 — Production hardening | In progress | Monthly caps, batch disbursement, compliance, audit portal |
| V5 — Multi-company | Planned | Multi-tenant vault, company isolation, role-based access |
| V6 — Mainnet | Planned | Mainnet deployment, fee model activation, enterprise tier |

---

## Getting Started

### Prerequisites
- Node.js 18+
- Solana CLI with a devnet wallet
- Anchor CLI 0.32.1 (for program builds)
- MongoDB (Atlas or local)
- Devnet SOL in employer wallet

### 1. Install Dependencies

```bash
git clone https://github.com/shumhn/expaynse.git
cd expaynse
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Required variables are documented in `.env.example` with MagicBlock endpoints, Solana RPC, MongoDB URI, and keypair paths.

### 3. Build the Anchor Program

```bash
npm run payroll:build
```

### 4. Run the App

```bash
npm run dev
```

### 5. Verify MagicBlock Connectivity

```bash
npm run payroll:magicblock:health
```

### 6. Run Tests

```bash
npm run test:app:smoke            # API route smoke tests
npm run test:app:e2e              # Full payroll lifecycle E2E
npm run test:app:realtime         # Realtime accrual verification
npm run payroll:test              # On-chain program tests
npm run payroll:verify:devnet     # End-to-end devnet verifier
```

### Demo Walkthrough

1. **Employer:** Connect wallet → Set up company → Fund treasury → Add employees → Activate streams
2. **Employee:** Connect wallet → View live accrued balance → Request withdrawal → Receive funds
3. **Auditor:** Open `/audit/[token]` → View read-only compliance data

---

## Currently on Devnet

Expaynse is live on Solana Devnet. All features — MagicBlock TEE streaming, private settlements, treasury swaps, employee self-service, audit portal — are fully functional and ready to test.

Program ID: `HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6`

Expaynse — Private, real-time payroll on Solana.
