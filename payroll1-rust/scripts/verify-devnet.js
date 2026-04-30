/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const nacl = require("tweetnacl");
const {
  getAuthToken,
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
} = require("@magicblock-labs/ephemeral-rollups-sdk");

const PROGRAM_ID = new web3.PublicKey(
  "EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR"
);
const DEVNET_RPC = "https://api.devnet.solana.com";
const TEE_URL = "https://devnet-tee.magicblock.app";
const EMPLOYEE_SEED = "employee";
const DEVNET_TEE_VALIDATOR = new web3.PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

function loadKeypair() {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8"))
  );
  return web3.Keypair.fromSecretKey(secret);
}

function getEmployeePda(employerPubkey, employeePubkey) {
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(EMPLOYEE_SEED),
      employerPubkey.toBuffer(),
      employeePubkey.toBuffer(),
    ],
    PROGRAM_ID
  );
  return pda;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchIdl(provider) {
  const localIdlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "payroll.json"
  );

  if (fs.existsSync(localIdlPath)) {
    return JSON.parse(fs.readFileSync(localIdlPath, "utf8"));
  }

  const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl) {
    throw new Error("Failed to load IDL from local target or devnet");
  }
  return idl;
}

async function confirmWithLatestBlockhash(connection, signature) {
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
}

async function airdropIfNeeded(connection, pubkey, minLamports = 1e9) {
  const balance = await connection.getBalance(pubkey, "confirmed");
  if (balance >= minLamports) return;

  console.log(
    `Airdropping ${((minLamports - balance) / web3.LAMPORTS_PER_SOL).toFixed(
      2
    )} SOL...`
  );
  const sig = await connection.requestAirdrop(pubkey, minLamports - balance);
  await confirmWithLatestBlockhash(connection, sig);
}

async function sendBaseTransaction(connection, tx, signers) {
  tx.feePayer = signers[0].publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  return sig;
}

async function sendTeeTransaction(connection, wallet, tx) {
  tx.feePayer = wallet.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(wallet);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  return sig;
}

