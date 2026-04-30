"use client";

import {
  createSignedWalletRequestHeaders,
  EXPAYNSE_SESSION_HEADER,
} from "@/lib/wallet-request-auth";

const SESSION_STORAGE_PREFIX = "expaynse-wallet-session";
const SESSION_EXPIRY_LEEWAY_MS = 60 * 1000;
const walletSessionCache = new Map<
  string,
  { sessionToken: string; expiresAt: number }
>();
const walletSessionCreationCache = new Map<
  string,
  Promise<{ sessionToken: string; expiresAt: number }>
>();

function getSessionStorageKey(wallet: string) {
  return `${SESSION_STORAGE_PREFIX}:${wallet}`;
}

function loadCachedWalletSession(wallet: string) {
  const inMemory = walletSessionCache.get(wallet);
  if (inMemory && inMemory.expiresAt > Date.now() + SESSION_EXPIRY_LEEWAY_MS) {
    return inMemory;
  }

  if (inMemory) {
    walletSessionCache.delete(wallet);
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getSessionStorageKey(wallet));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      sessionToken?: string;
      expiresAt?: number;
    };

    if (
      typeof parsed.sessionToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now() + SESSION_EXPIRY_LEEWAY_MS
    ) {
      window.sessionStorage.removeItem(getSessionStorageKey(wallet));
      return null;
    }

    walletSessionCache.set(wallet, {
      sessionToken: parsed.sessionToken,
      expiresAt: parsed.expiresAt,
    });

    return {
      sessionToken: parsed.sessionToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function persistWalletSession(
  wallet: string,
  session: { sessionToken: string; expiresAt: number },
) {
  walletSessionCache.set(wallet, session);

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getSessionStorageKey(wallet),
      JSON.stringify(session),
    );
  } catch {
    // no-op
  }
}

async function createWalletSession(input: {
  wallet: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}) {
  const bodyText = JSON.stringify({ wallet: input.wallet });
  const authHeaders = await createSignedWalletRequestHeaders({
    wallet: input.wallet,
    method: "POST",
    path: "/api/auth/session",
    body: bodyText,
    signBytes: input.signMessage,
  });

  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(authHeaders.entries()),
    },
    body: bodyText,
  });

  const json = (await response.json()) as {
    sessionToken?: string;
    expiresAt?: string;
    error?: string;
  };

  if (!response.ok || !json.sessionToken || !json.expiresAt) {
    throw new Error(json.error || "Failed to create wallet session");
  }

  const expiresAt = Date.parse(json.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Wallet session expiry is invalid");
  }

  const session = {
    sessionToken: json.sessionToken,
    expiresAt,
  };
  persistWalletSession(input.wallet, session);
  return session;
}

async function createWalletSessionDeduped(input: {
  wallet: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}) {
  const existing = walletSessionCreationCache.get(input.wallet);
  if (existing) {
    return existing;
  }

  const pending = createWalletSession(input).finally(() => {
    walletSessionCreationCache.delete(input.wallet);
  });

  walletSessionCreationCache.set(input.wallet, pending);
  return pending;
}

async function extractAuthErrorMessage(response: Response) {
  try {
    const cloned = response.clone();
    const json = (await cloned.json()) as { error?: string };
    return typeof json.error === "string" ? json.error : "";
  } catch {
    return "";
  }
}

function looksLikeAuthFailure(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("authorization") ||
    normalized.includes("session") ||
    normalized.includes("signature") ||
    normalized.includes("expired") ||
    normalized.includes("timestamp") ||
    normalized.includes("wallet")
  );
}

async function getOrCreateWalletSession(input: {
  wallet: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}) {
  const cached = loadCachedWalletSession(input.wallet);
  if (cached) {
    return cached;
  }

  return createWalletSessionDeduped(input);
}

export async function walletAuthenticatedFetch(input: {
  wallet: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  path: string;
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
}) {
  const method = input.method ?? "GET";
  const bodyText =
    input.body === undefined ? undefined : JSON.stringify(input.body);
  const headers = new Headers(input.headers);
  const session = await getOrCreateWalletSession({
    wallet: input.wallet,
    signMessage: input.signMessage,
  });
  headers.set(EXPAYNSE_SESSION_HEADER, session.sessionToken);

  if (bodyText && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response = await fetch(input.path, {
    method,
    headers,
    body: bodyText,
  });

  const authErrorMessage = await extractAuthErrorMessage(response);
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && looksLikeAuthFailure(authErrorMessage))
  ) {
    const renewed = await createWalletSessionDeduped({
      wallet: input.wallet,
      signMessage: input.signMessage,
    });
    headers.set(EXPAYNSE_SESSION_HEADER, renewed.sessionToken);
    response = await fetch(input.path, {
      method,
      headers,
      body: bodyText,
    });
  }

  return response;
}
