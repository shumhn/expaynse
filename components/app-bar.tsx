"use client";

import { useWallet } from "@/hooks/useWallet";
import { getWalletRole } from "@/lib/storage";
import {
  Wallet,
  X,
  LayoutDashboard,
  Play,
  Receipt,
  ChevronRight,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Menu,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Logo } from "@/components/landing/Logo";
import { useState } from "react";
import { usePathname } from "next/navigation";

import { ConnectWalletBtn } from "./connect-wallet-btn";

const tabs = [
  { label: "Deposit", href: "/setup", icon: ShieldCheck },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Send", href: "/disburse", icon: Play },
  { label: "Receive", href: "/claim/dashboard", icon: Receipt },
];

export default function Appbar() {
  const wallet = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const installedWallets = wallet.wallets.filter(
    (w) => w.readyState === "Installed",
  );
  const otherWallets = wallet.wallets.filter(
    (w) => w.readyState !== "Installed",
  );

  const pathname = usePathname();

  const dashboardHref = (() => {
    if (!wallet.publicKey) return "/get-started";
    const savedRole = getWalletRole(wallet.publicKey);
    return savedRole === "employer" ? "/dashboard" : "/get-started";
  })();

  const tabsWithResolvedDashboard = tabs.map((tab) =>
    tab.label === "Dashboard" ? { ...tab, href: dashboardHref } : tab,
  );

  return (
    <>
      <nav
        className="fixed top-0 left-0 right-0 z-50 bg-black/40 backdrop-blur-md border-b border-white/10"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2.5 no-underline group">
              <Logo className="w-8 h-8" />
              <span className="text-lg font-bold text-white tracking-tight hidden sm:block">
                expaynse
              </span>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center gap-8">
              {tabsWithResolvedDashboard.map((tab) => {
                const isActive = pathname?.startsWith(tab.href) ?? false;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={`text-[13px] font-semibold tracking-wide transition-colors duration-200 ${
                      isActive
                        ? "text-white font-bold"
                        : "text-[#a8a8aa] hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </div>

            {/* CTA Buttons */}
            <div className="hidden md:flex items-center gap-3">
              <ConnectWalletBtn menuOpen={menuOpen} onMenuToggle={setMenuOpen} />
            </div>

            {/* Mobile menu button */}
            <button
              className="md:hidden p-2 cursor-pointer"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <X className="w-6 h-6 text-white" />
              ) : (
                <Menu className="w-6 h-6 text-white" />
              )}
            </button>
          </div>

          {/* Mobile Navigation */}
          {menuOpen && (
            <div className="md:hidden py-4 border-t border-white/10 overflow-hidden">
              <div className="flex flex-col gap-2">
                {tabsWithResolvedDashboard.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = pathname?.startsWith(tab.href) ?? false;
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      onClick={() => setMenuOpen(false)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all no-underline ${isActive
                        ? "bg-white/10 text-white font-semibold"
                        : "text-[#a8a8aa] hover:text-white hover:bg-white/5"
                        }`}
                    >
                      <Icon size={18} />
                      <span className="text-sm">{tab.label}</span>
                    </Link>
                  );
                })}

                <div className="mt-2 pt-2 border-t border-white/10">
                  {wallet.connected ? (
                    <div className="p-2 space-y-3">
                      <div className="flex items-center justify-between px-3">
                        <div className="flex items-center gap-3">
                          <div className="relative">
                            <div className="w-2 h-2 rounded-full bg-green-500 absolute -top-0.5 -right-0.5 z-10 animate-pulse" />
                            {wallet.activeWallet?.adapter.icon && (
                              <Image
                                src={wallet.activeWallet.adapter.icon}
                                alt=""
                                width={24}
                                height={24}
                                className="rounded-lg"
                              />
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] text-[#a8a8aa] uppercase tracking-widest font-bold">
                              Connected
                            </span>
                            <span className="text-xs text-white font-bold">
                              {wallet.truncated}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={wallet.disconnect}
                          className="p-2 text-red-400 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer"
                        >
                          <LogOut size={18} />
                        </button>
                      </div>

                      <button
                        onClick={() => {
                          setMenuOpen(false);
                          setWalletModalOpen(true);
                        }}
                        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-white/10 bg-white/5 text-[#a8a8aa] hover:text-white text-xs font-bold transition-all cursor-pointer"
                      >
                        <RefreshCw size={14} />
                        Switch Account
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        setWalletModalOpen(true);
                      }}
                      className="w-full flex items-center justify-center gap-3 py-4 rounded-xl bg-[#1eba98] text-black font-bold shadow-lg active:scale-95 transition-all cursor-pointer"
                    >
                      <Wallet size={18} />
                      Connect Wallet
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* Wallet Selection Modal */}
      {walletModalOpen && !wallet.connected && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center px-4"
          onClick={() => setWalletModalOpen(false)}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            style={{ animation: "fadeIn 150ms ease-out" }}
          />

          {/* Modal */}
          <div
            className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a0a] shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "fadeInUp 200ms ease-out" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
              <h2 className="font-bold text-white text-base">
                Connect Wallet
              </h2>
              <button
                onClick={() => setWalletModalOpen(false)}
                className="p-1 text-gray-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Wallet list */}
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              {installedWallets.length > 0 && (
                <div className="mb-6 text-left">
                  <p className="text-[10px] text-[#a8a8aa] uppercase tracking-widest px-3 mb-3 font-bold">
                    Detected
                  </p>
                  <div className="flex flex-col gap-2">
                    {installedWallets.map((w) => (
                      <button
                        key={w.adapter.name}
                        onClick={() => wallet.selectAndConnect(w.adapter.name)}
                        disabled={wallet.connecting}
                        className="flex items-center gap-4 w-full px-4 py-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all duration-200 group cursor-pointer disabled:opacity-50"
                      >
                        <div className="relative">
                          <Image
                            src={w.adapter.icon}
                            alt={w.adapter.name}
                            width={32}
                            height={32}
                            className="rounded-xl group-hover:scale-110 transition-transform duration-300 shadow-lg"
                          />
                        </div>
                        <span className="text-sm text-white group-hover:text-white font-bold transition-colors flex-1 text-left">
                          {w.adapter.name}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(52,211,153,0.4)]" />
                          <span className="text-[10px] text-green-400 uppercase tracking-tight font-bold">
                            Active
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {otherWallets.length > 0 && (
                <div className="text-left">
                  <p className="text-[10px] text-[#a8a8aa] uppercase tracking-widest px-3 mb-3 font-bold">
                    Suggested
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    {otherWallets.map((w) => (
                      <a
                        key={w.adapter.name}
                        href={w.adapter.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-4 w-full px-4 py-4 rounded-xl border border-white/10 hover:bg-white/5 transition-all duration-200 group no-underline"
                      >
                        <Image
                          src={w.adapter.icon}
                          alt={w.adapter.name}
                          width={28}
                          height={28}
                          className="rounded-lg opacity-40 group-hover:opacity-100 transition-all duration-300"
                        />
                        <span className="text-sm text-[#a8a8aa] group-hover:text-white transition-colors flex-1 text-left">
                          {w.adapter.name}
                        </span>
                        <ChevronRight
                          size={14}
                          className="text-[#a8a8aa] group-hover:text-white group-hover:translate-x-0.5 transition-all"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {wallet.wallets.length === 0 && (
                <div className="py-10 text-center">
                  <Wallet size={32} className="text-[#a8a8aa] mx-auto mb-4" />
                  <p className="text-sm text-[#a8a8aa] mb-1">
                    No wallets found
                  </p>
                  <p className="text-xs text-[#a8a8aa]">
                    Install a Solana wallet extension to continue
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-6 border-t border-white/10 text-center">
              <p className="text-xs text-[#a8a8aa] uppercase tracking-widest font-bold">
                By connecting, you agree to the Terms
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Animations */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </>
  );
}
