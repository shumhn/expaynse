import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { assert } from "chai";
import fs from "fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  createDelegatePermissionInstruction,
  getAuthToken,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { Payroll } from "../../target/types/payroll";

const PROGRAM_ID = new PublicKey(
  "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6"
);
const DEVNET_RPC = "https://api.devnet.solana.com";
const TEE_URL = "https://devnet-tee.magicblock.app";
const EMPLOYEE_SEED = "employee";
const PRIVATE_PAYROLL_SEED = "private-payroll";
const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

type PublicEmployeeState = {
  streamId: number[];
  employerAuthorityHash: number[];
};

type PrivatePayrollPreview = {
  employee: PublicKey;
  streamId: Buffer;
  status: number;
  version: bigint;
  lastCheckpointTs: bigint;
  ratePerSecondMicro: bigint;
  lastAccrualTimestamp: bigint;
  accruedUnpaidMicro: bigint;
  totalPaidPrivateMicro: bigint;
};

function loadAuthorityKeypair() {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[]
  );
  return Keypair.fromSecretKey(secret);
}

function newOpaqueStreamSeed() {
  return Keypair.generate().publicKey.toBuffer();
}

function getEmployeePda(employer: PublicKey, streamSeed: Buffer) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(EMPLOYEE_SEED), employer.toBuffer(), streamSeed],
    PROGRAM_ID
  );
  return pda;
}

function getPrivatePayrollPda(employeePda: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PRIVATE_PAYROLL_SEED), employeePda.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBaseTransaction(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[]
) {
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

async function fundKeypair(
  connection: Connection,
  payer: Keypair,
  recipient: PublicKey,
  amountLamports: number
) {
  return sendBaseTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: amountLamports,
      })
    ),
    [payer]
  );
}

function decodePrivatePayrollState(data: Buffer): PrivatePayrollPreview {
  assert.isAtLeast(
    data.length,
    114,
    "Private payroll account data should be at least 114 bytes"
  );

  return {
    employee: new PublicKey(data.subarray(0, 32)),
    streamId: data.subarray(32, 64),
    status: data.readUInt8(64),
    version: data.readBigUInt64LE(65),
    lastCheckpointTs: data.readBigInt64LE(73),
    ratePerSecondMicro: data.readBigUInt64LE(81),
    lastAccrualTimestamp: data.readBigInt64LE(89),
    accruedUnpaidMicro: data.readBigUInt64LE(97),
    totalPaidPrivateMicro: data.readBigUInt64LE(105),
  };
}

function assertPublicEmployeePrivacyInvariant(args: {
  rawData: Buffer;
  publicState: PublicEmployeeState;
  streamSeed: Buffer;
  employer: PublicKey;
  employeeWallet: PublicKey;
}) {
  assert.equal(
    args.rawData.length,
    72,
    "Public employee account should only contain discriminator + stream_id + employer_authority_hash"
  );
  assert.deepEqual(
    Buffer.from(args.publicState.streamId),
    args.streamSeed,
    "Public account should store only the opaque stream id"
  );
  assert.equal(
    args.rawData.indexOf(args.employer.toBuffer()),
    -1,
    "Public employee account must not contain raw employer wallet bytes"
  );
  assert.equal(
    args.rawData.indexOf(args.employeeWallet.toBuffer()),
    -1,
    "Public employee account must not contain raw employee wallet bytes"
  );
}

