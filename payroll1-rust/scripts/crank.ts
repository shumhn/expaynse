import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs";
import { PayrollClient } from "../app/client";
import { Payroll } from "../target/types/payroll";
import { privateTransfer } from "../../lib/magicblock-api"; // Based on your architecture

async function runCrank() {
  // Load local Anchor config
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Payroll as anchor.Program<Payroll>;

  // Load Employer (in a real production app, Crank has its own wallet, but we'll use Employer for Devnet test)
  const keypairData = JSON.parse(
    fs.readFileSync(process.env.ANCHOR_WALLET!, "utf-8")
  );
  const crankSigner = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  // Connect to the Client Interface
  const client = new PayrollClient("https://api.devnet.solana.com", program);

  console.log("🔐 Authenticating Crank to MagicBlock TEE Validator...");
  const teeToken = await client.authenticateTee(crankSigner);
  console.log("   ✅ TEE Session Token Established.");

  // For testing, hardcode an employee or pass via ENV. The stream id is the
  // opaque on-chain identity; the employee wallet is only the payment recipient.
  // Assuming the employee is already onboarded and delegated inside the TEE:
  const employeePubkey = new PublicKey("11111111111111111111111111111111"); // Replace with real employee
  const streamId = new PublicKey(
    process.env.EXPAYNSE_STREAM_ID || "11111111111111111111111111111111"
  ).toBuffer();
  const employeePda = client.getEmployeePda(crankSigner.publicKey, streamId);

  const RATE_PER_TICK_USDC = 0.01; // $0.01 per tick private SPL transfer
  const INTERVAL_MS = 2000; // 2 seconds

  console.log(`\n⚙️  Starting Autonomous Streaming Crank...`);
  console.log(`   Target Employee PDA: ${employeePda.toBase58()}`);
  console.log(`   Tick Rate: 1 Request per ${INTERVAL_MS}ms\n`);

  setInterval(async () => {
    try {
      console.log(
        `[Crank Tick ${new Date().toISOString()}] Executing Streaming Updates...`
      );

      // 1. TEE State Accrual (Anchor Contract)
      // We manually construct the transaction to securely bypass base-chain preflight and target the TEE RPC.
      const paySalaryIx = await program.methods
        .paySalary()
        .accountsPartial({
          employer: crankSigner.publicKey,
          employee: employeePda,
          crankOrEmployer: crankSigner.publicKey,
        })
        .instruction();

      const tx = new Transaction().add(paySalaryIx);

      // Pull recent blockhash from the TEE network directly to satisfy ephemeral validation
      const { blockhash } = await client.teeConnection!.getLatestBlockhash(
        "confirmed"
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer = crankSigner.publicKey;
      tx.sign(crankSigner); // The Crank signs the transaction privately

      const wireRaw = tx.serialize();

      // Submit raw transaction to the ephemeral rollup
      const sig = await client.teeConnection!.sendRawTransaction(wireRaw, {
        skipPreflight: true,
      });
      console.log(
        `   -> [Smart Contract] Accrued Internal State Ledger (TEE Tx: ${sig})`
      );

      // 2. TEE Private Payments Transfer (Move real Tokens inside ER)
      // Calls the external MagicBlock Private Payments API from lib/magicblock-api.ts
      await privateTransfer(
        crankSigner.publicKey.toBase58(),
        employeePubkey.toBase58(), // The token moves to the employee's wallet natively
        RATE_PER_TICK_USDC,
        undefined, // Default USDC
        teeToken // Feed the TEE authenticated session ticket into the API wrapper
      );

      console.log(
        `   -> [Private Token API] Moved $${RATE_PER_TICK_USDC} to Employee ER Vault natively.`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ Crank Tick Failed:`, message);
    }
  }, INTERVAL_MS);
}

runCrank().catch(console.error);
