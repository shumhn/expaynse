use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::{Employee, PendingStatus, PrivatePayrollState};

pub fn derive_client_ref_hash(payroll_pda: &Pubkey, claim_id: u64) -> [u8; 32] {
    // Deterministic client ref derived from payroll PDA + claim id.
    // This gives each claim a stable, non-zero reference used in mark-paid flow.
    let (pda, _bump) = Pubkey::find_program_address(
        &[b"client_ref", payroll_pda.as_ref(), &claim_id.to_le_bytes()],
        &crate::ID,
    );
    pda.to_bytes()
}

pub fn clear_pending_claim(payroll: &mut PrivatePayrollState) {
    // Reset claim fields back to the canonical "no pending claim" state.
    payroll.pending_claim_id = 0;
    payroll.pending_amount = 0;
    payroll.pending_client_ref_hash = [0u8; 32];
    payroll.pending_requested_at = 0;
    payroll.pending_status = PendingStatus::None as u8;
}

pub fn load_private_payroll_mut(account: &AccountInfo) -> Result<PrivatePayrollState> {
    let data = account.try_borrow_data()?;
    if data.len() < 8 {
        // Accounts smaller than 8 bytes cannot hold a valid serialized state.
        return err!(ErrorCode::PrivatePayrollNotInitialized);
    }
    PrivatePayrollState::deserialize(&mut &data[..])
        .map_err(|_| error!(ErrorCode::PrivatePayrollNotInitialized))
}

pub fn store_private_payroll(account: &AccountInfo, payroll: &PrivatePayrollState) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    payroll.serialize(&mut &mut data[..])?;
    Ok(())
}

pub fn load_employee_account(account: &AccountInfo) -> Result<Employee> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    Employee::try_deserialize(&mut slice).map_err(Into::into)
}

pub fn accrue_private_payroll_to_now(
    now: i64,
    payroll: &mut PrivatePayrollState,
) -> Result<(u64, u64)> {
    // Guard against clock skew / non-monotonic time.
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
