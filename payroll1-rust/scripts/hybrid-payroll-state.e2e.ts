/**
 * scripts/hybrid-payroll-state.e2e.ts
 *
 * First E2E test for the final hybrid/API private payroll architecture.
 *
 * What this proves:
 *   ✅ create_employee on base devnet
 *   ✅ initialize_payroll on base devnet
 *   ✅ delegate_payroll_privately into PER/TEE
 *   ✅ resume_stream on ER/PER RPC
 *   ✅ checkpoint_accrual on ER/PER RPC
 *   ✅ employee request_withdrawal on ER/PER RPC
 *   ✅ settlement authority cancel_pending_withdrawal on ER/PER RPC
 *
 * What this does NOT test yet:
 *   ❌ /v1/spl/deposit
 *   ❌ /v1/spl/transfer
 *   ❌ /v1/spl/withdraw
 *
 * That comes in the second worker test.
 *
 * Install:
 *   pnpm add @coral-xyz/anchor @solana/web3.js dotenv
 *   pnpm add -D tsx typescript
 *
 * Required .env:
 *   PROGRAM_ID=HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6
 *   BASE_RPC_URL=https://api.devnet.solana.com
 *   ER_RPC_URL=https://devnet-tee.magicblock.app?token=<TOKEN>
 *   EMPLOYER_KEYPAIR=/absolute/path/to/employer.json
 *   EMPLOYEE_KEYPAIR=/absolute/path/to/employee.json
 *
 * Optional .env:
 *   IDL_PATH=target/idl/payroll.json
 *   SETTLEMENT_KEYPAIR=/absolute/path/to/settlement.json
 *   PAYROLL_TREASURY=<pubkey>
 *   MINT=<pubkey>
 *   VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
 *   STREAM_ID=hybrid-payroll-state-001
 *   RATE_PER_SECOND=1000000
 *   REQUEST_AMOUNT=1000000
 *   PERMISSION_SEED_STR=<override if auto-detect fails>
 *
 * Run:
 *   pnpm tsx scripts/hybrid-payroll-state.e2e.ts
 */

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

// -----------------------------------------------------------------------------
// Constants.
// -----------------------------------------------------------------------------

const DEFAULT_PROGRAM_ID = "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6";

const DEFAULT_DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

const DEFAULT_PERMISSION_PROGRAM_ID = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
);

const DEFAULT_DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

const EMPLOYEE_SEED = "employee";
const PAYROLL_SEED = "payroll";

// -----------------------------------------------------------------------------
// Basic helpers.
// -----------------------------------------------------------------------------

function env(name: string): string | undefined {
  return process.env[name];
}

function mustEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function envNumber(name: string, fallback: number): number {
  const v = env(name);
  return v ? Number(v) : fallback;
}

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function randomNonDefaultPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function sha256_32(input: string): Buffer {
  return crypto.createHash("sha256").update(input).digest().subarray(0, 32);
}

async function accountExists(connection: Connection, pubkey: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(pubkey, "confirmed")) !== null;
}

function pk(value: string | undefined, fallback: PublicKey): PublicKey {
  return value ? new PublicKey(value) : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTeeToken(connectionUrl: string, keypair: Keypair): Promise<string> {
  const auth = await getAuthToken(
    connectionUrl,
    keypair.publicKey,
    async (message) => nacl.sign.detached(message, keypair.secretKey)
  );
  return auth.token;
}

async function sendErTx(
  connection: Connection,
  keypair: Keypair,
  instruction: any
) {
  const tx = new Transaction().add(instruction);
  tx.feePayer = keypair.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(keypair);
  
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

const PERMISSION_SEED = "permission:";
const DELEGATE_BUFFER_TAG = "buffer";
const DELEGATION_RECORD_TAG = "delegation";
const DELEGATION_METADATA_TAG = "delegation-metadata";


// -----------------------------------------------------------------------------
// PDA helpers.
// -----------------------------------------------------------------------------

function employeePda(
  programId: PublicKey,
  employer: PublicKey,
  streamId32: Buffer
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(EMPLOYEE_SEED), employer.toBuffer(), streamId32],
    programId
  )[0];
}

function payrollPda(programId: PublicKey, employee: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PAYROLL_SEED), employee.toBuffer()],
    programId
  )[0];
}

