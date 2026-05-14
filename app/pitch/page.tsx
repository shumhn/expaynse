"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import {
  ChevronLeft, ChevronRight, Zap, Shield, Globe,
  CheckCircle, User, DollarSign, Check, X
} from "lucide-react";

const ease = [0.16, 1, 0.3, 1] as const;
const fadeUp = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 } };
const card = "rounded-2xl p-6 bg-zinc-900/40 border border-white/20 hover:border-white/30 hover:bg-zinc-900/60 transition-all shadow-xl";

const slides = [
  {
    id: "title",
    content: (
      <div className="relative flex items-center h-full px-6 lg:px-12 overflow-hidden bg-black">
        <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[800px] h-[800px] bg-kast-teal/10 rounded-full blur-[120px] pointer-events-none" />
        <div className="max-w-7xl grid lg:grid-cols-2 gap-16 items-center w-full mx-auto">
          <div className="flex flex-col gap-6 z-10">
            <motion.span
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 1, ease }}
              className="text-kast-teal text-lg font-semibold tracking-widest uppercase"
            >
              Introducing
            </motion.span>
            <motion.h1
              {...fadeUp}
              transition={{ duration: 1, ease }}
              className="text-[36px] md:text-[52px] font-medium tracking-tight leading-[1.2] text-white"
            >
              A Real Time{" "}
              <span className="text-kast-teal">Private</span> Payroll.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 1, ease }}
              className="text-2xl md:text-3xl text-gray-400 max-w-2xl leading-relaxed"
            >
              Instant and confidential settlement.
            </motion.p>
          </div>
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3, duration: 1, ease }}
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
      </div>
    ),
  },
  {
    id: "hook",
    content: (
      <div className="relative flex flex-col items-center justify-center h-full text-center max-w-5xl mx-auto px-6 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_48%,rgba(30,186,152,0.16),transparent_34%),radial-gradient(circle_at_28%_78%,rgba(30,186,152,0.06),transparent_24%)]" />
        <motion.p
          initial={{ opacity: 0, y: -18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease }}
          className="relative z-10 mb-8 text-kast-teal text-base md:text-[22px] font-semibold tracking-[0.35em] uppercase"
        >
          Because
        </motion.p>
        <motion.h1
          {...fadeUp}
          transition={{ delay: 0.15, duration: 1, ease }}
          className="relative z-10 text-[42px] md:text-[68px] lg:text-[78px] font-medium tracking-tight text-white mb-8 leading-[1.1] max-w-5xl"
        >
          Salaries were never meant to
          <br />
          be <span className="text-kast-teal">public on chain</span>.
        </motion.h1>
        <motion.p
          {...fadeUp}
          transition={{ delay: 0.38, duration: 1, ease }}
          className="relative z-10 text-[18px] md:text-[28px] text-gray-400 leading-[1.4] max-w-3xl"
        >
          Payroll should be private — whether paid monthly or streamed every second.
        </motion.p>
      </div>
    ),
  },
  {
    id: "problems",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-12">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">The Challenge</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Problems</h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 mb-6">
          {[
            { tag: "SPEED", stat: "78%", desc: "of U.S. workers would face financial difficulty if a paycheck were delayed by one week.", source: "PayrollOrg" },
            { tag: "PRIVACY", stat: "80%", desc: "of 755 employees preferred to hide salary information from coworkers.", source: "UCLA / Harvard Business School" },
            { tag: "ADOPTION", stat: "Adoption blocker", desc: "Companies want faster payroll on-chain, but public balance, salary, and burn-rate visibility makes it nearly impossible to adopt." },
          ].map((c, i) => (
            <motion.div key={i} {...fadeUp} transition={{ delay: i * 0.12, duration: 0.8, ease }} className="bg-zinc-900/40 border border-white/20 rounded-2xl p-6 shadow-xl flex flex-col relative">
              <p className="text-[11px] font-bold text-gray-500 uppercase tracking-[0.25em] mb-4">{c.tag}</p>
              <p className="text-3xl font-bold text-kast-teal mb-4">{c.stat}</p>
              <p className="text-sm font-semibold text-white leading-relaxed flex-grow">{c.desc}</p>
              {c.source && (
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-6">
                  Source: {c.source}
                </p>
              )}
            </motion.div>
          ))}
        </div>

        <motion.div {...fadeUp} transition={{ delay: 0.4, duration: 0.8, ease }} className="bg-zinc-900/40 border border-white/20 rounded-2xl p-8 w-full shadow-xl">
          <p className="text-xl font-bold text-white flex justify-between items-center">
            <span>Solving these problems unlocks a <span className="text-kast-teal">$13 Trillion</span> payroll market.</span>
            <span className="text-[10px] font-normal text-gray-500 uppercase tracking-widest">Source: FRED / BEA</span>
          </p>
        </motion.div>
      </div>
    ),
  },
  {
    id: "solution",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="mb-12">
          <h2 className="text-[26px] md:text-3xl lg:text-[36px] font-bold text-white tracking-tight uppercase whitespace-nowrap">SOLUTION — OUR PRIVATE PAYROLL WITH TWO PAYOUT MODES</h2>
          <p className="text-kast-teal text-lg font-bold tracking-[0.2em] mt-10 uppercase">Expaynse</p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 mt-12">
          {[
            {
              tag: "MODE 1 · INSTANT",
              title: "Instant private payouts",
              desc: "Companies can fund and distribute batch payroll while keeping all compensation data strictly confidential."
            },
            {
              tag: "MODE 2 · REAL-TIME",
              title: "Per-second streaming",
              desc: "Employees get access to their pay in real-time as they earn it, without exposing their income to the public."
            },
            {
              tag: "COMPLIANCE",
              title: "Enterprise controls",
              desc: "Keep sensitive data completely hidden from competitors while instantly generating clean reports for accounting."
            }
          ].map((c, i) => (
            <motion.div key={i} {...fadeUp} transition={{ delay: i * 0.12, duration: 0.8, ease }} className="bg-zinc-900/40 border border-white/20 rounded-2xl p-8 shadow-xl flex flex-col justify-start min-h-[180px]">
              <p className="text-[11px] font-bold text-gray-500 uppercase tracking-[0.25em] mb-4">{c.tag}</p>
              <p className="text-2xl font-bold text-kast-teal mb-4 leading-tight">{c.title}</p>
              <p className="text-base font-medium text-white/90 leading-relaxed">{c.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "market-opportunity",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-14">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">Why now</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Market Opportunity</h2>
          <p className="text-lg text-gray-400 max-w-3xl mx-auto mt-4 leading-relaxed">
            Stablecoin payroll is growing fast, but compensation privacy is still missing.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { value: "$1.14B", label: "Crypto payroll market (2024)" },
            { value: "22.7%", label: "CAGR to 2033" },
            { value: "$8.41B", label: "Projected market (2033)" },
            { value: "12,000+", label: "DAOs managing $28B" },
          ].map((stat, idx) => (
            <motion.div
              key={idx}
              {...fadeUp}
              transition={{ delay: idx * 0.1, duration: 0.8, ease }}
              className={`${card} text-center p-8 min-h-[170px] flex flex-col justify-center`}
            >
              <p className="text-4xl md:text-5xl font-bold text-kast-teal mb-4">{stat.value}</p>
              <p className="text-sm md:text-base font-semibold text-white/80 uppercase tracking-wider leading-relaxed">{stat.label}</p>
            </motion.div>
          ))}
        </div>

        <motion.div
          {...fadeUp}
          transition={{ delay: 0.45, duration: 0.8, ease }}
          className="bg-zinc-900/40 border border-white/20 rounded-2xl p-8 shadow-xl"
        >
          <p className="text-lg text-white font-semibold leading-relaxed">
            Cross-border payment flows are moving from <span className="text-kast-teal">$39.9T</span> in 2024
            toward <span className="text-kast-teal">$64.5T</span> by 2032, and crypto rails can reduce fees by up to
            <span className="text-kast-teal"> 95%</span> compared with SWIFT.
          </p>
          <p className="text-base text-gray-400 mt-5 leading-relaxed">
            Stablecoin payroll crossed the early-adopter chasm, but no protocol offers salary privacy by default.
          </p>
        </motion.div>
      </div>
    ),
  },
  {
    id: "target-markets",
    content: (
      <div className="flex flex-col h-full justify-center max-w-5xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-14">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">Who we serve</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Target Markets</h2>
        </motion.div>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            { icon: DollarSign, text: "Companies paying teams in StableCoins" },
            { icon: Globe, text: "DAOs paying contributors globally" },
            { icon: Zap, text: "Crypto-native teams with remote workforces" },
            { icon: Shield, text: "Companies wanting on-chain payroll with compensation privacy" },
          ].map((item, idx) => (
            <motion.div key={idx} {...fadeUp} transition={{ delay: idx * 0.12, duration: 0.8, ease }} className={`${card} flex items-center gap-6 p-8 min-h-[160px]`}>
              <div className="p-4 bg-kast-teal/10 rounded-2xl shrink-0"><item.icon className="w-8 h-8 text-kast-teal" /></div>
              <p className="text-lg font-semibold text-white leading-relaxed">{item.text}</p>
            </motion.div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "competitive",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-12">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">How we compare</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Competitive Landscape</h2>
        </motion.div>
        <motion.div {...fadeUp} transition={{ delay: 0.2, duration: 0.8, ease }} className="w-full rounded-2xl bg-zinc-900/40 border border-white/20 overflow-hidden shadow-xl">
          <div className="grid grid-cols-5 text-left border-b border-white/20 bg-zinc-900/60 text-sm font-bold text-gray-400 uppercase tracking-wider divide-x divide-white/10">
            <div className="py-5 px-8 flex items-center">Company</div>
            <div className="py-5 px-8 flex items-center">Real-time</div>
            <div className="py-5 px-8 flex items-center">Payroll logic</div>
            <div className="py-5 px-8 flex items-center">Private on-chain</div>
            <div className="py-5 px-8 flex items-center">Best fit</div>
          </div>
          <div className="divide-y divide-white/10">
            {[
              { company: "Zebec", realtime: true, logic: "Partial", priv: "No", fit: "Crypto payroll streams", hl: false },
              { company: "Superfluid", realtime: true, logic: "No", priv: "No", fit: "Token streaming infra", hl: false },
              { company: "Gusto", realtime: false, logic: "Yes", priv: "Off-chain", fit: "SMB payroll compliance", hl: false },
              { company: "Expaynse", realtime: true, logic: "Yes", priv: "Yes — PER", fit: "Private real-time payroll", hl: true },
            ].map((row, idx) => (
              <div key={idx} className={`grid grid-cols-5 items-stretch text-[17px] divide-x divide-white/10 transition-colors ${row.hl ? "bg-kast-teal/[0.05] shadow-[inset_0_0_30px_rgba(30,186,152,0.08)]" : "bg-transparent hover:bg-white/[0.04]"}`}>
                <div className={`py-6 px-8 flex items-center font-bold ${row.hl ? "text-kast-teal text-2xl drop-shadow-[0_0_12px_rgba(30,186,152,0.6)]" : "text-white"}`}>{row.company}</div>
                <div className="py-6 px-8 flex items-center">{row.realtime ? <Check className="w-6 h-6 text-kast-teal" /> : <X className="w-6 h-6 text-red-400" />}</div>
                <div className="py-6 px-8 flex items-center text-white/90 font-medium">{row.logic}</div>
                <div className="py-6 px-8 flex items-center"><span className={`px-4 py-2 rounded-full text-sm font-bold tracking-wide whitespace-nowrap ${row.priv.startsWith("Yes") ? "bg-kast-teal/20 text-kast-teal border border-kast-teal/50 shadow-[0_0_10px_rgba(30,186,152,0.2)]" : row.priv === "Off-chain" ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>{row.priv}</span></div>
                <div className="py-6 px-8 flex items-center text-white/90 font-medium">{row.fit}</div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    ),
  },
  {
    id: "business-model",
    content: (
      <div className="flex flex-col h-full justify-center max-w-5xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-14">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">Revenue Streams</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Business Model</h2>
        </motion.div>
        <div className="grid md:grid-cols-2 gap-6">
          <motion.div {...fadeUp} transition={{ delay: 0.1, duration: 0.8, ease }} className={`${card} p-10 flex flex-col items-center text-center`}>
            <p className="text-base text-kast-teal mb-5 font-bold uppercase tracking-[0.15em]">Recurring Revenue</p>
            <div className="text-6xl font-bold text-white mb-2 flex items-baseline justify-center">
              $99<span className="text-4xl text-gray-300 ml-3">– $499</span>
            </div>
            <p className="text-kast-teal font-mono text-base mb-10">/ month</p>
            <ul className="space-y-5 text-lg text-white font-semibold text-left w-full max-w-[280px]">
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Dashboard Access</li>
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Private Payroll Vaults</li>
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Advanced Reporting</li>
            </ul>
          </motion.div>
          <motion.div {...fadeUp} transition={{ delay: 0.25, duration: 0.8, ease }} className={`${card} p-10 flex flex-col items-center text-center`}>
            <p className="text-base text-kast-teal mb-5 font-bold uppercase tracking-[0.15em]">Active Worker Fee</p>
            <div className="text-6xl font-bold text-kast-teal mb-2 flex items-baseline justify-center">
              $3<span className="text-4xl text-kast-teal/90 ml-3">– $8</span>
            </div>
            <p className="text-gray-300 font-mono text-base mb-10">one-time / worker</p>
            <ul className="space-y-5 text-lg text-white font-semibold text-left w-full max-w-[280px]">
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Private Balance Accounts</li>
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Claim Gas Subsidization</li>
              <li className="flex items-center gap-4"><CheckCircle className="w-6 h-6 text-kast-teal shrink-0" /> Payment History Verification</li>
            </ul>
          </motion.div>
        </div>
      </div>
    ),
  },
  {
    id: "why-solana",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-14">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">Infrastructure</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">
            Why <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#14F195] to-[#9945FF]">Solana</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-4 leading-relaxed">Solana already has the stablecoin payment activity needed for payroll.</p>
        </motion.div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {[
            { value: "$1T+", label: "Stablecoin volume 2025" },
            { value: "$200B", label: "Monthly transfers" },
            { value: "$15.4B", label: "Stablecoin market cap" },
            { value: "$11.7T", label: "U.S. wages & salaries" },
          ].map((stat, idx) => (
            <motion.div key={idx} {...fadeUp} transition={{ delay: idx * 0.1, duration: 0.8, ease }} className={`${card} text-center p-8`}>
              <p className="text-4xl md:text-5xl font-bold text-kast-teal mb-4">{stat.value}</p>
              <p className="text-sm md:text-base font-semibold text-white/80 uppercase tracking-wider">{stat.label}</p>
            </motion.div>
          ))}
        </div>
        <motion.div {...fadeUp} transition={{ delay: 0.5, duration: 0.8, ease }} className="rounded-full py-4 px-8 text-center max-w-2xl mx-auto w-full bg-white/5 border border-white/20 backdrop-blur-sm shadow-[0_0_15px_rgba(255,255,255,0.05)]">
          <p className="text-base text-gray-300 font-medium tracking-wide">
            Trusted by <span className="text-white font-bold">PayPal</span>, <span className="text-white font-bold">Visa</span>, <span className="text-white font-bold">Western Union</span>, <span className="text-white font-bold">Worldpay</span>, and <span className="text-white font-bold">Fiserv</span>.
          </p>
        </motion.div>
        <p className="text-xs text-gray-400 text-center mt-6 tracking-wide">Sources: CoinMarketCap, DLNews, CryptoRank, BLS QCEW 2024</p>
      </div>
    ),
  },
  {
    id: "team",
    content: (
      <div className="flex flex-col h-full justify-center max-w-6xl mx-auto px-6 w-full">
        <motion.div {...fadeUp} transition={{ duration: 1, ease }} className="text-center mb-14">
          <p className="text-kast-teal text-sm font-semibold tracking-wide uppercase mb-4">The team behind Expaynse</p>
          <h2 className="text-[40px] md:text-[52px] font-medium text-white tracking-tight">Team</h2>
          <p className="text-lg text-gray-400 mt-4 max-w-2xl mx-auto leading-relaxed">Founder-led execution with the right mix: payments, product, operations, and marketing.</p>
        </motion.div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              name: "Shuman",
              role: "Founder",
              desc: "Solana Minihack Nepal 2026 Winner • 2nd at MagicBlock Privacy Blitz V3 • Superteam Nepal Member",
            },
            { name: "Mohit", role: "Full Stack Dev", desc: "2 years full-stack experience. Shipped multiple fintech and high-scale commerce projects." },
            { name: "Ananda", role: "Business Ops", desc: "3 years consulting at Anovox Labs. Specialist in scaling bootstrapped startups." },
            { name: "Isha", role: "Marketing Lead", desc: "Luminar Network marketer. Expert in cross-channel growth and community building." },
          ].map((member, idx) => (
            <motion.div key={idx} {...fadeUp} transition={{ delay: idx * 0.1, duration: 0.8, ease }} className={`${card} text-center p-8 relative overflow-hidden group`}>
              <div className="w-16 h-16 mx-auto rounded-full mb-5 border border-white/10 overflow-hidden flex items-center justify-center bg-kast-teal/10 group-hover:border-kast-teal/40 transition-colors duration-500">
                <User className="w-7 h-7 text-kast-teal/60" />
              </div>
              <h3 className="text-xl font-bold text-white mb-1 group-hover:text-kast-teal transition-colors">{member.name}</h3>
              <p className="text-xs text-kast-teal font-semibold tracking-widest uppercase mb-4">{member.role}</p>
              <p className="text-sm text-white/60 leading-relaxed font-medium">{member.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    ),
  },
];

export default function PitchDeck() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const nextSlide = useCallback(() => setCurrentSlide((p) => (p === slides.length - 1 ? p : p + 1)), []);
  const prevSlide = useCallback(() => setCurrentSlide((p) => (p === 0 ? p : p - 1)), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") nextSlide();
      else if (e.key === "ArrowLeft") prevSlide();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [nextSlide, prevSlide]);

  const progress = ((currentSlide + 1) / slides.length) * 100;

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden flex flex-col z-[100] selection:bg-kast-teal/30 selection:text-black">
      <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[800px] h-[800px] bg-kast-teal/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="absolute top-0 left-0 w-full h-[2px] z-50 bg-white/5">
        <motion.div className="h-full bg-kast-teal" initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 0.3 }} />
      </div>

      <div className="absolute top-0 left-0 w-full z-50 px-6 lg:px-12 py-5 flex items-center gap-3">
        <div className="relative w-8 h-8">
          <Image src="/logo.png" alt="Expaynse Logo" fill className="object-contain invert mix-blend-screen" />
        </div>
        <span className="text-white text-lg font-semibold tracking-tight">Expaynse</span>
      </div>

      <div className="relative flex-1 z-10 w-full h-full">
        <AnimatePresence mode="wait">
          <motion.div key={currentSlide} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.4, ease }} className="absolute inset-0 w-full h-full">
            {slides[currentSlide].content}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="absolute bottom-0 left-0 w-full p-6 z-50 flex justify-between items-center">
        <span className="text-xs font-mono text-gray-500"><span className="text-white font-semibold">{currentSlide + 1}</span> / {slides.length}</span>
        <div className="flex gap-3">
          <button onClick={prevSlide} disabled={currentSlide === 0} className="p-2.5 rounded-full bg-zinc-900/40 border border-white/10 hover:border-kast-teal/30 disabled:opacity-20 disabled:cursor-not-allowed transition-all"><ChevronLeft className="w-5 h-5" /></button>
          <button onClick={nextSlide} disabled={currentSlide === slides.length - 1} className="p-2.5 rounded-full bg-kast-teal text-black hover:scale-105 disabled:opacity-20 disabled:cursor-not-allowed transition-all"><ChevronRight className="w-5 h-5" /></button>
        </div>
      </div>
    </div>
  );
}
