"use client";

import { motion } from "framer-motion";
import { Check, Lock } from "lucide-react";

const features = [
    {
        title: "Complete Confidentiality",
        desc: "Salary amounts are never visible on-chain. Not to validators, not to explorers, not to anyone.",
    },
    {
        title: "Continuous Payments",
        desc: "No more waiting for payday. Salaries stream per-second, accessible anytime.",
    },
    {
        title: "Employer Controls",
        desc: "Pause, resume, stop, restart streams. Full lifecycle management in one panel.",
    },
    {
        title: "Verifiable Security",
        desc: "Open source code. Auditable privacy guarantees. No trust required.",
    },
];

const stats = [
    { value: "1 sec", label: "Streaming granularity" },
    { value: "Private", label: "Settlement layer" },
    { value: "0 bytes", label: "Salary data exposed" },
    { value: "Full", label: "Employer lifecycle control" },
];

export function PrivacyFeatures() {
    return (
        <section className="py-24 px-6 bg-black relative overflow-hidden">
            <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-start">
                <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                    style={{ willChange: "transform, opacity" }}
                >
                    <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight mb-4">
                        Built for teams that value privacy
                    </h2>
                    <p className="text-gray-400 text-lg leading-relaxed mb-10">
                        Expaynse provides real financial privacy without compromising on the features modern teams need from payroll infrastructure.
                    </p>
                    <div className="space-y-6">
                        {features.map((f, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, y: 10 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: i * 0.1, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                                style={{ willChange: "transform, opacity" }}
                                className="flex gap-4"
                            >
                                <div className="mt-1 w-5 h-5 rounded-full border border-kast-teal flex items-center justify-center flex-shrink-0">
                                    <Check className="w-3 h-3 text-kast-teal" strokeWidth={3} />
                                </div>
                                <div>
                                    <h4 className="text-white font-semibold mb-1">{f.title}</h4>
                                    <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                    style={{ willChange: "transform, opacity" }}
                    className="space-y-4"
                >
                    <div className="grid grid-cols-2 gap-4">
                        {stats.map((s, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, y: 20 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: i * 0.1, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                                style={{ willChange: "transform, opacity" }}
                                className="rounded-2xl p-6 border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/50 transition-colors"
                            >
                                <p className="text-2xl font-bold text-kast-teal mb-1">{s.value}</p>
                                <p className="text-sm text-gray-500">{s.label}</p>
                            </motion.div>
                        ))}
                    </div>
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.4, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                        style={{ willChange: "transform, opacity" }}
                        className="rounded-2xl p-6 border border-zinc-800 bg-black"
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center">
                                <Lock className="w-4 h-4 text-kast-teal" />
                            </div>
                            <h4 className="text-white font-semibold">Privacy by Default</h4>
                        </div>
                        <p className="text-gray-400 text-sm leading-relaxed">
                            Every operation in Expaynse is private by default. No configuration needed. No opt-in required. Privacy is the foundation, not a feature.
                        </p>
                    </motion.div>
                </motion.div>
            </div>
        </section>
    );
}
