"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X, Wallet, LogOut, Copy, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Logo } from "@/components/landing/Logo";
import { useWallet } from "@/hooks/useWallet";

export function Navbar() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [accountOpen, setAccountOpen] = useState(false);
    const wallet = useWallet();

    const appLinks = [
        { label: "Dashboard", href: "/dashboard" },
        { label: "Setup", href: "/setup" },
        { label: "Claim", href: "/claim" },
    ];

    return (
        <div className="fixed top-0 left-0 right-0 z-50 flex flex-col">
            <nav className="flex items-center justify-between px-6 lg:px-12 py-4 backdrop-blur-md bg-black/40 border-b border-white/10 w-full">
                <div className="flex items-center gap-2 lg:gap-3">
                    <Link href="/" className="flex items-center gap-3 group">
                        <Logo className="w-10 h-10 group-hover:scale-110 transition-transform duration-300" />
                        <span className="text-xl font-bold tracking-tighter uppercase text-white hover:text-kast-teal transition-colors">
                            Expaynse
                        </span>
                    </Link>
                </div>

                <div className="hidden md:flex items-center gap-8 text-[13px] font-medium tracking-wide text-kast-gray">
                    {appLinks.map((link) => (
                        <Link
                            key={link.href}
                            href={link.href}
                            className="hover:text-white transition-colors duration-200"
                        >
                            {link.label}
                        </Link>
                    ))}
                </div>

                <div className="flex items-center gap-4">
                    {!wallet.connected ? (
                        <button
                            onClick={() => wallet.connect()}
                            className="hidden sm:flex items-center gap-2 px-5 py-2 rounded-full border border-white/10 bg-white/5 text-sm font-medium text-white hover:bg-white/10 hover:border-white/20 transition-all duration-300 group cursor-pointer"
                        >
                            <Wallet className="w-4 h-4" />
                            Connect Wallet
                        </button>
                    ) : (
                        <div className="hidden sm:flex items-center gap-3 relative">
                            <Link
                                href="/get-started"
                                className="flex items-center gap-2 px-5 py-2 rounded-full border border-kast-teal/30 bg-kast-teal/10 text-sm font-medium text-kast-teal hover:bg-kast-teal/20 transition-all duration-300 group"
                            >
                                Launch App
                                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                            </Link>
                            <button
                                onClick={() => setAccountOpen(!accountOpen)}
                                className="flex items-center gap-2 px-3 py-2 rounded-full border border-white/10 bg-white/5 text-sm font-medium text-white hover:bg-white/10 transition-all cursor-pointer"
                            >
                                <span className="w-2 h-2 rounded-full bg-green-500" />
                                {wallet.truncated}
                                <ChevronDown className={`w-3 h-3 transition-transform ${accountOpen ? "rotate-180" : ""}`} />
                            </button>
                            {accountOpen && (
                                <div className="absolute top-full right-0 mt-2 w-56 rounded-xl border border-white/10 bg-black/90 backdrop-blur-xl shadow-2xl overflow-hidden">
                                    <div className="p-4 flex flex-col gap-3">
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(wallet.publicKey || "");
                                                setAccountOpen(false);
                                            }}
                                            className="flex items-center gap-2 text-sm text-kast-gray hover:text-white transition-colors cursor-pointer"
                                        >
                                            <Copy className="w-4 h-4" />
                                            Copy Address
                                        </button>
                                        <button
                                            onClick={() => {
                                                wallet.disconnect();
                                                setAccountOpen(false);
                                            }}
                                            className="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                                        >
                                            <LogOut className="w-4 h-4" />
                                            Disconnect
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <button
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                        className="md:hidden p-2 text-white hover:text-kast-teal transition-colors cursor-pointer"
                    >
                        {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                    </button>
                </div>

                <AnimatePresence>
                    {isMobileMenuOpen && (
                        <motion.div
                            initial={{ opacity: 0, y: -20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -20 }}
                            transition={{ duration: 0.2 }}
                            className="absolute top-full left-0 right-0 bg-black border-b border-white/10 p-6 md:hidden flex flex-col gap-6 shadow-2xl"
                        >
                            <div className="flex flex-col gap-4 text-center">
                                {appLinks.map((link) => (
                                    <Link
                                        key={link.href}
                                        href={link.href}
                                        className="text-lg font-medium text-zinc-400 hover:text-white transition-colors py-2"
                                        onClick={() => setIsMobileMenuOpen(false)}
                                    >
                                        {link.label}
                                    </Link>
                                ))}
                            </div>
                            {!wallet.connected ? (
                                <button
                                    onClick={() => {
                                        setIsMobileMenuOpen(false);
                                        wallet.connect();
                                    }}
                                    className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-kast-teal text-black font-bold cursor-pointer"
                                >
                                    <Wallet className="w-5 h-5" />
                                    Connect Wallet
                                </button>
                            ) : (
                                <div className="flex flex-col gap-3">
                                    <Link
                                        href="/get-started"
                                        onClick={() => setIsMobileMenuOpen(false)}
                                        className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-kast-teal text-black font-bold"
                                    >
                                        Launch App
                                        <ArrowRight className="w-4 h-4" />
                                    </Link>
                                    <button
                                        onClick={() => {
                                            setIsMobileMenuOpen(false);
                                            wallet.disconnect();
                                        }}
                                        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-white/10 text-red-400 font-medium cursor-pointer"
                                    >
                                        <LogOut className="w-4 h-4" />
                                        Disconnect
                                    </button>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </nav>
        </div>
    );
}
