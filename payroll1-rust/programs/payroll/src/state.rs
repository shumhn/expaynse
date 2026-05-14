use anchor_lang::prelude::*;

#[repr(u8)]
pub enum StreamStatus {
    /// Salary accrues over time and can be checkpointed/settled.
    Active = 1,
    /// Salary accrual is halted but state remains open.
    Paused = 2,
    /// Stream is terminal; only settlement/closure actions are allowed.
    Stopped = 3,
}

#[repr(u8)]
pub enum PendingStatus {
    /// No open withdrawal request.
    None = 0,
    /// A withdrawal is requested and awaiting settlement/cancellation.
    Requested = 1,
}

#[account]
pub struct Employee {
    pub stream_id: [u8; 32],
    pub employer: Pubkey,
}

impl Employee {
    pub const LEN: usize = 32 + 32;

    pub fn is_authorized_employer(&self, employer: &Pubkey) -> bool {
        self.employer == *employer
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrivatePayrollState {
    pub employee: Pubkey,
    pub employee_wallet: Pubkey,
    pub stream_id: [u8; 32],

    pub mint: Pubkey,
    pub payroll_treasury: Pubkey,
    pub settlement_authority: Pubkey,

    pub status: u8,
    pub version: u64,
    pub last_checkpoint_ts: i64,
    pub rate_per_second: u64,
    pub last_accrual_timestamp: i64,
    pub accrued_unpaid: u64,
    pub total_paid_private: u64,
    pub total_cancelled: u64,

    pub next_claim_id: u64,
    pub pending_claim_id: u64,
    pub pending_amount: u64,
    pub pending_client_ref_hash: [u8; 32],
    pub pending_requested_at: i64,
    pub pending_status: u8,

    pub bump: u8,
}

impl PrivatePayrollState {
    pub const LEN: usize = 32 + // employee
        32 + // employee_wallet
        32 + // stream_id
        32 + // mint
        32 + // payroll_treasury
        32 + // settlement_authority
        1 + // status
        8 + // version
        8 + // last_checkpoint_ts
        8 + // rate_per_second
        8 + // last_accrual_timestamp
        8 + // accrued_unpaid
        8 + // total_paid_private
        8 + // total_cancelled
        8 + // next_claim_id
        8 + // pending_claim_id
        8 + // pending_amount
        32 + // pending_client_ref_hash
        8 + // pending_requested_at
        1 + // pending_status
        1; // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScheduleCheckpointArgs {
    pub task_id: u64,
    pub execution_interval_millis: u64,
    pub iterations: u64,
}
