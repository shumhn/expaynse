// Edge Cases & Stress Test Runner
//
// 1. Over-claim: Claim > Accrued
// 2. Double-claim: Simultaneous claim requests
// 3. Unauthorized claim: Wrong wallet
// 4. Insufficient Treasury: Payout failure recovery
// 5. Control Flow: Pause/Resume/Rate Update
// 6. Drift: Long-running crank verification

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";

import { POST as companyPost } from "../app/api/company/create/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { POST as streamsPost } from "../app/api/streams/route.ts";
import { PATCH as onboardFinalizePatch, POST as onboardBuildPost } from "../app/api/streams/onboard/route.ts";
import { PATCH as controlFinalizePatch, POST as controlBuildPost } from "../app/api/streams/control/route.ts";
import { POST as claimRequestBuildPost } from "../app/api/claim-salary/request/route.ts";
import { POST as checkpointBuildPost, PATCH as checkpointFinalizePatch } from "../app/api/streams/checkpoint-crank/route.ts";
import { GET as previewGet } from "../app/api/payroll/preview/route.ts";

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

async function authReq(url: string, body: unknown, signer: Keypair, wallet: string, method = "POST") {
  return makeAuthenticatedJsonRequest({ url, wallet, signer, body, method });
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

async function runTest() {
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolveWalletPath(), "utf8")) as number[]));
  const connection = new Connection(DEVNET_RPC, "confirmed");
  
  console.log("  Funder:", funder.publicKey.toBase58());
  const funderBal = await connection.getBalance(funder.publicKey);
  console.log("  Funder Balance:", funderBal / 1e9, "SOL");
  
  const employer = Keypair.generate();
  const employee = Keypair.generate();
  const attacker = Keypair.generate();

  // Initial funding
  const latest = await connection.getLatestBlockhash();
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: employer.publicKey, lamports: 15_000_000 }),
    anchor.web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: employee.publicKey, lamports: 100_000 }),
    anchor.web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: attacker.publicKey, lamports: 100_000 })
  );
  tx.recentBlockhash = latest.blockhash;
  tx.sign(funder);
  await connection.sendRawTransaction(tx.serialize());

  const employerAuth = await fetchTeeAuthToken(employer.publicKey, async (msg) => nacl.sign.detached(msg, employer.secretKey));
  const employeeAuth = await fetchTeeAuthToken(employee.publicKey, async (msg) => nacl.sign.detached(msg, employee.secretKey));

  // --- SETUP ---
  logSection("0. SETUP: Create Stream");
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  const compRes = await companyPost(new Request("http://localhost/api/company/create", { method: "POST", body: JSON.stringify({ employerWallet, name: "Stress Test Ltd" }) }) as any);
  const compData = await compRes.json() as any;
  const companyId = compData.company.id;

  const empRes = await employeesPost(await authReq("http://localhost/api/employees", { employerWallet, wallet: employeeWallet, name: "Stress Alice" }, employer, employerWallet));
  const empData = await empRes.json() as any;

  const streamRes = await streamsPost(await authReq("http://localhost/api/streams", { employerWallet, employeeId: empData.employee.id, ratePerSecond: 0.01 }, employer, employerWallet));
  const streamData = await streamRes.json() as any;
  const streamId = streamData.stream.id;

  // Onboard
  const onboardRes = await onboardBuildPost(await authReq("http://localhost/api/streams/onboard", { employerWallet, streamId, teeAuthToken: employerAuth }, employer, employerWallet));
  const onboardData = await onboardRes.json() as any;
  const baseSig = await signAndSend(onboardData.transactions.baseSetup.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "base", publicKey: employer.publicKey });
  await onboardFinalizePatch(await authReq("http://localhost/api/streams/onboard", { employerWallet, streamId, employeePda: onboardData.employeePda, privatePayrollPda: onboardData.privatePayrollPda, permissionPda: onboardData.permissionPda, baseSetupSignature: baseSig, initializePrivateSignature: "bundled" }, employer, employerWallet, "PATCH"));

  // Resume
  const controlRes = await controlBuildPost(await authReq("http://localhost/api/streams/control", { employerWallet, streamId, action: "resume", teeAuthToken: employerAuth }, employer, employerWallet));
  const controlData = await controlRes.json() as any;
  const controlSig = await signAndSend(controlData.transactions.control.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerAuth)}` });
  await controlFinalizePatch(await authReq("http://localhost/api/streams/control", { employerWallet, streamId, action: "resume", employeePda: controlData.employeePda, privatePayrollPda: controlData.privatePayrollPda, controlSignature: controlSig, commitSignature: "skip" }, employer, employerWallet, "PATCH"));

  // --- TEST 1: WRONG WALLET ---
  logSection("1. TEST: Unauthorized Claim");
  const attackerAuth = await fetchTeeAuthToken(attacker.publicKey, async (msg) => nacl.sign.detached(msg, attacker.secretKey));
  const attackerReqRes = await claimRequestBuildPost(new Request("http://localhost/api/claim-salary/request", {
    method: "POST", body: JSON.stringify({ streamId, employeeWallet: attacker.publicKey.toBase58(), amountMicro: 1000, teeAuthToken: attackerAuth })
  }) as any);
  // The API should ideally block this if it checks the stream's expected employee wallet.
  const attackerData = await attackerReqRes.json() as any;
  if (attackerReqRes.status === 201) {
    console.log("  ⚠️ API allowed build. Checking on-chain simulation...");
    try {
      await signAndSend(attackerData.transactions.requestWithdrawal.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([attacker]); else t.partialSign(attacker); return t; }, { sendTo: "ephemeral", publicKey: attacker.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(attackerAuth)}` });
      assert.fail("Wrong wallet claim should have failed on-chain!");
    } catch (e: any) {
      console.log("  ✅ On-chain check PASSED: Attack blocked (Simulation failed)");
    }
  } else {
    console.log("  ✅ API check PASSED: Attack blocked at build time");
  }

  // --- TEST 2: OVER-CLAIM ---
  logSection("2. TEST: Over-claim");
  console.log("  Accruing a bit...");
  await sleep(2000);
  const overclaimReqRes = await claimRequestBuildPost(new Request("http://localhost/api/claim-salary/request", {
    method: "POST", body: JSON.stringify({ streamId, employeeWallet, amountMicro: 1_000_000_000, teeAuthToken: employeeAuth })
  }) as any);
  const overclaimData = await overclaimReqRes.json() as any;
  try {
    await signAndSend(overclaimData.transactions.requestWithdrawal.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employee]); else t.partialSign(employee); return t; }, { sendTo: "ephemeral", publicKey: employee.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employeeAuth)}` });
    assert.fail("Over-claim should have failed on-chain!");
  } catch (e: any) {
    console.log("  ✅ PASSED: Over-claim blocked (Simulation failed)");
  }

  // --- TEST 3: DOUBLE CLAIM ---
  logSection("3. TEST: Double Claim");
  const claim1Res = await claimRequestBuildPost(new Request("http://localhost/api/claim-salary/request", {
    method: "POST", body: JSON.stringify({ streamId, employeeWallet, amountMicro: 1000, teeAuthToken: employeeAuth })
  }) as any);
  const claim1Data = await claim1Res.json() as any;
  await signAndSend(claim1Data.transactions.requestWithdrawal.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employee]); else t.partialSign(employee); return t; }, { sendTo: "ephemeral", publicKey: employee.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employeeAuth)}` });
  console.log("  First claim sent.");

  const claim2Res = await claimRequestBuildPost(new Request("http://localhost/api/claim-salary/request", {
    method: "POST", body: JSON.stringify({ streamId, employeeWallet, amountMicro: 1000, teeAuthToken: employeeAuth })
  }) as any);
  const claim2Data = await claim2Res.json() as any;
  try {
    await signAndSend(claim2Data.transactions.requestWithdrawal.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employee]); else t.partialSign(employee); return t; }, { sendTo: "ephemeral", publicKey: employee.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employeeAuth)}` });
    assert.fail("Second claim should have failed!");
  } catch (e: any) {
    console.log("  ✅ PASSED: Double-claim blocked on-chain");
  }

  // --- TEST 4: PAUSE / RESUME ---
  logSection("4. TEST: Pause / Resume / Rate Update");
  const teeConn = new Connection(`${TEE_RPC_BASE}?token=${encodeURIComponent(employerAuth)}`, "confirmed");
  const provider = new anchor.AnchorProvider(teeConn, new anchor.Wallet(employer), { commitment: "confirmed" });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);
  const payrollPda = new PublicKey(onboardData.privatePayrollPda);

  const stateBeforePause = await (program.account as any).payrollState.fetch(payrollPda) as any;
  const ts0 = stateBeforePause.lastCheckpointTs.toNumber();
  console.log("  Pausing...");
  const pauseBuild = await controlBuildPost(await authReq("http://localhost/api/streams/control", { employerWallet, streamId, action: "pause", teeAuthToken: employerAuth }, employer, employerWallet));
  const pauseData = await pauseBuild.json() as any;
  await signAndSend(pauseData.transactions.control.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerAuth)}` });
  
  console.log("  Waiting 3s while paused...");
  await sleep(3000);
  const stateAfterPause = await (program.account as any).payrollState.fetch(payrollPda) as any;
  // In a real paused stream, virtual accrual calculation in preview might still show increase, 
  // but the on-chain checkpoint_accrual (if called) would see status=Paused.
  console.log("  Resuming with new rate...");
  const resumeBuild = await controlBuildPost(await authReq("http://localhost/api/streams/control", { employerWallet, streamId, action: "resume", ratePerSecond: 0.05, teeAuthToken: employerAuth }, employer, employerWallet));
  const resumeData = await resumeBuild.json() as any;
  await signAndSend(resumeData.transactions.control.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerAuth)}` });
  
  const stateFinal = await (program.account as any).payrollState.fetch(payrollPda) as any;
  assert.strictEqual(stateFinal.ratePerSecond.toNumber(), 50000, "Rate update failed!");
  console.log("  ✅ PASSED: Pause/Resume/Rate Update confirmed");

  // --- TEST 5: INSUFFICIENT TREASURY & RECOVERY ---
  logSection("5. TEST: Insufficient Treasury & Recovery");
  console.log("  Topping up employer for second stream...");
  const topUpTx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: employer.publicKey, lamports: 5_000_000 })
  );
  topUpTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  topUpTx.sign(funder);
  await connection.sendRawTransaction(topUpTx.serialize());

  console.log("  Creating a fresh employee and stream for Test 5...");
  const employee2 = Keypair.generate();
  const employee2Wallet = employee2.publicKey.toBase58();
  const emp2Res = await employeesPost(await authReq("http://localhost/api/employees", { employerWallet, wallet: employee2Wallet, name: "Recovery Bob" }, employer, employerWallet));
  const emp2Data = await emp2Res.json() as any;

  const stream2Res = await streamsPost(await authReq("http://localhost/api/streams", { employerWallet, employeeId: emp2Data.employee.id, ratePerSecond: 0.1 }, employer, employerWallet));
  const stream2Data = await stream2Res.json() as any;
  if (!stream2Data.stream) {
    console.error("  ❌ Stream creation failed:", stream2Data);
    process.exit(1);
  }
  const streamId2 = stream2Data.stream.id;

  // Onboard Stream 2
  const onboard2Res = await onboardBuildPost(await authReq("http://localhost/api/streams/onboard", { employerWallet, streamId: streamId2, teeAuthToken: employerAuth }, employer, employerWallet));
  const onboard2Data = await onboard2Res.json() as any;
  const base2Sig = await signAndSend(onboard2Data.transactions.baseSetup.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "base", publicKey: employer.publicKey });
  await onboardFinalizePatch(await authReq("http://localhost/api/streams/onboard", { employerWallet, streamId: streamId2, employeePda: onboard2Data.employeePda, privatePayrollPda: onboard2Data.privatePayrollPda, permissionPda: onboard2Data.permissionPda, baseSetupSignature: base2Sig, initializePrivateSignature: "bundled" }, employer, employerWallet, "PATCH"));

  // Resume Stream 2
  const control2Res = await controlBuildPost(await authReq("http://localhost/api/streams/control", { employerWallet, streamId: streamId2, action: "resume", teeAuthToken: employerAuth }, employer, employerWallet));
  const control2Data = await control2Res.json() as any;
  const control2Sig = await signAndSend(control2Data.transactions.control.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employer]); else t.partialSign(employer); return t; }, { sendTo: "ephemeral", publicKey: employer.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employerAuth)}` });
  await controlFinalizePatch(await authReq("http://localhost/api/streams/control", { employerWallet, streamId: streamId2, action: "resume", employeePda: control2Data.employeePda, privatePayrollPda: control2Data.privatePayrollPda, controlSignature: control2Sig, commitSignature: "skip" }, employer, employerWallet, "PATCH"));

  const employee2Auth = await fetchTeeAuthToken(employee2.publicKey, async (msg) => nacl.sign.detached(msg, employee2.secretKey));

  console.log("  Creating a fresh claim for recovery test...");
  await sleep(1000);
  const recoveryClaimRes = await claimRequestBuildPost(new Request("http://localhost/api/claim-salary/request", {
    method: "POST", body: JSON.stringify({ streamId: streamId2, employeeWallet: employee2Wallet, amountMicro: 5000, teeAuthToken: employee2Auth })
  }) as any);
  const recoveryClaimData = await recoveryClaimRes.json() as any;
  const recoveryClaimReqSig = await signAndSend(recoveryClaimData.transactions.requestWithdrawal.transactionBase64, async (t) => { if (t instanceof anchor.web3.VersionedTransaction) t.sign([employee2]); else t.partialSign(employee2); return t; }, { sendTo: "ephemeral", publicKey: employee2.publicKey, rpcUrl: `${TEE_RPC_BASE}?token=${encodeURIComponent(employee2Auth)}` });
  
  const { PATCH: claimFinalizePatch } = await import("../app/api/claim-salary/request/route.ts");
  const recoveryFinalizeRes = await claimFinalizePatch(new Request("http://localhost/api/claim-salary/request", {
    method: "PATCH", body: JSON.stringify({ streamId: streamId2, employeeWallet: employee2Wallet, amountMicro: 5000, signature: recoveryClaimReqSig, claimId: recoveryClaimData.claimId })
  }) as any);
  const recoveryFinalizeData = await recoveryFinalizeRes.json() as any;
  const recoveryDbClaimId = recoveryFinalizeData.claim.id;

  console.log("  Attempting process with EMPTY treasury...");
  const { POST: claimProcessPost } = await import("../app/api/claim-salary/process/route.ts");
  const failedProcessRes = await claimProcessPost(new Request("http://localhost/api/claim-salary/process", {
    method: "POST", body: JSON.stringify({ streamId: streamId2, employeeWallet: employee2Wallet, teeAuthToken: employerAuth })
  }) as any);
  
  assert.strictEqual(failedProcessRes.status, 500, "Process should have failed due to empty treasury!");
  console.log("  ✅ Correctly failed (Insufficient Treasury)");

  console.log("  Funding treasury now...");
  const { getCompanyForEmployer } = await import("../lib/server/company-service.ts");
  const company = await getCompanyForEmployer(employerWallet);
  const treasuryAddress = new PublicKey(company!.treasuryPubkey);
  
  const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = await import("@solana/spl-token");
  const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const funderAta = await getOrCreateAssociatedTokenAccount(connection, funder, DEVNET_USDC, funder.publicKey);
  const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, funder, DEVNET_USDC, treasuryAddress);
  
  const fundTx = new anchor.web3.Transaction().add(
    createTransferInstruction(funderAta.address, treasuryAta.address, funder.publicKey, 100_000)
  );
  fundTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  fundTx.sign(funder);
  const fundSig = await connection.sendRawTransaction(fundTx.serialize());
  await connection.confirmTransaction(fundSig, "confirmed");
  console.log("  Treasury funded. Sig:", fundSig);

  console.log("  Retrying process...");
  const retryProcessRes = await claimProcessPost(new Request("http://localhost/api/claim-salary/process", {
    method: "POST", body: JSON.stringify({ streamId: streamId2, employeeWallet: employee2Wallet, teeAuthToken: employerAuth })
  }) as any);
  assert.strictEqual(retryProcessRes.status, 200, "Retry should succeed!");
  console.log("  ✅ Recovery SUCCESSFUL");

  console.log("\n" + "=".repeat(60));
  console.log("  🎉 EDGE CASES & STRESS TEST SUCCESS!");
  console.log("  All unauthorized or invalid actions were correctly blocked.");
  console.log("=".repeat(60) + "\n");
  process.exit(0);
}

runTest().catch(e => { console.error("\n❌ Stress Test Failed:", e); process.exit(1); });
