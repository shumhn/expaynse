import { NextRequest, NextResponse } from "next/server";
import { VersionedTransaction } from "@solana/web3.js";
import { buildPrivateTransfer, DEVNET_USDC } from "@/lib/magicblock-api";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import {
  CompanyRouteAuthError,
  requireCompanyOwnerRequest,
} from "@/lib/server/company-route-auth";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await context.params;

  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}");

    if (!body.amount || typeof body.amount !== "number") {
      return NextResponse.json({ ok: false, error: "Invalid amount" }, { status: 400 });
    }
    if (!body.destinationAddress) {
      return NextResponse.json({ ok: false, error: "Missing destinationAddress" }, { status: 400 });
    }

    await requireCompanyOwnerRequest({
      request,
      companyId,
      body: rawBody,
    });

    // Load the treasury keypair from the encrypted vault
    const treasuryKeypair = await loadCompanyKeypair({
      companyId,
      kind: "treasury",
    });

    const treasuryPubkey = treasuryKeypair.publicKey.toBase58();

    // Build the transfer from treasury's ephemeral vault to employer's base wallet
    const buildRes = await buildPrivateTransfer({
      from: treasuryPubkey,
      to: body.destinationAddress,
      amount: body.amount,
      outputMint: DEVNET_USDC,
      balances: {
        fromBalance: "ephemeral",
        toBalance: "base",
      },
    });

    if (!buildRes.transactionBase64 || !buildRes.sendTo) {
      throw new Error("Failed to build private transfer");
    }

    // Deserialize and sign the transaction with the treasury private key
    const buf = Buffer.from(buildRes.transactionBase64, "base64");
    const vtx = VersionedTransaction.deserialize(buf);
    
    // Sign with treasury keypair
    vtx.sign([treasuryKeypair]);

    // Send the signed transaction using the correct RPC
    const rpcUrl = buildRes.sendTo === "ephemeral" 
      ? (process.env.NEXT_PUBLIC_MAGICBLOCK_RPC_URL || "https://devnet.magicblock.app")
      : (process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com");
    
    const { Connection } = await import("@solana/web3.js");
    const conn = new Connection(rpcUrl, "confirmed");
    const signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });

    return NextResponse.json({
      ok: true,
      signature,
      amount: body.amount,
    });
  } catch (error) {
    if (error instanceof CompanyRouteAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.status },
      );
    }
    console.error("Treasury withdraw error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to withdraw from treasury.",
      },
      { status: 500 }
    );
  }
}
