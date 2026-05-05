import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { Collection } from "mongodb";
import { requiredEnv } from "./company-env";
import { getMongoDb } from "./mongodb";
import type { EncryptedCompanyKey } from "./company-types";

// ── MongoDB collection ──

async function keysCollection(): Promise<Collection<EncryptedCompanyKey>> {
  const db = await getMongoDb();
  return db.collection<EncryptedCompanyKey>("company_keys");
}

// ── Encryption helpers ──

function encryptionKey(): Buffer {
  const secret = requiredEnv("COMPANY_KEY_ENCRYPTION_SECRET");

  if (secret.length < 32) {
    throw new Error("COMPANY_KEY_ENCRYPTION_SECRET must be at least 32 characters.");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecretKey(secretKey: Uint8Array): {
  encryptedSecretKeyBase64: string;
  ivBase64: string;
  authTagBase64: string;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(secretKey)),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    encryptedSecretKeyBase64: encrypted.toString("base64"),
    ivBase64: iv.toString("base64"),
    authTagBase64: authTag.toString("base64"),
  };
}

function decryptSecretKey(record: EncryptedCompanyKey): Uint8Array {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(record.ivBase64, "base64")
  );

  decipher.setAuthTag(Buffer.from(record.authTagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.encryptedSecretKeyBase64, "base64")),
    decipher.final(),
  ]);

  return Uint8Array.from(decrypted);
}

// ── Public API ──

export async function saveCompanyKeypair(args: {
  companyId: string;
  kind: "treasury" | "settlement";
  keypair: Keypair;
}): Promise<EncryptedCompanyKey> {
  const collection = await keysCollection();

  const existing = await collection.findOne({
    companyId: args.companyId,
    kind: args.kind,
  });

  if (existing) {
    throw new Error(`Keypair already exists for company=${args.companyId}, kind=${args.kind}`);
  }

  const encrypted = encryptSecretKey(args.keypair.secretKey);

  const record: EncryptedCompanyKey = {
    id: crypto.randomUUID(),
    companyId: args.companyId,
    kind: args.kind,
    pubkey: args.keypair.publicKey.toBase58(),
    ...encrypted,
    createdAt: new Date().toISOString(),
  };

  await collection.insertOne(record);

  return record;
}

export async function loadCompanyKeypair(args: {
  companyId: string;
  kind: "treasury" | "settlement";
}): Promise<Keypair> {
  const collection = await keysCollection();

  const record = await collection.findOne({
    companyId: args.companyId,
    kind: args.kind,
  });

  if (!record) {
    throw new Error(`Missing ${args.kind} keypair for company ${args.companyId}`);
  }

  return Keypair.fromSecretKey(decryptSecretKey(record));
}

export async function getCompanyKeyPublicInfo(args: {
  companyId: string;
  kind: "treasury" | "settlement";
}): Promise<Pick<EncryptedCompanyKey, "companyId" | "kind" | "pubkey" | "createdAt"> | null> {
  const collection = await keysCollection();

  const record = await collection.findOne({
    companyId: args.companyId,
    kind: args.kind,
  });

  if (!record) return null;

  return {
    companyId: record.companyId,
    kind: record.kind,
    pubkey: record.pubkey,
    createdAt: record.createdAt,
  };
}
