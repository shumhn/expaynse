"use client";

import { motion } from "framer-motion";

const cards = [
    {
        stat: "100%",
        label: "Salary amounts visible",
        desc: "Every payment is public on-chain.",
    },
    {
        stat: "24/7",
        label: "Burn rate exposed",
        desc: "Competitors track your runway.",
    },
    {
        stat: "30d",
        label: "Delayed salary",
        desc: "Employees wait days or weeks to get paid.",
    },
    {
        stat: "∞",
        label: "Privacy leaks",
        desc: "Colleagues compare salaries freely.",
    },
];

export function GlassOffice() {
    return (
        <section className="py-24 px-6 bg-black relative overflow-hidden">
            <div className="max-w-7xl mx-auto">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                    style={{ willChange: "transform, opacity" }}
                    className="text-center mb-16"
                >
                    <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight mb-4">
                        Traditional Crypto Payroll is a Glass Office
                    </h2>
                    <p className="text-gray-400 text-lg max-w-2xl mx-auto leading-relaxed">
                        When you pay salaries on-chain, everyone can see everything. Competitors learn your burn rate. Financial privacy disappears.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {cards.map((card, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.12, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                            style={{ willChange: "transform, opacity" }}
                            className="rounded-2xl p-6 bg-zinc-900/40 border border-white/10 border-t-2 border-t-kast-teal hover:border-kast-teal/30 hover:bg-zinc-900/60 transition-all"
                        >
                            <p className="text-3xl font-bold text-kast-teal mb-3">
                                {card.stat}
                            </p>
                            <p className="text-sm font-semibold text-white mb-1">
                                {card.label}
                            </p>
                            <p className="text-sm text-white/80 leading-relaxed">
                                {card.desc}
                            </p>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
