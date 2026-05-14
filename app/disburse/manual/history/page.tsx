"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import {
  ChevronLeft,
  Download,
  FileJson,
  History,
  Loader2,
  RefreshCw,
  Users,
  Wallet,
} from "lucide-react";

import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

type PrivatePayrollRun = {
  id: string;
  date: string;
  mode?: "streaming" | "private_payroll";
  totalAmount: number;
  employeeCount: number;
  employeeIds?: string[];
  employeeNames?: string[];
  recipientAddresses: string[];
  depositSig?: string;
  transferSig?: string;
  status: "success" | "failed";
};

function downloadJson(filename: string, payload: unknown) {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadCsv(filename: string, rows: string[][]) {
  if (typeof window === "undefined") return;
  const csv = rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(","),
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function PrivatePayrollHistoryPage() {
  const { publicKey, signMessage, connected } = useWallet();
  const [runs, setRuns] = useState<PrivatePayrollRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const wallet = publicKey?.toBase58() ?? "";

  const fetchRuns = useCallback(async () => {
    if (!wallet || !signMessage) return;
    try {
      setLoading(true);
      const response = await walletAuthenticatedFetch({
        wallet,
        signMessage,
        path: `/api/history?wallet=${wallet}`,
        method: "GET",
      });
      const payload = (await response.json()) as {
        payrollRuns?: PrivatePayrollRun[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to load private payroll history");
      }

      setRuns(
        (payload.payrollRuns ?? []).filter(
          (run) => run.mode === "private_payroll",
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load private payroll history";
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }, [wallet, signMessage]);

  useEffect(() => {
    if (!wallet || !signMessage) return;
    void fetchRuns().catch(() => undefined);
  }, [wallet, signMessage, fetchRuns]);

  const filteredRuns = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => {
      const employeeNames = run.employeeNames?.join(" ").toLowerCase() ?? "";
      const recipients = run.recipientAddresses.join(" ").toLowerCase();
      return (
        employeeNames.includes(needle) ||
        recipients.includes(needle) ||
        run.totalAmount.toString().includes(needle) ||
        new Date(run.date).toLocaleString().toLowerCase().includes(needle)
      );
    });
  }, [runs, search]);

  const summary = useMemo(() => {
    return {
      count: filteredRuns.length,
      totalAmount: filteredRuns.reduce((sum, run) => sum + run.totalAmount, 0),
      totalRecipients: filteredRuns.reduce(
        (sum, run) => sum + run.employeeCount,
        0,
      ),
      failedCount: filteredRuns.filter((run) => run.status === "failed").length,
    };
  }, [filteredRuns]);

  const employeeRollup = useMemo(() => {
    const map = new Map<
      string,
      { name: string; amount: number; runs: number; recipients: number }
    >();

    for (const run of filteredRuns) {
      const names =
        run.employeeNames && run.employeeNames.length > 0
          ? run.employeeNames
          : run.recipientAddresses.map(
              (address) => `${address.slice(0, 4)}...${address.slice(-4)}`,
            );

      for (const name of names) {
        const current = map.get(name) ?? {
          name,
          amount: 0,
          runs: 0,
          recipients: 0,
        };
        current.amount += run.totalAmount / Math.max(names.length, 1);
        current.runs += 1;
        current.recipients += 1;
        map.set(name, current);
      }
    }

    return Array.from(map.values()).sort((left, right) => right.amount - left.amount);
  }, [filteredRuns]);

  const exportRunsJson = () => {
    downloadJson(
      `expaynse_private_payroll_runs_${new Date().toISOString().split("T")[0]}.json`,
      filteredRuns,
    );
  };

  const exportRunsCsv = () => {
    downloadCsv(
      `expaynse_private_payroll_runs_${new Date().toISOString().split("T")[0]}.csv`,
      [
        [
          "date",
          "status",
          "total_amount_usdc",
          "employee_count",
          "employee_names",
          "deposit_sig",
          "transfer_sig",
        ],
        ...filteredRuns.map((run) => [
          run.date,
          run.status,
          run.totalAmount.toFixed(2),
          String(run.employeeCount),
          (run.employeeNames ?? []).join(" | "),
          run.depositSig ?? "",
          run.transferSig ?? "",
        ]),
      ],
    );
  };

  if (!connected) {
    return (
      <EmployerLayout>
        <div className="mx-auto max-w-5xl">
          <div className="rounded-[2.5rem] border border-white/10 bg-white/5 p-12 text-center">
            <Wallet size={28} className="mx-auto mb-4 text-[#a8a8aa]" />
            <p className="text-lg font-bold text-white">Connect your wallet</p>
            <p className="mt-2 text-sm text-[#8f8f95]">
              Private payroll history is available once you connect your employer wallet.
            </p>
          </div>
        </div>
      </EmployerLayout>
    );
  }

  return (
    <EmployerLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link
              href="/disburse/manual"
              className="group mb-5 inline-flex items-center gap-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-50 font-lexend"
            >
              <ChevronLeft
                size={14}
                className="transition-transform group-hover:-translate-x-0.5"
              />
              Back to Private Payroll
            </Link>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Private Payroll History
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-[#a8a8aa]">
              Dedicated employer-side run history, employee rollups, and export
              reporting for the `private_payroll` mode.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void fetchRuns().catch(() => undefined)}
              disabled={loading}
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Refresh
            </button>
            <button
              onClick={exportRunsCsv}
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition-colors hover:bg-white/10"
            >
              <Download size={16} />
              Export CSV
            </button>
            <button
              onClick={exportRunsJson}
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition-colors hover:bg-white/10"
            >
              <FileJson size={16} />
              Export JSON
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">
              Private Runs
            </p>
            <p className="mt-2 text-2xl font-bold text-white">{summary.count}</p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">
              Total Volume
            </p>
            <p className="mt-2 text-2xl font-bold text-white">
              {summary.totalAmount.toFixed(2)} USDC
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">
              Recipients
            </p>
            <p className="mt-2 text-2xl font-bold text-white">{summary.totalRecipients}</p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a8a8aa]">
              Failed Runs
            </p>
            <p className="mt-2 text-2xl font-bold text-white">{summary.failedCount}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1.9fr]">
          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-6">
            <div className="mb-5 flex items-center gap-3">
              <Users size={18} className="text-[#1eba98]" />
              <h2 className="text-lg font-bold text-white">Employee Rollup</h2>
            </div>
            <div className="space-y-3">
              {employeeRollup.length > 0 ? (
                employeeRollup.map((item) => (
                  <div
                    key={item.name}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-bold text-white">{item.name}</p>
                      <p className="text-sm font-bold text-[#84f7dc]">
                        {item.amount.toFixed(2)} USDC
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-[#8f8f95]">
                      {item.runs} run{item.runs === 1 ? "" : "s"} · {item.recipients} payout
                      {item.recipients === 1 ? "" : "s"}
                    </p>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-[#8f8f95]">
                  No private payroll runs yet.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#0a0a0a] p-6">
            <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <History size={18} className="text-[#1eba98]" />
                <h2 className="text-lg font-bold text-white">Run Statements</h2>
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search employees, addresses, or amounts"
                className="h-11 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm text-white outline-none placeholder:text-[#8f8f95] focus:border-[#1eba98]/40"
              />
            </div>

            <div className="space-y-3">
              {filteredRuns.length > 0 ? (
                filteredRuns.map((run) => (
                  <div
                    key={run.id}
                    className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="font-bold text-white">
                          {run.totalAmount.toFixed(2)} USDC to {run.employeeCount}{" "}
                          {run.employeeCount === 1 ? "employee" : "employees"}
                        </p>
                        <p className="mt-1 text-xs text-[#8f8f95]">
                          {new Date(run.date).toLocaleString()}
                        </p>
                        <p className="mt-2 text-sm text-[#c8c8cc]">
                          {(run.employeeNames ?? []).length > 0
                            ? run.employeeNames?.join(", ")
                            : run.recipientAddresses.join(", ")}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] ${
                            run.status === "success"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-red-500/15 text-red-300"
                          }`}
                        >
                          {run.status}
                        </span>
                        <button
                          onClick={() =>
                            downloadJson(
                              `expaynse_private_payroll_run_${run.id}.json`,
                              run,
                            )
                          }
                          className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
                        >
                          Export JSON
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-[#8f8f95]">
                  No matching private payroll runs yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </EmployerLayout>
  );
}
