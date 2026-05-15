import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

import {
  buildPrivateTransfer,
  getBalance,
  getPrivateBalance,
  signAndSend,
} from "../../lib/magicblock-api.ts";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export function toUiAmount(amountMicro: bigint) {
  return Number(amountMicro) / 1_000_000;
}

export async function fundBaseUsdcIfNeeded(args: {
  connection: Connection;
  payer: Keypair;
  recipient: PublicKey;
  minAmountMicro: bigint;
  label: string;
}) {
  const recipientWallet = args.recipient.toBase58();
  const current = await getBalance(recipientWallet);
  const currentMicro = BigInt(current.balance);

  if (currentMicro >= args.minAmountMicro) {
    return currentMicro;
  }

  const mint = new PublicKey(DEVNET_USDC);
  const payerAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.payer,
    mint,
    args.payer.publicKey,
  );
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.payer,
    mint,
    args.recipient,
  );

  const deltaMicro = args.minAmountMicro - currentMicro;
  if (deltaMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${args.label} base USDC top-up exceeds safe integer range`,
    );
  }

  console.log(
    `Funding ${args.label} with ${toUiAmount(deltaMicro).toFixed(
      6,
    )} base USDC`,
  );

  const latest = await args.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: args.payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    createTransferInstruction(
      payerAta.address,
      recipientAta.address,
      args.payer.publicKey,
      Number(deltaMicro),
    ),
  );

  tx.sign(args.payer);

  const signature = await args.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  await args.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  console.log(`${args.label} base USDC top-up signature:`, signature);

  const next = await getBalance(recipientWallet);
  return BigInt(next.balance);
}

function keypairSignTransactionFactory(signer: Keypair) {
  return async (
    tx: Transaction | VersionedTransaction,
  ): Promise<Transaction | VersionedTransaction> => {
    if (tx instanceof VersionedTransaction) {
      tx.sign([signer]);
      return tx;
    }

    tx.partialSign(signer);
    return tx;
  };
}

export async function fundPrivateUsdcIfNeeded(args: {
  connection: Connection;
  payer: Keypair;
  ownerWallet: string;
  ownerTeeAuthToken: string;
  signer: Keypair;
  minAmountMicro: bigint;
  label: string;
}) {
  const current = await getPrivateBalance(args.ownerWallet, args.ownerTeeAuthToken);
  const currentMicro = BigInt(current.balance);

  console.log(`${args.label} private balance before settlement:`, {
    location: current.location,
    balance: current.balance,
  });

  if (currentMicro >= args.minAmountMicro) {
    return currentMicro;
  }

  const shortfallMicro = args.minAmountMicro - currentMicro;
  const topUpMicro = shortfallMicro + 100_000n;
  const topUpUiAmount = toUiAmount(topUpMicro);

  await fundBaseUsdcIfNeeded({
    connection: args.connection,
    payer: args.payer,
    recipient: args.signer.publicKey,
    minAmountMicro: topUpMicro,
    label: `${args.label}-signer`,
  });

  console.log(
    `Funding ${args.label} private balance with ${topUpUiAmount.toFixed(
      6,
    )} USDC for settlement transfer precondition`,
  );

  const transferBuild = await buildPrivateTransfer({
    from: args.signer.publicKey.toBase58(),
    to: args.ownerWallet,
    amount: topUpUiAmount,
    outputMint: DEVNET_USDC,
    balances: {
      fromBalance: "base",
      toBalance: "ephemeral",
    },
  });
  if (!transferBuild.transactionBase64) {
    throw new Error(
      `${args.label} private top-up transfer did not return a transaction`,
    );
  }

  const depositSignature = await signAndSend(
    transferBuild.transactionBase64,
    keypairSignTransactionFactory(args.signer),
    {
      sendTo: transferBuild.sendTo || "base",
    },
  );

  console.log(`${args.label} private top-up signature:`, depositSignature);

  for (let i = 0; i < 12; i += 1) {
    const next = await getPrivateBalance(args.ownerWallet, args.ownerTeeAuthToken);
    const nextAmount = BigInt(next.balance);
    console.log(
      `[poll:${args.label}-private-balance] ${i + 1}/12 private=${toUiAmount(
        nextAmount,
      ).toFixed(6)} USDC`,
    );
    if (nextAmount >= args.minAmountMicro) {
      return nextAmount;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for ${args.label} private balance >= ${args.minAmountMicro.toString()} micro`,
  );
}
