import type { PublicKey } from "@solana/web3.js";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

export interface AnchorWalletLike {
  publicKey: PublicKey;
  payer?: Keypair;
  signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T
  ): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[]
  ): Promise<T[]>;
}

function signWithKeypair<T extends Transaction | VersionedTransaction>(
  tx: T,
  payer: Keypair
): T {
  if (tx instanceof VersionedTransaction) {
    tx.sign([payer]);
    return tx;
  }

  tx.partialSign(payer);
  return tx;
}

export function createAnchorNodeWallet(payer: Keypair): AnchorWalletLike {
  return {
    publicKey: payer.publicKey,
    payer,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T
    ): Promise<T> {
      return signWithKeypair(tx, payer);
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[]
    ): Promise<T[]> {
      return txs.map((tx) => signWithKeypair(tx, payer));
    },
  };
}

export function createReadonlyAnchorWallet(
  publicKey: PublicKey
): AnchorWalletLike {
  return {
    publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      _tx: T
    ): Promise<T> {
      void _tx;
      throw new Error(
        "Readonly Anchor wallet cannot sign transactions. Build the transaction on the server and have the browser wallet sign it."
      );
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      _txs: T[]
    ): Promise<T[]> {
      void _txs;
      throw new Error(
        "Readonly Anchor wallet cannot sign transactions. Build the transactions on the server and have the browser wallet sign them."
      );
    },
  };
}
