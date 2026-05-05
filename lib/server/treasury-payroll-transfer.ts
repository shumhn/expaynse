import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  buildPrivateTransfer,
  DEVNET_USDC,
  type PrivateTransferPrivacyConfig,
} from "@/lib/magicblock-api";

// ── RPC URLs ─────────────────────────────────────────────────
// The base-layer RPC for sending normal Solana transactions
const BASE_RPC_URL =
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

// The Ephemeral Rollup RPC for sending ER-routed transactions
const ER_RPC_URL =
  process.env.ER_RPC_URL ||
  process.env.NEXT_PUBLIC_MAGICBLOCK_EPHEMERAL_RPC_URL ||
  "https://devnet.magicblock.app";

// ── Types ────────────────────────────────────────────────────

export type TreasuryTransferArgs = {
  treasuryKeypair: Keypair;
  employeeWallet: string;
  amountMicro: number;
  clientRefId: string;
  fromBalance?: "base" | "ephemeral";
  toBalance?: "base" | "ephemeral";
  privacy?: PrivateTransferPrivacyConfig;
};

export type TreasuryTransferResult = {
  signature: string;
  from: string;
  to: string;
  amountMicro: number;
  fromBalance: string;
  toBalance: string;
  sendTo: string;
};

// ── Helpers ──────────────────────────────────────────────────

function decodeBuiltTransaction(
  transactionBase64: string,
): Transaction | VersionedTransaction {
  const raw = Buffer.from(transactionBase64, "base64");
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function signTx(
  tx: Transaction | VersionedTransaction,
  signer: Keypair,
): Transaction | VersionedTransaction {
  if (tx instanceof VersionedTransaction) {
    tx.sign([signer]);
    return tx;
  }
  tx.partialSign(signer);
  return tx;
}

function resolveRpcUrl(sendTo: string): string {
  const normalized = sendTo.toLowerCase();
  if (
    normalized.includes("er") ||
    normalized.includes("ephemeral") ||
    normalized.includes("magic")
  ) {
    return ER_RPC_URL;
  }
  return BASE_RPC_URL;
}

// ── Main export ──────────────────────────────────────────────

/**
 * Signs and sends a payroll transfer from the Company Treasury keypair.
 *
 * This is the production replacement for the old flow where the employer
 * signed a transfer from their personal wallet in Phantom.
 *
 * 1. Calls MagicBlock Private Payments API to build the transfer tx
 * 2. Signs it with the treasury keypair (server-side)
 * 3. Sends the raw transaction to the correct RPC
 * 4. Confirms the transaction
 * 5. Returns the signature
 */
export async function sendPayrollFromCompanyTreasury(
  args: TreasuryTransferArgs,
): Promise<TreasuryTransferResult> {
  const envFromBalance = process.env.PAYROLL_TICK_FROM_BALANCE === "base" ? "base" : "ephemeral";
  const envToBalance = process.env.PAYROLL_TICK_TO_BALANCE === "base" ? "base" : "ephemeral";

  const fromBalance = args.fromBalance ?? envFromBalance;
  const toBalance = args.toBalance ?? envToBalance;

  // 1. Build the unsigned transfer via MagicBlock Private Payments API
  const transferBuild = await buildPrivateTransfer({
    from: args.treasuryKeypair.publicKey.toBase58(),
    to: args.employeeWallet,
    amountMicro: args.amountMicro,
    outputMint: DEVNET_USDC,
    balances: {
      fromBalance,
      toBalance,
    },
    privacy: args.privacy,
    clientRefId: args.clientRefId,
  });

  // The API may return the transaction under different keys
  const transactionBase64 =
    transferBuild.transactionBase64 ??
    (transferBuild as Record<string, unknown>).transaction ??
    (transferBuild as Record<string, unknown>).serializedTransaction;

  if (!transactionBase64 || typeof transactionBase64 !== "string") {
    throw new Error(
      `MagicBlock transfer response missing transactionBase64: ${JSON.stringify(
        transferBuild,
        null,
        2,
      )}`,
    );
  }

  // 2. Deserialize and sign with treasury keypair
  const tx = decodeBuiltTransaction(transactionBase64);
  signTx(tx, args.treasuryKeypair);

  // 3. Serialize and send to the correct RPC
  const rawTx =
    tx instanceof VersionedTransaction
      ? tx.serialize()
      : tx.serialize({ requireAllSignatures: true, verifySignatures: false });

  const sendTo = String(transferBuild.sendTo ?? "base").toLowerCase();
  const rpcUrl = resolveRpcUrl(sendTo);

  const connection = new Connection(rpcUrl, "confirmed");
  const signature = await connection.sendRawTransaction(
    rawTx instanceof Uint8Array ? Buffer.from(rawTx) : rawTx,
    {
      skipPreflight: false,
      maxRetries: 5,
    },
  );

  // 4. Confirm the transaction
  await connection.confirmTransaction(signature, "confirmed");

  return {
    signature,
    from: args.treasuryKeypair.publicKey.toBase58(),
    to: args.employeeWallet,
    amountMicro: args.amountMicro,
    fromBalance,
    toBalance,
    sendTo,
  };
}
