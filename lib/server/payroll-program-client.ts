import fs from "fs";

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  createDelegatePermissionInstruction,
  getAuthToken,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { createAnchorNodeWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPayrollStreamSeedArg,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import { buildPrivateTransfer, DEVNET_USDC } from "@/lib/magicblock-api";

const DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TEE_URL = "https://devnet-tee.magicblock.app";
const MAGIC_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);
const DEFAULT_WALLET_PATH =
  "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";

export interface PayrollOnboardingResult {
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  createEmployeeSignature: string;
  createPermissionSignature: string;
  delegateBundleSignature: string;
  initializePrivatePayrollSignature: string;
}

export interface PayrollAccrualResult {
  paySalarySignature: string;
  commitSignature?: string;
}

export interface PayrollSettlementResult {
  settleSalarySignature: string;
  commitSignature?: string;
}

export interface PrivatePayrollStatePreview {
  employeePda: string;
  privatePayrollPda: string;
  employee: string;
  streamId: string;
  status: number;
  version: string;
  lastCheckpointTs: string;
  ratePerSecondMicro: string;
  lastAccrualTimestamp: string;
  accruedUnpaidMicro: string;
  totalPaidPrivateMicro: string;
}

type AnchorProgram = anchor.Program<Idl>;
type EmployeeAccountPublicState = {
  streamId: number[];
  employerAuthorityHash: number[];
};

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function resolveWalletPath() {
  return process.env.ANCHOR_WALLET || DEFAULT_WALLET_PATH;
}

function loadKeypair() {
  const walletPath = resolveWalletPath();
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[],
  );
  return Keypair.fromSecretKey(secret);
}

function getBaseConnection() {
  return new Connection(DEVNET_RPC, "confirmed");
}

function toRateMicroUnits(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error("ratePerSecond must be a positive number");
  }

  return Math.round(ratePerSecond * 1_000_000);
}

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readI64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigInt64LE(offset);
}

function decodePrivatePayrollState(
  data: Buffer,
  employeePda: PublicKey,
  privatePayrollPda: PublicKey,
): PrivatePayrollStatePreview {
  const PRIVATE_PAYROLL_STATE_LEN = 241;

  if (data.length < PRIVATE_PAYROLL_STATE_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  const employee = new PublicKey(data.subarray(0, 32));
  const streamId = data.subarray(64, 96).toString("hex");
  const status = data.readUInt8(192);
  const version = readU64LE(data, 193);
  const lastCheckpointTs = readI64LE(data, 201);
  const ratePerSecondMicro = readU64LE(data, 209);
  const lastAccrualTimestamp = readI64LE(data, 217);
  const accruedUnpaidMicro = readU64LE(data, 225);
  const totalPaidPrivateMicro = readU64LE(data, 233);

  return {
    employeePda: employeePda.toBase58(),
    privatePayrollPda: privatePayrollPda.toBase58(),
    employee: employee.toBase58(),
    streamId,
    status,
    version: String(version),
    lastCheckpointTs: String(lastCheckpointTs),
    ratePerSecondMicro: String(ratePerSecondMicro),
    lastAccrualTimestamp: String(lastAccrualTimestamp),
    accruedUnpaidMicro: String(accruedUnpaidMicro),
    totalPaidPrivateMicro: String(totalPaidPrivateMicro),
  };
}

async function getBaseProviderAndProgram() {
  const payer = loadKeypair();
  const wallet = createAnchorNodeWallet(payer);
  const connection = getBaseConnection();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);
  return { payer, wallet, connection, provider, program };
}

async function getTeeProviderAndProgram() {
  const { payer } = await getBaseProviderAndProgram();
  const auth = await getAuthToken(
    TEE_URL,
    payer.publicKey,
    async (message: Uint8Array) => nacl.sign.detached(message, payer.secretKey),
  );

  const connection = new Connection(
    `${TEE_URL}?token=${auth.token}`,
    "confirmed",
  );
  const wallet = createAnchorNodeWallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);

  return {
    payer,
    wallet,
    connection,
    provider,
    program,
    authToken: auth.token,
  };
}

async function sendSignedTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = signers[0].publicKey;
  transaction.sign(...signers);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: false,
    },
  );

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  return signature;
}

async function sendTeeTransaction(
  connection: Connection,
  transaction: Transaction,
  signer: Keypair,
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = signer.publicKey;
  transaction.sign(signer);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: true,
    },
  );

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  return signature;
}

function asProgram(program: anchor.Program<Idl>): AnchorProgram {
  return program as AnchorProgram;
}

