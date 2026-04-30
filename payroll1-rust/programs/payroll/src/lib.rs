use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::access_control::{
    instructions::CreatePermissionCpiBuilder,
    structs::{Member, MembersArgs, Permission, AUTHORITY_FLAG},
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, ephemeral_accounts};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use std::str::FromStr;

declare_id!("EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR");

pub const EMPLOYEE_SEED: &[u8] = b"employee";
pub const PRIVATE_PAYROLL_SEED: &[u8] = b"private-payroll";
pub const EMPLOYEE_PER_SPONSOR_TOP_UP_LAMPORTS: u64 = 5_000_000;
pub const DEVNET_TEE_VALIDATOR: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
pub const MAGIC_VAULT: &str = "MagicVau1t999999999999999999999999999999999";
pub const MAGIC_PROGRAM_PUBKEY: Pubkey =
    Pubkey::new_from_array(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID.to_bytes());

#[ephemeral]
#[program]
pub mod payroll {
    use super::*;

    pub fn create_employee(ctx: Context<CreateEmployee>, stream_id: [u8; 32]) -> Result<()> {
        let emp = &mut ctx.accounts.employee;
        emp.stream_id = stream_id;
        emp.employer_authority_hash =
            employer_authority_hash(&ctx.accounts.employer.key(), &stream_id);

        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.employer.key(),
            &emp.key(),
            EMPLOYEE_PER_SPONSOR_TOP_UP_LAMPORTS,
        );

        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.employer.to_account_info(),
                ctx.accounts.employee.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        msg!("Created opaque public employee anchor and topped up sponsor lamports");
        Ok(())
    }

    pub fn initialize_private_payroll(
        ctx: Context<InitializePrivatePayroll>,
        rate_per_second: u64,
    ) -> Result<()> {
        let employee = &ctx.accounts.employee;
        let now = Clock::get()?.unix_timestamp;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        ctx.accounts
            .create_ephemeral_private_payroll((8 + PrivatePayrollState::LEN) as u32)?;

        let state = PrivatePayrollState {
            employee: employee.key(),
            stream_id: employee.stream_id,
            status: StreamStatus::Paused as u8,
            version: 1,
            last_checkpoint_ts: now,
            rate_per_second,
            last_accrual_timestamp: now,
            accrued_unpaid: 0,
            total_paid_private: 0,
            bump: ctx.bumps.private_payroll,
        };

        let mut data = ctx.accounts.private_payroll.try_borrow_mut_data()?;
        state.serialize(&mut &mut data[..])?;

        msg!(
            "Initialized private payroll state at rate {}",
            rate_per_second
        );
        Ok(())
    }

    pub fn pay_salary(ctx: Context<PaySalary>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &mut ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        require_keys_eq!(
            ctx.accounts.crank_or_employer.key(),
            ctx.accounts.employer.key(),
            ErrorCode::UnauthorizedCrankOrEmployer
        );
        require!(
            payroll.status == StreamStatus::Active as u8,
            ErrorCode::EmployeeNotActive
        );

        let (elapsed, amount) = accrue_private_payroll_to_now(now, &mut payroll)?;

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!(
            "Accrued {} private units for opaque stream after {} seconds",
            amount,
            elapsed
        );

        Ok(())
    }

    pub fn checkpoint_accrual(ctx: Context<CheckpointAccrual>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts
                .employee
                .is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            payroll.status == StreamStatus::Active as u8,
            ErrorCode::EmployeeNotActive
        );

        let (elapsed, amount) = accrue_private_payroll_to_now(now, &mut payroll)?;

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!(
            "Checkpointed {} private units for opaque stream after {} seconds",
            amount,
            elapsed
        );

        Ok(())
    }

    pub fn schedule_checkpoint_accrual(
        ctx: Context<ScheduleCheckpointAccrual>,
        args: ScheduleCheckpointArgs,
    ) -> Result<()> {
        let employee = load_employee_account(&ctx.accounts.employee)?;
        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        let (expected_permission, _permission_bump) =
            Permission::find_pda(&ctx.accounts.employee.key());
        require_keys_eq!(
            ctx.accounts.permission.key(),
            expected_permission,
            ErrorCode::InvalidPermissionAccount
        );

        let crank_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.employer.key(), false),
                AccountMeta::new(ctx.accounts.employee.key(), false),
                AccountMeta::new(ctx.accounts.private_payroll.key(), false),
                AccountMeta::new_readonly(ctx.accounts.permission.key(), false),
                // `#[ephemeral_accounts]` injects the Magic vault and program accounts
                // into checkpoint_accrual. Anchor fills these automatically for direct
                // client calls, but scheduled tasks must include them explicitly.
                AccountMeta::new(Pubkey::from_str(MAGIC_VAULT).unwrap(), false),
                AccountMeta::new_readonly(MAGIC_PROGRAM_PUBKEY, false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::CheckpointAccrual {}),
        };

        let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id: args.task_id as i64,
            execution_interval_millis: args.execution_interval_millis as i64,
            iterations: args.iterations as i64,
            instructions: vec![crank_ix],
        }))
        .map_err(|_| error!(ErrorCode::CrankSerializationFailed))?;

        let schedule_ix = Instruction::new_with_bytes(
            MAGIC_PROGRAM_PUBKEY,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.employer.key(), true),
                AccountMeta::new(ctx.accounts.employee.key(), false),
                AccountMeta::new(ctx.accounts.private_payroll.key(), false),
                AccountMeta::new_readonly(ctx.accounts.permission.key(), false),
            ],
        );

        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.magic_program.to_account_info(),
                ctx.accounts.employer.to_account_info(),
                ctx.accounts.employee.to_account_info(),
                ctx.accounts.private_payroll.to_account_info(),
                ctx.accounts.permission.to_account_info(),
            ],
            &[],
        )?;

        Ok(())
    }

    pub fn cancel_checkpoint_accrual(
        ctx: Context<CancelCheckpointAccrual>,
        task_id: u64,
    ) -> Result<()> {
        let employee = load_employee_account(&ctx.accounts.employee)?;
        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        let ix_data = bincode::serialize(&MagicBlockInstruction::CancelTask {
            task_id: task_id as i64,
        })
        .map_err(|_| error!(ErrorCode::CrankSerializationFailed))?;

        let cancel_ix = Instruction::new_with_bytes(
            MAGIC_PROGRAM_PUBKEY,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.employer.key(), true),
                AccountMeta::new(ctx.accounts.employee.key(), false),
                AccountMeta::new(ctx.accounts.private_payroll.key(), false),
            ],
        );

        invoke_signed(
            &cancel_ix,
            &[
                ctx.accounts.magic_program.to_account_info(),
                ctx.accounts.employer.to_account_info(),
                ctx.accounts.employee.to_account_info(),
                ctx.accounts.private_payroll.to_account_info(),
            ],
            &[],
        )?;

        Ok(())
    }

    pub fn settle_salary(ctx: Context<SettleSalary>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        require!(amount > 0, ErrorCode::InvalidSettlementAmount);
        require!(
            payroll.accrued_unpaid >= amount,
            ErrorCode::InsufficientAccruedBalance
        );

        payroll.accrued_unpaid = payroll
            .accrued_unpaid
            .checked_sub(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.total_paid_private = payroll
            .total_paid_private
            .checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Settled {} private payroll units for opaque stream", amount);

        Ok(())
    }

    pub fn update_private_terms(
        ctx: Context<UpdatePrivateTerms>,
        new_rate_per_second: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        let (elapsed, amount) = if payroll.status == StreamStatus::Active as u8 {
            accrue_private_payroll_to_now(now, &mut payroll)?
        } else {
            (0, 0)
        };

        payroll.rate_per_second = new_rate_per_second;
        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!(
            "Updated private payroll rate to {} after checkpointing {} private units across {} seconds",
            new_rate_per_second,
            amount,
            elapsed
        );

        Ok(())
    }

    pub fn pause_stream(ctx: Context<UpdatePrivateTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        require!(
            payroll.status == StreamStatus::Active as u8,
            ErrorCode::EmployeeNotActive
        );

        let (_, pending_amount) = accrue_private_payroll_to_now(now, &mut payroll)?;

        payroll.status = StreamStatus::Paused as u8;
        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!(
            "Paused opaque payroll stream after accruing {} private units",
            pending_amount
        );

        Ok(())
    }

    pub fn resume_stream(ctx: Context<UpdatePrivateTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        require!(
            payroll.status == StreamStatus::Paused as u8,
            ErrorCode::EmployeeNotPaused
        );

        payroll.last_accrual_timestamp = now;
        payroll.status = StreamStatus::Active as u8;
        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Resumed opaque payroll stream");

        Ok(())
    }

    pub fn stop_stream(ctx: Context<UpdatePrivateTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let employee = &ctx.accounts.employee;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        if payroll.status == StreamStatus::Active as u8 {
            let _ = accrue_private_payroll_to_now(now, &mut payroll)?;
        }

        payroll.status = StreamStatus::Stopped as u8;
        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Stopped opaque payroll stream");

        Ok(())
    }

    pub fn close_private_payroll(ctx: Context<ClosePrivatePayroll>) -> Result<()> {
        let employer_key = ctx.accounts.employer.key();

        require!(
            ctx.accounts.employee.is_authorized_employer(&employer_key),
            ErrorCode::UnauthorizedEmployer
        );
        let payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;
        require!(
            payroll.status == StreamStatus::Stopped as u8,
            ErrorCode::EmployeeStillActive
        );
        require!(
            payroll.accrued_unpaid == 0,
            ErrorCode::OutstandingAccruedPayroll
        );

        ctx.accounts.close_ephemeral_private_payroll()?;

        Ok(())
    }

    pub fn close_employee(ctx: Context<CloseEmployee>) -> Result<()> {
        require!(
            ctx.accounts
                .employee
                .is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        let expected_private_payroll_pda = Pubkey::find_program_address(
            &[PRIVATE_PAYROLL_SEED, ctx.accounts.employee.key().as_ref()],
            &crate::ID,
        )
        .0;
        require!(
            ctx.accounts.private_payroll.key() == expected_private_payroll_pda,
            ErrorCode::InvalidPrivatePayrollAccount
        );
        require!(
            ctx.accounts.private_payroll.data_len() == 0,
            ErrorCode::PrivatePayrollStillOpen
        );
        Ok(())
    }

    pub fn create_permission(ctx: Context<CreatePermission>, _stream_id: [u8; 32]) -> Result<()> {
        let employer_member = Member {
            flags: AUTHORITY_FLAG,
            pubkey: ctx.accounts.employer.key(),
        };

        let bump = ctx.bumps.employee;
        let bump_seed = [bump];
        let employer_key = ctx.accounts.employer.key();
        let seeds: &[&[u8]] = &[
            EMPLOYEE_SEED,
            employer_key.as_ref(),
            &ctx.accounts.employee.stream_id,
            &bump_seed,
        ];
        let signer_seeds = &[seeds];

        require!(
            ctx.accounts
                .employee
                .is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&ctx.accounts.employee.to_account_info())
            .permission(&ctx.accounts.permission.to_account_info())
            .payer(&ctx.accounts.employer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .args(MembersArgs {
                // Never use None here: docs define None as publicly visible.
                // A single authority-only member keeps PER logs/balances/messages restricted.
                members: Some(vec![employer_member]),
            })
            .invoke_signed(signer_seeds)?;

        Ok(())
    }

    pub fn delegate_employee(ctx: Context<DelegateEmployee>, stream_id: [u8; 32]) -> Result<()> {
        let employee = load_employee_account(&ctx.accounts.employee)?;
        require!(employee.stream_id == stream_id, ErrorCode::InvalidStreamId);
        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        let employer_key = ctx.accounts.employer.key();
        let seeds: &[&[u8]] = &[EMPLOYEE_SEED, employer_key.as_ref(), &stream_id];

        ctx.accounts.delegate_employee(
            &ctx.accounts.employer,
            seeds,
            DelegateConfig {
                validator: Some(Pubkey::from_str(DEVNET_TEE_VALIDATOR).unwrap()),
                ..Default::default()
            },
        )?;

        Ok(())
    }

    pub fn commit_employee(ctx: Context<CommitEmployee>) -> Result<()> {
        require!(
            ctx.accounts
                .employee
                .is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        ctx.accounts.employee.exit(&crate::ID)?;
        commit_accounts(
            &ctx.accounts.employer,
            vec![&ctx.accounts.employee.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;
        Ok(())
    }

    pub fn undelegate_employee(ctx: Context<CommitEmployee>) -> Result<()> {
        require!(
            ctx.accounts
                .employee
                .is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );
        ctx.accounts.employee.exit(&crate::ID)?;
        commit_and_undelegate_accounts(
            &ctx.accounts.employer,
            vec![&ctx.accounts.employee.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;
        Ok(())
    }
}

#[repr(u8)]
pub enum StreamStatus {
    Active = 1,
    Paused = 2,
    Stopped = 3,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid time value")]
    InvalidTime,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Only the employer can close or update this employee account")]
    UnauthorizedEmployer,
    #[msg("Provided stream id does not match the employee account")]
    InvalidStreamId,
    #[msg("Only the authorized crank or employer may accrue payroll")]
    UnauthorizedCrankOrEmployer,
    #[msg("Failed to serialize MagicBlock crank schedule payload")]
    CrankSerializationFailed,
    #[msg("Provided permission account does not match the expected MagicBlock permission PDA")]
    InvalidPermissionAccount,
    #[msg("Settlement amount must be greater than zero")]
    InvalidSettlementAmount,
    #[msg("Insufficient accrued private payroll balance")]
    InsufficientAccruedBalance,
    #[msg("Employee stream must be stopped before closing")]
    EmployeeStillActive,
    #[msg("Employee stream must be active for this operation")]
    EmployeeNotActive,
    #[msg("Employee stream must be paused for this operation")]
    EmployeeNotPaused,
    #[msg("Private payroll state account is not initialized")]
    PrivatePayrollNotInitialized,
    #[msg("Outstanding accrued payroll must be settled before closing")]
    OutstandingAccruedPayroll,
    #[msg("Provided private payroll account does not match the expected PDA")]
    InvalidPrivatePayrollAccount,
    #[msg("Private payroll state must be closed before closing the employee")]
    PrivatePayrollStillOpen,
}

#[account]
pub struct Employee {
    pub stream_id: [u8; 32],
    pub employer_authority_hash: [u8; 32],
}

impl Employee {
    pub const LEN: usize = 32 + 32;

    pub fn is_authorized_employer(&self, employer: &Pubkey) -> bool {
        self.employer_authority_hash == employer_authority_hash(employer, &self.stream_id)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrivatePayrollState {
    pub employee: Pubkey,
    pub stream_id: [u8; 32],
    pub status: u8,
    pub version: u64,
    pub last_checkpoint_ts: i64,
    pub rate_per_second: u64,
    pub last_accrual_timestamp: i64,
    pub accrued_unpaid: u64,
    pub total_paid_private: u64,
    pub bump: u8,
}

impl PrivatePayrollState {
    pub const LEN: usize = 32 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
}

fn employer_authority_hash(employer: &Pubkey, stream_id: &[u8; 32]) -> [u8; 32] {
    let (commitment, _bump) = Pubkey::find_program_address(
        &[b"expensee-auth", employer.as_ref(), stream_id],
        &crate::ID,
    );
    commitment.to_bytes()
}

fn load_private_payroll_mut(account: &AccountInfo) -> Result<PrivatePayrollState> {
    let data = account.try_borrow_data()?;
    if data.len() < 8 {
        return err!(ErrorCode::PrivatePayrollNotInitialized);
    }
    PrivatePayrollState::deserialize(&mut &data[..])
        .map_err(|_| error!(ErrorCode::PrivatePayrollNotInitialized))
}

fn store_private_payroll(account: &AccountInfo, payroll: &PrivatePayrollState) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    payroll.serialize(&mut &mut data[..])?;
    Ok(())
}

fn load_employee_account(account: &AccountInfo) -> Result<Employee> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    Employee::try_deserialize(&mut slice).map_err(Into::into)
}

fn accrue_private_payroll_to_now(
    now: i64,
    payroll: &mut PrivatePayrollState,
) -> Result<(u64, u64)> {
    require!(
        now >= payroll.last_accrual_timestamp,
        ErrorCode::InvalidTime
    );

    let elapsed = (now - payroll.last_accrual_timestamp) as u64;
    if elapsed == 0 {
        return Ok((0, 0));
    }

    let amount = elapsed
        .checked_mul(payroll.rate_per_second)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    payroll.last_accrual_timestamp = now;
    payroll.accrued_unpaid = payroll
        .accrued_unpaid
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    Ok((elapsed, amount))
}

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
    #[account(
        mut,
        address = Permission::find_pda(&employee.key()).0
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock permission program
    #[account(address = ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID)]
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

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CheckpointAccrual<'info> {
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
    /// CHECK: Optional permission account forwarded by scheduled execution context.
    pub permission: Option<UncheckedAccount<'info>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScheduleCheckpointArgs {
    pub task_id: u64,
    pub execution_interval_millis: u64,
    pub iterations: u64,
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
    /// CHECK: Permission PDA for the employee anchor, forwarded to scheduled crank execution.
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
