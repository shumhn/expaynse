use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid time value")]
    InvalidTime,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Only the employer can close or update this employee account")]
    UnauthorizedEmployer,
    #[msg("Only the authorized employee can request withdrawal")]
    UnauthorizedEmployee,
    #[msg("Only the settlement authority can mark transfers paid or cancelled")]
    UnauthorizedSettlementAuthority,
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
    #[msg("Withdraw amount must be greater than zero")]
    InvalidWithdrawAmount,
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
    #[msg("A pending claim already exists")]
    PendingClaimExists,
    #[msg("No payable claim exists")]
    NoPayableClaim,
    #[msg("No cancellable claim exists")]
    NoCancellableClaim,
    #[msg("Invalid claim id")]
    InvalidClaimId,
    #[msg("Amount does not match pending claim amount")]
    AmountMismatch,
    #[msg("Invalid payment reference hash")]
    InvalidPaymentRef,
}
