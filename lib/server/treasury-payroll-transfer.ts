import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  buildPrivateTransfer,
  DEVNET_USDC,
  signAndSend,
  type PrivateTransferPrivacyConfig,
} from "@/lib/magicblock-api";

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

const TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL ||
  "https://devnet-tee.magicblock.app";

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
  const naclModule = await import("tweetnacl");
  const nacl = naclModule.default ?? naclModule;
  const auth = await getAuthToken(
    TEE_URL,
    args.treasuryKeypair.publicKey,
    async (message) => nacl.sign.detached(message, args.treasuryKeypair.secretKey),
  );

  // 1. Build the unsigned transfer via MagicBlock Private Payments API
  const transferBuild = await buildPrivateTransfer({
    from: args.treasuryKeypair.publicKey.toBase58(),
    to: args.employeeWallet,
    amountMicro: args.amountMicro,
    outputMint: DEVNET_USDC,
    token: auth.token,
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

  const sendTo = String(transferBuild.sendTo ?? "base").toLowerCase();

  // Reuse the app's resilient signing/sending path so server-side treasury
  // payouts get the same blockhash refresh and transient ER retry handling as
  // wallet-submitted app transactions.
  const signature = await signAndSend(
    transactionBase64,
    async (tx: Transaction | VersionedTransaction) => {
      return signTx(tx, args.treasuryKeypair);
    },
    {
      sendTo,
      retrySendCount: 3,
      retryDelayMs: 1_000,
    },
  );

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
