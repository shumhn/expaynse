"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";

import Appbar from "@/components/app-bar";
import { ConnectWalletBtn } from "@/components/connect-wallet-btn";
import { useWallet } from "@/hooks/useWallet";
import {
  getHomePathForRole,
  getWalletRole,
  saveWalletRole,
  type WalletRole,
} from "@/lib/storage";

const roleOptions: Array<{
  role: WalletRole;
  title: string;
  eyebrow: string;
  description: string;
  destination: string;
  points: string[];
}> = [
  {
    role: "employer",
    title: "Employer workspace",
    eyebrow: "Run payroll",
    description:
      "Manage team setup, fund payroll, and control private salary flows from the employer dashboard.",
    destination: "Dashboard",
    points: [
      "Manage employees and payroll controls",
      "Fund treasury and run private disbursements",
      "Track setup and history in one place",
    ],
  },
  {
    role: "employee",
    title: "Employee workspace",
    eyebrow: "Receive salary",
    description:
      "Open the receive dashboard to track private payroll, initialize once, and claim available balance.",
    destination: "Receive",
    points: [
      "See live claimable and payout history",
      "Initialize private recipient once",
      "Request base payout when needed",
    ],
  },
];

async function detectWalletDefaultRole(walletAddress: string): Promise<WalletRole> {
  try {
    const res = await fetch(
      `/api/employee-private-init?employeeWallet=${encodeURIComponent(walletAddress)}`,
      { method: "GET", cache: "no-store" },
    );

    if (!res.ok) {
      return "employer";
    }

    const json = (await res.json()) as { registered?: boolean };
    return json.registered ? "employee" : "employer";
  } catch {
    return "employer";
  }
}

