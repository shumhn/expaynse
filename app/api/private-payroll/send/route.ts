import { NextRequest, NextResponse } from "next/server";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

import { DEVNET_USDC } from "@/lib/magicblock-api";
import { requireEmployerCompanyRequest } from "@/lib/server/company-route-auth";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";
import { savePayrollRun } from "@/lib/server/history-store";
import { sendPayrollFromCompanyTreasury } from "@/lib/server/treasury-payroll-transfer";

export const runtime = "nodejs";

const BASE = "https://payments.magicblock.app/v1/spl";
const TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL ||
  "https://devnet-tee.magicblock.app";

type SendPrivatePayrollBody = {
  employerWallet?: string;
  recipients?: Array<{
    employeeId?: string;
    name?: string;
    address?: string;
    amount?: number;
  }>;
};

function badRequest(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const body = JSON.parse(rawBody || "{}") as SendPrivatePayrollBody;
  const employerWallet = body.employerWallet?.trim();

  if (!employerWallet) {
    return badRequest("employerWallet is required");
  }

  const recipients = Array.isArray(body.recipients)
    ? body.recipients
        .map((recipient) => ({
          employeeId: recipient.employeeId?.trim() || undefined,
          name: recipient.name?.trim() || undefined,
          address: recipient.address?.trim() || "",
          amount: Number(recipient.amount ?? 0),
        }))
        .filter(
          (recipient) =>
            recipient.address.length >= 32 &&
            Number.isFinite(recipient.amount) &&
            recipient.amount > 0,
        )
    : [];

  if (recipients.length === 0) {
    return badRequest("At least one valid recipient is required");
  }

  const { company } = await requireEmployerCompanyRequest({
    request,
    employerWallet,
    body: rawBody,
  });

  if (!company) {
    return badRequest("Company not found for employer", 404);
  }

  const treasuryKeypair = await loadCompanyKeypair({
    companyId: company.id,
    kind: "treasury",
  });

  const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
    const nacl = await import("tweetnacl");
    return nacl.sign.detached(message, treasuryKeypair.secretKey);
  };

  const auth = await getAuthToken(TEE_URL, treasuryKeypair.publicKey, signMessage);
  const teeToken = auth.token;

  const balanceRes = await fetch(
    `${BASE}/private-balance?address=${treasuryKeypair.publicKey.toBase58()}&mint=${DEVNET_USDC}&cluster=devnet`,
    {
      headers: {
        Authorization: `Bearer ${teeToken}`,
      },
    },
  );

  if (!balanceRes.ok) {
    const text = await balanceRes.text();
    return badRequest(`Treasury balance fetch failed: ${text}`, 502);
  }

  const balanceData = (await balanceRes.json()) as { balance?: string };
  const treasuryPrivateBalanceMicro = parseInt(balanceData.balance ?? "0", 10);
  const totalAmountMicro = recipients.reduce(
    (sum, recipient) => sum + Math.round(recipient.amount * 1_000_000),
    0,
  );

  if (treasuryPrivateBalanceMicro < totalAmountMicro) {
    return NextResponse.json(
      {
        ok: false,
        error: "Treasury private balance is too low for this payroll run.",
        treasuryPrivateBalanceMicro,
        totalAmountMicro,
        missingAmountMicro: totalAmountMicro - treasuryPrivateBalanceMicro,
      },
      { status: 409 },
    );
  }

  const transferResults = [];
  for (const recipient of recipients) {
    const transfer = await sendPayrollFromCompanyTreasury({
      treasuryKeypair,
      employeeWallet: recipient.address,
      amountMicro: Math.round(recipient.amount * 1_000_000),
      clientRefId: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
      fromBalance: "ephemeral",
      toBalance: "ephemeral",
    });

    transferResults.push({
      employeeId: recipient.employeeId,
      name: recipient.name,
      address: recipient.address,
      amount: recipient.amount,
      signature: transfer.signature,
      sendTo: transfer.sendTo,
    });
  }

  const payrollRun = await savePayrollRun({
    wallet: employerWallet,
    mode: "private_payroll",
    totalAmount: totalAmountMicro / 1_000_000,
    employeeCount: recipients.length,
    employeeIds: recipients
      .map((recipient) => recipient.employeeId)
      .filter((value): value is string => Boolean(value)),
    employeeNames: recipients
      .map((recipient) => recipient.name)
      .filter((value): value is string => Boolean(value)),
    recipientAddresses: recipients.map((recipient) => recipient.address),
    transferSig: transferResults[0]?.signature,
    status: "success",
    privacyConfig: {
      visibility: "private",
      fromBalance: "ephemeral",
      toBalance: "ephemeral",
    },
    providerMeta: {
      provider: "magicblock",
      action: "employee-private-transfer",
      sendTo: transferResults[0]?.sendTo,
    },
  });

  return NextResponse.json({
    ok: true,
    companyId: company.id,
    treasuryPubkey: company.treasuryPubkey,
    treasuryPrivateBalanceMicro,
    totalAmountMicro,
    transferResults,
    payrollRun,
  });
}
