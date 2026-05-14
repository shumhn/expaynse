"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Minus } from "lucide-react";

const faqs = [
    {
        question: "How does payroll streaming work?",
        answer: "Instead of paying salaries monthly, Expaynse streams USDC to employees every single second on Solana. You deposit funds into a treasury, set per-second rates for each employee, and salaries accrue continuously. Employees can cash out anytime.\n\nRefer to our Documentation for detailed guides on setting up your first stream."
    },
    {
        question: "Why stream payroll instead of monthly payments?",
        answer: "Streaming gives employees instant access to earned wages — no more waiting for payday. Employers get better cash flow management, reduced administrative overhead, and happier teams. It's payroll that moves at the speed of work."
    },
    {
        question: "How is salary data kept private on-chain?",
        answer: "Expaynse uses zero-knowledge proofs to settle streams. The blockchain only sees that a payment occurred — never the amount, never the recipient, never the employer. Validators and explorers see encrypted hashes, not salary data."
    },
    {
        question: "What tokens are supported?",
        answer: "Currently, Expaynse supports USDC on Solana. We're adding support for USDT, SOL-native tokens, and SPL tokens in the coming weeks. All settlements happen instantly with sub-second finality."
    },
    {
        question: "Can I pause or cancel a stream?",
        answer: "Yes. You have full lifecycle control over every stream. Pause, resume, adjust rates, or cancel entirely — all from a single dashboard. Changes take effect immediately on-chain with no delay."
    },
    {
        question: "How do I integrate Expaynse into my existing HR system?",
        answer: "Expaynse provides a REST API and webhooks for seamless integration with any HRIS, accounting software, or payroll provider. Sync employee lists, automate rate adjustments, and export reports with a few API calls."
    },
];

export function FAQ() {
    const [openIndex, setOpenIndex] = useState<number | null>(0);

    return (
        <section className="py-24 px-6 bg-black border-t border-white/5">
            <div className="max-w-7xl mx-auto">
                <div className="flex flex-col lg:flex-row gap-16 lg:gap-24">
                    <motion.div
                        className="lg:w-[300px] flex-shrink-0"
                        initial={{ opacity: 0, x: -30 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                    >
                        <h2 className="text-[40px] md:text-[52px] font-medium tracking-tight text-white">
                            FAQS
                        </h2>
                    </motion.div>

                    <div className="flex-1 space-y-0">
                        {faqs.map((faq, index) => (
                            <FAQItem
                                key={index}
                                question={faq.question}
                                answer={faq.answer}
                                isOpen={openIndex === index}
                                onToggle={() => setOpenIndex(openIndex === index ? null : index)}
                                index={index}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function FAQItem({
    question,
    answer,
    isOpen,
    onToggle,
    index
}: {
    question: string;
    answer: string;
    isOpen: boolean;
    onToggle: () => void;
    index: number;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: index * 0.05, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            style={{ willChange: "transform, opacity" }}
            className={`border-t border-white/10 last:border-b transition-all duration-300 ${isOpen ? "border-l-2 border-l-kast-teal pl-4 -ml-4" : ""}`}
        >
            <button
                onClick={onToggle}
                className="w-full py-6 flex items-center justify-between gap-4 text-left group"
            >
                <span className="text-lg md:text-xl font-medium text-white group-hover:text-kast-teal transition-colors">
                    {question}
                </span>
                <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center transition-colors">
                    {isOpen ? (
                        <Minus className="w-5 h-5 text-white/50 group-hover:text-kast-teal transition-colors" />
                    ) : (
                        <Plus className="w-5 h-5 text-white/50 group-hover:text-kast-teal transition-colors" />
                    )}
                </div>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="pb-8 pr-12">
                            <p className="text-zinc-400 text-lg leading-relaxed whitespace-pre-line max-w-2xl">
                                {answer}
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