export default function GetStartedPage() {
  const router = useRouter();
  const wallet = useWallet();
  const [selectedRole, setSelectedRole] = useState<WalletRole | null>(null);
  const [pendingAutoContinue, setPendingAutoContinue] = useState(false);
  const [savedRoleLoaded, setSavedRoleLoaded] = useState(false);
  const [isRouting, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    const walletKey = wallet.publicKey;
    if (!wallet.connected || !walletKey) {
      const timeoutId = window.setTimeout(() => {
        setSavedRoleLoaded(true);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    const resolveRole = async () => {
      const storedRole = getWalletRole(walletKey);
      if (storedRole) {
        if (!cancelled) {
          setSelectedRole((current) => current ?? storedRole);
          setSavedRoleLoaded(true);
        }
        return;
      }

      const detectedRole = await detectWalletDefaultRole(walletKey);
      if (cancelled) return;

      saveWalletRole(walletKey, detectedRole);
      setSelectedRole((current) => current ?? detectedRole);
      setSavedRoleLoaded(true);
    };

    void resolveRole();
    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.publicKey]);

  const routeWithRole = useCallback((role: WalletRole) => {
    if (!wallet.publicKey) return;

    saveWalletRole(wallet.publicKey, role);
    startTransition(() => {
      router.push(getHomePathForRole(role));
    });
  }, [router, startTransition, wallet.publicKey]);

  function handleRolePick(role: WalletRole) {
    setSelectedRole(role);

    if (wallet.connected && wallet.publicKey) {
      routeWithRole(role);
      return;
    }

    setPendingAutoContinue(true);
  }

  useEffect(() => {
    if (
      !pendingAutoContinue ||
      !selectedRole ||
      !wallet.connected ||
      !wallet.publicKey
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPendingAutoContinue(false);
      routeWithRole(selectedRole);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [pendingAutoContinue, selectedRole, wallet.connected, wallet.publicKey, routeWithRole]);

  const activeRole = roleOptions.find((item) => item.role === selectedRole) ?? null;

  return (
    <div className="min-h-screen bg-black">
      <Appbar />

      <main className="relative overflow-hidden px-4 pb-20 pt-28 sm:px-6 lg:px-8">
        <div className="absolute inset-x-0 top-0 -z-10 h-[480px] bg-[radial-gradient(circle_at_top,rgba(30,186,152,0.15),transparent_58%),linear-gradient(180deg,rgba(30,186,152,0.08),transparent_72%)]" />

        <div className="mx-auto max-w-7xl">
          <section className="rounded-[2rem] border border-white/5 bg-[#0a0a0a]/90 p-6 shadow-[0_25px_90px_rgba(0,0,0,0.3)] backdrop-blur sm:p-8 lg:p-12">
            <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-[#1eba98]/30 bg-[#1eba98]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#1eba98]">
                  <Sparkles size={14} />
                  Choose your workspace
                </div>

                <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-[-0.05em] text-white sm:text-5xl lg:text-6xl">
                  Start in the right payroll flow from the first click.
                </h1>

                <p className="mt-5 max-w-2xl text-base leading-8 text-[#a8a8aa] sm:text-lg">
                  New wallet is defaulted automatically: if this address is already
                  registered as an employee, we set Employee mode; otherwise Employer mode.
                  You can still switch here anytime.
                </p>

                <div className="mt-8 grid gap-4 sm:grid-cols-2">
                  {roleOptions.map((option) => {
                    const isActive = selectedRole === option.role;
                    const Icon =
                      option.role === "employer" ? BriefcaseBusiness : Wallet;

                    return (
                      <button
                        key={option.role}
                        type="button"
                        onClick={() => handleRolePick(option.role)}
                        className={`group rounded-[1.75rem] border px-5 py-5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1eba98] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
                          isActive
                            ? "border-[#1eba98] bg-[#1eba98]/10 text-white shadow-[0_20px_50px_rgba(30,186,152,0.15)]"
                            : "border-white/10 bg-white/5 text-white hover:border-white/20 hover:bg-white/10"
                        }`}
                      >
                        <div
                          className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
                            isActive
                              ? "bg-[#1eba98]/20 text-[#1eba98]"
                              : "bg-white/5 text-white shadow-sm"
                          }`}
                        >
                          <Icon size={22} />
                        </div>

                        <p
                          className={`mt-5 text-[11px] font-semibold uppercase tracking-[0.22em] ${
                            isActive ? "text-[#1eba98]" : "text-[#a8a8aa]"
                          }`}
                        >
                          {option.eyebrow}
                        </p>
                        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">
                          {option.title}
                        </h2>
                        <p
                          className={`mt-3 text-sm leading-7 ${
                            isActive ? "text-white/80" : "text-[#a8a8aa]"
                          }`}
                        >
                          {option.description}
                        </p>

                        <div className="mt-5 flex items-center gap-2 text-sm font-semibold">
                          Open {option.destination}
                          <ArrowRight
                            size={16}
                            className="transition-transform group-hover:translate-x-1"
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-8 rounded-[1.75rem] border border-white/5 bg-white/5 p-5">
                  <p className="text-sm font-semibold text-white">
                    How this flow works
                  </p>
                  <div className="mt-4 grid gap-3 text-sm leading-7 text-[#a8a8aa] sm:grid-cols-3">
                    <div className="rounded-2xl bg-white/5 p-4 shadow-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a8a8aa]">
                        Step 1
                      </span>
                      <p className="mt-2">We detect whether this wallet is employee-registered and pick the default role.</p>
                    </div>
                    <div className="rounded-2xl bg-white/5 p-4 shadow-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a8a8aa]">
                        Step 2
                      </span>
                      <p className="mt-2">Connect the wallet if this is the first time using Expaynse.</p>
                    </div>
                    <div className="rounded-2xl bg-white/5 p-4 shadow-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a8a8aa]">
                        Step 3
                      </span>
                      <p className="mt-2">We save the detected role and route into the matching dashboard.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-[2rem] border border-white/5 bg-[#0a0a0a] p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:p-8">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#a8a8aa]">
                      Wallet onboarding
                    </p>
                    <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                      {activeRole
                        ? `Continue as ${activeRole.role}`
                        : "Pick a role to continue"}
                    </h2>
                  </div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-[#1eba98]">
                    <ShieldCheck size={24} />
                  </div>
                </div>

                <div className="mt-8 rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-sm font-medium text-[#a8a8aa]">Connected wallet</p>
                  <p className="mt-2 text-xl font-semibold tracking-tight text-white">
                    {wallet.connected && wallet.truncated
                      ? wallet.truncated
                      : "No wallet connected yet"}
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[#a8a8aa]">
                    {wallet.connected
                      ? "This wallet can now be linked to the role you selected."
                      : "Choose a role first, then connect the wallet to finish onboarding."}
                  </p>
                </div>

                <div className="mt-6 rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-sm font-medium text-[#a8a8aa]">Current selection</p>
                  <p className="mt-2 text-xl font-semibold tracking-tight text-white">
                    {activeRole ? activeRole.title : "No role selected"}
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[#a8a8aa]">
                    {activeRole
                      ? activeRole.description
                      : "The first role you choose will define which workspace we open after connect."}
                  </p>
                </div>

                {activeRole && (
                  <div className="mt-6 rounded-[1.75rem] border border-[#1eba98]/20 bg-[#1eba98]/5 p-5">
                    <p className="text-sm font-semibold text-[#1eba98]">
                      {activeRole.title} includes
                    </p>
                    <div className="mt-4 space-y-3">
                      {activeRole.points.map((point) => (
                        <div key={point} className="flex items-start gap-3 text-sm text-white/80">
                          <CheckCircle2 size={16} className="mt-1 shrink-0 text-[#1eba98]" />
                          <span>{point}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-8 flex flex-col gap-4">
                  {!activeRole && (
                    <p className="text-sm text-[#a8a8aa]">
                      Choose `Employer` or `Employee` on the left to unlock the next step.
                    </p>
                  )}

                  {activeRole && !wallet.connected && (
                    <div className="flex flex-col items-start gap-3">
                      <ConnectWalletBtn mode="standalone" />
                      <p className="text-sm text-[#a8a8aa]">
                        Once the wallet connects, we will save the role and open the
                        {` ${activeRole.destination.toLowerCase()}`}.
                      </p>
                    </div>
                  )}

                  {activeRole && wallet.connected && (
                    <button
                      type="button"
                      onClick={() => routeWithRole(activeRole.role)}
                      disabled={isRouting}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#1eba98] px-6 py-3 text-sm font-bold text-black transition-all hover:bg-[#1eba98]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-70"
                    >
                      {isRouting
                        ? "Opening workspace..."
                        : `Open ${activeRole.destination}`}
                    </button>
                  )}

                  {savedRoleLoaded && wallet.connected && !activeRole && (
                    <p className="text-sm text-[#a8a8aa]">
                      This wallet does not have a saved role yet. Pick one to continue.
                    </p>
                  )}
                </div>

                <div className="mt-8 border-t border-white/10 pt-6 text-sm text-[#a8a8aa]">
                  Need to switch later? Return here anytime and choose another role
                  for the currently connected wallet.
                </div>
              </div>
            </div>
          </section>

          <div className="mt-6 flex items-center justify-center">
            <Link
              href="/"
              className="text-sm font-medium text-[#a8a8aa] underline-offset-4 transition hover:text-white hover:underline"
            >
              Back to landing page
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
