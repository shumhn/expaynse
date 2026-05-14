import {
  Connection,
  PublicKey,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

// ── JWT expiry helpers ──
// TEE auth tokens are JWTs. If a cached token is expired or about to expire,
// the API silently returns the base balance instead of a 401, which causes the
// "private balance mirrors base" symptom.

/**
 * Decode a JWT payload without verifying the signature.
 * Returns null if the token is not a valid JWT.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // base64url → base64 → JSON
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns true if the token is a JWT that has expired or will expire within
 * the next `bufferSeconds` seconds (default 60).
 * Returns false for non-JWT strings so non-JWT tokens are always considered
 * valid (fail-open — let the API reject them if they're actually bad).
 */
export function isJwtExpired(token: string, bufferSeconds = 60): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return false; // not a JWT — treat as non-expired
  if (typeof payload.exp !== "number") return false; // no expiry claim
  const nowSeconds = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSeconds + bufferSeconds;
}

const BASE = "https://payments.magicblock.app/v1/spl";
const SWAP_BASE = "https://payments.magicblock.app/v1/swap";
const HEALTH_URL = "https://payments.magicblock.app/health";
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Standard base RPC for devnet flows
const BASE_DEVNET_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("devnet");
const devnetConnection = new Connection(BASE_DEVNET_RPC_URL, "confirmed");

// MagicBlock ephemeral rollup RPC
const EPHEMERAL_RPC = "https://devnet.magicblock.app";
const ephemeralConnection = new Connection(EPHEMERAL_RPC, "confirmed");

export type BalanceLocation = "base" | "ephemeral";

export interface PrivateTransferBalances {
  fromBalance?: BalanceLocation;
  toBalance?: BalanceLocation;
}

export interface PrivateTransferPrivacyConfig {
  minDelayMs?: number;
  maxDelayMs?: number;
  split?: number;
  memo?: string;
}

export interface PrivateTransferBuildRequest {
  from: string;
  to: string;
  amount?: number;
  amountMicro?: number;
  outputMint?: string;
  token?: string;
  balances?: PrivateTransferBalances;
  privacy?: PrivateTransferPrivacyConfig;
  clientRefId?: string;
}

export interface PrivateTransferBuildResponse {
  transactionBase64?: string;
  sendTo?: string;
  [key: string]: unknown;
}

export interface BalanceResponse {
  address: string;
  mint: string;
  ata: string;
  location: BalanceLocation;
  balance: string;
}

export interface MagicBlockHealthResponse {
  status: string;
  [key: string]: unknown;
}

export type SwapMode = "ExactIn" | "ExactOut";
export type SwapVisibility = "public" | "private";

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  swapMode?: SwapMode;
  dexes?: string;
  excludeDexes?: string;
  restrictIntermediateTokens?: boolean;
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
  platformFeeBps?: number;
  maxAccounts?: number;
  instructionVersion?: "V1" | "V2";
  dynamicSlippage?: boolean;
  forJitoBundle?: boolean;
  supportDynamicIntermediateTokens?: boolean;
}

export interface SwapQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: SwapMode;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<Record<string, unknown>>;
  contextSlot: number;
  timeTaken: number;
  [key: string]: unknown;
}

export interface PrivateSwapOptions {
  destination: string;
  minDelayMs: string;
  maxDelayMs: string;
  split: number;
  clientRefId?: string;
  validator?: string;
}

export interface BuildSwapRequest {
  userPublicKey: string;
  quoteResponse: SwapQuoteResponse;
  payer?: string;
  wrapAndUnwrapSol?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  trackingAccount?: string;
  prioritizationFeeLamports?: number | Record<string, unknown>;
  asLegacyTransaction?: boolean;
  destinationTokenAccount?: string;
  nativeDestinationAccount?: string;
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
  dynamicSlippage?: boolean;
  computeUnitPriceMicroLamports?: number;
  blockhashSlotsToExpiry?: number;
  positiveSlippage?: Record<string, unknown>;
  visibility?: SwapVisibility;
  privateOptions?: PrivateSwapOptions;
}

