"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  LayoutDashboard,
  Users,
  Banknote,
  History,
  Settings,
  Wallet,
  Search,
  Briefcase,
  Receipt,
  UserCircle,
  Command,
  Landmark,
  Bell,
  ArrowUpRight,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/landing/Logo";
import { ConnectWalletBtn } from "./connect-wallet-btn";
import { getWalletRole, saveWalletRole, type WalletRole } from "@/lib/storage";

type UserRole = WalletRole;

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  role: UserRole | "both";
}

const navItems: NavItem[] = [
  { label: "Home", href: "/dashboard", icon: LayoutDashboard, role: "employer" },
  { label: "Employee", href: "/people", icon: Users, role: "employer" },
  { label: "Dashboard", href: "/claim/dashboard", icon: LayoutDashboard, role: "employee" },
  { label: "Balances", href: "/claim/balances", icon: Wallet, role: "employee" },
  { label: "Withdraw", href: "/claim/withdraw", icon: ArrowUpRight, role: "employee" },
  { label: "Treasury", href: "/treasury", icon: Landmark, role: "employer" },
  { label: "Activity", href: "/activity", icon: Bell, role: "employer" },
];

function shorten(addr: string) {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

export function AppSidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const { connected, publicKey, disconnect } = useWallet();
  const pathname = usePathname();


  const [searchQuery, setSearchQuery] = useState("");
  const walletAddr = publicKey?.toBase58();
  const isClaimRoute = pathname === "/claim" || pathname?.startsWith("/claim/");
  const isEmployerRoute =
    pathname === "/dashboard" ||
    pathname === "/people" ||
    pathname?.startsWith("/people/") ||
    pathname === "/disburse" ||
    pathname?.startsWith("/disburse/") ||
    pathname === "/treasury" ||
    pathname?.startsWith("/treasury/");

  const persistedRole = useMemo((): UserRole => {
    if (typeof window === "undefined") {
      return "employer";
    }

    if (walletAddr) {
      const savedForWallet = getWalletRole(walletAddr);
      if (savedForWallet) return savedForWallet;
    }

    // No explicit role yet: direct Receive opens in employee context.
    if (isClaimRoute) {
      return "employee";
    }

    // Everywhere else defaults to employer context.
    return "employer";
  }, [walletAddr, isClaimRoute]);

  // Receive page is always employee-facing, even for wallets that are primarily employers.
  const role: UserRole = isClaimRoute ? "employee" : persistedRole;

  useEffect(() => {
    if (!walletAddr) return;

    const saved = getWalletRole(walletAddr);
    if (saved) return;

    // First confirmed employer navigation locks role as employer.
    if (isEmployerRoute) {
      saveWalletRole(walletAddr, "employer");
    }
  }, [walletAddr, isEmployerRoute]);

  const visibleItems = navItems.filter(
    (item) =>
      item.role === "both" || item.role === role
  );

  const filteredItems = searchQuery.trim()
    ? visibleItems.filter((item) =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase())
    )
    : visibleItems;

  return (
    <aside
      className={`fixed lg:sticky top-0 left-0 z-50 h-screen w-72 bg-[#0a0a0a] border-r border-white/5 flex flex-col transition-transform duration-300 ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
    >
      <Link href="/" className="h-16 flex items-center gap-3 px-5 border-b border-white/5 no-underline group">
        <Logo className="w-9 h-9 transition-transform group-hover:scale-110" />
        <span className="text-lg font-bold text-white tracking-tight">
          expaynse
        </span>
      </Link>

      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        <div className="px-2 mb-4">
          <div className="flex items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/5 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#a8a8aa]">
            {role === "employee" ? <UserCircle size={14} className="text-[#1eba98]" /> : <Briefcase size={14} className="text-[#1eba98]" />}
            {role === "employee" ? "Employee Workspace" : "Employer Workspace"}
          </div>
        </div>

        <div className="px-2 mb-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a8a8aa]"
            />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="w-full pl-9 pr-10 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-[#a8a8aa] focus:outline-none focus:ring-2 focus:ring-[#1eba98]/20 focus:border-[#1eba98]/30 transition-all"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white/5 border border-white/10 rounded-md px-1.5 py-0.5">
              <Command size={10} className="text-[#a8a8aa]" />
              <span className="text-[10px] font-medium text-[#a8a8aa]">K</span>
            </div>
          </div>
        </div>

        <div className="space-y-0.5">
          {filteredItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== "/" && pathname?.startsWith(`${item.href}/`));

            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                data-guide={
                  item.href === "/people"
                    ? "employee-nav"
                    : item.href === "/treasury"
                      ? "treasury-nav"
                      : item.href === "/dashboard"
                        ? "home-nav"
                        : undefined
                }
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all no-underline ${isActive
                  ? "bg-[#1eba98]/10 text-[#1eba98] border border-[#1eba98]/20 shadow-xs"
                  : "text-[#a8a8aa] hover:text-white hover:bg-white/5"
                  }`}
              >
                <Icon
                  size={18}
                  className={isActive ? "text-[#1eba98]" : "text-[#a8a8aa]"}
                />
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="p-3 border-t border-white/5">
        {connected && walletAddr ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 rounded-full bg-[#1eba98]/20 flex items-center justify-center">
                <Wallet size={14} className="text-[#1eba98]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-white truncate">
                  {shorten(walletAddr)}
                </p>
                <p className="text-[10px] text-[#a8a8aa]">
                  {role === "employee" ? "Employee" : "Employer"}
                </p>
              </div>
            </div>
            <button
              onClick={disconnect}
              className="w-full py-2.5 bg-[#1eba98] hover:bg-[#1eba98]/80 text-black text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <ConnectWalletBtn mode="standalone" className="w-full" />
        )}
      </div>
    </aside>
  );
}
