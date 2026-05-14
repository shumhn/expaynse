use anchor_lang::prelude::*;

pub const EMPLOYEE_SEED: &[u8] = b"employee";
pub const PRIVATE_PAYROLL_SEED: &[u8] = b"private-payroll";
pub const EMPLOYEE_PER_SPONSOR_TOP_UP_LAMPORTS: u64 = 5_000_000;
pub const DEVNET_TEE_VALIDATOR: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
pub const MAGIC_PROGRAM_PUBKEY: Pubkey =
    Pubkey::new_from_array(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID.to_bytes());
pub const PERMISSION_PROGRAM_ID: Pubkey =
    Pubkey::new_from_array(ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID.to_bytes());
