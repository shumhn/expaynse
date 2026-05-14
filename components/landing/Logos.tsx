"use client";

import Image from "next/image";

const textLogos = [
    "Per-Second Streaming",
    "USDC Payroll",
    "Zero-Knowledge Privacy",
    "Instant Cashout",
    "Automated Treasury",
    "Private Balances",
    "Non-Custodial",
];

const brandLogos = [
    { name: "MagicBlock", src: "/magicblock-logo.png" },
    { name: "Solana", src: "/solana-logo.png" },
];

export function Logos() {
    const items = [
        ...brandLogos.map((b) => ({ type: "brand" as const, ...b })),
        ...textLogos.map((t) => ({ type: "text" as const, name: t, src: "" })),
    ];

    return (
        <section className="py-24 bg-black overflow-hidden border-b border-white/5">
            <div className="text-center mb-12">
                <span className="text-white text-sm uppercase tracking-[0.3em] font-normal opacity-80">Built For Modern Payroll</span>
            </div>

            <div className="relative flex overflow-x-hidden group">
                <div className="flex animate-marquee whitespace-nowrap gap-20 items-center">
                    {[...items, ...items, ...items].map((item, i) => (
                        item.type === "brand" ? (
                            <span key={i} className="inline-flex items-center gap-2.5 text-2xl font-normal text-white uppercase tracking-tight hover:text-kast-teal transition-colors cursor-default">
                                <Image src={item.src} alt={item.name} width={28} height={28} className="rounded-md" />
                                {item.name}
                            </span>
                        ) : (
                            <span
                                key={i}
                                className="text-2xl font-normal text-white uppercase tracking-tight hover:text-kast-teal transition-colors cursor-default"
                            >
                                {item.name}
                            </span>
                        )
                    ))}
                </div>

                <div className="absolute top-0 right-0 w-32 h-full bg-gradient-to-l from-black to-transparent z-10" />
                <div className="absolute top-0 left-0 w-32 h-full bg-gradient-to-r from-black to-transparent z-10" />
            </div>
        </section>
    );
}
