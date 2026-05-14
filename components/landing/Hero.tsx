"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";

export function Hero() {
    return (
        <section className="relative min-h-screen flex items-center pt-24 md:pt-32 px-6 lg:px-12 overflow-hidden bg-black selection:bg-kast-teal/30">
            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[800px] h-[800px] bg-kast-teal/10 rounded-full blur-[120px] pointer-events-none" />
            
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                className="absolute top-24 md:top-32 left-1/2 -translate-x-1/2 flex items-center justify-center gap-4 flex-wrap w-full px-6 z-20"
            >
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md">
                    <Image src="/magicblock-logo.png" alt="MagicBlock" width={16} height={16} className="rounded-sm" />
                    <span className="text-sm text-zinc-300 font-medium">Powered by MagicBlock</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-kast-teal/10 border border-kast-teal/20 backdrop-blur-md">
                    <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-kast-teal opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-kast-teal"></span>
                    </span>
                    <span className="text-sm text-kast-teal font-medium tracking-wide">Live on Devnet</span>
                </div>
            </motion.div>

            <div className="max-w-7xl grid lg:grid-cols-2 gap-16 items-center w-full mt-16 md:mt-24">
                <div className="flex flex-col gap-6 z-10">

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                        style={{ willChange: "transform, opacity" }}
                        className="text-[36px] md:text-[44px] font-medium tracking-tight leading-[1.2] text-white"
                    >
                        Privacy-First Real-Time
                        <br />
                        <span className="whitespace-nowrap">Payroll Streaming on Solana</span>
                    </motion.h1>
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                        style={{ willChange: "transform, opacity" }}
                        className="text-lg text-gray-400 max-w-2xl leading-relaxed"
                    >
                        Per-second salary streaming with MagicBlock TEE.
                        <br />
                        <span className="whitespace-nowrap">Complete auditability for you, complete privacy for your team on Solana.</span>
                    </motion.p>
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                        style={{ willChange: "transform, opacity" }}
                    >
                        <Link href="/dashboard" className="inline-flex px-8 py-3 bg-kast-teal text-black font-bold rounded-full hover:scale-105 transition-transform border-2 border-kast-teal hover:bg-transparent hover:text-kast-teal">
                            Launch App
                        </Link>
                    </motion.div>

                </div>
                <motion.div
                    initial={{ opacity: 0, x: 40 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                    style={{ willChange: "transform, opacity" }}
                    className="flex items-center justify-center"
                >
                    <div className="relative w-[320px] h-auto overflow-hidden bg-black z-20 shadow-[0_0_100px_-20px_rgba(30,186,152,0.25)] rounded-[2.5rem]">
                        <Image
                            src="/phone-screenshot-v2.png"
                            alt="Expaynse App"
                            width={632}
                            height={1048}
                            className="w-full h-auto object-contain"
                            priority
                        />
                    </div>
                </motion.div>
            </div>
        </section>
    );
}
