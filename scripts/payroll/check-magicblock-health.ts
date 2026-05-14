import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
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
  console.log("Checking MagicBlock ER/PER health...");

  if (!process.env.EMPLOYER_KEYPAIR) {
    throw new Error("Missing EMPLOYER_KEYPAIR (or ANCHOR_WALLET fallback) for payroll health check.");
  }

  const employerKey = JSON.parse(fs.readFileSync(process.env.EMPLOYER_KEYPAIR, "utf8"));
  const employer = Keypair.fromSecretKey(Uint8Array.from(employerKey));

  console.log("🔐 Authenticating with TEE...");
  const token = await getTeeToken(erRpc!, employer);
  const authenticatedRpc = `${erRpc}?token=${token}`;

  const connection = new Connection(authenticatedRpc, "confirmed");

  try {
    const version = await connection.getVersion();
    console.log("✅ getVersion:", version);
  } catch (e: any) {
    console.error("❌ getVersion failed:", e.message);
  }

  try {
    const slot = await connection.getSlot();
    console.log("✅ getSlot:", slot);
  } catch (e: any) {
    console.error("❌ getSlot failed:", e.message);
  }

  try {
    const res = await fetch(authenticatedRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const data: any = await res.json();
    console.log("✅ getHealth:", data.result ?? data.error?.message ?? "unknown");
  } catch (e: any) {
    console.error("❌ getHealth failed:", e.message);
  }

  console.log("\n--- Readiness Summary ---");
  console.log("If reads work but your E2E says 'Transactions disabled', the cluster is in Maintenance Mode (Write-Locked).");
}

main().catch((err) => {
  console.error("Health check crashed:", err);
  process.exit(1);
});
