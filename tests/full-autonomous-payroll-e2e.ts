// Full Autonomous Payroll End-to-End Test Runner
//
// What this covers:
// 1. Setup devnet wallets and MagicBlock auth tokens
// 2. Company Creation (generates Treasury & Settlement keys autonomously)
// 3. Fund Treasury Base Wallet with devnet USDC
// 4. Create Employee & Pending Stream
// 5. Onboard Stream to MagicBlock PER
// 6. Resume Stream & Accrue Salary
// 7. Employee Claim Salary (Build request_withdrawal tx & Sign)
// 8. Backend Autonomously Processes Claim (Company Treasury -> Employee Ephemeral)
// 9. Backend Autonomously Settles Claim (mark_private_transfer_paid)
// 10. Employee Withdraws from Ephemeral to Base Wallet

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { NextRequest } from "next/server.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, createTransferInstruction, createMint, mintTo } from "@solana/spl-token";

import { POST as companyPost } from "../app/api/company/create/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { POST as streamsPost } from "../app/api/streams/route.ts";
import { PATCH as onboardFinalizePatch, POST as onboardBuildPost } from "../app/api/streams/onboard/route.ts";
import { PATCH as controlFinalizePatch, POST as controlBuildPost } from "../app/api/streams/control/route.ts";
import { POST as checkpointBuildPost, PATCH as checkpointFinalizePatch } from "../app/api/streams/checkpoint-crank/route.ts";
import { GET as previewGet } from "../app/api/payroll/preview/route.ts";

import { POST as claimRequestBuildPost, PATCH as claimRequestFinalizePatch } from "../app/api/claim-salary/request/route.ts";
import { POST as claimProcessPost } from "../app/api/claim-salary/process/route.ts";

import { loadCompanyKeypair } from "../lib/server/company-key-vault.ts";
import { getOnChainClaimById } from "../lib/server/payroll-store.ts";
import { loadPayrollIdl } from "../lib/server/payroll-idl.ts";
import * as anchor from "@coral-xyz/anchor";

import { fetchTeeAuthToken, getPrivateBalance, signAndSend, withdraw, getBalance } from "../lib/magicblock-api.ts";
import { makeAuthenticatedJsonRequest } from "./wallet-auth-test-helpers.ts";

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEE_RPC_BASE = "https://devnet-tee.magicblock.app";

type SendableTx = Transaction | VersionedTransaction;
type SendSpec = { transactionBase64: string; sendTo: string };

// --- HELPERS ---

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
  
  // Parse solana config
  try {
    const configPath = path.join(os.homedir(), ".config/solana/cli/config.yml");
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, "utf8");
      const match = config.match(/keypair_path:\s*([^\s]+)/);
      if (match && match[1] && fs.existsSync(match[1])) {
        return match[1];
      }
    }
  } catch (e) {}

  const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
  if (fs.existsSync(defaultPath)) return defaultPath;
  throw new Error("No devnet keypair found.");
}

function loadKeypair(walletPath: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[]));
}

function keypairSignMessageFactory(signer: Keypair) {
  return async (message: Uint8Array): Promise<Uint8Array> => nacl.sign.detached(message, signer.secretKey);
}

function signTransactionFactory(signer: Keypair) {
  return async (tx: SendableTx): Promise<SendableTx> => {
    if (tx instanceof VersionedTransaction) { tx.sign([signer]); return tx; }
    tx.partialSign(signer);
    return tx;
  };
}

async function sendBuiltTransaction(args: { spec: SendSpec; signer: Keypair; signerLabel: string; teeAuthToken?: string; useTeeRpc?: boolean }) {
  console.log(`  → Sending ${args.signerLabel} tx -> ${args.spec.sendTo}`);
  return signAndSend(args.spec.transactionBase64, signTransactionFactory(args.signer), {
    sendTo: args.spec.sendTo,
    rpcUrl: args.useTeeRpc && args.teeAuthToken ? `${TEE_RPC_BASE}?token=${encodeURIComponent(args.teeAuthToken)}` : undefined,
    signMessage: keypairSignMessageFactory(args.signer),
    publicKey: args.signer.publicKey,
  });
}

