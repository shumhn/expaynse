"use client";

import { motion } from "framer-motion";

const steps = [
    {
        step: "01",
        title: "Setup Treasury",
        desc: "Initialize treasury and deposit USDC. Funds move to privacy layer automatically.",
    },
    {
        step: "02",
        title: "Add Employees",
        desc: "Add team members and set per-second salary rates for each stream.",
    },
    {
        step: "03",
        title: "Stream in Real-Time",
        desc: "Salaries accrue every second. Track live balances in real-time.",
    },
    {
        step: "04",
        title: "Settle Privately",
        desc: "One-click cashouts. Settled from accrued balances, hidden on-chain.",
    },
];

export function HowItWorks() {
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
                        How Expaynse works
                    </h2>
                    <p className="text-gray-400 text-lg max-w-2xl mx-auto leading-relaxed">
                        A straightforward workflow for automated payroll. Setup once, stream salaries forever — completely private.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {steps.map((s, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.15, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                            style={{ willChange: "transform, opacity" }}
                            className="group rounded-2xl p-8 border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 transition-colors"
                        >
                            <span className="text-xs font-bold text-kast-teal uppercase tracking-widest">
                                Step {s.step}
                            </span>
                            <h3 className="text-xl font-bold text-white mt-2 mb-3">
                                {s.title}
                            </h3>
                            <p className="text-sm text-gray-400 leading-relaxed">
                                {s.desc}
                            </p>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
