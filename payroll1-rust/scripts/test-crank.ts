import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve(__dirname, "../.env") });

import fs from "node:fs";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const DEVNET_TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

function getPayrollStreamSeed(streamId: string) {
  return crypto.createHash("sha256").update("expaynse-stream:v1").update(streamId).digest();
}

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}
function readI64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigInt64LE(offset);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getTeeToken(connectionUrl: string, keypair: Keypair): Promise<string> {
  const auth = await getAuthToken(
    connectionUrl,
    keypair.publicKey,
    async (message) => nacl.sign.detached(message, keypair.secretKey)
  );
  return auth.token;
}

async function main() {
  console.log("⚙️ Testing MagicBlock Autonomous Crank (schedule_checkpoint)...");
  
  const rootEnv = dotenv.config({ path: resolve(__dirname, "../../.env") }).parsed || {};
  const baseRpc = rootEnv.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.BASE_RPC_URL || "https://api.devnet.solana.com";
  const erRpc = process.env.ER_RPC_URL!;
  
  console.log(`Using Base RPC: ${baseRpc}`);

  const employer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.EMPLOYER_KEYPAIR!, "utf8"))));
  const employee = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.EMPLOYEE_KEYPAIR!, "utf8"))));
  const mint = process.env.MINT ? new PublicKey(process.env.MINT) : Keypair.generate().publicKey;
  const settlement = employer;
  const payrollTreasury = employer.publicKey;

  const streamIdStr = `crank-test-${Date.now()}`;
  const streamIdBuf = getPayrollStreamSeed(streamIdStr);
  const taskId = new BN(Date.now().toString()); // Use timestamp as task ID
  
  console.log(`Stream ID: ${streamIdStr}`);
  
  const [employeePda] = PublicKey.findProgramAddressSync([Buffer.from("employee"), employer.publicKey.toBuffer(), streamIdBuf], PROGRAM_ID);
  const [payrollPda] = PublicKey.findProgramAddressSync([Buffer.from("payroll"), employeePda.toBuffer()], PROGRAM_ID);
  const [permissionPda] = PublicKey.findProgramAddressSync([Buffer.from("permission:"), payrollPda.toBuffer()], PERMISSION_PROGRAM_ID);

  const [bufferPermission] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), permissionPda.toBuffer()], PERMISSION_PROGRAM_ID);
  const [delegationRecordPermission] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), permissionPda.toBuffer()], DELEGATION_PROGRAM_ID);
  const [delegationMetadataPermission] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), permissionPda.toBuffer()], DELEGATION_PROGRAM_ID);

  const baseConnection = new Connection(baseRpc, "confirmed");
  const baseProvider = new AnchorProvider(baseConnection, new Wallet(employer), { commitment: "confirmed" });
  
  const idlPath = process.env.IDL_PATH ?? "target/idl/payroll.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl & { address?: string };
  idl.address = PROGRAM_ID.toBase58();
  const baseProgram = new Program(idl, baseProvider);

  // 1. Create Employee
  console.log("1️⃣ Creating Employee on Base...");
  await baseProgram.methods.createEmployee(Array.from(streamIdBuf), employee.publicKey)
    .accounts({ employee: employeePda, employer: employer.publicKey, systemProgram: SystemProgram.programId })
    .signers([employer]).rpc();

  // 2. Initialize Payroll
  console.log("2️⃣ Initializing Payroll on Base...");
  await baseProgram.methods.initializePayroll(new BN(1000000), mint, payrollTreasury, settlement.publicKey)
    .accounts({ employer: employer.publicKey, employee: employeePda, payroll: payrollPda, systemProgram: SystemProgram.programId })
    .signers([employer]).rpc();

  // 3. Delegate Privately
  console.log("3️⃣ Delegating Privately to TEE...");
  await baseProgram.methods.delegatePayrollPrivately()
    .accounts({
      employer: employer.publicKey, employee: employeePda, payroll: payrollPda, permission: permissionPda,
      bufferPermission, delegationRecordPermission, delegationMetadataPermission,
      permissionProgram: PERMISSION_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId, validator: DEVNET_TEE_VALIDATOR
    })
    .signers([employer]).rpc();

  console.log("⏳ Waiting 3s for ER visibility...");
  await sleep(3000);

  // 4. Setup ER connection and Program
  console.log("🔐 Authenticating with TEE...");
  const token = await getTeeToken(erRpc, employer);
  const erConnection = new Connection(`${erRpc}?token=${token}`, "confirmed");
  const erProvider = new AnchorProvider(erConnection, new Wallet(employer), { commitment: "confirmed", skipPreflight: true });
  const erProgram = new Program(idl, erProvider) as any;

  // 5. Resume Stream (so accrual can happen)
  console.log("4️⃣ Resuming Stream on ER...");
  const resumeIx = await erProgram.methods.resumeStream().accounts({ employer: employer.publicKey, payroll: payrollPda }).instruction();
  const txResume = new Transaction().add(resumeIx);
  txResume.feePayer = employer.publicKey;
  txResume.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash;
  txResume.sign(employer);
  await erConnection.sendRawTransaction(txResume.serialize(), { skipPreflight: true });

  // 6. Schedule Checkpoint (The Crank)
  console.log("5️⃣ Scheduling Autonomous Crank on ER...");
  // 1000ms = 1s, 999999 iterations
  const scheduleIx = await erProgram.methods.scheduleCheckpoint({
      taskId: taskId,
      executionIntervalMillis: new BN(1000),
      iterations: new BN(999999)
    })
    .accounts({
      magicProgram: MAGIC_PROGRAM_ID,
      payer: employer.publicKey,
      payroll: payrollPda,
      program: PROGRAM_ID
    })
    .instruction();
  
  const txSchedule = new Transaction().add(scheduleIx);
  txSchedule.feePayer = employer.publicKey;
  txSchedule.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash;
  txSchedule.sign(employer);
  const sigSchedule = await erConnection.sendRawTransaction(txSchedule.serialize(), { skipPreflight: true });
  console.log(`✅ Crank scheduled! Signature: ${sigSchedule}`);

  // 7. Verify Crank
  async function fetchState() {
      const accountInfo = await erConnection.getAccountInfo(payrollPda, "confirmed");
      if (!accountInfo || !accountInfo.data) return null;
      const data = Buffer.from(accountInfo.data);
      return {
          lastCheckpointTs: readI64LE(data, 249).toString(),
          accruedUnpaidMicro: readU64LE(data, 257).toString()
      };
  }

  console.log("\n⏳ Waiting 5 seconds to observe autonomous accrual...");
  await sleep(2000);
  const state1 = await fetchState();
  console.log(`Snapshot 1 -> Accrued: ${state1!.accruedUnpaidMicro} | Last Ts: ${state1!.lastCheckpointTs}`);
  
  await sleep(4000);
  const state2 = await fetchState();
  console.log(`Snapshot 2 -> Accrued: ${state2!.accruedUnpaidMicro} | Last Ts: ${state2!.lastCheckpointTs}`);

  if (BigInt(state2!.accruedUnpaidMicro) > BigInt(state1!.accruedUnpaidMicro)) {
      console.log("\n✅ THE CRANK IS ALIVE! MagicBlock is automatically calling checkpoint_accrual every second in the background.");
  } else {
      console.log("\n❌ Accrual did not increase. Crank might not be running.");
  }
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
