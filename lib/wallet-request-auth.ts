import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

export const EXPAYNSE_AUTH_WALLET_HEADER = "x-expaynse-wallet";
export const EXPAYNSE_AUTH_TIMESTAMP_HEADER = "x-expaynse-timestamp";
export const EXPAYNSE_AUTH_SIGNATURE_HEADER = "x-expaynse-signature";
export const EXPAYNSE_SESSION_HEADER = "x-expaynse-session";

const AUTH_MESSAGE_PREFIX = "Expaynse Request Authorization";
const AUTH_VERSION = "1";
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function getSubtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API is unavailable");
  }
  return subtle;
}

function normalizePath(path: string) {
  try {
    const url = new URL(path, "http://localhost");
    return `${url.pathname}${url.search}`;
  } catch {
    return path;
  }
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await getSubtleCrypto().digest("SHA-256", encoded as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function buildWalletRequestAuthMessage(input: {
  wallet: string;
  method: string;
  path: string;
  timestamp: string;
  body?: string;
}) {
  const bodySha256 = await sha256Hex(input.body ?? "");
  return [
    AUTH_MESSAGE_PREFIX,
    `version:${AUTH_VERSION}`,
    `wallet:${input.wallet}`,
    `method:${input.method.toUpperCase()}`,
    `path:${normalizePath(input.path)}`,
    `timestamp:${input.timestamp}`,
    `bodySha256:${bodySha256}`,
  ].join("\n");
}

export async function createSignedWalletRequestHeaders(input: {
  wallet: string;
  method: string;
  path: string;
  body?: string;
  signBytes: (message: Uint8Array) => Promise<Uint8Array>;
}) {
  const timestamp = new Date().toISOString();
  const message = await buildWalletRequestAuthMessage({
    wallet: input.wallet,
    method: input.method,
    path: input.path,
    timestamp,
    body: input.body,
  });
  const signature = await input.signBytes(new TextEncoder().encode(message));

  const headers = new Headers();
  headers.set(EXPAYNSE_AUTH_WALLET_HEADER, input.wallet);
  headers.set(EXPAYNSE_AUTH_TIMESTAMP_HEADER, timestamp);
  headers.set(EXPAYNSE_AUTH_SIGNATURE_HEADER, bs58.encode(signature));
  return headers;
}

export async function verifySignedWalletRequest(input: {
  headers: Headers;
  expectedWallet: string;
  method: string;
  path: string;
  body?: string;
  maxAgeMs?: number;
}) {
  const wallet = input.headers.get(EXPAYNSE_AUTH_WALLET_HEADER)?.trim() ?? "";
  const timestamp =
    input.headers.get(EXPAYNSE_AUTH_TIMESTAMP_HEADER)?.trim() ?? "";
  const signature =
    input.headers.get(EXPAYNSE_AUTH_SIGNATURE_HEADER)?.trim() ?? "";

  if (!wallet || !timestamp || !signature) {
    throw new Error("Missing request authorization headers");
  }

  if (wallet !== input.expectedWallet) {
    throw new Error("Wallet authorization does not match the requested wallet");
  }

  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    throw new Error("Invalid request authorization timestamp");
  }

  const ageMs = Date.now() - parsedTimestamp;
  if (ageMs > (input.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    throw new Error("Request authorization has expired");
  }

  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    throw new Error("Request authorization timestamp is too far in the future");
  }

  const message = await buildWalletRequestAuthMessage({
    wallet,
    method: input.method,
    path: input.path,
    timestamp,
    body: input.body,
  });

  let publicKey: PublicKey;
  let signatureBytes: Uint8Array;

  try {
    publicKey = new PublicKey(wallet);
    signatureBytes = bs58.decode(signature);
  } catch {
    throw new Error("Invalid request authorization payload");
  }

  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    signatureBytes,
    publicKey.toBytes(),
  );

  if (!verified) {
    throw new Error("Request authorization signature is invalid");
  }

  return {
    wallet,
    timestamp,
  };
}

export async function verifyAuthorizedWalletRequest(input: {
  headers: Headers;
  expectedWallet: string;
  method: string;
  path: string;
  body?: string;
  maxAgeMs?: number;
}) {
  const sessionToken = input.headers.get(EXPAYNSE_SESSION_HEADER)?.trim();

  if (sessionToken) {
    const { verifyWalletSessionToken } = await import(
      "@/lib/server/wallet-session"
    );

    return verifyWalletSessionToken(sessionToken, input.expectedWallet);
  }

  return verifySignedWalletRequest(input);
}

export function isWalletAuthorizationError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes("authorization") ||
    message.includes("session") ||
    message.includes("signature") ||
    message.includes("expired") ||
    message.includes("timestamp") ||
    message.includes("missing request authorization headers") ||
    message.includes("wallet session") ||
    message.includes("does not match the requested wallet")
  );
}
