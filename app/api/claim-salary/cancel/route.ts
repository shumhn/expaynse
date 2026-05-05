import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";

import {
  getEmployeeById,
  getPendingOnChainClaim,
  getStreamByStreamId,
  updateOnChainClaim,
  findUnsettledTransfer,
  updateTransferRecord,
} from "@/lib/server/payroll-store";
import { findCompanyByEmployerWallet } from "@/lib/server/company-store";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import { createAnchorNodeWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import { getEmployeePdaForStream } from "@/lib/server/payroll-pdas";
import {
  fetchPrivatePayrollState,
  PRIVATE_PENDING_STATUS_REQUESTED,
} from "@/lib/server/private-payroll-state";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

const TEE_URL = "https://devnet-tee.magicblock.app";

type CancelClaimRequestBody = {
  streamId?: string;
  teeAuthToken?: string;
  employeeWallet?: string;
  employerWallet?: string;
};

type CancelPendingWithdrawalMethods = {
  cancelPendingWithdrawal(claimId: BN): {
    accounts(input: {
      settlementAuthority: PublicKey;
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

function getCancelPendingWithdrawalMethods(
  program: anchor.Program<Idl>,
): CancelPendingWithdrawalMethods {
  return program.methods as unknown as CancelPendingWithdrawalMethods;
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as CancelClaimRequestBody;

    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();
    const employeeWallet = body.employeeWallet?.trim();
    const employerWallet = body.employerWallet?.trim();

    if (!streamId) {
      return badRequest("streamId is required");
    }
    if (!teeAuthToken) {
      return badRequest("teeAuthToken is required");
    }
    if (!employeeWallet && !employerWallet) {
      return badRequest("employeeWallet or employerWallet is required");
    }

    const claim = await getPendingOnChainClaim(streamId);
    if (!claim) {
      return badRequest("No pending claim found for this stream", 404);
    }

    const stream = await getStreamByStreamId(streamId);
    if (!stream) {
      return badRequest("Stream not found", 404);
    }

    const expectedWallet = employerWallet || employeeWallet || "";
    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    if (employerWallet && employerWallet !== stream.employerWallet) {
      return badRequest("Employer wallet does not own this stream", 403);
    }
    if (employeeWallet && employeeWallet !== claim.employeeWallet) {
      return badRequest("Employee wallet does not match the pending claim", 403);
    }

    if (claim.paymentTxSignature) {
      return badRequest(
        "This claim already has a transfer signature recorded and must be recovered with sync instead of cancelled",
        409,
      );
    }

    if (claim.status !== "failed" && claim.status !== "requested") {
      return badRequest("Only failed or requested claims can be cancelled", 409);
    }

    const employee = await getEmployeeById(stream.employerWallet, stream.employeeId);
    if (!employee || employee.wallet !== claim.employeeWallet) {
      return badRequest("Pending claim employee mismatch", 403);
    }

    const company = await findCompanyByEmployerWallet(stream.employerWallet);
    if (!company) {
      return badRequest("Company not found for stream", 404);
    }

    const privateState = await fetchPrivatePayrollState({
      employerWallet: stream.employerWallet,
      streamId: stream.id,
      teeAuthToken,
    });

    if (privateState.state.employeeWallet !== claim.employeeWallet) {
      return badRequest("Private payroll employee wallet does not match the pending claim", 409);
    }
    if (privateState.state.settlementAuthority !== company.settlementPubkey) {
      return badRequest("Private payroll settlement authority does not match the company authority", 409);
    }
    if (privateState.state.pendingStatus !== PRIVATE_PENDING_STATUS_REQUESTED) {
      return badRequest("No cancellable on-chain pending claim exists for this stream", 409);
    }
    if (Number(privateState.state.pendingClaimId) !== claim.claimId) {
      return badRequest("On-chain pending claim id does not match the stored claim", 409);
    }
    if (Number(privateState.state.pendingAmountMicro) !== claim.amountMicro) {
      return badRequest("On-chain pending claim amount does not match the stored claim", 409);
    }

    const settlementKeypair = await loadCompanyKeypair({
      companyId: company.id,
      kind: "settlement",
    });

    const connection = new Connection(
      `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
      "confirmed",
    );
    const provider = new anchor.AnchorProvider(
      connection,
      createAnchorNodeWallet(settlementKeypair),
      { commitment: "confirmed" },
    );
    const idl = await loadPayrollIdl(provider);
    const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
    const methods = getCancelPendingWithdrawalMethods(program);

    const cancelIx = await methods
      .cancelPendingWithdrawal(new BN(claim.claimId))
      .accounts({
        settlementAuthority: settlementKeypair.publicKey,
        employer: new PublicKey(stream.employerWallet),
        employee: getEmployeePdaForStream(stream.employerWallet, stream.id),
        privatePayroll: new PublicKey(claim.payrollPda),
      })
      .instruction();

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(cancelIx);
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = settlementKeypair.publicKey;
    tx.sign(settlementKeypair);

    const cancelTxSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(cancelTxSignature, "confirmed");

    const unsettled = await findUnsettledTransfer(stream.id);
    if (unsettled) {
      await updateTransferRecord(unsettled.id, {
        status: "failed",
        errorMessage: "Claim was cancelled before a treasury transfer was completed",
      });
    }

    const updatedClaim = await updateOnChainClaim(claim.id, {
      status: "cancelled",
      markPaidTxSignature: cancelTxSignature,
      paymentTxSignature: null,
    });

    return NextResponse.json({
      message: "Pending claim cancelled successfully",
      claim: updatedClaim,
      cancelTxSignature,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel pending claim";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 500);
  }
}
