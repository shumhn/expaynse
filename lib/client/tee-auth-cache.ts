"use client";

import { isJwtExpired } from "@/lib/magicblock-api";

const TEE_TOKEN_STORAGE_PREFIX = "expaynse-tee-token";

type CachedTeeToken = {
  token: string;
};

const teeTokenCache = new Map<string, CachedTeeToken>();
const teeTokenPromiseCache = new Map<string, Promise<string>>();

function getStorageKey(wallet: string) {
  return `${TEE_TOKEN_STORAGE_PREFIX}:${wallet}`;
}

export function loadCachedTeeToken(wallet: string) {
  const inMemory = teeTokenCache.get(wallet);
  if (inMemory && !isJwtExpired(inMemory.token)) {
    return inMemory.token;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getStorageKey(wallet));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      token?: string;
    };

    if (typeof parsed.token !== "string" || isJwtExpired(parsed.token)) {
      window.sessionStorage.removeItem(getStorageKey(wallet));
      return null;
    }

    teeTokenCache.set(wallet, { token: parsed.token });
    return parsed.token;
  } catch {
    return null;
  }
}

export function persistTeeToken(wallet: string, token: string) {
  teeTokenCache.set(wallet, { token });

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getStorageKey(wallet),
      JSON.stringify({ token }),
    );
  } catch {
    // no-op
  }
}

export function clearCachedTeeToken(wallet: string) {
  teeTokenCache.delete(wallet);
  teeTokenPromiseCache.delete(wallet);

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(getStorageKey(wallet));
  } catch {
    // no-op
  }
}

export async function getOrCreateCachedTeeToken(
  wallet: string,
  createToken: () => Promise<string>,
) {
  const cached = loadCachedTeeToken(wallet);
  if (cached) {
    return cached;
  }

  const existing = teeTokenPromiseCache.get(wallet);
  if (existing) {
    return existing;
  }

  const pending = createToken()
    .then((token) => {
      persistTeeToken(wallet, token);
      return token;
    })
    .finally(() => {
      teeTokenPromiseCache.delete(wallet);
    });

  teeTokenPromiseCache.set(wallet, pending);
  return pending;
}
