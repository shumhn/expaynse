// Crank Scheduler End-to-End Test
// 
// Verifies that:
// 1. schedule_checkpoint can be called via the API
// 2. MagicBlock crank actually executes checkpoint_accrual automatically
// 3. The on-chain state (last_checkpoint_ts) updates without manual intervention

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import { POST as companyPost } from "../app/api/company/create/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { POST as streamsPost } from "../app/api/streams/route.ts";
import { PATCH as onboardFinalizePatch, POST as onboardBuildPost } from "../app/api/streams/onboard/route.ts";
import { PATCH as controlFinalizePatch, POST as controlBuildPost } from "../app/api/streams/control/route.ts";
import { POST as checkpointBuildPost, PATCH as checkpointFinalizePatch } from "../app/api/streams/checkpoint-crank/route.ts";

import { fetchTeeAuthToken, signAndSend } from "../lib/magicblock-api.ts";
import { makeAuthenticatedJsonRequest } from "./wallet-auth-test-helpers.ts";
import { loadPayrollIdl } from "../lib/server/payroll-idl.ts";

const DEVNET_RPC = "https://api.devnet.solana.com";
const TEE_RPC_BASE = "https://devnet-tee.magicblock.app";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSection(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}`);
}

function resolveWalletPath() {
  const testAuth = process.env.TEST_AUTHORITY_KEYPAIR?.trim();
  if (testAuth && fs.existsSync(testAuth)) return testAuth;
  const anchorW = process.env.ANCHOR_WALLET?.trim();
  if (anchorW && fs.existsSync(anchorW)) return anchorW;
  const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
  if (fs.existsSync(defaultPath)) return defaultPath;
  throw new Error("No devnet keypair found.");
}

function loadKeypair(walletPath: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[]));
}

async function authReq(url: string, body: unknown, signer: Keypair, wallet: string, method = "POST") {
  return makeAuthenticatedJsonRequest({ url, wallet, signer, body, method });
}

async function runTest() {
  logSection("1. Setup & Auth");
  const employerFunder = loadKeypair(resolveWalletPath());
  const employer = Keypair.generate();
  const employee = Keypair.generate();
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  const connection = new Connection(DEVNET_RPC, "confirmed");
  
  // Minimal funding
  const latest = await connection.getLatestBlockhash();
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({ fromPubkey: employerFunder.publicKey, toPubkey: employer.publicKey, lamports: 30_000_000 })
  );
  tx.recentBlockhash = latest.blockhash;
  tx.sign(employerFunder);
  await connection.sendRawTransaction(tx.serialize());

  const employerTeeAuthToken = await fetchTeeAuthToken(employer.publicKey, async (msg) => nacl.sign.detached(msg, employer.secretKey));
  console.log("  Employer:", employerWallet);
  console.log("  ✓ Auth token acquired");

  // ── Step 2: Create Company ──
  const companyRes = await companyPost(new Request("http://localhost/api/company/create", { 
    method: "POST", body: JSON.stringify({ employerWallet, name: "Crank Test Corp" }) 
  }) as any);
  const companyData = await companyRes.json() as any;
  const companyId = companyData.company.id;

  // ── Step 3: Create Employee & Stream ──
  const empRes = await employeesPost(await authReq("http://localhost/api/employees", {
    employerWallet, wallet: employeeWallet, name: "Crank Alice", monthlySalaryUsd: 1000
  }, employer, employerWallet));
  const empData = await empRes.json() as any;

  const streamRes = await streamsPost(await authReq("http://localhost/api/streams", {
    employerWallet, employeeId: empData.employee.id, ratePerSecond: 0.1, // High rate for visible changes
  }, employer, employerWallet));
  const streamData = await streamRes.json() as any;
  const streamId = streamData.stream.id;

  // ── Step 4: Onboard ──
  logSection("2. Onboard & Resume");
  const onboardBuildRes = await onboardBuildPost(await authReq("http://localhost/api/streams/onboard", {
    employerWallet, streamId, teeAuthToken: employerTeeAuthToken,
  }, employer, employerWallet));
  const onboardBuild = await onboardBuildRes.json() as any;
  
  const baseSig = await signAndSend(onboardBuild.transactions.baseSetup.transactionBase64, async (tx) => {
    if (tx instanceof anchor.web3.VersionedTransaction) { tx.sign([employer]); return tx; }
    tx.partialSign(employer); return tx;
  }, { sendTo: "base", publicKey: employer.publicKey });

  await onboardFinalizePatch(await authReq("http://localhost/api/streams/onboard", {
    employerWallet, streamId, employeePda: onboardBuild.employeePda,
    privatePayrollPda: onboardBuild.privatePayrollPda, permissionPda: onboardBuild.permissionPda,
    baseSetupSignature: baseSig, initializePrivateSignature: "bundled",
  }, employer, employerWallet, "PATCH"));

  // Resume
  const controlBuildRes = await controlBuildPost(await authReq("http://localhost/api/streams/control", {
    employerWallet, streamId, action: "resume", teeAuthToken: employerTeeAuthToken,
  }, employer, employerWallet));
  const controlBuild = await controlBuildRes.json() as any;
  const controlSig = await signAndSend(controlBuild.transactions.control.transactionBase64, async (tx) => {
    if (tx instanceof anchor.web3.VersionedTransaction) { tx.sign([employer]); return tx; }
    tx.partialSign(employer); return tx;
  }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerTeeAuthToken)}` });

  await controlFinalizePatch(await authReq("http://localhost/api/streams/control", {
    employerWallet, streamId, action: "resume", employeePda: controlBuild.employeePda,
    privatePayrollPda: controlBuild.privatePayrollPda, controlSignature: controlSig, commitSignature: "skip",
  }, employer, employerWallet, "PATCH"));
  console.log("  ✓ Stream active");

  // ── Step 5: Schedule Crank ──
  logSection("3. Schedule Crank & Verify");
  const crankBuildRes = await checkpointBuildPost(await authReq("http://localhost/api/streams/checkpoint-crank", {
    employerWallet, streamId, teeAuthToken: employerTeeAuthToken, mode: "schedule",
    executionIntervalMillis: 2000, iterations: 10,
  }, employer, employerWallet));
  assert.strictEqual(crankBuildRes.status, 201, `Crank build failed: ${await crankBuildRes.clone().text()}`);
  const crankBuild = await crankBuildRes.json() as any;

  const crankSig = await signAndSend(crankBuild.transactions.checkpointCrank.transactionBase64, async (tx) => {
    if (tx instanceof anchor.web3.VersionedTransaction) { tx.sign([employer]); return tx; }
    tx.partialSign(employer); return tx;
  }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerTeeAuthToken)}` });

  await checkpointFinalizePatch(await authReq("http://localhost/api/streams/checkpoint-crank", {
    employerWallet, streamId, mode: "schedule", signature: crankSig, status: "active",
  }, employer, employerWallet, "PATCH"));
  console.log("  ✓ Task scheduled. TaskID:", crankBuild.taskId);

  // ── Step 6: Verify Automatic Updates ──
  const teeConn = new Connection(`${TEE_RPC_BASE}?token=${encodeURIComponent(employerTeeAuthToken)}`, "confirmed");
  const provider = new anchor.AnchorProvider(teeConn, new anchor.Wallet(employer), { commitment: "confirmed" });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);
  const payrollPda = new PublicKey(crankBuild.privatePayrollPda);

  console.log("  Fetching initial state...");
  const state0 = await (program.account as any).payrollState.fetch(payrollPda) as any;
  const ts0 = state0.lastCheckpointTs.toNumber();
  const accrued0 = state0.accruedUnpaid.toNumber();
  console.log(`  Initial: checkpoint=${ts0}, accrued=${accrued0}`);

  console.log("  ⏳ Waiting 8s for crank executions...");
  await sleep(8000);

  const state1 = await (program.account as any).payrollState.fetch(payrollPda) as any;
  const ts1 = state1.lastCheckpointTs.toNumber();
  const accrued1 = state1.accruedUnpaid.toNumber();
  console.log(`  After wait: checkpoint=${ts1}, accrued=${accrued1}`);

  assert(ts1 > ts0, "Crank FAIL: last_checkpoint_ts did not increase!");
  assert(accrued1 > accrued0, "Crank FAIL: accrued_unpaid did not increase!");
  
  console.log("\n" + "=".repeat(60));
  console.log("  🎉 CRANK E2E SUCCESS!");
  console.log("  MagicBlock automatically executed checkpoint_accrual.");
  console.log("=".repeat(60) + "\n");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("\n❌ Crank Test Failed:", err);
  process.exit(1);
});
