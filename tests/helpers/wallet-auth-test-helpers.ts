import nacl from "tweetnacl";
import { NextRequest } from "next/server.js";
import { Keypair } from "@solana/web3.js";

import { createSignedWalletRequestHeaders } from "../lib/wallet-request-auth.ts";

export function keypairSignMessageFactory(signer: Keypair) {
  return async (message: Uint8Array) =>
    nacl.sign.detached(message, signer.secretKey);
}

export async function makeAuthenticatedJsonRequest(args: {
  url: string;
  wallet: string;
  signer: Keypair;
  body: unknown;
  method?: string;
}) {
  const method = args.method ?? "POST";
  const bodyText = JSON.stringify(args.body);
  const authHeaders = await createSignedWalletRequestHeaders({
    wallet: args.wallet,
    method,
    path: args.url,
    body: bodyText,
    signBytes: keypairSignMessageFactory(args.signer),
  });
  authHeaders.set("Content-Type", "application/json");

  return new NextRequest(args.url, {
    method,
    headers: authHeaders,
    body: bodyText,
  });
}

export async function makeAuthenticatedGetRequest(args: {
  url: string;
  wallet: string;
  signer: Keypair;
  method?: "GET" | "DELETE";
  extraHeaders?: HeadersInit;
}) {
  const method = args.method ?? "GET";
  const authHeaders = await createSignedWalletRequestHeaders({
    wallet: args.wallet,
    method,
    path: args.url,
    signBytes: keypairSignMessageFactory(args.signer),
  });
  const headers = new Headers(args.extraHeaders);

  for (const [key, value] of authHeaders.entries()) {
    headers.set(key, value);
  }

  return new NextRequest(args.url, {
    method,
    headers,
  });
}
