import { Keypair, VersionedTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildPrivateTransfer, signAndSend } from "@/lib/magicblock-api";
import {
  markEmployeePrivateRecipientInitialized,
  updateEmployeePrivateRecipientInitState,
} from "@/lib/server/payroll-store";

export function getSponsorKeypair(): Keypair | null {
  const pkStr = process.env.SPONSOR_PRIVATE_KEY;
  if (!pkStr) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(pkStr));
  } catch (error) {
    console.error("Failed to decode SPONSOR_PRIVATE_KEY", error);
    return null;
  }
}

export async function sponsorInitializeEmployeeVault(employeeWallet: string) {
  const attemptedAt = new Date().toISOString();
  await updateEmployeePrivateRecipientInitState({
    employeeWallet,
    status: "processing",
    timestamp: attemptedAt,
    error: null,
  });

  const sponsor = getSponsorKeypair();
  if (!sponsor) {
    console.warn("No Sponsor Keypair found. Employee vault must be initialized manually.");
    await updateEmployeePrivateRecipientInitState({
      employeeWallet,
      status: "failed",
      timestamp: attemptedAt,
      error: "Sponsor wallet is not configured. Employee must self-initialize.",
    });
    return false;
  }

  try {
    // Build transfer of 1 micro-USDC (0.000001) from Sponsor (Base) to Employee (Ephemeral)
    const build = await buildPrivateTransfer({
      from: sponsor.publicKey.toBase58(),
      to: employeeWallet,
      amountMicro: 1, // Minimum allowed
      balances: { fromBalance: "base", toBalance: "ephemeral" }
    });

    if (!build.transactionBase64) {
      throw new Error("Failed to build sponsor initialization transaction");
    }

    // Define server-side signing function
    const signTransaction = async (tx: Transaction | VersionedTransaction) => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([sponsor]);
      } else {
        tx.sign(sponsor);
      }
      return tx;
    };

    // Sign and send via MagicBlock API
    const signature = await signAndSend(build.transactionBase64, signTransaction, {
      sendTo: build.sendTo === "ephemeral" || build.sendTo === "base" ? build.sendTo : "base",
    });

    // Mark as initialized in DB
    await markEmployeePrivateRecipientInitialized(
      employeeWallet,
      new Date().toISOString(),
      signature,
    );

    console.log(`Successfully initialized vault for ${employeeWallet} via Sponsor`);
    return true;
  } catch (error) {
    console.error(`Sponsor failed to initialize vault for ${employeeWallet}:`, error);
    await updateEmployeePrivateRecipientInitState({
      employeeWallet,
      status: "failed",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Sponsor initialization failed",
    });
    return false;
  }
}
