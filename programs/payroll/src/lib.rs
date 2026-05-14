use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::access_control::{
    instructions::CreatePermissionCpiBuilder,
    structs::{Member, MembersArgs, AUTHORITY_FLAG},
};
use ephemeral_rollups_sdk::anchor::ephemeral;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use std::str::FromStr;

mod constants;
mod contexts;
mod errors;
mod helpers;
mod state;

use constants::*;
use contexts::*;
use errors::ErrorCode;
use helpers::*;
use state::*;

// Payroll program for privacy-first salary flows:
// - employer-managed stream lifecycle (active/paused/stopped)
// - checkpointed accrual inside MagicBlock ER
// - employee withdrawal requests + settlement authority reconciliation
declare_id!("HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6");

#[ephemeral]
#[program]
pub mod payroll {
    use super::*;

    pub fn create_employee(ctx: Context<CreateEmployee>, stream_id: [u8; 32]) -> Result<()> {
        let emp = &mut ctx.accounts.employee;
        emp.stream_id = stream_id;
        emp.employer = ctx.accounts.employer.key();

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
        employee_wallet: Pubkey,
        mint: Pubkey,
        payroll_treasury: Pubkey,
        settlement_authority: Pubkey,
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
            employee_wallet,
            stream_id: employee.stream_id,
            mint,
            payroll_treasury,
            settlement_authority,
            status: StreamStatus::Paused as u8,
            version: 1,
            last_checkpoint_ts: now,
            rate_per_second,
            last_accrual_timestamp: now,
            accrued_unpaid: 0,
            total_paid_private: 0,
            total_cancelled: 0,
            next_claim_id: 0,
            pending_claim_id: 0,
            pending_amount: 0,
            pending_client_ref_hash: [0u8; 32],
            pending_requested_at: 0,
            pending_status: PendingStatus::None as u8,
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

    pub fn pay_salary(ctx: Context<PaySalary>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidSettlementAmount);

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
            payroll.status == StreamStatus::Active as u8
                || payroll.status == StreamStatus::Stopped as u8,
            ErrorCode::EmployeeNotActive
        );

        let (elapsed, accrued_amount) = if payroll.status == StreamStatus::Active as u8 {
            accrue_private_payroll_to_now(now, &mut payroll)?
        } else {
            (0, 0)
        };

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

        msg!(
            "Settled {} private units after accruing {} units over {} seconds",
            amount,
            accrued_amount,
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

    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidWithdrawAmount);

        let now = Clock::get()?.unix_timestamp;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;
        let payroll_key = ctx.accounts.private_payroll.key();

        // Withdrawal requests must come from the wallet linked to this payroll state.
        require_keys_eq!(
            ctx.accounts.employee_signer.key(),
            payroll.employee_wallet,
            ErrorCode::UnauthorizedEmployee
        );
        require!(
            payroll.pending_status == PendingStatus::None as u8,
            ErrorCode::PendingClaimExists
        );

        if payroll.status == StreamStatus::Active as u8 {
            accrue_private_payroll_to_now(now, &mut payroll)?;
        }

        require!(
            payroll.accrued_unpaid >= amount,
            ErrorCode::InsufficientAccruedBalance
        );

        let claim_id = payroll.next_claim_id;
        let client_ref_hash = derive_client_ref_hash(&payroll_key, claim_id);

        payroll.accrued_unpaid = payroll
            .accrued_unpaid
            .checked_sub(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        payroll.pending_claim_id = claim_id;
        payroll.pending_amount = amount;
        payroll.pending_client_ref_hash = client_ref_hash;
        payroll.pending_requested_at = now;
        payroll.pending_status = PendingStatus::Requested as u8;
        payroll.next_claim_id = payroll
            .next_claim_id
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Withdrawal requested for {} units", amount);

        Ok(())
    }

    pub fn mark_private_transfer_paid(
        ctx: Context<MarkPrivateTransferPaid>,
        claim_id: u64,
        amount: u64,
        payment_ref_hash: [u8; 32],
    ) -> Result<()> {
        require!(payment_ref_hash != [0u8; 32], ErrorCode::InvalidPaymentRef);

        let now = Clock::get()?.unix_timestamp;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require_keys_eq!(
            ctx.accounts.settlement_authority.key(),
            payroll.settlement_authority,
            ErrorCode::UnauthorizedSettlementAuthority
        );
        require!(
            payroll.pending_status == PendingStatus::Requested as u8,
            ErrorCode::NoPayableClaim
        );
        require!(
            payroll.pending_claim_id == claim_id,
            ErrorCode::InvalidClaimId
        );
        require!(payroll.pending_amount == amount, ErrorCode::AmountMismatch);

        payroll.total_paid_private = payroll
            .total_paid_private
            .checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        clear_pending_claim(&mut payroll);

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Marked transfer paid for {} units", amount);

        Ok(())
    }

    pub fn cancel_pending_withdrawal(
        ctx: Context<CancelPendingWithdrawal>,
        claim_id: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut payroll = load_private_payroll_mut(&ctx.accounts.private_payroll)?;

        require_keys_eq!(
            ctx.accounts.settlement_authority.key(),
            payroll.settlement_authority,
            ErrorCode::UnauthorizedSettlementAuthority
        );
        require!(
            payroll.pending_status == PendingStatus::Requested as u8,
            ErrorCode::NoCancellableClaim
        );
        require!(
            payroll.pending_claim_id == claim_id,
            ErrorCode::InvalidClaimId
        );

        let amount = payroll.pending_amount;

        payroll.accrued_unpaid = payroll
            .accrued_unpaid
            .checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        payroll.total_cancelled = payroll
            .total_cancelled
            .checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        clear_pending_claim(&mut payroll);

        payroll.version = payroll
            .version
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payroll.last_checkpoint_ts = now;

        store_private_payroll(&ctx.accounts.private_payroll, &payroll)?;

        msg!("Cancelled pending withdrawal of {} units", amount);

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

    pub fn create_permission(
        ctx: Context<CreatePermission>,
        _stream_id: [u8; 32],
        employee_wallet: Pubkey,
    ) -> Result<()> {
        let employer_member = Member {
            flags: AUTHORITY_FLAG
                | ephemeral_rollups_sdk::access_control::structs::TX_LOGS_FLAG
                | ephemeral_rollups_sdk::access_control::structs::TX_BALANCES_FLAG
                | ephemeral_rollups_sdk::access_control::structs::TX_MESSAGE_FLAG
                | ephemeral_rollups_sdk::access_control::structs::ACCOUNT_SIGNATURES_FLAG,
            pubkey: ctx.accounts.employer.key(),
        };

        let employee_member = Member {
            flags: ephemeral_rollups_sdk::access_control::structs::ACCOUNT_SIGNATURES_FLAG,
            pubkey: employee_wallet,
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
                members: Some(vec![employer_member, employee_member]),
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

    pub fn schedule_checkpoint_accrual(
        ctx: Context<ScheduleCheckpointAccrual>,
        args: ScheduleCheckpointArgs,
    ) -> Result<()> {
        let employee = load_employee_account(&ctx.accounts.employee)?;
        require!(
            employee.is_authorized_employer(&ctx.accounts.employer.key()),
            ErrorCode::UnauthorizedEmployer
        );

        let crank_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.employer.key(), false),
                AccountMeta::new(ctx.accounts.employee.key(), false),
                AccountMeta::new(ctx.accounts.private_payroll.key(), false),
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
                AccountMeta::new(ctx.accounts.permission.key(), false),
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
                AccountMeta::new(ctx.accounts.permission.key(), false),
            ],
        );

        invoke_signed(
            &cancel_ix,
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
}
