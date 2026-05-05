import { NextRequest, NextResponse } from "next/server";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import {
  CompanyRouteAuthError,
  requireCompanyOwnerRequest,
} from "@/lib/server/company-route-auth";

export const runtime = "nodejs";

const BASE = "https://payments.magicblock.app/v1/spl";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEE_URL = "https://devnet-tee.magicblock.app";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await context.params;

  try {
    await requireCompanyOwnerRequest({
      request,
      companyId,
    });

    // Load the treasury keypair from the encrypted vault
    const treasuryKeypair = await loadCompanyKeypair({
      companyId,
      kind: "treasury",
    });

    // Generate a TEE auth token using the treasury's own keypair
    const treasuryPubkey = treasuryKeypair.publicKey;
    const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      // nacl.sign.detached equivalent using the keypair's secret key
      const nacl = await import("tweetnacl");
      return nacl.sign.detached(message, treasuryKeypair.secretKey);
    };

    const auth = await getAuthToken(TEE_URL, treasuryPubkey, signMessage);
    const teeToken = auth.token;

    // Fetch the private balance for the treasury address
    const res = await fetch(
      `${BASE}/private-balance?address=${treasuryPubkey.toBase58()}&mint=${DEVNET_USDC}&cluster=devnet`,
      {
        headers: { Authorization: `Bearer ${teeToken}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Balance fetch failed: ${text}` },
        { status: 502 }
      );
    }

    const balanceData = await res.json();

    return NextResponse.json({
      ok: true,
      balance: balanceData.balance ?? "0",
      location: balanceData.location ?? "ephemeral",
    });
  } catch (error) {
    if (error instanceof CompanyRouteAuthError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch treasury balance.",
      },
      { status: 500 }
    );
  }
}
