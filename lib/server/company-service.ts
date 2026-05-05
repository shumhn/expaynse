import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { boolEnv } from "./company-env";
import {
  createCompanyRecord,
  findCompanyByEmployerWallet,
  findCompanyById,
} from "./company-store";
import { saveCompanyKeypair } from "./company-key-vault";
import type { Company, CreateCompanyInput, PublicCompanyResponse } from "./company-types";
import bs58 from "bs58";
import nacl from "tweetnacl";

// ── Zod schema ──

const createCompanySchema = z.object({
  name: z.string().min(2).max(80),
  employerWallet: z.string().min(32),
  message: z.string().optional(),
  signature: z.string().optional(),
});

// ── Wallet auth helpers ──

function expectedCreateCompanyMessage(args: {
  employerWallet: string;
  companyName: string;
}): string {
  return [
    "Create Expaynsee payroll company",
    `Company: ${args.companyName}`,
    `Employer: ${args.employerWallet}`,
  ].join("\n");
}

function verifyWalletSignature(args: {
  wallet: string;
  message: string;
  signature: string;
}): boolean {
  const publicKey = new PublicKey(args.wallet);
  const messageBytes = new TextEncoder().encode(args.message);
  const signatureBytes = bs58.decode(args.signature);

  return nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    publicKey.toBytes()
  );
}

// ── Helpers ──

function toPublicCompany(company: Company): PublicCompanyResponse {
  return {
    id: company.id,
    name: company.name,
    employerWallet: company.employerWallet,
    treasuryPubkey: company.treasuryPubkey,
    settlementPubkey: company.settlementPubkey,
    currency: company.currency,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

// ── Public API ──

export async function getCompanyForEmployer(employerWallet: string): Promise<PublicCompanyResponse | null> {
  const company = await findCompanyByEmployerWallet(employerWallet);
  return company ? toPublicCompany(company) : null;
}

export async function getCompany(companyId: string): Promise<PublicCompanyResponse | null> {
  const company = await findCompanyById(companyId);
  return company ? toPublicCompany(company) : null;
}

export async function createCompany(input: CreateCompanyInput): Promise<PublicCompanyResponse> {
  const parsed = createCompanySchema.parse(input);

  const employerWallet = new PublicKey(parsed.employerWallet).toBase58();

  // Idempotent: return existing company if already created
  const existing = await findCompanyByEmployerWallet(employerWallet);
  if (existing) {
    return toPublicCompany(existing);
  }

  // Optional wallet signature verification (production only)
  if (boolEnv("ENFORCE_WALLET_SIGNATURE", false)) {
    if (!parsed.message || !parsed.signature) {
      throw new Error("Wallet signature is required.");
    }

    const expected = expectedCreateCompanyMessage({
      employerWallet,
      companyName: parsed.name,
    });

    if (parsed.message !== expected) {
      throw new Error("Invalid signed message.");
    }

    const ok = verifyWalletSignature({
      wallet: employerWallet,
      message: parsed.message,
      signature: parsed.signature,
    });

    if (!ok) {
      throw new Error("Invalid wallet signature.");
    }
  }

  // Generate keypairs
  const treasury = Keypair.generate();
  const settlement = Keypair.generate();

  const now = new Date().toISOString();
  const companyId = crypto.randomUUID();

  const company: Company = {
    id: companyId,
    name: parsed.name.trim(),
    employerWallet,
    treasuryPubkey: treasury.publicKey.toBase58(),
    settlementPubkey: settlement.publicKey.toBase58(),
    currency: "USDC",
    createdAt: now,
    updatedAt: now,
  };

  // Encrypt and store keypairs
  await saveCompanyKeypair({
    companyId,
    kind: "treasury",
    keypair: treasury,
  });

  await saveCompanyKeypair({
    companyId,
    kind: "settlement",
    keypair: settlement,
  });

  // Store company record
  await createCompanyRecord(company);

  return toPublicCompany(company);
}
