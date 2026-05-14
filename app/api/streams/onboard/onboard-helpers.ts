import * as anchor from "@coral-xyz/anchor";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";

export const DELEGATED_ACCOUNT_OWNER = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
export const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);
export const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
export const MAGIC_VAULT = new PublicKey(
  "MagicVau1t999999999999999999999999999999999",
);
export const BASE_DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("devnet");
export const TEE_URL = "https://devnet-tee.magicblock.app";

const { AnchorProvider, Program } = anchor;

export function badRequest(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

export function toRateMicroUnits(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error("ratePerSecond must be a positive number");
  }

  return Math.round(ratePerSecond * 1_000_000);
}

function isRpcRateLimitError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("429") || message.includes("too many requests");
}

async function getLatestBlockhashWithRetry(connection: Connection) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (error: unknown) {
      lastError = error;
      if (!isRpcRateLimitError(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch recent blockhash");
}

export async function getBaseProgramForEmployer(employerPubkey: PublicKey) {
  const connection = new Connection(BASE_DEVNET_RPC, "confirmed");
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new Program(idl, provider);
  return { connection, provider, program };
}

export async function getTeeProgramForEmployer(
  employerPubkey: PublicKey,
  teeAuthToken: string,
) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new Program(idl, provider);
  return { connection, provider, program };
}

export async function serializeUnsignedTransaction(
  connection: Connection,
  feePayer: PublicKey,
  transaction: Transaction,
) {
  const latest = await getLatestBlockhashWithRetry(connection);
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = feePayer;
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}

export async function getAccountInfo(
  connection: Connection,
  address: PublicKey,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await connection.getAccountInfo(address, "confirmed");
    } catch (error: unknown) {
      lastError = error;
      if (!isRpcRateLimitError(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to load account info");
}

export function isOwnedByProgram(
  accountInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  return Boolean(accountInfo && accountInfo.owner.equals(programId));
}