function permissionPda(
  permissionedAccount: PublicKey,
  permissionProgramId: PublicKey
): PublicKey {
  if (process.env.PERMISSION_PDA) {
    return new PublicKey(process.env.PERMISSION_PDA);
  }

  return PublicKey.findProgramAddressSync(
    [Buffer.from(PERMISSION_SEED), permissionedAccount.toBuffer()],
    permissionProgramId
  )[0];
}

function permissionDelegationPdas(params: {
  permission: PublicKey;
  permissionProgramId: PublicKey;
  delegationProgramId: PublicKey;
}) {
  const bufferPermission = PublicKey.findProgramAddressSync(
    [Buffer.from(DELEGATE_BUFFER_TAG), params.permission.toBuffer()],
    params.permissionProgramId
  )[0];

  const delegationRecordPermission = PublicKey.findProgramAddressSync(
    [Buffer.from(DELEGATION_RECORD_TAG), params.permission.toBuffer()],
    params.delegationProgramId
  )[0];

  const delegationMetadataPermission = PublicKey.findProgramAddressSync(
    [Buffer.from(DELEGATION_METADATA_TAG), params.permission.toBuffer()],
    params.delegationProgramId
  )[0];

  return {
    bufferPermission,
    delegationRecordPermission,
    delegationMetadataPermission,
  };
}

// -----------------------------------------------------------------------------
// Payroll state decoding helper.
// -----------------------------------------------------------------------------

function asU64String(value: any): string {
  if (value == null) return "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return JSON.stringify(value);
}

async function fetchPayroll(program: Program, payroll: PublicKey): Promise<any> {
  // Anchor account name is usually payrollState from #[account] pub struct PayrollState
  const anyProgram = program as any;
  if (!anyProgram.account?.payrollState) {
    throw new Error("program.account.payrollState not found. Check IDL account name.");
  }

  return anyProgram.account.payrollState.fetch(payroll);
}

function printPayroll(label: string, state: any) {
  console.log(`\n${label}`);
  console.log("  status:", state.status);
  console.log("  rate_per_second:", asU64String(state.ratePerSecond));
  console.log("  accrued_unpaid:", asU64String(state.accruedUnpaid));
  console.log("  total_paid_private:", asU64String(state.totalPaidPrivate));
  console.log("  total_cancelled:", asU64String(state.totalCancelled));
  console.log("  next_claim_id:", asU64String(state.nextClaimId));
  console.log("  pending_claim_id:", asU64String(state.pendingClaimId));
  console.log("  pending_amount:", asU64String(state.pendingAmount));
  console.log("  pending_status:", state.pendingStatus);
}

// -----------------------------------------------------------------------------
// Main E2E.
// -----------------------------------------------------------------------------

