import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import {
  checkHealth,
  getBalance,
  getPrivateBalance,
  isMintInitialized,
  initializeMint,
  deposit,
  withdraw,
  buildPrivateTransfer,
  DEVNET_USDC
} from "../../lib/magicblock-api";
import { loadPayrollRuntimeEnv } from "./runtime-env";

loadPayrollRuntimeEnv();

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

async function main() {
  console.log("🚀 Testing MagicBlock Private Payments API Endpoints...");

  if (!process.env.EMPLOYER_KEYPAIR) {
    throw new Error("Missing EMPLOYER_KEYPAIR (or ANCHOR_WALLET fallback) for payroll API testing.");
  }

  const employerKey = JSON.parse(fs.readFileSync(process.env.EMPLOYER_KEYPAIR, "utf8"));
  const employer = Keypair.fromSecretKey(Uint8Array.from(employerKey));
  const pubkey = employer.publicKey.toBase58();

  console.log(`\n🔑 Authenticating with TEE for ${pubkey}...`);
  const token = await getTeeToken(erRpc!, employer);
  console.log("✅ Got TEE Token");

  // 1. checkHealth
  console.log("\n1️⃣ Testing /health...");
  try {
    const health = await checkHealth();
    console.log("✅ checkHealth:", health);
  } catch (e: any) {
    console.error("❌ checkHealth failed:", e.message);
  }

  // 2. isMintInitialized
  console.log("\n2️⃣ Testing /v1/spl/is-mint-initialized...");
  try {
    const isInit = await isMintInitialized(token);
    console.log("✅ isMintInitialized:", isInit);
  } catch (e: any) {
    console.error("❌ isMintInitialized failed:", e.message);
  }

  // 3. getBalance (Base)
  console.log("\n3️⃣ Testing /v1/spl/balance (Base)...");
  try {
    const baseBal = await getBalance(pubkey, token);
    console.log("✅ getBalance:", baseBal);
  } catch (e: any) {
    console.error("❌ getBalance failed:", e.message);
  }

  // 4. getPrivateBalance (Ephemeral)
  console.log("\n4️⃣ Testing /v1/spl/private-balance (Ephemeral)...");
  try {
    const privBal = await getPrivateBalance(pubkey, token);
    console.log("✅ getPrivateBalance:", privBal);
  } catch (e: any) {
    console.error("❌ getPrivateBalance failed:", e.message);
  }

  // 5. deposit (Base -> Ephemeral)
  console.log("\n5️⃣ Testing /v1/spl/deposit (Build TX)...");
  try {
    // Only build, don't actually sign/send so we don't mess up balances
    const depRes = await deposit(pubkey, 0.000001, token);
    console.log("✅ deposit built TX successfully:", Object.keys(depRes).includes("transactionBase64"));
  } catch (e: any) {
    console.error("❌ deposit failed:", e.message);
  }

  // 6. withdraw (Ephemeral -> Base)
  console.log("\n6️⃣ Testing /v1/spl/withdraw (Build TX)...");
  try {
    const wRes = await withdraw(pubkey, 0.000001, token);
    console.log("✅ withdraw built TX successfully:", Object.keys(wRes).includes("transactionBase64"));
  } catch (e: any) {
    console.error("❌ withdraw failed:", e.message);
  }

  // 7. transfer (Private Transfer)
  console.log("\n7️⃣ Testing /v1/spl/transfer (Build TX)...");
  try {
    // We send from employer to employer just to test the build endpoint
    const txRes = await buildPrivateTransfer({
      from: pubkey,
      to: pubkey,
      amountMicro: 1, // 1 micro-USDC
      outputMint: DEVNET_USDC,
      token,
      balances: { fromBalance: "ephemeral", toBalance: "ephemeral" }
    });
    console.log("✅ transfer built TX successfully:", Object.keys(txRes).includes("transactionBase64"), "SendTo:", txRes.sendTo);
  } catch (e: any) {
    console.error("❌ transfer failed:", e.message);
  }

  console.log("\n🎉 All endpoints tested!");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