export async function onboardEmployeeToPayrollProgram(input: {
  streamId: string;
  employeeWallet: string;
  ratePerSecond: number;
}): Promise<PayrollOnboardingResult> {
  assertWallet(input.employeeWallet, "Employee wallet");
  const rateMicroUnits = toRateMicroUnits(input.ratePerSecond);

  const { payer, connection, program } = await getBaseProviderAndProgram();
  const typedProgram = asProgram(program);

  const streamSeedArg = getPayrollStreamSeedArg(input.streamId);
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);
  const permissionPda = permissionPdaFromAccount(employeePda);

  const createEmployeeSignature = await typedProgram.methods
    .createEmployee(streamSeedArg)
    .accounts({
      employer: payer.publicKey,
    })
    .signers([payer])
    .rpc();

  const createPermissionSignature = await typedProgram.methods
    .createPermission(streamSeedArg)
    .accounts({
      employee: employeePda,
      employer: payer.publicKey,
      permission: permissionPda,
      permissionProgram: PERMISSION_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();

  const delegatePermissionIx = createDelegatePermissionInstruction({
    payer: payer.publicKey,
    authority: [payer.publicKey, true],
    permissionedAccount: [employeePda, false],
    ownerProgram: PERMISSION_PROGRAM_ID,
    validator: DEVNET_TEE_VALIDATOR,
  });

  const delegateEmployeeIx = await typedProgram.methods
    .delegateEmployee(streamSeedArg)
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const delegateBundleSignature = await sendSignedTransaction(
    connection,
    new Transaction().add(delegatePermissionIx, delegateEmployeeIx),
    [payer],
  );

  const { connection: teeConnection, program: teeProgram } =
    await getTeeProviderAndProgram();
  const typedTeeProgram = asProgram(teeProgram);

  const initializePrivatePayrollIx = await typedTeeProgram.methods
    .initializePrivatePayroll(new BN(rateMicroUnits))
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
      vault: MAGIC_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();

  const initializePrivatePayrollSignature = await sendTeeTransaction(
    teeConnection,
    new Transaction().add(initializePrivatePayrollIx),
    payer,
  );

  // --- Auto-Initialize Employee Vault ---
  // The Backend Payer will send 1 micro USDC to the employee's ephemeral balance.
  // This forces the MagicBlock API to automatically prepend the base-chain 
  // `CreateVault` and `DelegateVault` instructions so the employee doesn't have to pay rent.
  let employeeVaultInitSignature = null;
  try {
    const initTransferRes = await buildPrivateTransfer({
      from: payer.publicKey.toBase58(),
      to: input.employeeWallet,
      amountMicro: 1, // Minimum positive amount
      outputMint: DEVNET_USDC,
      balances: { fromBalance: "base", toBalance: "ephemeral" },
    });

    if (initTransferRes.transactionBase64) {
      const txBuf = Buffer.from(initTransferRes.transactionBase64, "base64");
      const initTx = VersionedTransaction.deserialize(txBuf);
      
      const latest = await connection.getLatestBlockhash("confirmed");
      initTx.message.recentBlockhash = latest.blockhash;
      initTx.sign([payer]);
      
      employeeVaultInitSignature = await connection.sendRawTransaction(initTx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction({ signature: employeeVaultInitSignature, ...latest }, "confirmed");
      console.log(`Auto-initialized Employee Vault. Tx: ${employeeVaultInitSignature}`);
    }
  } catch (err) {
    console.warn("Failed to auto-initialize employee vault during onboarding. Employee may already have a vault or need manual init.", err);
  }
  // --------------------------------------

  return {
    employeePda: employeePda.toBase58(),
    privatePayrollPda: privatePayrollPda.toBase58(),
    permissionPda: permissionPda.toBase58(),
    createEmployeeSignature,
    createPermissionSignature,
    delegateBundleSignature,
    initializePrivatePayrollSignature,
  };
}

export async function accruePayrollInTee(input: {
  streamId: string;
  employeeWallet: string;
  commitAfter?: boolean;
}): Promise<PayrollAccrualResult> {
  assertWallet(input.employeeWallet, "Employee wallet");

  const { payer, connection, program } = await getTeeProviderAndProgram();
  const typedProgram = asProgram(program);
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);

  const paySalaryIx = await typedProgram.methods
    .checkpointAccrual()
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
      vault: MAGIC_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();

  const paySalarySignature = await sendTeeTransaction(
    connection,
    new Transaction().add(paySalaryIx),
    payer,
  );

  if (!input.commitAfter) {
    return { paySalarySignature };
  }

  const commitIx = await typedProgram.methods
    .commitEmployee()
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const commitSignature = await sendTeeTransaction(
    connection,
    new Transaction().add(commitIx),
    payer,
  );

  return {
    paySalarySignature,
    commitSignature,
  };
}

export async function settlePayrollInTee(input: {
  streamId: string;
  employeeWallet: string;
  amount: number;
  commitAfter?: boolean;
}): Promise<PayrollSettlementResult> {
  assertWallet(input.employeeWallet, "Employee wallet");
  const amountMicroUnits = Math.round(input.amount * 1_000_000);

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("amount must be a positive number");
  }

  const { payer, connection, program } = await getTeeProviderAndProgram();
  const typedProgram = asProgram(program);
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);

  const settleSalaryIx = await typedProgram.methods
    .paySalary(new BN(amountMicroUnits))
    .accounts({
      crankOrEmployer: payer.publicKey,
      employer: payer.publicKey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
    })
    .instruction();

  const settleSalarySignature = await sendTeeTransaction(
    connection,
    new Transaction().add(settleSalaryIx),
    payer,
  );

  if (!input.commitAfter) {
    return { settleSalarySignature };
  }

  const commitIx = await typedProgram.methods
    .commitEmployee()
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const commitSignature = await sendTeeTransaction(
    connection,
    new Transaction().add(commitIx),
    payer,
  );

  return {
    settleSalarySignature,
    commitSignature,
  };
}

