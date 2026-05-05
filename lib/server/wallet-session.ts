import { createHmac, timingSafeEqual } from "crypto";

function getSessionSecret() {
  const secret =
    process.env.EXPAYNSE_SESSION_SECRET ||
    process.env.EXPENSEE_SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET;

  if (!secret) {
    throw new Error(
      "Missing EXPAYNSE_SESSION_SECRET (or NEXTAUTH_SECRET) environment variable",
    );
  }

  return secret;
}

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type WalletSessionPayload = {
  wallet: string;
  exp: number;
};

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  return createHmac("sha256", getSessionSecret())
    .update(value)
    .digest("base64url");
}

export function createWalletSessionToken(wallet: string) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const payload: WalletSessionPayload = {
    wallet,
    exp: expiresAt,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);

  return {
    sessionToken: `${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function verifyWalletSessionToken(
  sessionToken: string,
  expectedWallet: string,
) {
  const [encodedPayload, providedSignature] = sessionToken.split(".");

  if (!encodedPayload || !providedSignature) {
    throw new Error("Invalid wallet session token");
  }

  const expectedSignature = sign(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error("Wallet session signature is invalid");
  }

  const payload = JSON.parse(
    base64UrlDecode(encodedPayload),
  ) as WalletSessionPayload;

  if (payload.wallet !== expectedWallet) {
    throw new Error("Wallet session does not match the requested wallet");
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
    throw new Error("Wallet session has expired");
  }

  return {
    wallet: payload.wallet,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}
