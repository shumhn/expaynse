import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createDelegatePermissionInstruction,
  PERMISSION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import {
  getEmployeeById,
  listStreams,
  updateStreamRuntimeState,
} from "@/lib/server/payroll-store";
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
import {
  assertWallet,
  badRequest,
  BASE_DEVNET_RPC,
  DELEGATED_ACCOUNT_OWNER,
  DEVNET_TEE_VALIDATOR,
  DEVNET_USDC_MINT,
  getAccountInfo,
  getBaseProgramForEmployer,
  getTeeProgramForEmployer,
  isOwnedByProgram,
  MAGIC_VAULT,
  serializeUnsignedTransaction,
  toRateMicroUnits,
} from "./onboard-helpers";
import type {
  BuildOnboardingBody,
  BuildOnboardingResponse,
} from "./onboard-types";

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

    // Delegation is inferred by account owner: delegated shells are owned by
    // MagicBlock delegation runtime instead of the base program owner.
    const isDelegated = isOwnedByProgram(
      employeeAccountInfo,
      DELEGATED_ACCOUNT_OWNER,
    );

    const typedBaseProgram = baseProgram as anchor.Program<Idl>;
    const baseInstructions: anchor.web3.TransactionInstruction[] = [];

    // Step 1 (base): create employee anchor if missing.
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

    // Step 2 (base): create permission account for TEE-controlled execution.
    if (!employeeExistsOnBase) {
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
    const isPermissionDelegated = isOwnedByProgram(
      permissionAccountInfo,
      DELEGATED_ACCOUNT_OWNER,
    );

    // Step 3 (base): delegate employee shell into TEE runtime if not delegated.
    if (!isDelegated) {
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

    let baseSetupSerialized: Uint8Array | undefined;
    if (baseInstructions.length > 0) {
      baseSetupSerialized = await serializeUnsignedTransaction(
        baseConnection,
        employerPubkey,
        new Transaction().add(...baseInstructions),
      );
    }

    // Step 4 (TEE): initialize private payroll state if absent.
    let initPrivatePayrollSerialized: Uint8Array | undefined;
    const company = await findCompanyByEmployerWallet(employerWallet);
    if (!company) throw new Error("Company not found for employer");

    const { connection: teeConnection, program: teeProgram } =
      await getTeeProgramForEmployer(employerPubkey, teeAuthToken);
    const typedTeeProgram = teeProgram as anchor.Program<Idl>;

    const teePrivatePayrollAccount = await teeConnection.getAccountInfo(privatePayrollPda);
    const isPrivatePayrollInitialized = teePrivatePayrollAccount !== null;

    if (!isPrivatePayrollInitialized) {
      const initPrivatePayrollIx = await typedTeeProgram.methods
        .initializePrivatePayroll(
          new BN(rateMicroUnits),
          new PublicKey(employee.wallet),
          DEVNET_USDC_MINT,
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
        // `status` lives at byte offset 192 in the serialized payroll state.
        isStreamActive = teePrivatePayrollAccount.data[192] === 1;
      }
    }

    let resumeStreamSerialized: Uint8Array | undefined;
    const shouldResumeDuringOnboarding = stream.status === "active";
    if (shouldResumeDuringOnboarding && !isStreamActive) {
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
