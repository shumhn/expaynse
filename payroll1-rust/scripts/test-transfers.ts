import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import {
  getPrivateBalance,
  getBalance,
  buildPrivateTransfer,
  DEVNET_USDC,
  signAndSend,
  deserializeTx,
  deposit
} from "../../lib/magicblock-api";

const erRpc = process.env.ER_RPC_URL;
if (!erRpc) throw new Error("Missing ER_RPC_URL");

async function getTeeToken(connectionUrl: string, keypair: Keypair): Promise<string> {
  const auth = await getAuthToken(
    connectionUrl,
    keypair.publicKey,
    async (message) => nacl.sign.detached(message, keypair.secretKey)
  );
  return auth.token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("🚀 Testing Actual Transfers (Ephemeral->Ephemeral & Ephemeral->Base)...");
  
  const employerKey = JSON.parse(fs.readFileSync(process.env.EMPLOYER_KEYPAIR!, "utf8"));
  const employer = Keypair.fromSecretKey(Uint8Array.from(employerKey));
  const employerPub = employer.publicKey.toBase58();

  const employeeKey = JSON.parse(fs.readFileSync(process.env.EMPLOYEE_KEYPAIR!, "utf8"));
  const employee = Keypair.fromSecretKey(Uint8Array.from(employeeKey));
  const employeePub = employee.publicKey.toBase58();

  console.log(`\n🔑 Authenticating Employer: ${employerPub}...`);
  const employerToken = await getTeeToken(erRpc!, employer);
  
  console.log(`🔑 Authenticating Employee: ${employeePub}...`);
  const employeeToken = await getTeeToken(erRpc!, employee);

  // 0. Ensure employee has an ephemeral vault by depositing 0 if needed (initVaultIfMissing is true in deposit)
  console.log("\n0️⃣ Ensuring recipient vaults exist...");
  try {
    const depRes = await deposit(employeePub, 0, employeeToken);
    if (depRes.transactionBase64) {
      console.log("Initializing employee vaults...");
      await signAndSend(depRes.transactionBase64, async (tx) => {
        if (tx instanceof VersionedTransaction) tx.sign([employee]);
        else tx.partialSign(employee);
        return tx;
      }, { sendTo: depRes.sendTo });
      await sleep(2000);
    }
  } catch (e: any) {
      console.log("Vaults might already exist or deposit failed:", e.message);
  }

  // --- Test 1: Ephemeral to Ephemeral ---
  console.log("\n1️⃣ Testing Ephemeral -> Ephemeral Transfer...");
  try {
    const empPrivBalBefore = await getPrivateBalance(employerPub, employerToken);
    const eePrivBalBefore = await getPrivateBalance(employeePub, employeeToken);
    console.log(`Before: Employer Private: ${empPrivBalBefore.balance}, Employee Private: ${eePrivBalBefore.balance}`);

    const transferAmount = 1000; // 0.001 USDC

    console.log(`Building E2E transfer of ${transferAmount} micro-USDC...`);
    const buildRes = await buildPrivateTransfer({
      from: employerPub,
      to: employeePub,
      amountMicro: transferAmount,
      outputMint: DEVNET_USDC,
      token: employerToken,
      balances: { fromBalance: "ephemeral", toBalance: "ephemeral" }
    });

    console.log("Signing and sending to ER...");
    const sig1 = await signAndSend(buildRes.transactionBase64!, async (tx) => {
        if (tx instanceof VersionedTransaction) tx.sign([employer]);
        else tx.partialSign(employer);
        return tx;
    }, { sendTo: buildRes.sendTo });
    
    console.log(`✅ Success! Signature: ${sig1}`);
    
    // Check balances after
    await sleep(2000);
    const empPrivBalAfter = await getPrivateBalance(employerPub, employerToken);
    const eePrivBalAfter = await getPrivateBalance(employeePub, employeeToken);
    console.log(`After: Employer Private: ${empPrivBalAfter.balance}, Employee Private: ${eePrivBalAfter.balance}`);
    
    const diffSent = parseInt(empPrivBalBefore.balance) - parseInt(empPrivBalAfter.balance);
    const diffRcvd = parseInt(eePrivBalAfter.balance) - parseInt(eePrivBalBefore.balance);
    console.log(`Diff: Employer sent: ${diffSent}, Employee received: ${diffRcvd}`);

  } catch (e: any) {
    console.error("❌ Ephemeral->Ephemeral failed:", e.message);
  }

  // --- Test 2: Ephemeral to Base ---
  console.log("\n2️⃣ Testing Ephemeral -> Base Transfer...");
  try {
    const empPrivBalBefore = await getPrivateBalance(employerPub, employerToken);
    const eeBaseBalBefore = await getBalance(employeePub, employeeToken);
    console.log(`Before: Employer Private: ${empPrivBalBefore.balance}, Employee Base: ${eeBaseBalBefore.balance}`);

    const transferAmount = 1000; // 0.001 USDC

    console.log(`Building E2B transfer of ${transferAmount} micro-USDC...`);
    const buildRes = await buildPrivateTransfer({
      from: employerPub,
      to: employeePub,
      amountMicro: transferAmount,
      outputMint: DEVNET_USDC,
      token: employerToken,
      balances: { fromBalance: "ephemeral", toBalance: "base" }
    });

    console.log("Signing and sending to ER...");
    const sig2 = await signAndSend(buildRes.transactionBase64!, async (tx) => {
        if (tx instanceof VersionedTransaction) tx.sign([employer]);
        else tx.partialSign(employer);
        return tx;
    }, { sendTo: buildRes.sendTo });
    
    console.log(`✅ Success! Signature: ${sig2}`);
    
    // Check balances after
    await sleep(2000);
    const empPrivBalAfter = await getPrivateBalance(employerPub, employerToken);
    const eeBaseBalAfter = await getBalance(employeePub, employeeToken);
    console.log(`After: Employer Private: ${empPrivBalAfter.balance}, Employee Base: ${eeBaseBalAfter.balance}`);
    
    const diffSent = parseInt(empPrivBalBefore.balance) - parseInt(empPrivBalAfter.balance);
    const diffRcvd = parseInt(eeBaseBalAfter.balance) - parseInt(eeBaseBalBefore.balance);
    console.log(`Diff: Employer sent: ${diffSent}, Employee received: ${diffRcvd}`);

  } catch (e: any) {
    console.error("❌ Ephemeral->Base failed:", e.message);
  }

}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
