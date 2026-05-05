import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import crypto from "node:crypto";
import { clusterApiUrl } from "@solana/web3.js";

import {
  getStreamByStreamId,
  getEmployeeById,
  getPendingOnChainClaim,
  updateOnChainClaim,
  findUnsettledTransfer,
  createTransferRecord,
  updateTransferRecord,
} from "@/lib/server/payroll-store";
import { findCompanyByEmployerWallet } from "@/lib/server/company-store";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import { sendPayrollFromCompanyTreasury } from "@/lib/server/treasury-payroll-transfer";
import { createAnchorNodeWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import { getEmployeePdaForStream } from "@/lib/server/payroll-pdas";
import {
  evaluateMonthlyCap,
} from "@/lib/server/monthly-cap";
import {
  fetchPrivatePayrollState,
  PRIVATE_PENDING_STATUS_REQUESTED,
} from "@/lib/server/private-payroll-state";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

const TEE_URL = "https://devnet-tee.magicblock.app";

type ProcessClaimRequestBody = {
  streamId?: string;
  teeAuthToken?: string;
  employeeWallet?: string;
};

type MarkPrivateTransferPaidMethods = {
  markPrivateTransferPaid(claimId: BN, amount: BN, paymentRefHash: number[]): {
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

function getMarkPrivateTransferPaidMethods(
  program: anchor.Program<Idl>,
): MarkPrivateTransferPaidMethods {
  return program.methods as unknown as MarkPrivateTransferPaidMethods;
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

const BASE_RPC_URL =
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  clusterApiUrl("devnet");

const ER_RPC_URL =
  process.env.ER_RPC_URL ||
  process.env.NEXT_PUBLIC_MAGICBLOCK_EPHEMERAL_RPC_URL ||
  "https://devnet.magicblock.app";

function resolveTransferRpcUrl(sendTo?: string | null) {
  const normalized = (sendTo ?? "").toLowerCase();
  if (
    normalized.includes("er") ||
    normalized.includes("ephemeral") ||
    normalized.includes("magic")
  ) {
    return ER_RPC_URL;
  }
  return BASE_RPC_URL;
}

async function assertTransferSignatureSettled(args: {
  signature: string;
  sendTo?: string | null;
}) {
  const connection = new Connection(resolveTransferRpcUrl(args.sendTo), "confirmed");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = (await connection.getSignatureStatuses([args.signature])).value[0];
    if (status?.err) {
      throw new Error(
        `Transfer transaction ${args.signature} failed on-chain: ${JSON.stringify(status.err)}`,
      );
    }
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Transfer transaction ${args.signature} is not confirmed yet`);
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as ProcessClaimRequestBody;

    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();
    const employeeWallet = body.employeeWallet?.trim();

    if (!streamId) return badRequest("streamId is required");
    if (!teeAuthToken) return badRequest("teeAuthToken is required");

    const claim = await getPendingOnChainClaim(streamId);
    if (!claim) {
      return badRequest("No pending claim found for this stream", 404);
    }

    if (claim.status === "needs_sync") {
      // The treasury transfer succeeded, but mark-paid failed. 
      // Let's skip directly to mark-paid.
      // But we need the paymentTxSignature to proceed.
      if (!claim.paymentTxSignature) {
        return badRequest("Claim needs sync but missing payment signature", 500);
      }
    }

    if (employeeWallet && employeeWallet !== claim.employeeWallet) {
      return badRequest("Employee wallet does not match the pending claim", 403);
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: claim.employeeWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const stream = await getStreamByStreamId(streamId);
    if (!stream) return badRequest("Stream not found", 404);
    const employee = await getEmployeeById(stream.employerWallet, stream.employeeId);
    if (!employee || employee.wallet !== claim.employeeWallet) {
      return badRequest("Pending claim employee mismatch", 403);
    }

    const company = await findCompanyByEmployerWallet(stream.employerWallet);
    if (!company) return badRequest("Company not found for stream", 404);

    const treasuryKeypair = await loadCompanyKeypair({
      companyId: company.id,
      kind: "treasury",
    });

    const settlementKeypair = await loadCompanyKeypair({
      companyId: company.id,
      kind: "settlement",
    });

    const amountMicro = claim.amountMicro;
    const claimEmployeeWallet = claim.employeeWallet;
    const {
      state,
    } = await fetchPrivatePayrollState({
      employerWallet: stream.employerWallet,
      streamId: stream.id,
      teeAuthToken,
    });

    if (state.employeeWallet !== claimEmployeeWallet) {
      return badRequest("Private payroll employee wallet does not match the claim", 409);
    }
    if (state.payrollTreasury !== company.treasuryPubkey) {
      return badRequest("Private payroll treasury does not match the company treasury", 409);
    }
    if (state.settlementAuthority !== company.settlementPubkey) {
      return badRequest("Private payroll settlement authority does not match the company authority", 409);
    }
    if (state.pendingStatus !== PRIVATE_PENDING_STATUS_REQUESTED) {
      return badRequest("No payable on-chain pending claim exists for this stream", 409);
    }
    if (Number(state.pendingClaimId) !== claim.claimId) {
      return badRequest("On-chain pending claim id does not match the stored claim", 409);
    }
    if (Number(state.pendingAmountMicro) !== amountMicro) {
      return badRequest("On-chain pending claim amount does not match the stored claim", 409);
    }

    const cap = evaluateMonthlyCap({
      stream,
      employee,
      rawClaimableAmountMicro: state.accruedUnpaidMicro + state.pendingAmountMicro,
      totalPaidPrivateMicro: state.totalPaidPrivateMicro,
    });
    const startsAt = stream.startsAt ?? employee.startDate ?? null;
    const startsAtUnix = startsAt ? new Date(startsAt).getTime() : null;
    const hasFutureStart =
      startsAtUnix !== null && Number.isFinite(startsAtUnix) && startsAtUnix > Date.now();
    const effectiveClaimableAmountMicro = hasFutureStart
      ? BigInt(0)
      : BigInt(cap.effectiveClaimableAmountMicro);

    if (BigInt(amountMicro) > effectiveClaimableAmountMicro) {
      return badRequest("Pending claim exceeds the currently allowed claimable amount", 409);
    }

    const unsettled = await findUnsettledTransfer(stream.id);

    if (claim.status === "needs_sync") {
      if (!unsettled || !unsettled.txSignature) {
        return badRequest("Claim needs sync but no unsettled transfer record was found", 409);
      }
      if (unsettled.txSignature !== claim.paymentTxSignature) {
        return badRequest("Stored payment signature does not match the unsettled transfer record", 409);
      }

      try {
        await assertTransferSignatureSettled({
          signature: unsettled.txSignature,
          sendTo: unsettled.providerMeta?.sendTo,
        });
      } catch (error) {
        await updateOnChainClaim(claim.id, { status: "failed", paymentTxSignature: null });
        await updateTransferRecord(unsettled.id, {
          status: "failed",
          errorMessage:
            error instanceof Error
              ? error.message
              : "Stored transfer signature is not confirmed on-chain",
        });
        return badRequest(
          "Stored payout transfer is not confirmed on-chain anymore. The claim was moved back to failed so you can retry or cancel it.",
          409,
        );
      }
    }

    // 1. Treasury Transfer (if not needs_sync)
    let paymentTxSignature = claim.paymentTxSignature;
    if (claim.status !== "needs_sync") {
      let pendingTransferId = unsettled?.id;
      let clientRefId = unsettled?.providerMeta?.clientRefId;

      if (!unsettled || unsettled.status !== "transfer_pending") {
        const newTransfer = await createTransferRecord({
          employerWallet: stream.employerWallet,
          employeeId: stream.employeeId,
          streamId: stream.id,
          amount: amountMicro / 1_000_000,
          recipientAddress: claimEmployeeWallet,
          status: "transfer_pending",
          providerMeta: { provider: "magicblock" },
          privacyConfig: {
            visibility: "private",
            fromBalance: "ephemeral",
            toBalance: "ephemeral",
          },
        });
        pendingTransferId = newTransfer.id;
        clientRefId = BigInt("0x" + crypto.randomBytes(8).toString("hex")).toString();

        await updateTransferRecord(pendingTransferId, {
          providerMeta: { provider: "magicblock", clientRefId },
        });
      }

      await updateOnChainClaim(claim.id, { status: "paying" });

      try {
        console.log("=== TREASURY WALLET INFO ===");
        console.log("Treasury Address:", treasuryKeypair.publicKey.toBase58());
        console.log("============================");
        
        const treasuryTransfer = await sendPayrollFromCompanyTreasury({
          treasuryKeypair,
          employeeWallet: claimEmployeeWallet,
          amountMicro,
          clientRefId: clientRefId as string,
          fromBalance: "ephemeral",
          toBalance: "ephemeral",
        });

        paymentTxSignature = treasuryTransfer.signature;

        await updateTransferRecord(pendingTransferId as string, {
          status: "transfer_sent",
          txSignature: paymentTxSignature,
          providerMeta: {
            provider: "magicblock",
            sendTo: treasuryTransfer.sendTo,
            clientRefId,
          },
        });

        await updateOnChainClaim(claim.id, { paymentTxSignature });
      } catch (err: any) {
        // Transfer failed, we can fail the claim and it can be cancelled later
        await updateOnChainClaim(claim.id, { status: "failed" });
        if (pendingTransferId) {
          await updateTransferRecord(pendingTransferId, {
            status: "failed",
            errorMessage: err instanceof Error ? err.message : "Treasury transfer failed",
          });
        }
        throw err;
      }
    }

    // 2. Mark Paid On-Chain
    try {
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
      const methods = getMarkPrivateTransferPaidMethods(program);

      // The payment_ref_hash in rust expects 32 bytes. We can just hash the signature or use a zero array if allowed.
      // Wait, the rust program says: `require!(payment_ref_hash != [0u8; 32], PayrollError::InvalidPaymentRef);`
      // So we must provide a non-zero 32-byte array. We'll use the first 32 bytes of the bs58 decoded signature, or a SHA256 of it.
      const hash = crypto.createHash("sha256").update(paymentTxSignature as string).digest();
      const paymentRefHashArray = Array.from(hash);

      const markPaidIx = await methods
        .markPrivateTransferPaid(
          new BN(claim.claimId),
          new BN(amountMicro),
          paymentRefHashArray as number[]
        )
        .accounts({
          settlementAuthority: settlementKeypair.publicKey,
          employer: new PublicKey(stream.employerWallet),
          employee: getEmployeePdaForStream(stream.employerWallet, stream.id),
          privatePayroll: new PublicKey(claim.payrollPda),
        })
        .instruction();

      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction().add(markPaidIx);
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = settlementKeypair.publicKey;
      tx.sign(settlementKeypair);

      const markPaidTxSignature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });

      // Update transfer and claim to success/paid
      const latestUnsettled = await findUnsettledTransfer(stream.id);
      if (latestUnsettled) {
        await updateTransferRecord(latestUnsettled.id, {
          status: "success",
          errorMessage: undefined,
        });
      }

      const updatedClaim = await updateOnChainClaim(claim.id, {
        status: "paid",
        markPaidTxSignature,
      });

      return NextResponse.json({
        message: "Claim processed successfully",
        claim: updatedClaim,
      });
    } catch (err: any) {
      console.error("Mark private transfer paid failed:", err);
      // The funds were transferred, but the on-chain mark paid failed.
      await updateOnChainClaim(claim.id, { status: "needs_sync" });
      const latestUnsettled = await findUnsettledTransfer(stream.id);
      if (latestUnsettled) {
        await updateTransferRecord(latestUnsettled.id, {
          status: "recovery_required",
          errorMessage:
            err instanceof Error
              ? err.message
              : "Treasury transfer succeeded but mark-paid failed",
        });
      }
      throw new Error("Treasury transfer succeeded, but marking claim paid on-chain failed. Please sync state.");
    }

  } catch (error: unknown) {
    console.error("Claim process error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to process claim";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 500);
  }
}