describe("payroll devnet e2e", function () {
  this.timeout(300_000);

  const baseConnection = new Connection(DEVNET_RPC, "confirmed");
  const employer = loadAuthorityKeypair();
  const employeeWallet = Keypair.generate().publicKey;
  const streamSeed = newOpaqueStreamSeed();
  const streamSeedArg = Array.from(streamSeed);

  const wallet = new anchor.Wallet(employer);
  const provider = new anchor.AnchorProvider(baseConnection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("./target/idl/payroll.json", "utf8"));
  const program = new anchor.Program(idl, provider) as anchor.Program<Payroll>;

  let teeConnection: Connection;
  let teeProgram: anchor.Program<Payroll>;

  const employeePda = getEmployeePda(employer.publicKey, streamSeed);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);
  const permissionPda = permissionPdaFromAccount(employeePda);

  it("runs the private payroll PER lifecycle with opaque public metadata", async () => {
    const employerBalance = await baseConnection.getBalance(
      employer.publicKey,
      "confirmed"
    );
    assert.isAbove(
      employerBalance,
      0,
      "Configured authority wallet must already be funded on devnet"
    );

    const createEmployeeSig = await program.methods
      .createEmployee(streamSeedArg)
      .accountsPartial({
        employer: employer.publicKey,
      })
      .signers([employer])
      .rpc();

    const publicEmployee = (await program.account.employee.fetch(
      employeePda
    )) as PublicEmployeeState;
    const employeeAccountInfo = await baseConnection.getAccountInfo(
      employeePda,
      "confirmed"
    );

    assert.isNotNull(
      employeeAccountInfo,
      "Employee PDA should exist after create_employee"
    );
    assertPublicEmployeePrivacyInvariant({
      rawData: Buffer.from(employeeAccountInfo!.data),
      publicState: publicEmployee,
      streamSeed,
      employer: employer.publicKey,
      employeeWallet,
    });

    const auth = await getAuthToken(
      TEE_URL,
      employer.publicKey,
      async (message: Uint8Array) =>
        nacl.sign.detached(message, employer.secretKey)
    );

    teeConnection = new Connection(
      `${TEE_URL}?token=${auth.token}`,
      "confirmed"
    );
    const teeProvider = new anchor.AnchorProvider(
      teeConnection,
      new anchor.Wallet(employer),
      { commitment: "confirmed" }
    );
    teeProgram = new anchor.Program(
      program.idl,
      teeProvider
    ) as anchor.Program<Payroll>;

    const createPermissionSig = await program.methods
      .createPermission(streamSeedArg)
      .accountsPartial({
        employee: employeePda,
        employer: employer.publicKey,
        permission: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .signers([employer])
      .rpc();

    const delegatePermissionIx = createDelegatePermissionInstruction({
      payer: employer.publicKey,
      authority: [employer.publicKey, true],
      permissionedAccount: [employeePda, false],
      ownerProgram: PERMISSION_PROGRAM_ID,
      validator: DEVNET_TEE_VALIDATOR,
    });

    const delegateEmployeeIx = await program.methods
      .delegateEmployee(streamSeedArg)
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
      })
      .instruction();

    const delegateBundleSig = await sendBaseTransaction(
      baseConnection,
      new Transaction().add(delegatePermissionIx, delegateEmployeeIx),
      [employer]
    );

    await sleep(3_000);

    const initializePrivatePayrollSig = await teeProgram.methods
      .initializePrivatePayroll(new BN(1_000_000))
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    const initializedPrivateInfo = await teeConnection.getAccountInfo(
      privatePayrollPda,
      "confirmed"
    );
    assert.isNotNull(
      initializedPrivateInfo,
      "Private payroll state should exist in PER after initialization"
    );

    const initializedPrivateState = decodePrivatePayrollState(
      Buffer.from(initializedPrivateInfo!.data)
    );
    assert.equal(
      initializedPrivateState.employee.toBase58(),
      employeePda.toBase58()
    );
    assert.deepEqual(initializedPrivateState.streamId, streamSeed);
    assert.equal(initializedPrivateState.status, 2);
    assert.equal(initializedPrivateState.version.toString(), "1");
    assert.equal(
      initializedPrivateState.ratePerSecondMicro.toString(),
      "1000000"
    );
    assert.equal(initializedPrivateState.accruedUnpaidMicro.toString(), "0");
    assert.equal(initializedPrivateState.totalPaidPrivateMicro.toString(), "0");

    const resumeStreamSig = await teeProgram.methods
      .resumeStream()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    await sleep(2_000);

    const checkpointSig = await teeProgram.methods
      .checkpointAccrual()
      .accountsPartial({
        crankOrEmployer: employer.publicKey,
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    const accruedPrivateInfo = await teeConnection.getAccountInfo(
      privatePayrollPda,
      "confirmed"
    );
    assert.isNotNull(
      accruedPrivateInfo,
      "Private payroll state should still exist after checkpoint_accrual"
    );

    const accruedPrivateState = decodePrivatePayrollState(
      Buffer.from(accruedPrivateInfo!.data)
    );
    assert.equal(accruedPrivateState.status, 1);
    assert.isTrue(
      accruedPrivateState.accruedUnpaidMicro > BigInt(0),
      "Accrued unpaid should increase after checkpoint_accrual"
    );

    const settleAmount = accruedPrivateState.accruedUnpaidMicro;
    const settleSalarySig = await teeProgram.methods
      .paySalary(new BN(settleAmount.toString()))
      .accountsPartial({
        crankOrEmployer: employer.publicKey,
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    const settledPrivateInfo = await teeConnection.getAccountInfo(
      privatePayrollPda,
      "confirmed"
    );
    assert.isNotNull(
      settledPrivateInfo,
      "Private payroll state should still exist after settle_salary"
    );

    const settledPrivateState = decodePrivatePayrollState(
      Buffer.from(settledPrivateInfo!.data)
    );
    assert.equal(settledPrivateState.accruedUnpaidMicro.toString(), "0");
    assert.equal(
      settledPrivateState.totalPaidPrivateMicro.toString(),
      settleAmount.toString()
    );
    assert.isTrue(
      settledPrivateState.version > initializedPrivateState.version,
      "Private version should advance inside PER"
    );

    const commitEmployeeSig = await teeProgram.methods
      .commitEmployee()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
      })
      .signers([employer])
      .rpc();

    await sleep(4_000);

    const committedEmployeeInfo = await baseConnection.getAccountInfo(
      employeePda,
      "confirmed"
    );
    assert.isNotNull(
      committedEmployeeInfo,
      "Employee PDA should exist on base"
    );
    assertPublicEmployeePrivacyInvariant({
      rawData: Buffer.from(committedEmployeeInfo!.data),
      publicState: publicEmployee,
      streamSeed,
      employer: employer.publicKey,
      employeeWallet,
    });

    const undelegateEmployeeSig = await teeProgram.methods
      .undelegateEmployee()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
      })
      .signers([employer])
      .rpc();

    await sleep(4_000);

    const finalAccountInfo = await baseConnection.getAccountInfo(
      employeePda,
      "confirmed"
    );
    assert.isNotNull(
      finalAccountInfo,
      "Employee PDA should still exist on base"
    );
    assert.equal(finalAccountInfo!.owner.toBase58(), PROGRAM_ID.toBase58());

    console.log("\n=== Devnet E2E Summary ===");
    console.log("create_employee:", createEmployeeSig);
    console.log("create_permission:", createPermissionSig);
    console.log("delegate bundle:", delegateBundleSig);
    console.log("initialize_private_payroll:", initializePrivatePayrollSig);
    console.log("resume_stream:", resumeStreamSig);
    console.log("checkpoint_accrual:", checkpointSig);
    console.log("settle_salary:", settleSalarySig);
    console.log("commit_employee:", commitEmployeeSig);
    console.log("undelegate_employee:", undelegateEmployeeSig);
  });

  it("rejects initialize_private_payroll from an unrelated signer", async () => {
    const attacker = Keypair.generate();
    const victimStreamSeed = newOpaqueStreamSeed();
    const victimStreamSeedArg = Array.from(victimStreamSeed);
    const victimEmployeePda = getEmployeePda(
      employer.publicKey,
      victimStreamSeed
    );
    const victimPrivatePayrollPda = getPrivatePayrollPda(victimEmployeePda);
    const victimPermissionPda = permissionPdaFromAccount(victimEmployeePda);

    await fundKeypair(
      baseConnection,
      employer,
      attacker.publicKey,
      Math.floor(0.05 * LAMPORTS_PER_SOL)
    );

    await program.methods
      .createEmployee(victimStreamSeedArg)
      .accountsPartial({
        employer: employer.publicKey,
      })
      .signers([employer])
      .rpc();

    const createVictimPermissionSig = await program.methods
      .createPermission(victimStreamSeedArg)
      .accountsPartial({
        employee: victimEmployeePda,
        employer: employer.publicKey,
        permission: victimPermissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .signers([employer])
      .rpc();

    const victimDelegatePermissionIx = createDelegatePermissionInstruction({
      payer: employer.publicKey,
      authority: [employer.publicKey, true],
      permissionedAccount: [victimEmployeePda, false],
      ownerProgram: PERMISSION_PROGRAM_ID,
      validator: DEVNET_TEE_VALIDATOR,
    });

    const victimDelegateEmployeeIx = await program.methods
      .delegateEmployee(victimStreamSeedArg)
      .accountsPartial({
        employer: employer.publicKey,
        employee: victimEmployeePda,
      })
      .instruction();

    const delegateVictimSig = await sendBaseTransaction(
      baseConnection,
      new Transaction().add(
        victimDelegatePermissionIx,
        victimDelegateEmployeeIx
      ),
      [employer]
    );

    await sleep(3_000);

    const attackerAuth = await getAuthToken(
      TEE_URL,
      attacker.publicKey,
      async (message: Uint8Array) =>
        nacl.sign.detached(message, attacker.secretKey)
    );

    const attackerTeeConnection = new Connection(
      `${TEE_URL}?token=${attackerAuth.token}`,
      "confirmed"
    );
    const attackerTeeProvider = new anchor.AnchorProvider(
      attackerTeeConnection,
      new anchor.Wallet(attacker),
      { commitment: "confirmed" }
    );
    const attackerTeeProgram = new anchor.Program(
      program.idl,
      attackerTeeProvider
    ) as anchor.Program<Payroll>;

    let threw = false;
    try {
      await attackerTeeProgram.methods
        .initializePrivatePayroll(new BN(999_999))
        .accountsPartial({
          employer: attacker.publicKey,
          employee: victimEmployeePda,
          privatePayroll: victimPrivatePayrollPda,
        })
        .signers([attacker])
        .rpc();
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      if (message) {
        assert.match(
          message,
          /UnauthorizedEmployer|custom program error/i,
          "Unauthorized init should fail with an authorization error"
        );
      }
    }

    assert.isTrue(
      threw,
      "Unrelated signer should not be able to initialize victim private payroll"
    );

    const victimPrivatePayrollInfo = await attackerTeeConnection.getAccountInfo(
      victimPrivatePayrollPda,
      "confirmed"
    );
    assert.isNull(
      victimPrivatePayrollInfo,
      "Unauthorized initialize_private_payroll must not create private payroll state"
    );

    console.log("create_permission (victim):", createVictimPermissionSig);
    console.log("delegate bundle (victim):", delegateVictimSig);
  });

  it("derives different employee PDAs for different employers using the same stream id", async () => {
    const sameStreamSeed = newOpaqueStreamSeed();
    const employerA = Keypair.generate().publicKey;
    const employerB = Keypair.generate().publicKey;

    const employeePdaA = getEmployeePda(employerA, sameStreamSeed);
    const employeePdaB = getEmployeePda(employerB, sameStreamSeed);

    assert.notEqual(
      employeePdaA.toBase58(),
      employeePdaB.toBase58(),
      "Employee PDA derivation must be employer-scoped"
    );
  });
});
