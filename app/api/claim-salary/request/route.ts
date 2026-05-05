import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  getStreamByStreamId,
  getEmployeeById,
  createOnChainClaim,
  getPendingOnChainClaim,
} from "@/lib/server/payroll-store";
import {
  evaluateMonthlyCap,
} from "@/lib/server/monthly-cap";
import {
  fetchPrivatePayrollState,
  getConfirmedUnixTimestamp,
  computeRawClaimableAmountMicro,
  PRIVATE_PENDING_STATUS_NONE,
  PRIVATE_PENDING_STATUS_REQUESTED,
} from "@/lib/server/private-payroll-state";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

const TEE_URL = "https://devnet-tee.magicblock.app";

type BuildClaimRequestBody = {
  employeeWallet?: string;
  streamId?: string;
  amountMicro?: number;
  teeAuthToken?: string;
};

type FinalizeClaimRequestBody = {
  employeeWallet?: string;
  streamId?: string;
  amountMicro?: number;
  claimId?: number;
  signature?: string;
  teeAuthToken?: string;
};

type RequestWithdrawalMethods = {
  requestWithdrawal(amount: BN): {
    accounts(input: {
      employeeSigner: PublicKey;
      employer: PublicKey;
      employee: PublicKey;
      privatePayroll: PublicKey;
    }): {
      instruction(): Promise<TransactionInstruction>;
    };
  };
};

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

async function getTeeProgramForEmployee(
  employeePubkey: PublicKey,
  teeAuthToken: string,
) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createReadonlyAnchorWallet(employeePubkey);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
  return { connection, program };
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

