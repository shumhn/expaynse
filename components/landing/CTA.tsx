"use client";

import { motion } from "framer-motion";
import Link from "next/link";

export function CTA() {
    return (
        <section className="py-24 px-6 bg-black">
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                style={{ willChange: "transform, opacity" }}
                className="max-w-7xl mx-auto"
            >
                <div className="bg-[#08E0A3] rounded-2xl p-12 flex flex-col items-center text-center">
                    <h2 className="text-[28px] leading-tight font-normal text-[#000000] tracking-tight">
                        Pay. Stream. Stack.
                        <br />
                        The Future of Money Moves in Real-Time
                    </h2>
                    <Link href="/get-started" className="mt-8 inline-flex px-8 py-3 bg-black text-white text-sm font-bold rounded-full hover:scale-105 transition-transform duration-300">
                        Launch App
                    </Link>
                </div>
            </motion.div>
        </section>
    );
}