function makeJsonRequest(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function fundUsdcIfNeeded(connection: Connection, payer: Keypair, recipient: PublicKey, minAmountMicro: bigint, mintAddress: string) {
  const recipientWallet = recipient.toBase58();
  const current = await getBalance(recipientWallet, mintAddress);
  const currentMicro = BigInt(current.balance);
  if (currentMicro >= minAmountMicro) return currentMicro;

  const mint = new PublicKey(mintAddress);
  const payerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const recipientAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, recipient);
  const deltaMicro = minAmountMicro - currentMicro;
  console.log(`  Funding ${recipientWallet.slice(0,8)}... with ${Number(deltaMicro)/1e6} USDC`);

  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(
    createTransferInstruction(payerAta.address, recipientAta.address, payer.publicKey, Number(deltaMicro))
  );
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
  return BigInt((await getBalance(recipientWallet, mintAddress)).balance);
}

async function fundSolIfNeeded(connection: Connection, payer: Keypair, recipient: PublicKey, minLamports: number) {
  const balance = await connection.getBalance(recipient, "confirmed");
  if (balance >= minLamports) return balance;
  const needed = minLamports - balance;
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: needed })
  );
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
  return connection.getBalance(recipient, "confirmed");
}

async function waitForPrivateBalanceAtLeast(address: string, token: string, minMicro: bigint, attempts = 20, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    const bal = await getPrivateBalance(address, token);
    const amt = BigInt(bal.balance);
    console.log(`  [poll ${i+1}/${attempts}] private=${(Number(amt)/1e6).toFixed(6)} USDC`);
    if (amt >= minMicro) return amt;
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for private balance >= ${minMicro}`);
}

// --- Helper to build authenticated requests ---
async function authReq(url: string, body: unknown, signer: Keypair, wallet: string, method = "POST") {
  return makeAuthenticatedJsonRequest({ url, wallet, signer, body, method });
}

// --- MAIN RUNNER ---

async function runTest() {
  logSection("1. Setup & Auth");
  
  const employerFunder = loadKeypair(resolveWalletPath());
  const employer = Keypair.generate();
  const employee = Keypair.generate();
  
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  console.log("  Employer:", employerWallet);
  console.log("  Employee:", employeeWallet);

  const connection = new Connection(DEVNET_RPC, "confirmed");

  console.log("  Funding devnet SOL...");
  await fundSolIfNeeded(connection, employerFunder, employer.publicKey, 100_000_000);
  await fundSolIfNeeded(connection, employerFunder, employee.publicKey, 50_000_000);

  console.log("  Fetching MagicBlock TEE Auth Tokens...");
  const employerTeeAuthToken = await fetchTeeAuthToken(employer.publicKey, keypairSignMessageFactory(employer));
  const employeeTeeAuthToken = await fetchTeeAuthToken(employee.publicKey, keypairSignMessageFactory(employee));
  console.log("  ✓ Auth tokens acquired");

  // ── Step 2: Create Company ──
  logSection("2. Create Company & Keys");
  const companyRes = await companyPost(makeJsonRequest("http://localhost/api/company/create", { employerWallet, name: "Acme Corp E2E" }));
  assert.strictEqual(companyRes.status, 200, `Company creation failed: ${await companyRes.clone().text()}`);
  const companyData = await json<{ company: any }>(companyRes);
  const companyId = companyData.company.id;
  console.log("  Company:", companyId);

  const treasuryKeypair = await loadCompanyKeypair({ companyId, kind: "treasury" });
  const settlementKeypair = await loadCompanyKeypair({ companyId, kind: "settlement" });
  console.log("  Treasury:", treasuryKeypair.publicKey.toBase58());
  console.log("  Settlement:", settlementKeypair.publicKey.toBase58());

  // ── Step 3: Fund Treasury ──
  logSection("3. Fund Company Treasury");
  await fundSolIfNeeded(connection, employerFunder, treasuryKeypair.publicKey, 50_000_000);
  await fundUsdcIfNeeded(connection, employerFunder, treasuryKeypair.publicKey, 500_000n, DEVNET_USDC);
  console.log("  ✓ Treasury funded");

  // ── Step 4: Create Employee & Stream ──
  logSection("4. Create Employee & Stream");
  const empRes = await employeesPost(
    await authReq("http://localhost/api/employees", {
      employerWallet, wallet: employeeWallet, name: "Alice Worker",
      notes: "E2E test employee", monthlySalaryUsd: 1000,
    }, employer, employerWallet)
  );
  assert.strictEqual(empRes.status, 201, `Employee create failed: ${await empRes.clone().text()}`);
  const empData = await json<{ employee: any }>(empRes);
  console.log("  Employee:", empData.employee.id);

  const streamRes = await streamsPost(
    await authReq("http://localhost/api/streams", {
      employerWallet, employeeId: empData.employee.id, ratePerSecond: 0.001,
    }, employer, employerWallet)
  );
  assert.strictEqual(streamRes.status, 201, `Stream create failed: ${await streamRes.clone().text()}`);
  const streamData = await json<{ stream: any }>(streamRes);
  const streamId = streamData.stream.id;
  console.log("  Stream:", streamId);

  // ── Step 5: Onboard to PER ──
  logSection("5. Onboard Stream to MagicBlock PER");
  const onboardRes = await onboardBuildPost(
    await authReq("http://localhost/api/streams/onboard", {
      employerWallet, streamId, teeAuthToken: employerTeeAuthToken,
    }, employer, employerWallet)
  );
  assert.strictEqual(onboardRes.status, 201, `Onboard build failed: ${await onboardRes.clone().text()}`);
  const onboardBuild = await json<any>(onboardRes);

  if (onboardBuild.transactions.baseSetup) {
    const baseSig = await sendBuiltTransaction({ spec: onboardBuild.transactions.baseSetup, signer: employer, signerLabel: "onboard:base" });
    
    // We update the PATCH call to use this baseSig
    await onboardFinalizePatch(
      await authReq("http://localhost/api/streams/onboard", {
        employerWallet, streamId, employeePda: onboardBuild.employeePda,
        privatePayrollPda: onboardBuild.privatePayrollPda, permissionPda: onboardBuild.permissionPda,
        baseSetupSignature: baseSig, initializePrivateSignature: "bundled",
      }, employer, employerWallet, "PATCH")
    );
  } else {
    // If no transactions, it might already be onboarded or something went wrong
    // But the test expects to do it.
    console.log("  (No baseSetup transactions returned, skipping base tx)");
  }

  if (onboardBuild.transactions.initializePrivatePayroll) {
    const initSig = await sendBuiltTransaction({
      spec: onboardBuild.transactions.initializePrivatePayroll, signer: employer,
      signerLabel: "onboard:init", teeAuthToken: employerTeeAuthToken, useTeeRpc: true,
    });
    
    await onboardFinalizePatch(
      await authReq("http://localhost/api/streams/onboard", {
        employerWallet, streamId, employeePda: onboardBuild.employeePda,
        privatePayrollPda: onboardBuild.privatePayrollPda, permissionPda: onboardBuild.permissionPda,
        baseSetupSignature: "skip", initializePrivateSignature: initSig,
      }, employer, employerWallet, "PATCH")
    );
  }
  console.log("  ✓ Onboarded");

  // ── Step 6: Start Stream ──
  logSection("6. Start Stream & Accrue");
  const controlRes = await controlBuildPost(
    await authReq("http://localhost/api/streams/control", {
      employerWallet, streamId, action: "resume", teeAuthToken: employerTeeAuthToken,
    }, employer, employerWallet)
  );
  assert.strictEqual(controlRes.status, 201, `Control build failed: ${await controlRes.clone().text()}`);
  const controlBuild = await json<any>(controlRes);

  const controlSig = await sendBuiltTransaction({
    spec: controlBuild.transactions.control, signer: employer,
    signerLabel: "resume:control", teeAuthToken: employerTeeAuthToken, useTeeRpc: true,
  });
  let commitSig = "skip";
  if (controlBuild.transactions.commitEmployee) {
    commitSig = await sendBuiltTransaction({
      spec: controlBuild.transactions.commitEmployee, signer: employer,
      signerLabel: "resume:commit", teeAuthToken: employerTeeAuthToken, useTeeRpc: true,
    });
  }

  await controlFinalizePatch(
    await authReq("http://localhost/api/streams/control", {
      employerWallet, streamId, action: "resume",
      employeePda: controlBuild.employeePda, privatePayrollPda: controlBuild.privatePayrollPda,
      controlSignature: controlSig, commitSignature: commitSig,
    }, employer, employerWallet, "PATCH")
  );
  console.log("  ✓ Stream active!");
  
  // ── Step 6.5: Schedule Crank & Verify ──
  logSection("6.5 Schedule Crank & Verify");
  const crankBuildRes = await checkpointBuildPost(
    await authReq("http://localhost/api/streams/checkpoint-crank", {
      employerWallet, streamId, teeAuthToken: employerTeeAuthToken, mode: "schedule",
      executionIntervalMillis: 2000, iterations: 10,
    }, employer, employerWallet)
  );
  assert.strictEqual(crankBuildRes.status, 201, `Crank build failed: ${await crankBuildRes.clone().text()}`);
  const crankBuild = await json<any>(crankBuildRes);

  const crankSig = await sendBuiltTransaction({
    spec: crankBuild.transactions.checkpointCrank, signer: employer,
    signerLabel: "crank:schedule", teeAuthToken: employerTeeAuthToken, useTeeRpc: true,
  });

  await checkpointFinalizePatch(
    await authReq("http://localhost/api/streams/checkpoint-crank", {
      employerWallet, streamId, mode: "schedule", signature: crankSig, status: "active",
    }, employer, employerWallet, "PATCH")
  );
  console.log("  ✓ Task scheduled. TaskID:", crankBuild.taskId);

  // Verification
  const teeConn = new Connection(`${TEE_RPC_BASE}?token=${encodeURIComponent(employerTeeAuthToken)}`, "confirmed");
  const provider = new anchor.AnchorProvider(teeConn, new anchor.Wallet(employer), { commitment: "confirmed" });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);
  const payrollPda = new PublicKey(crankBuild.privatePayrollPda);

  const state0 = await (program.account as any).payrollState.fetch(payrollPda) as any;
  const ts0 = state0.lastCheckpointTs.toNumber();
  console.log(`  Initial checkpoint: ${ts0}`);

  console.log("  ⏳ Waiting 6s for MagicBlock crank...");
  await sleep(6000);

  const state1 = await (program.account as any).payrollState.fetch(payrollPda) as any;
  const ts1 = state1.lastCheckpointTs.toNumber();
  console.log(`  Final checkpoint:   ${ts1}`);

  assert(ts1 > ts0, "Crank FAIL: last_checkpoint_ts did not increase automatically!");
  console.log("  ✓ Crank verified! Automatic state sync is working.");

  const previewRes = await previewGet(
    new NextRequest(`http://localhost/api/payroll/preview?streamId=${streamId}&employerWallet=${employerWallet}`, {
      method: "GET", headers: { authorization: `Bearer ${employerTeeAuthToken}` },
    })
  );
  assert.strictEqual(previewRes.status, 200, `Preview failed: ${await previewRes.clone().text()}`);
  const previewData = await json<any>(previewRes);
  const claimableAmountMicro = Number(previewData.preview.claimableAmountMicro);
  console.log(`  Accrued: ${(claimableAmountMicro / 1e6).toFixed(6)} USDC`);
  assert(claimableAmountMicro > 0, "No salary accrued!");

  // ── Step 7: Employee Claims ──
  logSection("7. Employee Claims Salary");
  const claimReqRes = await claimRequestBuildPost(
    makeJsonRequest("http://localhost/api/claim-salary/request", {
      streamId, employeeWallet, amountMicro: claimableAmountMicro, teeAuthToken: employeeTeeAuthToken,
    })
  );
  assert.strictEqual(claimReqRes.status, 201, `Claim build failed: ${await claimReqRes.clone().text()}`);
  const claimReqBuild = await json<any>(claimReqRes);

  const reqSig = await sendBuiltTransaction({
    spec: claimReqBuild.transactions.requestWithdrawal, signer: employee,
    signerLabel: "claim:request_withdrawal", teeAuthToken: employeeTeeAuthToken, useTeeRpc: true,
  });
  console.log("  request_withdrawal signed:", reqSig.slice(0, 20) + "...");

  const claimFinalizeRes = await claimRequestFinalizePatch(
    makeJsonRequest("http://localhost/api/claim-salary/request", {
      streamId, employeeWallet, amountMicro: claimReqBuild.amountMicro,
      signature: reqSig, claimId: claimReqBuild.claimId,
    }, "PATCH")
  );
  assert.strictEqual(claimFinalizeRes.status, 200, `Claim finalize failed: ${await claimFinalizeRes.clone().text()}`);
  const claimFinalizeData = await json<any>(claimFinalizeRes);
  const dbClaimId = claimFinalizeData.claim.id;
  console.log("  ✓ Claim saved. DB ID:", dbClaimId);

  // ── Step 8: Autonomous Processing ──
  logSection("8. Backend Autonomously Processes & Settles");
  const processRes = await claimProcessPost(
    makeJsonRequest("http://localhost/api/claim-salary/process", {
      streamId,
      employeeWallet,
      teeAuthToken: employerTeeAuthToken,
    })
  );
  assert.strictEqual(processRes.status, 200, `Process failed: ${await processRes.clone().text()}`);
  const processData = await json<any>(processRes);
  console.log("  Backend:", processData.message);

  const finalClaim = await getOnChainClaimById(dbClaimId);
  assert.strictEqual(finalClaim?.status, "paid", `Expected 'paid', got '${finalClaim?.status}'`);
  console.log("  ✓ DB claim status: paid");

  // ── Step 9: Withdraw to L1 ──
  logSection("9. Employee Withdraws to Base Wallet");
  const privBal = await waitForPrivateBalanceAtLeast(employeeWallet, employeeTeeAuthToken, BigInt(claimableAmountMicro));
  console.log(`  Private balance: ${(Number(privBal)/1e6).toFixed(6)} USDC`);

  const withdrawBuild = await withdraw(
    employeeWallet,
    Number(privBal) / 1_000_000,
    employeeTeeAuthToken,
  );

  const withdrawSig = await sendBuiltTransaction({
    spec: { transactionBase64: withdrawBuild.transactionBase64, sendTo: "base" },
    signer: employee, signerLabel: "withdraw_to_l1",
  });
  console.log("  ✓ Withdrawal complete:", withdrawSig.slice(0, 20) + "...");

  // ── Done ──
  console.log("\n" + "=".repeat(60));
  console.log("  ✅ ALL 9 STEPS PASSED!");
  console.log("  The Autonomous Payroll system is fully operational E2E.");
  console.log("=".repeat(60) + "\n");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("\n❌ E2E Test Failed:", err);
  process.exit(1);
});
