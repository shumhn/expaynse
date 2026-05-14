import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { assert } from "chai";
import fs from "fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  createDelegatePermissionInstruction,
  getAuthToken,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { Payroll } from "../target/types/payroll";

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
  assert.equal(args.rawData.length, 72);
  assert.deepEqual(Buffer.from(args.publicState.streamId), args.streamSeed);
  assert.equal(args.rawData.indexOf(args.employer.toBuffer()), -1);
  assert.equal(args.rawData.indexOf(args.employeeWallet.toBuffer()), -1);
}

async function readPrivatePayrollState(
  connection: Connection,
  privatePayrollPda: PublicKey
) {
  const accountInfo = await connection.getAccountInfo(
    privatePayrollPda,
    "confirmed"
  );
  assert.isNotNull(accountInfo, "Private payroll state should exist in PER");
  return decodePrivatePayrollState(Buffer.from(accountInfo!.data));
}

describe("payroll self-custodial devnet e2e", function () {
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

  const employeePda = getEmployeePda(employer.publicKey, streamSeed);
  const privatePayrollPda = getPrivatePayrollPda(employeePda);
  const permissionPda = permissionPdaFromAccount(employeePda);

  let teeConnection: Connection;
  let teeProgram: anchor.Program<Payroll>;

  it("keeps lifecycle status private while exercising employer controls", async () => {
    const employerBalance = await baseConnection.getBalance(
      employer.publicKey,
      "confirmed"
    );
    assert.isAbove(
      employerBalance,
      0,
      "Configured authority wallet must already be funded on devnet"
    );

    await program.methods
      .createEmployee(streamSeedArg)
      .accountsPartial({
        employer: employer.publicKey,
      })
      .signers([employer])
      .rpc();

    const publicEmployee = (await program.account.employee.fetch(
      employeePda
    )) as PublicEmployeeState;
    const publicEmployeeInfo = await baseConnection.getAccountInfo(
      employeePda,
      "confirmed"
    );
    assert.isNotNull(publicEmployeeInfo);
    assertPublicEmployeePrivacyInvariant({
      rawData: Buffer.from(publicEmployeeInfo!.data),
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

    await program.methods
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
    await sendBaseTransaction(
      baseConnection,
      new Transaction().add(delegatePermissionIx, delegateEmployeeIx),
      [employer]
    );
    await sleep(3_000);

    await teeProgram.methods
      .initializePrivatePayroll(new BN(1_000_000))
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    const initializedState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.equal(initializedState.status, 2);
    assert.equal(initializedState.version.toString(), "1");
    assert.deepEqual(initializedState.streamId, streamSeed);

    await teeProgram.methods
      .resumeStream()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    const activeState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.equal(activeState.status, 1);

    await teeProgram.methods
      .updatePrivateTerms(new BN(2_000_000))
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    const updatedState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.equal(updatedState.ratePerSecondMicro.toString(), "2000000");
    assert.isTrue(updatedState.version > activeState.version);

    await teeProgram.methods
      .pauseStream()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    const pausedState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.equal(pausedState.status, 2);

    await teeProgram.methods
      .resumeStream()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    await sleep(2_000);

    await teeProgram.methods
      .checkpointAccrual()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    const accruedState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.isTrue(accruedState.accruedUnpaidMicro > BigInt(0));

    await teeProgram.methods
      .paySalary(new BN(accruedState.accruedUnpaidMicro.toString()))
      .accountsPartial({
        crankOrEmployer: employer.publicKey,
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();

    await teeProgram.methods
      .stopStream()
      .accountsPartial({
        employer: employer.publicKey,
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .signers([employer])
      .rpc();
    const stoppedState = await readPrivatePayrollState(
      teeConnection,
      privatePayrollPda
    );
    assert.equal(stoppedState.status, 3);

    await teeProgram.methods
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
    assert.isNotNull(committedEmployeeInfo);
    assertPublicEmployeePrivacyInvariant({
      rawData: Buffer.from(committedEmployeeInfo!.data),
      publicState: publicEmployee,
      streamSeed,
      employer: employer.publicKey,
      employeeWallet,
    });
  });
});