async function main() {
  const programId = new PublicKey(env("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID);
  const baseRpc = mustEnv("BASE_RPC_URL");
  const erRpc = mustEnv("ER_RPC_URL");

  const permissionProgramId = pk(env("PERMISSION_PROGRAM_ID"), DEFAULT_PERMISSION_PROGRAM_ID);
  const delegationProgramId = pk(env("DELEGATION_PROGRAM_ID"), DEFAULT_DELEGATION_PROGRAM_ID);
  const validator = pk(env("VALIDATOR"), DEFAULT_DEVNET_TEE_VALIDATOR);

  const employer = loadKeypair(mustEnv("EMPLOYER_KEYPAIR"));
  const employee = loadKeypair(mustEnv("EMPLOYEE_KEYPAIR"));
  const settlement = env("SETTLEMENT_KEYPAIR")
    ? loadKeypair(mustEnv("SETTLEMENT_KEYPAIR"))
    : employer;

  const payrollTreasury = env("PAYROLL_TREASURY")
    ? new PublicKey(mustEnv("PAYROLL_TREASURY"))
    : employer.publicKey;

  // For state-only test, mint only needs to be non-default.
  // Real payment worker test will use the actual funded mint.
  const mint = env("MINT") ? new PublicKey(mustEnv("MINT")) : randomNonDefaultPubkey();

  const ratePerSecond = new BN(envNumber("RATE_PER_SECOND", 1_000_000));
  const requestAmount = new BN(envNumber("REQUEST_AMOUNT", 1_000_000));

  const streamIdLabel = env("STREAM_ID") ?? "hybrid-payroll-state-001";
  const streamId = sha256_32(streamIdLabel);

  const baseConnection = new Connection(baseRpc, "confirmed");

  console.log("🔐 Fetching TEE auth tokens...");
  const employerToken = await getTeeToken(erRpc, employer);
  const employeeToken = await getTeeToken(erRpc, employee);
  const settlementToken = (settlement.publicKey.equals(employer.publicKey)) 
    ? employerToken 
    : await getTeeToken(erRpc, settlement);

  const employerErConnection = new Connection(`${erRpc}?token=${employerToken}`, "confirmed");
  const employeeErConnection = new Connection(`${erRpc}?token=${employeeToken}`, "confirmed");
  const settlementErConnection = new Connection(`${erRpc}?token=${settlementToken}`, "confirmed");

  const baseProvider = new AnchorProvider(
    baseConnection,
    new Wallet(employer),
    { commitment: "confirmed" }
  );

  const employerErProvider = new AnchorProvider(
    employerErConnection,
    new Wallet(employer),
    { commitment: "confirmed", skipPreflight: true }
  );

  const employeeErProvider = new AnchorProvider(
    employeeErConnection,
    new Wallet(employee),
    { commitment: "confirmed", skipPreflight: true }
  );

  const settlementErProvider = new AnchorProvider(
    settlementErConnection,
    new Wallet(settlement),
    { commitment: "confirmed", skipPreflight: true }
  );

  const idlPath = env("IDL_PATH") ?? "target/idl/payroll.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl & { address?: string };
  idl.address = programId.toBase58();

  const baseProgram = new Program(idl, baseProvider);
  const employerErProgram = new Program(idl, employerErProvider);
  const employeeErProgram = new Program(idl, employeeErProvider);
  const settlementErProgram = new Program(idl, settlementErProvider);

  const employeeAccount = employeePda(programId, employer.publicKey, streamId);
  const payroll = payrollPda(programId, employeeAccount);
  const permission = permissionPda(payroll, permissionProgramId);
  const permissionDelegation = permissionDelegationPdas({
    permission,
    permissionProgramId,
    delegationProgramId,
  });

  console.log("\nHybrid Payroll State E2E");
  console.log("Program:", programId.toBase58());
  console.log("Employer:", employer.publicKey.toBase58());
  console.log("Employee wallet:", employee.publicKey.toBase58());
  console.log("Settlement authority:", settlement.publicKey.toBase58());
  console.log("Payroll treasury:", payrollTreasury.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("Validator:", validator.toBase58());
  console.log("Stream ID label:", streamIdLabel);
  console.log("Employee account:", employeeAccount.toBase58());
  console.log("Payroll:", payroll.toBase58());
  console.log("Permission:", permission.toBase58());
  console.log("Buffer permission:", permissionDelegation.bufferPermission.toBase58());
  console.log("Delegation record permission:", permissionDelegation.delegationRecordPermission.toBase58());
  console.log("Delegation metadata permission:", permissionDelegation.delegationMetadataPermission.toBase58());

  // 1. create_employee
  if (!(await accountExists(baseConnection, employeeAccount))) {
    await baseProgram.methods
      .createEmployee(Array.from(streamId), employee.publicKey)
      .accounts({
        employee: employeeAccount,
        employer: employer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([employer])
      .rpc();

    console.log("✅ create_employee");
  } else {
    console.log("↪ employee already exists");
  }

  // 2. initialize_payroll
  if (!(await accountExists(baseConnection, payroll))) {
    await baseProgram.methods
      .initializePayroll(
        ratePerSecond,
        mint,
        payrollTreasury,
        settlement.publicKey
      )
      .accounts({
        employer: employer.publicKey,
        employee: employeeAccount,
        payroll,
        systemProgram: SystemProgram.programId,
      })
      .signers([employer])
      .rpc();

    console.log("✅ initialize_payroll");
  } else {
    console.log("↪ payroll already exists");
  }

  const payrollOwnerBefore = await baseConnection.getAccountInfo(payroll, "confirmed");
  console.log("Payroll owner before delegation:", payrollOwnerBefore?.owner.toBase58());

  // 3. delegate_payroll_privately
  if (!payrollOwnerBefore?.owner.equals(delegationProgramId)) {
    await baseProgram.methods
      .delegatePayrollPrivately()
      .accounts({
        employer: employer.publicKey,
        employee: employeeAccount,
        payroll,
        permission,
        bufferPermission: permissionDelegation.bufferPermission,
        delegationRecordPermission: permissionDelegation.delegationRecordPermission,
        delegationMetadataPermission: permissionDelegation.delegationMetadataPermission,
        permissionProgram: permissionProgramId,
        delegationProgram: delegationProgramId,
        systemProgram: SystemProgram.programId,
        validator,
      })
      .signers([employer])
      .rpc();

    console.log("✅ delegate_payroll_privately");
  } else {
    console.log("↪ payroll already delegated");
  }

  console.log("⏳ Waiting 3 seconds for ER visibility...");
  await sleep(3000);

  // 4. resume_stream on ER
  try {
    const resumeIx = await employerErProgram.methods
      .resumeStream()
      .accounts({
        employer: employer.publicKey,
        payroll,
      })
      .instruction();

    await sendErTx(employerErConnection, employer, resumeIx);

    console.log("✅ resume_stream on ER");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("StreamNotPaused") || msg.includes("stream is not paused")) {
      console.log("↪ stream already active");
    } else {
      throw e;
    }
  }

  console.log("⏳ Waiting 3 seconds to accrue...");
  await sleep(3000);

  // 5. checkpoint_accrual on ER
  const checkpointIx = await employerErProgram.methods
    .checkpointAccrual()
    .accounts({
      payroll,
    })
    .instruction();

  await sendErTx(employerErConnection, employer, checkpointIx);

  console.log("✅ checkpoint_accrual on ER");

  let payrollState = await fetchPayroll(employerErProgram, payroll);
  printPayroll("Payroll after checkpoint", payrollState);

  const accrued = BigInt(asU64String(payrollState.accruedUnpaid));
  if (accrued <= BigInt(0)) {
    throw new Error("Expected accrued_unpaid > 0 after checkpoint");
  }

  // If a previous run left a pending claim, cancel it first.
  if (Number(payrollState.pendingStatus) === 1) {
    console.log("↪ pending claim exists; cancelling before new request...");
    const pendingClaimId = new BN(asU64String(payrollState.pendingClaimId));

    const cancelOldIx = await settlementErProgram.methods
      .cancelPendingWithdrawal(pendingClaimId)
      .accounts({
        settlementAuthority: settlement.publicKey,
        payroll,
      })
      .instruction();

    await sendErTx(settlementErConnection, settlement, cancelOldIx);

    console.log("✅ cancel old pending withdrawal");

    payrollState = await fetchPayroll(employerErProgram, payroll);
    printPayroll("Payroll after old pending cancel", payrollState);
  }

  const requestAmountBig = BigInt(requestAmount.toString());
  const currentAccrued = BigInt(asU64String(payrollState.accruedUnpaid));

  if (currentAccrued < requestAmountBig) {
    throw new Error(
      `Not enough accrued for request. accrued=${currentAccrued}, request=${requestAmountBig}. Increase wait or lower REQUEST_AMOUNT.`
    );
  }

  // 6. employee request_withdrawal on ER
  const requestIx = await employeeErProgram.methods
    .requestWithdrawal(requestAmount)
    .accounts({
      employeeSigner: employee.publicKey,
      payroll,
    })
    .instruction();

  await sendErTx(employeeErConnection, employee, requestIx);

  console.log("✅ request_withdrawal on ER");

  payrollState = await fetchPayroll(employeeErProgram, payroll);
  printPayroll("Payroll after request_withdrawal", payrollState);

  if (Number(payrollState.pendingStatus) !== 1) {
    throw new Error("Expected pending_status = Requested after request_withdrawal");
  }

  // 7. cancel pending withdrawal on ER.
  // This proves settlement authority can update/cancel the pending payment.
  const cancelIx = await settlementErProgram.methods
    .cancelPendingWithdrawal(new BN(asU64String(payrollState.pendingClaimId)))
    .accounts({
      settlementAuthority: settlement.publicKey,
      payroll,
    })
    .instruction();

  await sendErTx(settlementErConnection, settlement, cancelIx);

  console.log("✅ cancel_pending_withdrawal on ER");

  payrollState = await fetchPayroll(settlementErProgram, payroll);
  printPayroll("Payroll after cancel_pending_withdrawal", payrollState);

  if (Number(payrollState.pendingStatus) !== 0) {
    throw new Error("Expected pending_status = None after cancel_pending_withdrawal");
  }

  console.log("\n🎉 HYBRID PAYROLL STATE E2E SUCCESS");
  console.log("Private payroll state/delegation/accrual/request/cancel flow works.");
}

main().catch((err) => {
  console.error("\n❌ HYBRID PAYROLL STATE E2E FAILED");
  console.error(err);
  process.exit(1);
});