export async function undelegateEmployeeFromPayrollProgram(input: {
  streamId: string;
  employeeWallet: string;
}) {
  assertWallet(input.employeeWallet, "Employee wallet");

  const { payer, connection, program } = await getTeeProviderAndProgram();
  const typedProgram = asProgram(program);
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);

  const undelegateIx = await typedProgram.methods
    .undelegateEmployee()
    .accounts({
      employer: payer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const undelegateSignature = await sendTeeTransaction(
    connection,
    new Transaction().add(undelegateIx),
    payer,
  );

  return {
    employeePda: employeePda.toBase58(),
    undelegateSignature,
  };
}

export async function fetchEmployeePayrollState(input: {
  streamId: string;
  employeeWallet: string;
}) {
  assertWallet(input.employeeWallet, "Employee wallet");

  const { payer, program } = await getBaseProviderAndProgram();
  const typedProgram = asProgram(program);
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);

  const employeeAccountNamespace =
    typedProgram.account as anchor.Program<Idl>["account"] & {
      employee: {
        fetch(address: PublicKey): Promise<unknown>;
      };
    };

  const account = (await employeeAccountNamespace.employee.fetch(
    employeePda,
  )) as EmployeeAccountPublicState;

  return {
    employeePda: employeePda.toBase58(),
    privatePayrollPda: getPrivatePayrollPda(employeePda).toBase58(),
    streamId: Buffer.from(account.streamId).toString("hex"),
  };
}

export async function fetchPrivatePayrollState(input: {
  streamId: string;
  employeeWallet: string;
}): Promise<PrivatePayrollStatePreview> {
  assertWallet(input.employeeWallet, "Employee wallet");

  const { payer, connection } = await getTeeProviderAndProgram();
  const employeePda = getEmployeePdaForStream(payer.publicKey.toBase58(), input.streamId);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);

  const accountInfo = await connection.getAccountInfo(
    privatePayrollPda,
    "confirmed",
  );
  if (!accountInfo?.data) {
    throw new Error("Private payroll state not found in PER");
  }

  return decodePrivatePayrollState(
    Buffer.from(accountInfo.data),
    employeePda,
    privatePayrollPda,
  );
}

export async function previewPrivatePayrollAccrual(input: {
  streamId: string;
  employeeWallet: string;
  asOfUnixTimestamp?: number;
}) {
  const state = await fetchPrivatePayrollState({
    streamId: input.streamId,
    employeeWallet: input.employeeWallet,
  });

  const now =
    typeof input.asOfUnixTimestamp === "number"
      ? input.asOfUnixTimestamp
      : Math.floor(Date.now() / 1000);

  const lastAccrual = Number(state.lastAccrualTimestamp);
  const elapsedSeconds = state.status === 1 ? Math.max(0, now - lastAccrual) : 0;

  const ratePerSecondMicro = BigInt(state.ratePerSecondMicro);
  const accruedUnpaidMicro = BigInt(state.accruedUnpaidMicro);
  const pendingAccrualMicro = ratePerSecondMicro * BigInt(elapsedSeconds);
  const claimableAmountMicro = accruedUnpaidMicro + pendingAccrualMicro;

  return {
    ...state,
    elapsedSeconds,
    pendingAccrualMicro: pendingAccrualMicro.toString(),
    claimableAmountMicro: claimableAmountMicro.toString(),
  };
}
