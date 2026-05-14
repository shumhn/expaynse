"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/landing/Logo";

export function Footer() {
    return (
        <footer className="relative bg-black border-t border-white/5 py-24 px-6 overflow-hidden">
            <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-start gap-16">
                {/* Brand Section */}
                <div className="space-y-8 flex-1">
                    <div className="flex items-center gap-4">
                        <Logo className="w-16 h-16" />
                        <h2 className="text-3xl font-black uppercase tracking-[-0.02em] text-white">
                            Expaynse
                        </h2>
                    </div>
                    <p className="text-zinc-500 text-lg font-medium max-w-sm leading-relaxed">
Privacy-first real-time payroll streaming on Solana. Pay employees every second with zero-knowledge security.

                    </p>
                </div>

                {/* Links Grid - Compact Right Aligned */}
                <div className="grid grid-cols-2 sm:grid-cols-2 gap-12 md:gap-16">
                    <FooterColumn
                        title="Ecosystem"
                        links={[
                            { label: "Treasury Dashboard", href: "/dashboard" },
                            { label: "Launch App", href: "/dashboard" },
                            { label: "Claim Pay", href: "/claim" }
                        ]}
                    />
                    <FooterColumn
                        title="Resources"
                        links={[
                            { label: "Treasury", href: "/treasury" },
                            { label: "GitHub", href: "#" }
                        ]}
                    />
                </div>
            </div>

            {/* Bottom Bar */}
            <div className="max-w-7xl mx-auto mt-24 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                <div className="flex items-center gap-8">
                    <p>© 2026 Expaynse Labs</p>
                    <p className="hidden md:block">The future of payroll is real-time.</p>
                </div>

                <div className="flex items-center gap-4">
                    <img src="/magicblock-logo.png" alt="MagicBlock" className="w-5 h-5 rounded opacity-50" />
                    <img src="/solanaLogo.png" alt="Solana" className="w-4 h-4 opacity-50" />
                </div>

                <div className="flex items-center gap-6 cursor-default">
                    <a href="#" className="hover:text-kast-teal transition-colors">Twitter</a>
                    <a href="#" className="hover:text-kast-teal transition-colors">Discord</a>
                    <Link href="#" className="hover:text-kast-teal transition-colors">Documentation</Link>
                </div>
            </div>
        </footer>
    );
}

function FooterColumn({ title, links }: { title: string, links: { label: string, href?: string }[] }) {
    return (
        <div className="flex flex-col gap-6">
            <h4 className="text-white text-xs font-black uppercase tracking-[0.2em]">
                {title}
            </h4>
            <div className="flex flex-col gap-4">
                {links.map((link, i) => (
                    link.href ? (
                        <Link
                            key={i}
                            href={link.href}
                            target={link.href.startsWith("http") ? "_blank" : undefined}
                            rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
                            className="text-zinc-500 hover:text-kast-teal text-sm font-bold uppercase tracking-wider transition-colors duration-300"
                        >
                            {link.label}
                        </Link>
                    ) : (
                        <span
                            key={i}
                            className="text-zinc-500 hover:text-kast-teal text-sm font-bold uppercase tracking-wider transition-colors duration-300 cursor-default"
                        >
                            {link.label}
                        </span>
                    )
                ))}
            </div>
        </div>
    );
}
