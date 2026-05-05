import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import { PayrollClient } from "../app/client";
import { Payroll } from "../target/types/payroll";

async function main() {
  // Use the local CLI wallet which is already funded with Devnet SOL
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Payroll as anchor.Program<Payroll>;

  // Load the employer wallet
  const keypairData = JSON.parse(
    fs.readFileSync(process.env.ANCHOR_WALLET!, "utf-8")
  );
  const employer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  // We'll simulate onboarding a random employee wallet plus an opaque stream id.
  const employee = Keypair.generate();
  const streamId = Keypair.generate().publicKey.toBuffer();
  console.log(`\n👨‍💼 Onboarding New Employee: ${employee.publicKey.toBase58()}`);

  const client = new PayrollClient("https://api.devnet.solana.com", program);

  // 1. TEE Validation
  console.log("\n🔒 1. Authenticating MagicBlock TEE Session...");
  const token = await client.authenticateTee(employer);
  console.log(
    `   ✅ TEE Signed Authenticated! Token scoped: ${token.substring(0, 15)}...`
  );

  // 2. Base Chain Initialization
  console.log("\n🏗️  2. Initializing Payroll Account on Solana Devnet...");
  // Pay them 1000 lamports / second
  const initTx = await client.createEmployee(employer, streamId, 1000);
  console.log(
    `   ✅ Created Employee on Base: https://solscan.io/tx/${initTx}?cluster=devnet`
  );

  // 3. Delegate into TEE!
  console.log(
    "\n🚀 3. Assigning MagicBlock Permissions & Teleporting into TEE..."
  );
  const delegateTx = await client.delegateEmployeeToTee(employer, streamId);
  console.log(
    `   ✅ Delegated! Privacy enforced: https://solscan.io/tx/${delegateTx}?cluster=devnet`
  );

  // 4. Fund Payroll inside the TEE using Private Payments
  console.log("\n💰 4. Minting and Funding the Confidential Vault...");
  const fundRes = await client.fundPayroll(
    employer.publicKey.toBase58(),
    5 /* 5 USDC/SOL equiv */,
    token
  );
  console.log(`   ✅ Bankrolled!`, fundRes);

  console.log("\n🎉 EMPLOYEE SUCCESSFULLY ONBOARDED AND DELEGATED!");
}

main().catch(console.error);
