import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Lock,
  FileText,
  Code2,
  Unlock,
} from "lucide-react";

export function Footer() {
  return (
    <>
      {/* ============================================
          KEY BENEFITS
      ============================================ */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-transparent">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-4xl sm:text-5xl font-bold tracking-tight text-black mb-6">
                Built for teams that value privacy
              </h2>
              <p className="text-lg text-gray-500 mb-8">
                Expaynse provides real financial privacy without compromising on
                the features modern teams need from payroll infrastructure.
              </p>

              <div className="space-y-6">
                {[
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
                ].map((benefit) => (
                  <div key={benefit.title} className="flex gap-4">
                    <div className="flex-shrink-0 w-6 h-6 bg-gray-50 rounded-full flex items-center justify-center mt-1">
                      <CheckCircle2 className="w-4 h-4 text-[#5b9cac]" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-black mb-1">
                        {benefit.title}
                      </h4>
                      <p className="text-gray-500 text-sm">{benefit.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-gray-50 rounded-3xl p-8 border border-gray-100 shadow-inner">
              <div className="grid grid-cols-2 gap-6">
                {[
                  { value: "1 sec", label: "Streaming granularity" },
                  { value: "Private", label: "Settlement layer" },
                  { value: "0 bytes", label: "Salary data exposed" },
                  { value: "Full", label: "Employer lifecycle control" },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="bg-white rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow border border-gray-100"
                  >
                    <div className="text-3xl font-bold text-black mb-2">
                      {stat.value}
                    </div>
                    <div className="text-sm text-gray-500">{stat.label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-8 p-8 bg-black rounded-3xl shadow-xl">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 bg-[#5b9cac] rounded-full flex items-center justify-center">
                    <Lock className="w-4 h-4 text-black" />
                  </div>
                  <span className="text-white font-bold tracking-tight">
                    Privacy by Default
                  </span>
                </div>
                <p className="text-gray-400 text-sm leading-relaxed">
                  Every operation in Expaynse is private by default. No
                  configuration needed. No opt-in required. Privacy is the
                  foundation, not a feature.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>





      {/* ============================================
          FINAL CTA
      ============================================ */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-transparent">
        <div className="max-w-7xl mx-auto">
          <div className="bg-[#00E559] rounded-[3.5rem] p-12 md:p-24 relative overflow-hidden shadow-2xl shadow-emerald-500/20">
            <div className="absolute top-0 right-0 w-1/2 h-full bg-white/5 skew-x-12 translate-x-1/2" />

            <div className="relative z-10 max-w-2xl">
              <h2 className="text-5xl sm:text-7xl font-bold tracking-tight text-black mb-8 leading-[1.1]">
                Ready to stream <br />
                <span className="opacity-40">salaries privately?</span>
              </h2>
              <p className="text-xl text-black/70 mb-12 font-medium leading-relaxed">
                Join teams that value financial privacy. Start streaming salaries
                with per-second accrual and private settlements today.
              </p>

              <div className="flex flex-col sm:flex-row gap-6">
                <Link
                  href="/dashboard"
                  className="bg-black text-white px-10 py-5 text-lg rounded-full font-bold flex items-center justify-center gap-2 no-underline hover:scale-105 transition-all shadow-xl"
                >
                  Get Started Now
                  <ArrowRight size={20} />
                </Link>
                <Link
                  href="/claim/dashboard"
                  className="bg-white/20 backdrop-blur-md border border-black/5 text-black px-10 py-5 text-lg rounded-full font-bold flex items-center justify-center gap-2 no-underline hover:bg-white/40 transition-all"
                >
                  Receive Payments
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>


      {/* ============================================
          FOOTER
      ============================================ */}
      <footer className="bg-transparent py-16 px-4 sm:px-6 lg:px-8 border-t border-gray-200">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-4 gap-12 mb-12">
            {/* Brand */}
            <div className="md:col-span-2">
              <div className="flex items-center gap-2 mb-8">
                <img src="/logo.png" alt="Expaynse" className="h-20 w-auto mix-blend-multiply" />
              </div>
              <p className="text-gray-500 mb-6 max-w-sm">
                Privacy-first payroll infrastructure for Solana. Real-time
                streaming, MagicBlock private settlements, complete salary
                confidentiality.
              </p>
              <p className="text-sm text-gray-400">
                Built for Solana Privacy Hackathon 2026
              </p>
            </div>

            {/* Resources */}
            <div>
              <h4 className="text-black font-semibold mb-4">Product</h4>
              <ul className="space-y-3 list-none p-0 m-0">
                <li>
                  <Link
                    href="/treasury"
                    className="text-gray-500 hover:text-black transition-colors text-sm no-underline"
                  >
                    Treasury
                  </Link>
                </li>
                <li>
                  <Link
                    href="/disburse"
                    className="text-gray-500 hover:text-black transition-colors text-sm no-underline"
                  >
                    Send Payroll
                  </Link>
                </li>
                <li>
                  <Link
                    href="/claim/dashboard"
                    className="text-gray-500 hover:text-black transition-colors text-sm no-underline"
                  >
                    Receive & Withdraw
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard"
                    className="text-gray-500 hover:text-black transition-colors text-sm no-underline"
                  >
                    Dashboard
                  </Link>
                </li>
              </ul>
            </div>

            {/* Connect */}
            <div>
              <h4 className="text-black font-semibold mb-4">
                Technology
              </h4>
              <ul className="space-y-3 list-none p-0 m-0">
                <li className="text-gray-500 text-sm">Solana</li>
                <li className="text-gray-500 text-sm">MagicBlock PER</li>
                <li className="text-gray-500 text-sm">TEE Authentication</li>
                <li className="text-gray-500 text-sm">Metaplex Core</li>
              </ul>
            </div>
          </div>

          {/* Bottom */}
          <div className="border-t border-gray-200 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-sm text-gray-400">
              © {new Date().getFullYear()} Expaynse. Open source under MIT
              license.
            </p>
            <p className="text-sm text-gray-400">
              Private payroll, per-second streaming, on Solana 🔒
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
