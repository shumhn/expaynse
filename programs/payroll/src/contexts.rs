use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::Permission;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral_accounts};

use crate::constants::{
    EMPLOYEE_SEED, MAGIC_PROGRAM_PUBKEY, PERMISSION_PROGRAM_ID, PRIVATE_PAYROLL_SEED,
};
use crate::state::Employee;

#[derive(Accounts)]
#[instruction(stream_id: [u8; 32])]
pub struct CreateEmployee<'info> {
    #[account(
        init,
        payer = employer,
        space = 8 + Employee::LEN,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    #[account(mut)]
    pub employer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct InitializePrivatePayroll<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll state sponsored by the delegated employee anchor
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(stream_id: [u8; 32])]
pub struct CreatePermission<'info> {
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    #[account(mut)]
    pub employer: Signer<'info>,
    /// CHECK: Permission PDA derived and checked by the permission program
    #[account(mut, address = Permission::find_pda(&employee.key()).0)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct PaySalary<'info> {
    #[account(mut)]
    pub crank_or_employer: Signer<'info>,
    /// CHECK: Authorized employer used for employee PDA derivation and auth validation.
    pub employer: UncheckedAccount<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

/// Plain Anchor struct (no #[ephemeral_accounts]) so the MagicBlock
/// scheduler can execute it — the scheduler cannot inject the hidden
/// vault/magic_context accounts that the ephemeral macros add.
#[derive(Accounts)]
pub struct CheckpointAccrual<'info> {
    /// CHECK: Authorized employer used for employee PDA derivation and auth validation.
    pub employer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA — already lives in the ephemeral rollup.
    #[account(mut)]
    pub private_payroll: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub employee_signer: Signer<'info>,
    /// CHECK: Authorized employer used for employee PDA derivation.
    pub employer: UncheckedAccount<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct MarkPrivateTransferPaid<'info> {
    #[account(mut)]
    pub settlement_authority: Signer<'info>,
    /// CHECK: Authorized employer used for employee PDA derivation.
    pub employer: UncheckedAccount<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CancelPendingWithdrawal<'info> {
    #[account(mut)]
    pub settlement_authority: Signer<'info>,
    /// CHECK: Authorized employer used for employee PDA derivation.
    pub employer: UncheckedAccount<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ScheduleCheckpointAccrual<'info> {
    /// CHECK: MagicBlock magic program CPI target
    #[account(address = MAGIC_PROGRAM_PUBKEY)]
    pub magic_program: AccountInfo<'info>,
    #[account(mut)]
    pub employer: Signer<'info>,
    /// CHECK: Employee anchor may be delegated during scheduling lifecycle.
    #[account(mut)]
    pub employee: AccountInfo<'info>,
    /// CHECK: ER-only private payroll PDA passed through to the MagicBlock scheduler task context.
    #[account(mut)]
    pub private_payroll: AccountInfo<'info>,
    /// CHECK: Permission account forwarded to scheduled checkpoint execution context.
    #[account(mut)]
    pub permission: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CancelCheckpointAccrual<'info> {
    /// CHECK: MagicBlock magic program CPI target
    #[account(address = MAGIC_PROGRAM_PUBKEY)]
    pub magic_program: AccountInfo<'info>,
    #[account(mut)]
    pub employer: Signer<'info>,
    /// CHECK: Employee anchor may be delegated during scheduling lifecycle.
    #[account(mut)]
    pub employee: AccountInfo<'info>,
    /// CHECK: ER-only private payroll PDA passed through to the MagicBlock scheduler task context.
    #[account(mut)]
    pub private_payroll: AccountInfo<'info>,
    /// CHECK: Permission account tied to the delegated payroll context.
    #[account(mut)]
    pub permission: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct SettleSalary<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct UpdatePrivateTerms<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct ClosePrivatePayroll<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        mut,
        sponsor,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: ER-only private payroll PDA
    #[account(
        mut,
        eph,
        seeds = [PRIVATE_PAYROLL_SEED, employee.key().as_ref()],
        bump
    )]
    pub private_payroll: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CloseEmployee<'info> {
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump,
        close = employer
    )]
    pub employee: Account<'info, Employee>,
    /// CHECK: Expected private payroll PDA for this employee; must already be closed.
    pub private_payroll: AccountInfo<'info>,
    #[account(mut)]
    pub employer: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(stream_id: [u8; 32])]
pub struct DelegateEmployee<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    /// CHECK: PDA delegated to the ER delegation program
    #[account(mut, del)]
    pub employee: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitEmployee<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employer.key().as_ref(), employee.stream_id.as_ref()],
        bump
    )]
    pub employee: Account<'info, Employee>,
}
