"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import {
  ChevronDown,
  Check,
  Copy,
  Wallet,
  X,
  Menu,
  LogOut,
} from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";

export interface ConnectWalletBtnProps {
  menuOpen?: boolean;
  onMenuToggle?: (open: boolean) => void;
  className?: string;
  mode?: "nav" | "standalone";
}

export function ConnectWalletBtn({
  menuOpen = false,
  onMenuToggle,
  className = "",
  mode = "nav",
}: ConnectWalletBtnProps) {
  const { wallet, wallets, connected, publicKey, disconnect, select, connect } =
    useWallet();

  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingName, setConnectingName] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setAccountDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!walletModalOpen) return;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWalletModalOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handler);
    };
  }, [walletModalOpen]);

  const openModal = () => {
    setAccountDropdownOpen(false);
    setWalletModalOpen(true);
  };

  const handleCopy = async () => {
    if (publicKey) {
      try {
        await navigator.clipboard.writeText(publicKey.toBase58());
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1500);
      } catch {
        // Copy failed silently
      }
    }
  };

  const handleSelectWallet = async (walletName: WalletName) => {
    try {
      setConnecting(true);
      setConnectingName(walletName);
      if (connected) {
        await disconnect();
      }
      select(walletName);
      await connect();
      setWalletModalOpen(false);
    } catch {
      // Wallet selection failed silently
    } finally {
      setConnecting(false);
      setConnectingName(null);
    }
  };

  const installedWallets = wallets.filter((w) => w.readyState === "Installed");
  const otherWallets = wallets.filter((w) => w.readyState !== "Installed");
  const isStandalone = mode === "standalone";

  const truncated = publicKey
    ? publicKey.toBase58().slice(0, 4) + "···" + publicKey.toBase58().slice(-4)
    : "";

  return (
    <>
      <div className={`flex items-center gap-2.5 ${className}`}>
        {connected ? (
          <div
            className={`${isStandalone ? "block" : "hidden md:block"} relative z-50`}
            ref={dropdownRef}
          >
            <button
              onClick={() => setAccountDropdownOpen(!accountDropdownOpen)}
              className="flex items-center gap-2 pl-2 pr-3 py-2 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 transition-all duration-200 cursor-pointer shadow-sm"
            >
              {wallet?.adapter?.icon ? (
                <span className="w-7 h-7 rounded-lg overflow-hidden flex items-center justify-center bg-[#1eba98]/20 shrink-0">
                  <Image
                    src={wallet.adapter.icon}
                    alt={wallet.adapter.name || "Wallet"}
                    width={20}
                    height={20}
                  />
                </span>
              ) : (
                <span className="w-7 h-7 rounded-lg flex items-center justify-center bg-[#1eba98]/20 shrink-0">
                  <Wallet size={16} className="text-[#1eba98]" />
                </span>
              )}
              <span className="font-mono text-[12px] tracking-wide text-white">
                {truncated}
              </span>
              <ChevronDown
                size={13}
                className={`text-gray-400 transition-transform duration-200 ${accountDropdownOpen ? "rotate-180" : ""
                  }`}
              />
            </button>

            {accountDropdownOpen && (
              <div
                className="absolute right-0 top-[calc(100%+10px)] w-60 rounded-2xl border border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-right z-[100]"
                role="menu"
              >
                <div className="flex flex-col items-center gap-3 px-4 pt-5 pb-4 bg-[#0a0a0a] border-b border-white/10">
                  <div className="flex items-center justify-center w-12 h-12 rounded-2xl overflow-hidden border border-white/10 shrink-0 bg-white/5">
                    {wallet?.adapter?.icon ? (
                      <Image
                        src={wallet.adapter.icon}
                        alt={wallet.adapter.name || "Wallet"}
                        width={32}
                        height={32}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5">
                        <Wallet size={20} className="text-[#a8a8aa]" />
                      </div>
                    )}
                  </div>
                  {wallet?.adapter?.name && (
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                      {wallet.adapter.name}
                    </span>
                  )}
                  <button
                    onClick={handleCopy}
                    aria-label="Copy address"
                    className="flex items-center justify-between gap-2 w-full px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-all duration-150 cursor-pointer border border-white/10"
                  >
                    <span className="font-mono text-[12px] tracking-wider text-white">
                      {truncated}
                    </span>
                    {isCopied ? (
                      <Check size={13} className="text-[#1eba98] shrink-0" />
                    ) : (
                      <Copy size={13} className="text-[#a8a8aa] shrink-0" />
                    )}
                  </button>
                </div>

                <div className="p-2 bg-[#0a0a0a]">
                  <button
                    role="menuitem"
                    onClick={openModal}
                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-[13px] font-medium text-[#a8a8aa] hover:text-white hover:bg-white/5 transition-all duration-150 cursor-pointer"
                  >
                    <span className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 shrink-0">
                      <Wallet size={14} className="text-[#a8a8aa]" />
                    </span>
                    Change Wallet
                  </button>

                  <div className="h-px bg-white/10 mx-2 my-1.5" />

                  <button
                    role="menuitem"
                    onClick={() => {
                      setAccountDropdownOpen(false);
                      disconnect();
                    }}
                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-[13px] font-medium text-red-400/80 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150 cursor-pointer"
                  >
                    <span className="w-8 h-8 rounded-lg flex items-center justify-center bg-red-500/10 shrink-0">
                      <LogOut size={14} className="text-red-400" />
                    </span>
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── Disconnected state ── */
          <button
            onClick={openModal}
            aria-label="Connect wallet"
            className={`${isStandalone ? "inline-flex w-full justify-center py-3 rounded-xl" : "hidden md:flex px-6 py-2.5 rounded-full"} items-center gap-2.5 bg-[#1eba98] hover:bg-[#1eba98]/80 active:scale-[0.98] text-black text-[13.5px] font-bold tracking-tight transition-all duration-200 cursor-pointer shadow-sm`}
          >
            <Wallet size={16} />
            Connect Wallet
          </button>
        )}

        {!isStandalone && (
          <button
            onClick={() => onMenuToggle?.(!menuOpen)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="md:hidden flex items-center justify-center w-[40px] h-[40px] rounded-xl bg-white/5 border border-white/10 text-[#a8a8aa] hover:text-white hover:bg-white/10 transition-all duration-150 cursor-pointer shadow-sm"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        )}
      </div>

      {walletModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={() => setWalletModalOpen(false)}
          >
            <div
              className="relative w-full max-w-[380px] rounded-2xl bg-[#0b0f14] border border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.45)] overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Connect Wallet"
            >
              <div className="flex items-center justify-between px-7 py-6 bg-[#0b0f14] border-b border-white/10">
                <h2 className="text-base font-bold tracking-tight text-white">
                  Connect Wallet
                </h2>
                <button
                  onClick={() => setWalletModalOpen(false)}
                  aria-label="Close"
                  className="flex items-center justify-center w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-[#8f8f95] hover:text-white transition-all duration-150 cursor-pointer border border-white/10"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="p-4 max-h-[400px] overflow-y-auto [scrollbar-width:thin]">
                {wallets.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-12 px-6 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mb-2 border border-white/10">
                      <Wallet size={24} className="text-[#8f8f95]" />
                    </div>
                    <p className="text-sm font-bold text-white">
                      No wallets found
                    </p>
                    <p className="text-xs text-[#8f8f95] leading-relaxed max-w-[200px]">
                      Install a Solana wallet extension to continue
                    </p>
                  </div>
                ) : (
                  <>
                    {installedWallets.length > 0 && (
                      <div className="mb-4">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95] px-3 py-1.5 mb-1">
                          Detected
                        </p>
                        {installedWallets.map((w) => {
                          const isConnecting =
                            connecting && connectingName === w.adapter.name;
                          return (
                            <button
                              key={w.adapter.name}
                              onClick={() => handleSelectWallet(w.adapter.name)}
                              disabled={connecting}
                              className="flex items-center gap-4 w-full px-4 py-3.5 rounded-xl hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 cursor-pointer border border-transparent hover:border-white/15 group"
                            >
                              <span className="flex items-center justify-center w-10 h-10 rounded-xl overflow-hidden border border-white/10 shrink-0 p-px bg-white/5 group-hover:scale-105 transition-transform">
                                <Image
                                  src={w.adapter.icon}
                                  alt={w.adapter.name}
                                  width={30}
                                  height={30}
                                />
                              </span>
                              <span className="flex-1 text-[15px] font-bold text-left text-white">
                                {w.adapter.name}
                              </span>
                              {isConnecting ? (
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  className="shrink-0 animate-spin text-[#8f8f95]"
                                >
                                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                                </svg>
                              ) : (
                                <span className="text-[10px] font-bold text-[#1eba98] bg-[#1eba98]/10 border border-[#1eba98]/30 px-2.5 py-1 rounded-full shrink-0 uppercase tracking-tighter">
                                  Installed
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {otherWallets.length > 0 && (
                      <div className="mt-2">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-[#8f8f95] px-3 py-1.5 mb-1">
                          More wallets
                        </p>
                        {otherWallets.map((w) => (
                          <a
                            key={w.adapter.name}
                            href={w.adapter.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-4 w-full px-4 py-3 rounded-xl hover:bg-white/5 transition-all duration-200 no-underline group border border-transparent hover:border-white/15"
                          >
                            <span className="w-10 h-10 rounded-xl overflow-hidden border border-white/10 shrink-0 bg-white/5 opacity-70 group-hover:opacity-100 transition-all p-px">
                              <Image
                                src={w.adapter.icon}
                                alt={w.adapter.name}
                                width={36}
                                height={36}
                              />
                            </span>
                            <span className="flex-1 text-[15px] font-bold text-left text-[#8f8f95] group-hover:text-white transition-colors duration-150">
                              {w.adapter.name}
                            </span>
                            <span className="text-[11px] text-[#8f8f95] group-hover:text-white font-bold transition-colors">
                              Install →
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="px-8 py-5 border-t border-white/10 text-center">
                <p className="text-[10px] font-bold text-[#8f8f95] uppercase tracking-widest">
                  By connecting, you agree to the Terms
                </p>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