export interface BuildSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  privateTransfer?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── helpers ──

async function post(
  path: string,
  body: Record<string, unknown>,
  token?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PER API ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PER API ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function getAbsolute(url: string, token?: string) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PER API ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function postAbsolute(
  url: string,
  body: Record<string, unknown>,
  token?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PER API ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function checkHealth(): Promise<MagicBlockHealthResponse> {
  const res = await fetch(HEALTH_URL);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MagicBlock health failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MagicBlockHealthResponse;
}

function getConnection(sendTo: string): Connection {
  return sendTo === "ephemeral" ? ephemeralConnection : devnetConnection;
}

function getTransactionSignature(
  tx: Transaction | VersionedTransaction
): string | null {
  if (tx instanceof VersionedTransaction) {
    const first = tx.signatures[0];
    return first ? bs58.encode(Buffer.from(first)) : null;
  }

  const first = tx.signatures[0];
  return first?.signature ? bs58.encode(Buffer.from(first.signature)) : null;
}

function isAlreadyProcessedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already been processed") ||
    normalized.includes("this transaction has already been processed")
  );
}

function isWritableAccountVerificationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("transaction loads a writable account that cannot be written") ||
    normalized.includes("invalidwritableaccount") ||
    normalized.includes("invalid writable account")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const errWithCause = error as Error & { cause?: unknown };
    const nested =
      errWithCause.cause && errWithCause.cause !== error
        ? extractErrorMessage(errWithCause.cause)
        : "";
    return nested && nested !== error.message
      ? `${error.message}: ${nested}`
      : error.message;
  }
  if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
  }
  return String(error);
}

function isWalletUserRejected(error: unknown) {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("user rejected") ||
    message.includes("rejected the request") ||
    message.includes("user denied")
  );
}

async function enrichSendError(
  conn: Connection,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof SendTransactionError)) {
    return error;
  }

  try {
    const logs = await error.getLogs(conn);
    if (!logs || logs.length === 0) {
      return error;
    }
    const joined = logs.slice(-6).join(" | ");
    return new Error(`${error.message}. Program logs: ${joined}`);
  } catch {
    return error;
  }
}

async function refreshRecentBlockhash(
  conn: Connection,
  tx: Transaction | VersionedTransaction
) {
  const latest = await conn.getLatestBlockhash("confirmed");

  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = latest.blockhash;
    return tx;
  }

  tx.recentBlockhash = latest.blockhash;
  return tx;
}

async function assertSignatureSucceeded(conn: Connection, signature: string) {
  const status = (await conn.getSignatureStatuses([signature])).value[0];
  if (status?.err) {
    throw new Error(
      `Transaction ${signature} confirmed with error: ${JSON.stringify(
        status.err
      )}`
    );
  }
}

function getTxRecentBlockhash(tx: Transaction | VersionedTransaction): string {
  if (tx instanceof VersionedTransaction) {
    return tx.message.recentBlockhash;
  }
  return tx.recentBlockhash ?? "";
}

