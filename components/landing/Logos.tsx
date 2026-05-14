"use client";

const textLogos = [
    "Per-Second Streaming",
    "USDC Payroll",
    "Zero-Knowledge Privacy",
    "Instant Cashout",
    "Automated Treasury",
    "Private Balances",
    "Non-Custodial",
];

export function Logos() {
    return (
        <section className="py-24 bg-black overflow-hidden border-b border-white/5">
            <div className="text-center mb-12">
                <span className="text-white text-sm uppercase tracking-[0.3em] font-normal opacity-80">Built For Modern Payroll</span>
            </div>

            <div className="relative flex overflow-x-hidden group">
                <div className="flex animate-marquee whitespace-nowrap gap-20 items-center">
                    {[...textLogos, ...textLogos, ...textLogos].map((item, i) => (
                        <span
                            key={i}
                            className="text-2xl font-normal text-white uppercase tracking-tight hover:text-kast-teal transition-colors cursor-default"
                        >
                            {item}
                        </span>
                    ))}
                </div>

                <div className="absolute top-0 right-0 w-32 h-full bg-gradient-to-l from-black to-transparent z-10" />
                <div className="absolute top-0 left-0 w-32 h-full bg-gradient-to-r from-black to-transparent z-10" />
            </div>
        </section>
    );
}
