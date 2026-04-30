"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Wallet, ChevronLeft } from "lucide-react";
import { ReactNode, useState } from "react";
import { AppSidebar } from "./app-sidebar";
import { ConnectWalletBtn } from "./connect-wallet-btn";

export function EmployerLayout({ children }: { children: ReactNode }) {
  const { connected } = useWallet();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-black flex">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <AppSidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="h-16 bg-[#0a0a0a] border-b border-white/5 flex items-center justify-between px-4 sm:px-6 sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ChevronLeft size={20} className="text-[#a8a8aa]" />
          </button>
          <div className="flex items-center gap-3">
            <ConnectWalletBtn menuOpen={false} onMenuToggle={() => {}} />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto bg-black">
          {!connected ? (
            <div className="h-[60vh] flex flex-col items-center justify-center">
              <div className="w-16 h-16 bg-[#0a0a0a] rounded-2xl border border-white/5 flex items-center justify-center mb-6 shadow-sm">
                <Wallet size={28} className="text-[#a8a8aa]" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Connect Wallet</h2>
              <p className="text-sm text-[#a8a8aa] max-w-md text-center">
                Connect your wallet to manage payroll, people, and history.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