async function confirmAndAssertSignature(
  conn: Connection,
  signature: string,
  opts?: {
    blockhash?: string;
    lastValidBlockHeight?: number;
  },
) {
  try {
    if (opts?.blockhash && typeof opts.lastValidBlockHeight === "number") {
      await conn.confirmTransaction(
        {
          signature,
          blockhash: opts.blockhash,
          lastValidBlockHeight: opts.lastValidBlockHeight,
        },
        "confirmed",
      );
    } else {
      await conn.confirmTransaction(signature, "confirmed");
    }
  } catch (confirmError) {
    // Some RPCs return transient confirm errors even when the signature lands.
    // Fallback to polling signature status before failing the flow.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(1_000);
      const status = (await conn.getSignatureStatuses([signature])).value[0];
      if (status?.err) {
        throw new Error(
          `Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        await assertSignatureSucceeded(conn, signature);
        return;
      }
    }

    throw new Error(
      `Transaction ${signature} not confirmed: ${extractErrorMessage(confirmError)}`,
    );
  }

  await assertSignatureSucceeded(conn, signature);
}

// ── sign + send utility ──
//
// The API returns `sendTo` ("base" | "ephemeral") telling us which RPC to use.
// For ephemeral txs, always use `signTransaction` and surface the real signing
// or send error back to the caller.

export interface SignAndSendOpts {
  sendTo?: string; // "base" | "ephemeral" from API response
  rpcUrl?: string;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  publicKey?: PublicKey;
  retrySendCount?: number;
  retryDelayMs?: number;
}

export async function signAndSend(
  txBase64: string,
  signTransaction: (
    tx: Transaction | VersionedTransaction
  ) => Promise<Transaction | VersionedTransaction>,
  opts: SignAndSendOpts = {}
) {
  const buf = Buffer.from(txBase64, "base64");
  const conn = opts.rpcUrl
    ? new Connection(opts.rpcUrl, "confirmed")
    : getConnection(opts.sendTo || "base");
  const isEphemeral = opts.sendTo
    ? opts.sendTo === "ephemeral"
    : Boolean(opts.rpcUrl);

  // ── Ephemeral path ──
  if (isEphemeral) {
    let signed: Transaction | VersionedTransaction;
    try {
      try {
        const vtx = VersionedTransaction.deserialize(buf);
        await refreshRecentBlockhash(conn, vtx);
        signed = await signTransaction(vtx);
      } catch {
        const tx = Transaction.from(buf);
        await refreshRecentBlockhash(conn, tx);
        signed = await signTransaction(tx);
      }
    } catch (signTxErr) {
      if (isWalletUserRejected(signTxErr)) {
        throw new Error("Transaction signature was rejected in wallet.");
      }
      throw signTxErr;
    }

    const raw =
      signed instanceof VersionedTransaction
        ? signed.serialize()
        : signed.serialize();

    const blockhash = getTxRecentBlockhash(signed);
    const maxAttempts = Math.max(1, (opts.retrySendCount ?? 0) + 1);
    const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 0);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const latestAtSend = await conn.getLatestBlockhash("confirmed");
        const sig = await conn.sendRawTransaction(raw, {
          skipPreflight: true,
        });
        await confirmAndAssertSignature(conn, sig, {
          blockhash: blockhash || latestAtSend.blockhash,
          lastValidBlockHeight: latestAtSend.lastValidBlockHeight,
        });
        return sig;
      } catch (sendErr) {
        if (isAlreadyProcessedError(sendErr)) {
          const recoveredSig = getTransactionSignature(signed);
          if (recoveredSig) {
            await assertSignatureSucceeded(conn, recoveredSig);
            return recoveredSig;
          }
        }

        const shouldRetry =
          attempt < maxAttempts && isWritableAccountVerificationError(sendErr);
        if (!shouldRetry) {
          throw await enrichSendError(conn, sendErr);
        }

        await sleep(retryDelayMs);
      }
    }
  }

  // ── Standard base path ──
  let signed: Transaction | VersionedTransaction;
  try {
    const vtx = VersionedTransaction.deserialize(buf);
    await refreshRecentBlockhash(conn, vtx);
    signed = await signTransaction(vtx);
  } catch {
    const tx = Transaction.from(buf);
    await refreshRecentBlockhash(conn, tx);
    signed = await signTransaction(tx);
  }

  const maxAttempts = Math.max(2, (opts.retrySendCount ?? 0) + 2);
  const retryDelayMs = Math.max(300, opts.retryDelayMs ?? 600);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        await refreshRecentBlockhash(conn, signed);
      }

      const raw =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : signed.serialize();
      const blockhash = getTxRecentBlockhash(signed);
      const latestAtSend = await conn.getLatestBlockhash("confirmed");
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      await confirmAndAssertSignature(conn, sig, {
        blockhash: blockhash || latestAtSend.blockhash,
        lastValidBlockHeight: latestAtSend.lastValidBlockHeight,
      });
      return sig;
    } catch (error) {
      if (isAlreadyProcessedError(error)) {
        const recoveredSig = getTransactionSignature(signed);
        if (recoveredSig) {
          await assertSignatureSucceeded(conn, recoveredSig);
          return recoveredSig;
        }
      }

      const shouldRetry =
        attempt < maxAttempts && isWritableAccountVerificationError(error);
      if (!shouldRetry) {
        throw await enrichSendError(conn, error);
      }

      await sleep(retryDelayMs);
    }
  }

  throw new Error("Transaction send failed after retry attempts.");
}

// ── Deserialize helper ──

export function deserializeTx(
  base64: string
): Transaction | VersionedTransaction {
  const buf = Buffer.from(base64, "base64");
  try {
    return VersionedTransaction.deserialize(buf);
  } catch {
    return Transaction.from(buf);
  }
}

// ── Batch sign + send ──
// Signs all txs in ONE wallet popup via signAllTransactions, then sends in parallel.
// Returns an array of { index, sig?, error? } for each tx.

const BATCH_SIZE = 20; // max txs per signAllTransactions call

export interface BatchResult {
  index: number;
  sig?: string;
  error?: string;
}

export async function batchSignAndSend(
  txBases64: string[],
  signAllTransactions: (
    txs: (Transaction | VersionedTransaction)[]
  ) => Promise<(Transaction | VersionedTransaction)[]>,
  sendTo: string,
  onProgress?: (phase: string, current: number, total: number) => void
): Promise<BatchResult[]> {
  const conn = getConnection(sendTo);
  const results: BatchResult[] = [];

  // Process in batches of BATCH_SIZE
  for (
    let batchStart = 0;
    batchStart < txBases64.length;
    batchStart += BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, txBases64.length);
    const batchBase64 = txBases64.slice(batchStart, batchEnd);

    // Deserialize all txs in this batch
    const txs = batchBase64.map((b64) => deserializeTx(b64));

    // Sign all at once — ONE wallet popup
    onProgress?.("signing", batchStart + 1, txBases64.length);
    const signed = await signAllTransactions(txs);

    // Send all signed txs in parallel
    onProgress?.("sending", batchStart + 1, txBases64.length);
    const sendPromises = signed.map(async (tx, i) => {
      const globalIdx = batchStart + i;
      try {
        const raw =
          tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize();

        const sig = await conn.sendRawTransaction(raw, {
          skipPreflight: false,
        });
        onProgress?.("confirming", globalIdx + 1, txBases64.length);
        await confirmAndAssertSignature(conn, sig);
        return { index: globalIdx, sig };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { index: globalIdx, error: msg };
      }
    });

    const batchResults = await Promise.all(sendPromises);
    results.push(...batchResults);
  }

  return results;
}

// ── API functions ──

// Deposit from Solana into ephemeral rollup vault
export async function deposit(owner: string, amount: number, token?: string) {
  const res = await post(
    "/deposit",
    {
      owner,
      amount: Math.round(amount * 1_000_000), // USDC 6 decimals
      mint: DEVNET_USDC,
      cluster: "devnet",
      initIfMissing: true,
      initVaultIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
    },
    token
  );
  return res;
}

export async function getSwapQuote(
  params: SwapQuoteParams,
  token?: string,
): Promise<SwapQuoteResponse> {
  const search = new URLSearchParams();

  search.set("inputMint", params.inputMint);
  search.set("outputMint", params.outputMint);
  search.set("amount", params.amount);

  if (typeof params.slippageBps === "number") {
    search.set("slippageBps", String(params.slippageBps));
  }
  if (params.swapMode) {
    search.set("swapMode", params.swapMode);
  }
  if (params.dexes) {
    search.set("dexes", params.dexes);
  }
  if (params.excludeDexes) {
    search.set("excludeDexes", params.excludeDexes);
  }
  if (typeof params.restrictIntermediateTokens === "boolean") {
    search.set(
      "restrictIntermediateTokens",
      String(params.restrictIntermediateTokens),
    );
  }
  if (typeof params.onlyDirectRoutes === "boolean") {
    search.set("onlyDirectRoutes", String(params.onlyDirectRoutes));
  }
  if (typeof params.asLegacyTransaction === "boolean") {
    search.set("asLegacyTransaction", String(params.asLegacyTransaction));
  }
  if (typeof params.platformFeeBps === "number") {
    search.set("platformFeeBps", String(params.platformFeeBps));
  }
  if (typeof params.maxAccounts === "number") {
    search.set("maxAccounts", String(params.maxAccounts));
  }
  if (params.instructionVersion) {
    search.set("instructionVersion", params.instructionVersion);
  }
  if (typeof params.dynamicSlippage === "boolean") {
    search.set("dynamicSlippage", String(params.dynamicSlippage));
  }
  if (typeof params.forJitoBundle === "boolean") {
    search.set("forJitoBundle", String(params.forJitoBundle));
  }
  if (typeof params.supportDynamicIntermediateTokens === "boolean") {
    search.set(
      "supportDynamicIntermediateTokens",
      String(params.supportDynamicIntermediateTokens),
    );
  }

  return (await getAbsolute(
    `${SWAP_BASE}/quote?${search.toString()}`,
    token,
  )) as SwapQuoteResponse;
}

export async function buildSwap(
  input: BuildSwapRequest,
  token?: string,
): Promise<BuildSwapResponse> {
  const body: Record<string, unknown> = {
    userPublicKey: input.userPublicKey,
    quoteResponse: input.quoteResponse,
  };

  if (input.payer) body.payer = input.payer;
  if (typeof input.wrapAndUnwrapSol === "boolean") {
    body.wrapAndUnwrapSol = input.wrapAndUnwrapSol;
  }
  if (typeof input.useSharedAccounts === "boolean") {
    body.useSharedAccounts = input.useSharedAccounts;
  }
  if (input.feeAccount) body.feeAccount = input.feeAccount;
  if (input.trackingAccount) body.trackingAccount = input.trackingAccount;
  if (typeof input.prioritizationFeeLamports !== "undefined") {
    body.prioritizationFeeLamports = input.prioritizationFeeLamports;
  }
  if (typeof input.asLegacyTransaction === "boolean") {
    body.asLegacyTransaction = input.asLegacyTransaction;
  }
  if (input.destinationTokenAccount) {
    body.destinationTokenAccount = input.destinationTokenAccount;
  }
  if (input.nativeDestinationAccount) {
    body.nativeDestinationAccount = input.nativeDestinationAccount;
  }
  if (typeof input.dynamicComputeUnitLimit === "boolean") {
    body.dynamicComputeUnitLimit = input.dynamicComputeUnitLimit;
  }
  if (typeof input.skipUserAccountsRpcCalls === "boolean") {
    body.skipUserAccountsRpcCalls = input.skipUserAccountsRpcCalls;
  }
  if (typeof input.dynamicSlippage === "boolean") {
    body.dynamicSlippage = input.dynamicSlippage;
  }
  if (typeof input.computeUnitPriceMicroLamports === "number") {
    body.computeUnitPriceMicroLamports = input.computeUnitPriceMicroLamports;
  }
  if (typeof input.blockhashSlotsToExpiry === "number") {
    body.blockhashSlotsToExpiry = input.blockhashSlotsToExpiry;
  }
  if (input.positiveSlippage) {
    body.positiveSlippage = input.positiveSlippage;
  }
  if (input.visibility) {
    body.visibility = input.visibility;
  }
  if (input.visibility === "private" && input.privateOptions) {
    body.destination = input.privateOptions.destination;
    body.minDelayMs = input.privateOptions.minDelayMs;
    body.maxDelayMs = input.privateOptions.maxDelayMs;
    body.split = input.privateOptions.split;
    if (input.privateOptions.clientRefId) {
      body.clientRefId = input.privateOptions.clientRefId;
    }
    if (input.privateOptions.validator) {
      body.validator = input.privateOptions.validator;
    }
  }

  return (await postAbsolute(`${SWAP_BASE}/swap`, body, token)) as BuildSwapResponse;
}

// Private transfer — callers can choose whether funds move from base or ephemeral
// into a base or ephemeral destination.
export async function buildPrivateTransfer(
  input: PrivateTransferBuildRequest
): Promise<PrivateTransferBuildResponse> {
  const amountMicro =
    typeof input.amountMicro === "number"
      ? input.amountMicro
      : Math.round((input.amount ?? 0) * 1_000_000);

  if (!Number.isFinite(amountMicro) || amountMicro <= 0) {
    throw new Error("privateTransfer amount must be a positive number");
  }

  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    mint: input.outputMint || DEVNET_USDC,
    amount: Math.round(amountMicro),
    visibility: "private",
    fromBalance: input.balances?.fromBalance || "base",
    toBalance: input.balances?.toBalance || "ephemeral",
    cluster: "devnet",
    initIfMissing: true,
    initAtasIfMissing: true,
    initVaultIfMissing: true,
  };

  if (typeof input.privacy?.minDelayMs === "number") {
    body.minDelayMs = String(input.privacy.minDelayMs);
  }

  if (typeof input.privacy?.maxDelayMs === "number") {
    body.maxDelayMs = String(input.privacy.maxDelayMs);
  }

  if (typeof input.privacy?.split === "number") {
    body.split = input.privacy.split;
  }

  if (input.privacy?.memo?.trim()) {
    body.memo = input.privacy.memo.trim();
  }

  if (input.clientRefId?.trim()) {
    // MagicBlock API requires clientRefId to be a non-negative bigint string
    const raw = input.clientRefId.trim();
    body.clientRefId = /^\d+$/.test(raw) ? raw : "0";
  }

  const res = await post(
    "/transfer",
    body,
    input.token
  );
  return res as PrivateTransferBuildResponse;
}

export async function privateTransfer(
  from: string,
  to: string,
  amount: number,
  outputMint?: string,
  token?: string,
  balances?: PrivateTransferBalances,
  privacy?: PrivateTransferPrivacyConfig
) {
  return buildPrivateTransfer({
    from,
    to,
    amount,
    outputMint,
    token,
    balances,
    privacy,
  });
}

// Balance on base layer (regular Solana ATA)
export async function getBalance(
  address: string,
  token?: string,
  mint = DEVNET_USDC,
): Promise<BalanceResponse> {
  // /balance does not require auth — omit the header entirely when no token
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const res = await fetch(
    `${BASE}/balance?address=${address}&mint=${mint}&cluster=devnet`,
    { headers }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getBalance failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data as BalanceResponse;
}

// Balance on ephemeral rollup — requires a valid TEE auth token
export async function getPrivateBalance(
  address: string,
  token?: string
): Promise<BalanceResponse> {
  if (!token) {
    throw new Error(
      "[PER] getPrivateBalance requires a valid TEE auth token. " +
        "Call fetchTeeAuthToken(publicKey, signMessage) first and pass the result here."
    );
  }


  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(
    `${BASE}/private-balance?address=${address}&mint=${DEVNET_USDC}&cluster=devnet`,
    { headers }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getPrivateBalance failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as BalanceResponse;
  return data;
}

// Withdraw from ephemeral rollup back to Solana
export async function withdraw(owner: string, amount: number, token?: string) {
  const res = await post(
    "/withdraw",
    {
      owner,
      mint: DEVNET_USDC,
      amount: Math.round(amount * 1_000_000),
      cluster: "devnet",
      initAtasIfMissing: true,
      idempotent: true,
    },
    token
  );
  return res;
}

export async function initializeMint(payer: string, token?: string) {
  return post(
    "/initialize-mint",
    {
      payer,
      mint: DEVNET_USDC,
      cluster: "devnet",
    },
    token
  );
}

export async function isMintInitialized(token?: string) {
  const data = await get(
    `/is-mint-initialized?mint=${DEVNET_USDC}&cluster=devnet`,
    token
  );
  return data as {
    mint: string;
    validator: string;
    transferQueue: string;
    initialized: boolean;
  };
}

// Fetch auth token using the wallet signature
export async function fetchTeeAuthToken(
  publicKey: PublicKey,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<string> {
  const auth = await getAuthToken(
    "https://devnet-tee.magicblock.app",
    publicKey,
    signMessage
  );
  const token = auth.token;

  return token;
}
