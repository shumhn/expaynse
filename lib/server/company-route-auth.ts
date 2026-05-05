import { PublicKey } from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { findCompanyByEmployerWallet, findCompanyById } from "./company-store";
import { verifyAuthorizedWalletRequest } from "@/lib/wallet-request-auth";
import type { Company } from "./company-types";

export class CompanyRouteAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeWallet(wallet: string) {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new CompanyRouteAuthError(400, "Invalid wallet address");
  }
}

async function verifyWalletBoundRequest(args: {
  request: NextRequest;
  expectedWallet: string;
  body?: string;
}) {
  await verifyAuthorizedWalletRequest({
    headers: args.request.headers,
    expectedWallet: args.expectedWallet,
    method: args.request.method,
    path: `${args.request.nextUrl.pathname}${args.request.nextUrl.search}`,
    body: args.body,
  });
}

export async function requireEmployerWalletRequest(args: {
  request: NextRequest;
  employerWallet: string;
  body?: string;
}) {
  const normalizedWallet = normalizeWallet(args.employerWallet);

  await verifyWalletBoundRequest({
    request: args.request,
    expectedWallet: normalizedWallet,
    body: args.body,
  });

  return normalizedWallet;
}

export async function requireEmployerCompanyRequest(args: {
  request: NextRequest;
  employerWallet: string;
  body?: string;
}): Promise<{ wallet: string; company: Company | null }> {
  const wallet = await requireEmployerWalletRequest({
    request: args.request,
    employerWallet: args.employerWallet,
    body: args.body,
  });

  const company = await findCompanyByEmployerWallet(wallet);
  return { wallet, company };
}

export async function requireCompanyOwnerRequest(args: {
  request: NextRequest;
  companyId: string;
  body?: string;
}): Promise<{ wallet: string; company: Company }> {
  const wallet = args.request.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) {
    throw new CompanyRouteAuthError(401, "Missing wallet query parameter");
  }

  const normalizedWallet = normalizeWallet(wallet);
  await verifyWalletBoundRequest({
    request: args.request,
    expectedWallet: normalizedWallet,
    body: args.body,
  });

  const company = await findCompanyById(args.companyId);
  if (!company) {
    throw new CompanyRouteAuthError(404, "Company not found.");
  }

  if (company.employerWallet !== normalizedWallet) {
    throw new CompanyRouteAuthError(
      403,
      "Wallet is not authorized for this company.",
    );
  }

  return {
    wallet: normalizedWallet,
    company,
  };
}