function getRequestWithdrawalMethods(
  program: anchor.Program<Idl>,
): RequestWithdrawalMethods {
  return program.methods as unknown as RequestWithdrawalMethods;
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as BuildClaimRequestBody;

    const employeeWallet = body.employeeWallet?.trim();
    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();
    const amountMicro = body.amountMicro;

    if (!employeeWallet) {
      return badRequest("employeeWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!teeAuthToken) {
      return badRequest("teeAuthToken is required");
    }

    if (!amountMicro || amountMicro <= 0) {
      return badRequest("amountMicro must be greater than 0");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employeeWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    // Verify no pending claim exists
    const existingPending = await getPendingOnChainClaim(streamId);
    if (existingPending) {
      return badRequest("A pending claim already exists for this stream");
    }

    const stream = await getStreamByStreamId(streamId);
    if (!stream) {
      return badRequest("Stream not found", 404);
    }
    
    const employee = await getEmployeeById(stream.employerWallet, stream.employeeId);
    if (!employee || employee.wallet !== employeeWallet) {
      return badRequest("Stream employee wallet mismatch", 403);
    }

    if (!stream.employeePda || !stream.privatePayrollPda || !stream.permissionPda) {
      return badRequest("Stream must be PER onboarded before claiming");
    }

    const employeePubkey = new PublicKey(
      assertWallet(employeeWallet, "Employee wallet"),
    );

    const employeePda = getEmployeePdaForStream(stream.employerWallet, stream.id);
    const privatePayrollPda = getPrivatePayrollPda(employeePda);
    const startsAt = stream.startsAt ?? employee.startDate ?? null;

    const { connection, program } = await getTeeProgramForEmployee(
      employeePubkey,
      teeAuthToken,
    );
    const methods = getRequestWithdrawalMethods(program);
    const {
      state,
    } = await fetchPrivatePayrollState({
      employerWallet: stream.employerWallet,
      streamId: stream.id,
      teeAuthToken,
    });

    if (state.employeeWallet !== employeeWallet) {
      return badRequest("Private payroll employee wallet mismatch", 403);
    }

    if (state.pendingStatus !== PRIVATE_PENDING_STATUS_NONE) {
      return badRequest("A pending claim already exists for this stream");
    }

    const nowUnix = await getConfirmedUnixTimestamp(connection);
    const rawClaimable = computeRawClaimableAmountMicro({
      state,
      nowUnix,
      startsAt,
    });
    const cap = evaluateMonthlyCap({
      stream,
      employee,
      rawClaimableAmountMicro: rawClaimable.claimableAmountMicro,
      totalPaidPrivateMicro: state.totalPaidPrivateMicro,
      now: new Date(nowUnix * 1000),
    });
    const effectiveClaimableAmountMicro = rawClaimable.hasFutureStart
      ? BigInt(0)
      : BigInt(cap.effectiveClaimableAmountMicro);

    if (BigInt(amountMicro) > effectiveClaimableAmountMicro) {
      return badRequest("Requested amount exceeds the currently claimable balance");
    }

    const claimId = Number(state.nextClaimId);

    const instruction = await methods
      .requestWithdrawal(new BN(amountMicro))
      .accounts({
        employeeSigner: employeePubkey,
        employer: new PublicKey(stream.employerWallet),
        employee: employeePda,
        privatePayroll: privatePayrollPda,
      })
      .instruction();

    const serialized = await serializeUnsignedTransaction(
      connection,
      employeePubkey,
      new Transaction().add(instruction),
    );

    return NextResponse.json({
      employeeWallet,
      streamId,
      amountMicro,
      claimId,
      transactions: {
        requestWithdrawal: {
          transactionBase64: Buffer.from(serialized).toString("base64"),
          sendTo: "ephemeral",
        },
      },
    }, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to build claim tx";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as FinalizeClaimRequestBody;

    const employeeWallet = body.employeeWallet?.trim();
    const streamId = body.streamId?.trim();
    const amountMicro = body.amountMicro;
    const claimId = body.claimId;
    const signature = body.signature?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();

    if (!employeeWallet) {
      return badRequest("employeeWallet is required");
    }
    if (!streamId) {
      return badRequest("streamId is required");
    }
    if (amountMicro === undefined || amountMicro <= 0) {
      return badRequest("amountMicro is required and must be > 0");
    }
    if (claimId === undefined || claimId < 0) {
      return badRequest("claimId is required and must be >= 0");
    }
    if (!signature) {
      return badRequest("signature is required");
    }
    if (!teeAuthToken) {
      return badRequest("teeAuthToken is required");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employeeWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const existingPending = await getPendingOnChainClaim(streamId);
    if (existingPending) {
      return badRequest("A pending claim already exists for this stream");
    }

    const stream = await getStreamByStreamId(streamId);
    if (!stream) {
      return badRequest("Stream not found", 404);
    }
    
    const employee = await getEmployeeById(stream.employerWallet, stream.employeeId);
    if (!employee || employee.wallet !== employeeWallet) {
      return badRequest("Stream employee wallet mismatch", 403);
    }

    const employeePda = getEmployeePdaForStream(stream.employerWallet, stream.id);
    const privatePayrollPda = getPrivatePayrollPda(employeePda);
    const { state } = await fetchPrivatePayrollState({
      employerWallet: stream.employerWallet,
      streamId: stream.id,
      teeAuthToken,
    });

    if (state.employeeWallet !== employeeWallet) {
      return badRequest("Private payroll employee wallet mismatch", 403);
    }

    if (state.pendingStatus !== PRIVATE_PENDING_STATUS_REQUESTED) {
      return badRequest("No on-chain pending claim is available to finalize");
    }

    if (Number(state.pendingClaimId) !== claimId) {
      return badRequest("On-chain claim id does not match the finalized claim");
    }

    if (Number(state.pendingAmountMicro) !== amountMicro) {
      return badRequest("On-chain claim amount does not match the finalized claim");
    }

    const claim = await createOnChainClaim({
      streamId,
      payrollPda: privatePayrollPda.toBase58(),
      employeeWallet,
      claimId,
      amountMicro,
      requestTxSignature: signature,
    });

    return NextResponse.json({
      message: "Claim requested successfully",
      claim,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize claim request";

    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 500);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const streamId = searchParams.get("streamId");
    
    if (streamId) {
      const existingPending = await getPendingOnChainClaim(streamId);
      return NextResponse.json({
        pendingClaim: existingPending || null
      });
    }

    return badRequest("streamId is required");
  } catch (error: unknown) {
    return badRequest("Failed to get claims", 500);
  }
}
