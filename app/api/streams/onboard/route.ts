import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createDelegatePermissionInstruction,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import {
  getEmployeeById,
  listStreams,
  updateStreamRuntimeState,
} from "@/lib/server/payroll-store";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPayrollStreamSeedArg,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";

const PROGRAM_ID = new PublicKey(
  "EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR",
);
const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);
const DEVNET_RPC = clusterApiUrl("devnet");
const TEE_URL = "https://devnet-tee.magicblock.app";
type BuildOnboardingBody = {
  employerWallet?: string;
  streamId?: string;
  teeAuthToken?: string;
};

type BuildOnboardingResponse = {
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  alreadyOnboarded?: boolean;
  transactions: {
    baseSetup?: {
      transactionBase64: string;
      sendTo: "base";
    };
    initializePrivatePayroll?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
};

const { AnchorProvider, Program } = anchor;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function toRateMicroUnits(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error("ratePerSecond must be a positive number");
  }

  return Math.round(ratePerSecond * 1_000_000);
}

async function getBaseProgramForEmployer(employerPubkey: PublicKey) {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new Program(idl, provider);
  return { connection, provider, program };
}

async function getTeeProgramForEmployer(
  employerPubkey: PublicKey,
  teeAuthToken: string,
) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new Program(idl, provider);
  return { connection, provider, program };
}

async function serializeUnsignedTransaction(
  connection: Connection,
  feePayer: PublicKey,
  transaction: Transaction,
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = feePayer;
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}

async function getAccountInfo(connection: Connection, address: PublicKey) {
  return connection.getAccountInfo(address, "confirmed");
}