async function main() {
  const employer = loadKeypair();
  const employeeWallet = web3.Keypair.generate().publicKey;

  const baseConnection = new web3.Connection(DEVNET_RPC, "confirmed");
  const baseWallet = new anchor.Wallet(employer);
  const baseProvider = new anchor.AnchorProvider(baseConnection, baseWallet, {
    commitment: "confirmed",
  });

  const idl = await fetchIdl(baseProvider);
  const baseProgram = new anchor.Program(idl, baseProvider);

  const employeePda = getEmployeePda(employer.publicKey, employeeWallet);

  console.log("=== Devnet Payroll Verification ===");
  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("Employer:", employer.publicKey.toBase58());
  console.log("Employee wallet:", employeeWallet.toBase58());
  console.log("Employee PDA:", employeePda.toBase58());

  console.log("\n[1/7] Ensuring employer has devnet SOL...");
  await airdropIfNeeded(
    baseConnection,
    employer.publicKey,
    2 * web3.LAMPORTS_PER_SOL
  );
  const employerBalance = await baseConnection.getBalance(
    employer.publicKey,
    "confirmed"
  );
  console.log(
    "Employer balance:",
    (employerBalance / web3.LAMPORTS_PER_SOL).toFixed(4),
    "SOL"
  );

  console.log("\n[2/7] Creating public employee payroll anchor on base...");
  const createSig = await baseProgram.methods
    .createEmployee(employeeWallet)
    .accounts({
      employer: employer.publicKey,
    })
    .signers([employer])
    .rpc();
  console.log("create_employee signature:", createSig);

  const createdEmployee = await baseProgram.account.employee.fetch(employeePda);
  console.log("Created public employee anchor:", {
    employer: createdEmployee.employer.toBase58(),
    employee: createdEmployee.employee.toBase58(),
    status: createdEmployee.status,
    version: createdEmployee.version.toString(),
    lastCheckpointTs: createdEmployee.lastCheckpointTs.toString(),
  });

  console.log("\n[3/7] Authenticating against devnet TEE...");
  const auth = await getAuthToken(
    TEE_URL,
    employer.publicKey,
    async (message) => nacl.sign.detached(message, employer.secretKey)
  );
  const teeConnection = new web3.Connection(
    `${TEE_URL}?token=${auth.token}`,
    "confirmed"
  );
  const teeProvider = new anchor.AnchorProvider(teeConnection, baseWallet, {
    commitment: "confirmed",
  });
  const teeProgram = new anchor.Program(idl, teeProvider);
  console.log("TEE auth acquired.");

  console.log(
    "\n[4/7] Creating permission on-chain + delegating employee PDA on base..."
  );

  const permissionPda = permissionPdaFromAccount(employeePda);

  const createPermissionSig = await baseProgram.methods
    .createPermission(employeeWallet)
    .accounts({
      employee: employeePda,
      employer: employer.publicKey,
      employeeSigner: employeeWallet,
      permission: permissionPda,
      permissionProgram: PERMISSION_PROGRAM_ID,
    })
    .signers([employer])
    .rpc();

  console.log("create_permission signature:", createPermissionSig);
  console.log("Permission PDA:", permissionPda.toBase58());

  const delegatePermissionIx = createDelegatePermissionInstruction({
    payer: employer.publicKey,
    authority: [employer.publicKey, true],
    permissionedAccount: [employeePda, false],
    ownerProgram: PERMISSION_PROGRAM_ID,
    validator: DEVNET_TEE_VALIDATOR,
  });

  const delegateEmployeeIx = await baseProgram.methods
    .delegateEmployee(employeeWallet)
    .accounts({
      employer: employer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const delegationTx = new web3.Transaction().add(
    delegatePermissionIx,
    delegateEmployeeIx
  );
  const delegateSig = await sendBaseTransaction(baseConnection, delegationTx, [
    employer,
  ]);
  console.log("Delegation bundle signature:", delegateSig);

  await sleep(3000);

  console.log("\n[5/7] Initializing private payroll state on the TEE...");
  const [privatePayrollPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("private-payroll"), employeePda.toBuffer()],
    PROGRAM_ID
  );

  const initPrivateSig = await teeProgram.methods
    .initializePrivatePayroll(new anchor.BN(1000))
    .accounts({
      employer: employer.publicKey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
    })
    .signers([employer])
    .rpc();
  console.log("initialize_private_payroll signature:", initPrivateSig);

  await sleep(2000);

  console.log("\n[6/7] Executing pay_salary on the TEE...");
  await sleep(2000);

  const paySalaryIx = await teeProgram.methods
    .paySalary()
    .accountsPartial({
      employer: employer.publicKey,
      crankOrEmployer: employer.publicKey,
      employee: employeePda,
      privatePayroll: privatePayrollPda,
    })
    .instruction();

  const teePayTx = new web3.Transaction().add(paySalaryIx);
  const teePaySig = await sendTeeTransaction(teeConnection, employer, teePayTx);
  console.log("pay_salary TEE signature:", teePaySig);

  console.log("\n[6/7] Committing TEE state back to devnet...");
  const commitIx = await teeProgram.methods
    .commitEmployee()
    .accountsPartial({
      employer: employer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const commitTx = new web3.Transaction().add(commitIx);
  const commitSig = await sendTeeTransaction(teeConnection, employer, commitTx);
  console.log("commit_employee TEE signature:", commitSig);

  await sleep(4000);

  const committedEmployee = await baseProgram.account.employee.fetch(
    employeePda
  );
  console.log("Employee public checkpoint after commit:", {
    employer: committedEmployee.employer.toBase58(),
    employee: committedEmployee.employee.toBase58(),
    status: committedEmployee.status,
    version: committedEmployee.version.toString(),
    lastCheckpointTs: committedEmployee.lastCheckpointTs.toString(),
  });

  console.log("\n[7/7] Undelegating employee PDA from the TEE...");
  const undelegateIx = await teeProgram.methods
    .undelegateEmployee()
    .accountsPartial({
      employer: employer.publicKey,
      employee: employeePda,
    })
    .instruction();

  const undelegateTx = new web3.Transaction().add(undelegateIx);
  const undelegateSig = await sendTeeTransaction(
    teeConnection,
    employer,
    undelegateTx
  );
  console.log("undelegate_employee TEE signature:", undelegateSig);

  await sleep(4000);

  const accountInfo = await baseConnection.getAccountInfo(
    employeePda,
    "confirmed"
  );
  console.log(
    "\nFinal base account owner:",
    accountInfo?.owner.toBase58() || "missing"
  );
  console.log("Expected owner after undelegation:", PROGRAM_ID.toBase58());

  console.log("\n=== Verification Summary ===");
  console.log("create_employee:", createSig);
  console.log("delegate bundle:", delegateSig);
  console.log("TEE pay_salary:", teePaySig);
  console.log("TEE commit_employee:", commitSig);
  console.log("TEE undelegate_employee:", undelegateSig);

  if (
    !committedEmployee.totalPaid ||
    committedEmployee.totalPaid.eq(new anchor.BN(0))
  ) {
    console.warn(
      "\nWarning: total_paid is still 0 on base after commit. The flow executed, but state may not have had enough time to accrue or the delegated session may need deeper inspection."
    );
  } else {
    console.log(
      `\nSuccess: total_paid committed back to base as ${committedEmployee.totalPaid.toString()}`
    );
  }
}

main().catch((err) => {
  console.error("\nVerification failed:");
  console.error(err);
  process.exit(1);
});
