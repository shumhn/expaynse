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
  MAGIC_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import {
  getEmployeeById,
  listStreams,
  updateStreamRuntimeState,
} from "@/lib/server/payroll-store";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import { findCompanyByEmployerWallet } from "@/lib/server/company-store";
import {
  getEmployeePdaForStream,
  getPayrollStreamSeedArg,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  fetchPrivatePayrollState,
} from "@/lib/server/private-payroll-state";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

const PROGRAM_ID = new PublicKey(
  "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6",
);
const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);
const BASE_DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("devnet");
const BASE_DEVNET_RPC_FALLBACKS = Array.from(
  new Set([BASE_DEVNET_RPC, clusterApiUrl("devnet")].filter(Boolean)),
);
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
    resumeStream?: {
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

function isRpcRateLimitError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("429") || message.includes("too many requests");
}

async function getLatestBlockhashWithRetry(connection: Connection) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (error: unknown) {
      lastError = error;
      if (!isRpcRateLimitError(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch recent blockhash");
}

async function getBaseProgramForEmployer(employerPubkey: PublicKey) {
  const connection = new Connection(BASE_DEVNET_RPC, "confirmed");
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
  const latest = await getLatestBlockhashWithRetry(connection);
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = feePayer;
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}

async function getAccountInfo(connection: Connection, address: PublicKey) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await connection.getAccountInfo(address, "confirmed");
    } catch (error: unknown) {
      lastError = error;
      if (!isRpcRateLimitError(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to load account info");
}

function isOwnedByProgram(
  accountInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  return Boolean(accountInfo && accountInfo.owner.equals(programId));
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as BuildOnboardingBody;

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

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

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

    const [
      employeeAccountInfo,
    ] = await Promise.all([
      getAccountInfo(baseConnection, employeePda),
    ]);

    const employeeExistsOnBase = Boolean(employeeAccountInfo);

    // Check if already delegated by looking at account owner
    const isDelegated =
      employeeExistsOnBase &&
      employeeAccountInfo!.owner.toBase58() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

    const typedBaseProgram = baseProgram as anchor.Program<Idl>;
    const baseInstructions: anchor.web3.TransactionInstruction[] = [];

    // 1. Create Employee (Base) — V2: only takes stream_id, no wallet
    if (!employeeExistsOnBase) {
      console.log("  Building createEmployee instruction...");
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

    // 2. Create Permission (Base) — V2: sets up TEE access control
    if (!employeeExistsOnBase) {
      console.log("  Building createPermission instruction...");
      const permissionProgramId = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
      const createPermissionIx = await typedBaseProgram.methods
        .createPermission(streamSeedArg, new PublicKey(employee.wallet))
        .accounts({
          employee: employeePda,
          employer: employerPubkey,
          permission: permissionPda,
          permissionProgram: permissionProgramId,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      baseInstructions.push(createPermissionIx);
    }

    const permissionAccountInfo = await getAccountInfo(
      baseConnection,
      permissionPda,
    );
    const isPermissionDelegated = permissionAccountInfo ? permissionAccountInfo.owner.toBase58() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh" : false;

    // 3. Delegate Employee (Base) — V2: teleports employee shell into TEE
    if (!isDelegated) {
      console.log("  Building delegateEmployee instruction...");
      
      if (!isPermissionDelegated) {
        const delegatePermissionIx = createDelegatePermissionInstruction({
          payer: employerPubkey,
          authority: [employerPubkey, true],
          permissionedAccount: [employeePda, false],
          ownerProgram: PERMISSION_PROGRAM_ID,
          validator: DEVNET_TEE_VALIDATOR,
        });
        baseInstructions.push(delegatePermissionIx);
      }

      const delegateEmployeeIx = await typedBaseProgram.methods
        .delegateEmployee(streamSeedArg)
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
        })
        .instruction();
      baseInstructions.push(delegateEmployeeIx);
    }

    console.log(`  Base instructions built: ${baseInstructions.length}`);
    let baseSetupSerialized: Uint8Array | undefined;
    if (baseInstructions.length > 0) {
      baseSetupSerialized = await serializeUnsignedTransaction(
        baseConnection,
        employerPubkey,
        new Transaction().add(...baseInstructions),
      );
    }

    // 4. Initialize Private Payroll (TEE) — V2: creates PrivatePayrollState inside the TEE
    let initPrivatePayrollSerialized: Uint8Array | undefined;
    const company = await findCompanyByEmployerWallet(employerWallet);
    if (!company) throw new Error("Company not found for employer");

    const { connection: teeConnection, program: teeProgram } =
      await getTeeProgramForEmployer(employerPubkey, teeAuthToken);
    const typedTeeProgram = teeProgram as anchor.Program<Idl>;

    const teePrivatePayrollAccount = await teeConnection.getAccountInfo(privatePayrollPda);
    const isPrivatePayrollInitialized = teePrivatePayrollAccount !== null;

    if (!isPrivatePayrollInitialized) {
      console.log("  Building initializePrivatePayroll instruction (TEE)...");
      const MAGIC_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
      const initPrivatePayrollIx = await typedTeeProgram.methods
        .initializePrivatePayroll(
          new BN(rateMicroUnits),
          new PublicKey(employee.wallet),
          new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), // DEVNET_USDC
          new PublicKey(company.treasuryPubkey),
          new PublicKey(company.settlementPubkey),
        )
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
          vault: MAGIC_VAULT,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .instruction();

      initPrivatePayrollSerialized = await serializeUnsignedTransaction(
        teeConnection,
        employerPubkey,
        new Transaction().add(initPrivatePayrollIx),
      );
    }

    let isStreamActive = false;
    if (isPrivatePayrollInitialized && teePrivatePayrollAccount) {
      if (teePrivatePayrollAccount.data.length >= 193) {
        // The status field is at offset 192 (6 * 32-byte Pubkeys/arrays)
        isStreamActive = teePrivatePayrollAccount.data[192] === 1;
      }
    }

    let resumeStreamSerialized: Uint8Array | undefined;
    const shouldResumeDuringOnboarding = stream.status === "active";
    if (shouldResumeDuringOnboarding && !isStreamActive) {
      console.log("  Building resumeStream instruction (TEE)...");
      const MAGIC_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
      const resumeStreamIx = await typedTeeProgram.methods
        .resumeStream()
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
          vault: MAGIC_VAULT,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .instruction();

      resumeStreamSerialized = await serializeUnsignedTransaction(
        teeConnection,
        employerPubkey,
        new Transaction().add(resumeStreamIx),
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
        ...(initPrivatePayrollSerialized
          ? {
            initializePrivatePayroll: {
              transactionBase64: Buffer.from(
                initPrivatePayrollSerialized,
              ).toString("base64"),
              sendTo: "ephemeral" as const,
            },
          }
          : {}),
        ...(resumeStreamSerialized
          ? {
            resumeStream: {
              transactionBase64: Buffer.from(
                resumeStreamSerialized,
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

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      streamId?: string;
      employeePda?: string;
      privatePayrollPda?: string;
      permissionPda?: string;
      teeAuthToken?: string;
    };

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const employeePda = body.employeePda?.trim();
    const privatePayrollPda = body.privatePayrollPda?.trim();
    const permissionPda = body.permissionPda?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();

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
    if (!teeAuthToken) {
      return badRequest("teeAuthToken is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const streams = await listStreams(employerWallet);
    const stream = streams.find((item) => item.id === streamId);

    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }
    const employee = await getEmployeeById(employerWallet, stream.employeeId);
    if (!employee) {
      return badRequest("Employee not found for this stream", 404);
    }
    const company = await findCompanyByEmployerWallet(employerWallet);
    if (!company) {
      return badRequest("Company not found for this employer", 404);
    }

    const expectedEmployeePda = getEmployeePdaForStream(employerWallet, streamId);
    const expectedPrivatePayrollPda = getPrivatePayrollPda(expectedEmployeePda);
    const expectedPermissionPda = permissionPdaFromAccount(expectedEmployeePda);

    if (employeePda !== expectedEmployeePda.toBase58()) {
      return badRequest("employeePda does not match the expected stream employee PDA", 409);
    }
    if (privatePayrollPda !== expectedPrivatePayrollPda.toBase58()) {
      return badRequest("privatePayrollPda does not match the expected private payroll PDA", 409);
    }
    if (permissionPda !== expectedPermissionPda.toBase58()) {
      return badRequest("permissionPda does not match the expected permission PDA", 409);
    }

    const baseConnection = new Connection(BASE_DEVNET_RPC, "confirmed");
    const [employeeAccountInfo, permissionAccountInfo] = await Promise.all([
      getAccountInfo(baseConnection, expectedEmployeePda),
      getAccountInfo(baseConnection, expectedPermissionPda),
    ]);

    if (!employeeAccountInfo) {
      return badRequest("Employee base account is not initialized on-chain", 409);
    }
    if (!permissionAccountInfo) {
      return badRequest("Permission account is not initialized on-chain", 409);
    }

    const privateState = await fetchPrivatePayrollState({
      employerWallet,
      streamId,
      teeAuthToken,
    });

    if (privateState.state.employee !== expectedEmployeePda.toBase58()) {
      return badRequest("Private payroll state is linked to a different employee PDA", 409);
    }
    if (privateState.state.employeeWallet !== employee.wallet) {
      return badRequest("Private payroll state is linked to a different employee wallet", 409);
    }
    if (privateState.state.payrollTreasury !== company.treasuryPubkey) {
      return badRequest("Private payroll treasury does not match the company treasury", 409);
    }
    if (privateState.state.settlementAuthority !== company.settlementPubkey) {
      return badRequest("Private payroll settlement authority does not match the company settlement key", 409);
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

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
