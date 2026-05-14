import { Keypair, VersionedTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildPrivateTransfer, signAndSend } from "@/lib/magicblock-api";
import {
  markEmployeePrivateRecipientInitialized,
  updateEmployeePrivateRecipientInitState,
} from "@/lib/server/payroll-store";
import { findCompanyByEmployerWallet } from "@/lib/server/company-store";
import { loadCompanyKeypair } from "@/lib/server/company-key-vault";

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

async function resolveAutoInitKeypair(employerWallet?: string) {
  const sponsor = getSponsorKeypair();
  if (sponsor) {
    return {
      signer: sponsor,
      source: "sponsor" as const,
      label: "system sponsor wallet",
    };
  }

  if (!employerWallet?.trim()) {
    return null;
  }

  const company = await findCompanyByEmployerWallet(employerWallet.trim());
  if (!company) {
    return null;
  }

  try {
    const treasury = await loadCompanyKeypair({
      companyId: company.id,
      kind: "treasury",
    });
    return {
      signer: treasury,
      source: "company_treasury" as const,
      label: "company treasury wallet",
    };
  } catch (error) {
    console.warn(
      `Failed to load treasury keypair for company ${company.id}:`,
      error,
    );
    return null;
  }
}

function normalizeAutoInitError(error: unknown, signerLabel: string) {
  const message =
    error instanceof Error ? error.message : "Sponsor initialization failed";

  if (
    message.includes(
      "Attempt to debit an account but found no record of a prior credit",
    ) ||
    message.toLowerCase().includes("prior credit")
  ) {
    return `${signerLabel} has no funded base USDC available for auto-init.`;
  }

  return message;
}

export async function sponsorInitializeEmployeeVault(
  employeeWallet: string,
  employerWallet?: string,
) {
  const attemptedAt = new Date().toISOString();
  await updateEmployeePrivateRecipientInitState({
    employeeWallet,
    status: "processing",
    timestamp: attemptedAt,
    error: null,
  });

  const autoInitSigner = await resolveAutoInitKeypair(employerWallet);
  if (!autoInitSigner) {
    console.warn(
      "No sponsor keypair or company treasury keypair found. Employee vault must be initialized manually.",
    );
    await updateEmployeePrivateRecipientInitState({
      employeeWallet,
      status: "failed",
      timestamp: attemptedAt,
      error:
        "Server auto-init is unavailable because no sponsor or treasury signer is configured.",
    });
    return false;
  }

  try {
    // Build transfer of 1 micro-USDC (0.000001) from the server-side auto-init signer
    // (sponsor if configured, otherwise company treasury) to the employee ephemeral balance.
    const build = await buildPrivateTransfer({
      from: autoInitSigner.signer.publicKey.toBase58(),
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
        tx.sign([autoInitSigner.signer]);
      } else {
        tx.sign(autoInitSigner.signer);
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

    return true;
  } catch (error) {
    const normalizedMessage = normalizeAutoInitError(
      error,
      autoInitSigner.label,
    );
    console.error(
      `${autoInitSigner.label} failed to initialize vault for ${employeeWallet}:`,
      error,
    );
    await updateEmployeePrivateRecipientInitState({
      employeeWallet,
      status: "failed",
      timestamp: new Date().toISOString(),
      error: normalizedMessage,
    });
    return false;
  }
}
