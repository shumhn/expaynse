"use client";

import { useCallback, useMemo } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";

export function useWallet() {
  const {
    connected,
    publicKey,
    connect,
    disconnect,
    select,
    wallets,
    wallet: activeWallet,
    connecting,
  } = useSolanaWallet();

  const selectAndConnect = useCallback(
    async (walletName: WalletName) => {
      try {
        select(walletName);
        await connect();
      } catch {
        // User rejected or no wallet found
      }
    },
    [select, connect],
  );

  const handleConnect = useCallback(async () => {
    if (activeWallet?.adapter?.name) {
      try {
        await connect();
      } catch {
        // User rejected or no wallet found — silently ignore
      }
      return;
    }

    const firstInstalledWallet = wallets.find(
      (wallet) => wallet.readyState === "Installed",
    );

    if (!firstInstalledWallet) {
      return;
    }

    try {
      select(firstInstalledWallet.adapter.name);
      await connect();
    } catch {
      // User rejected or no wallet found — silently ignore
    }
  }, [activeWallet, connect, select, wallets]);

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect();
    } catch {
      // ignore
    }
  }, [disconnect]);

  const publicKeyStr = useMemo(
    () => (publicKey ? publicKey.toBase58() : null),
    [publicKey],
  );

  const truncated = useMemo(
    () =>
      publicKeyStr
        ? `${publicKeyStr.slice(0, 4)}...${publicKeyStr.slice(-4)}`
        : null,
    [publicKeyStr],
  );

  return {
    connected,
    connecting,
    publicKey: publicKeyStr,
    truncated,
    connect: handleConnect,
    disconnect: handleDisconnect,
    wallets,
    activeWallet,
    selectAndConnect,
  };
}