function isOwnedByProgram(
  accountInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  return Boolean(accountInfo && accountInfo.owner.equals(programId));
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BuildOnboardingBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!teeAuthToken) {
      return badRequest(
        "teeAuthToken is required to build the PER onboarding transaction",
      );
    }

    const employerPubkey = new PublicKey(
      assertWallet(employerWallet, "Employer wallet"),
    );

    const streams = await listStreams(employerWallet);
    const stream = streams.find((item) => item.id === streamId);

    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const employee = await getEmployeeById(employerWallet, stream.employeeId);

    if (!employee) {
      return badRequest("Employee not found for this stream", 404);
    }

    const rateMicroUnits = toRateMicroUnits(stream.ratePerSecond);
    const streamSeedArg = getPayrollStreamSeedArg(stream.id);

    const employeePda = getEmployeePdaForStream(stream.employerWallet, stream.id);
    const privatePayrollPda = getPrivatePayrollPda(employeePda);
    const permissionPda = permissionPdaFromAccount(employeePda);

    const isAlreadyOnboarded = !!(
      stream.employeePda &&
      stream.privatePayrollPda &&
      stream.permissionPda &&
      stream.delegatedAt
    );

    if (isAlreadyOnboarded) {
      const response: BuildOnboardingResponse = {
        employeePda: employeePda.toBase58(),
        privatePayrollPda: privatePayrollPda.toBase58(),
        permissionPda: permissionPda.toBase58(),
        alreadyOnboarded: true,
        transactions: {},
      };

      return NextResponse.json(response, { status: 200 });
    }

    const { connection: baseConnection, program: baseProgram } =
      await getBaseProgramForEmployer(employerPubkey);
    const { connection: teeConnection, program: teeProgram } =
      await getTeeProgramForEmployer(employerPubkey, teeAuthToken);

    const [
      employeeAccountInfo,
      permissionAccountInfo,
      privatePayrollAccountInfo,
    ] = await Promise.all([
      getAccountInfo(baseConnection, employeePda),
      getAccountInfo(baseConnection, permissionPda),
      getAccountInfo(teeConnection, privatePayrollPda),
    ]);

    const employeeExistsOnBase = Boolean(employeeAccountInfo);
    const permissionExistsOnBase = Boolean(permissionAccountInfo);
    const privatePayrollExistsOnTee = Boolean(privatePayrollAccountInfo);
    const employeeDelegated =
      employeeExistsOnBase &&
      !isOwnedByProgram(employeeAccountInfo, PROGRAM_ID);
    const permissionDelegated =
      permissionExistsOnBase &&
      !isOwnedByProgram(permissionAccountInfo, PERMISSION_PROGRAM_ID);

    if (
      employeeExistsOnBase &&
      permissionExistsOnBase &&
      privatePayrollExistsOnTee
    ) {
      const response: BuildOnboardingResponse = {
        employeePda: employeePda.toBase58(),
        privatePayrollPda: privatePayrollPda.toBase58(),
        permissionPda: permissionPda.toBase58(),
        alreadyOnboarded: true,
        transactions: {},
      };

      return NextResponse.json(response, { status: 200 });
    }

    const typedBaseProgram = baseProgram as anchor.Program<Idl>;
    const typedTeeProgram = teeProgram as anchor.Program<Idl>;

    const baseInstructions: anchor.web3.TransactionInstruction[] = [];

    if (!employeeExistsOnBase) {
      const createEmployeeIx = await typedBaseProgram.methods
        .createEmployee(streamSeedArg)
        .accounts({
          employee: employeePda,
          employer: employerPubkey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      baseInstructions.push(createEmployeeIx);
    }

    if (!permissionExistsOnBase) {
      const createPermissionIx = await typedBaseProgram.methods
        .createPermission(streamSeedArg)
        .accounts({
          employee: employeePda,
          employer: employerPubkey,
          permission: permissionPda,
          permissionProgram: PERMISSION_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      baseInstructions.push(createPermissionIx);
    }

    if (!permissionExistsOnBase || !permissionDelegated) {
      const delegatePermissionIx = createDelegatePermissionInstruction({
        payer: employerPubkey,
        authority: [employerPubkey, true],
        permissionedAccount: [employeePda, false],
        ownerProgram: PERMISSION_PROGRAM_ID,
        validator: DEVNET_TEE_VALIDATOR,
      });
      baseInstructions.push(delegatePermissionIx);
    }

    if (!employeeDelegated) {
      const delegateEmployeeIx = await typedBaseProgram.methods
        .delegateEmployee(streamSeedArg)
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
        })
        .instruction();
      baseInstructions.push(delegateEmployeeIx);
    }

    let baseSetupSerialized: Uint8Array | undefined;
    if (baseInstructions.length > 0) {
      baseSetupSerialized = await serializeUnsignedTransaction(
        baseConnection,
        employerPubkey,
        new Transaction().add(...baseInstructions),
      );
    }

    let initializePrivatePayrollSerialized: Uint8Array | undefined;
    if (!privatePayrollExistsOnTee) {
      const initializePrivatePayrollIx = await typedTeeProgram.methods
        .initializePrivatePayroll(new BN(rateMicroUnits))
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();

      initializePrivatePayrollSerialized = await serializeUnsignedTransaction(
        teeConnection,
        employerPubkey,
        new Transaction().add(initializePrivatePayrollIx),
      );
    }

    const response: BuildOnboardingResponse = {
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
      permissionPda: permissionPda.toBase58(),
      alreadyOnboarded: false,
      transactions: {
        ...(baseSetupSerialized
          ? {
              baseSetup: {
                transactionBase64: Buffer.from(
                  baseSetupSerialized,
                ).toString("base64"),
                sendTo: "base" as const,
              },
            }
          : {}),
        ...(initializePrivatePayrollSerialized
          ? {
              initializePrivatePayroll: {
                transactionBase64: Buffer.from(
                  initializePrivatePayrollSerialized,
                ).toString("base64"),
                sendTo: "ephemeral" as const,
              },
            }
          : {}),
      },
    };

    return NextResponse.json(response, {
      status: Object.keys(response.transactions).length === 0 ? 200 : 201,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build payroll onboarding transactions";

    return badRequest(message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      employerWallet?: string;
      streamId?: string;
      employeePda?: string;
      privatePayrollPda?: string;
      permissionPda?: string;
    };

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const employeePda = body.employeePda?.trim();
    const privatePayrollPda = body.privatePayrollPda?.trim();
    const permissionPda = body.permissionPda?.trim();

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!employeePda || !privatePayrollPda || !permissionPda) {
      return badRequest(
        "employeePda, privatePayrollPda, and permissionPda are required",
      );
    }

    const streams = await listStreams(employerWallet);
    const stream = streams.find((item) => item.id === streamId);

    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const updatedStream = await updateStreamRuntimeState({
      employerWallet,
      streamId,
      employeePda,
      privatePayrollPda,
      permissionPda,
      delegatedAt: new Date().toISOString(),
    });

    return NextResponse.json(
      {
        message: "Stream onboarding metadata recorded",
        stream: updatedStream,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize payroll onboarding";

    return badRequest(message);
  }
}
