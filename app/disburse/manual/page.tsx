"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Papa from "papaparse";
import { toast } from "sonner";
import Link from "next/link";
import {
  Plus,
  Trash2,
  Play,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Wallet,
  ExternalLink,
  ChevronLeft,
  X,
} from "lucide-react";

import Appbar from "@/components/app-bar";
import { Footer } from "@/components/footer";
import {
  deposit,
  privateTransfer,
  signAndSend,
  batchSignAndSend,
} from "@/lib/magicblock-api";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

const PRIVATE_PAYOUT_PRIVACY = {
  minDelayMs: 600_000,
  maxDelayMs: 600_000,
  split: 3,
} as const;

interface Employee {
  address: string;
  amount: number;
}

type StepStatus = "pending" | "active" | "done" | "error";

interface Step {
  label: string;
  status: StepStatus;
  sig?: string;
}

interface PayrollSummary {
  totalAmount: number;
  employeeCount: number;
  depositSig?: string;
  transferSig?: string;
}

export default function ManualBatchPayrollPage() {
  const {
    publicKey,
    signTransaction,
    signAllTransactions,
    signMessage,
    connected,
  } = useWallet();

  const [employees, setEmployees] = useState<Employee[]>([
    { address: "", amount: 0 },
  ]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [successModal, setSuccessModal] = useState<PayrollSummary | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(results) {
        const parsed: Employee[] = [];

        for (const row of results.data) {
          if (row.length >= 2) {
            const addr = row[0]?.trim();
            const amt = parseFloat(row[1]);
            if (addr && !Number.isNaN(amt) && amt > 0) {
              parsed.push({ address: addr, amount: amt });
            }
          }
        }

        if (parsed.length === 0) {
          toast.error("No valid rows found. Format: address,amount");
          return;
        }

        setEmployees(parsed);
        toast.success(`Loaded ${parsed.length} employees from CSV`);
      },
    });

    e.target.value = "";
  };

  const addRow = () => {
    setEmployees((prev) => [...prev, { address: "", amount: 0 }]);
  };

  const removeRow = (index: number) => {
    setEmployees((prev) => prev.filter((_, idx) => idx !== index));
  };

  const updateRow = (index: number, field: keyof Employee, value: string) => {
    setEmployees((prev) => {
      const next = [...prev];
      if (field === "amount") {
        next[index] = {
          ...next[index],
          amount: parseFloat(value) || 0,
        };
      } else {
        next[index] = {
          ...next[index],
          address: value,
        };
      }
      return next;
    });
  };

  const totalAmount = useMemo(
    () => employees.reduce((sum, employee) => sum + employee.amount, 0),
    [employees],
  );

  const validEmployees = useMemo(
    () =>
      employees.filter(
        (employee) => employee.address.length >= 32 && employee.amount > 0,
      ),
    [employees],
  );

  const runPayroll = useCallback(async () => {
    if (!publicKey || !signTransaction || !signAllTransactions) return;

    if (validEmployees.length === 0) {
      toast.error("No valid employees to pay");
      return;
    }

    setRunning(true);
    const owner = publicKey.toBase58();

    const initialSteps: Step[] = [
      {
        label: `Deposit ${totalAmount.toFixed(2)} USDC into vault`,
        status: "pending",
      },
      {
        label: `Sign ${validEmployees.length} private transfer${validEmployees.length > 1 ? "s" : ""}`,
        status: "pending",
      },
      ...validEmployees.map(
        (employee) =>
          ({
            label: `Send privately to ${employee.address.slice(0, 4)}...${employee.address.slice(-4)}`,
            status: "pending",
          }) satisfies Step,
      ),
    ];

    setSteps(initialSteps);

    const updateStep = (idx: number, partial: Partial<Step>) => {
      setSteps((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], ...partial };
        return next;
      });
    };

    try {
      let depositSig: string | undefined;

      const depositRes = await deposit(owner, totalAmount);
      const depositTx = depositRes.transactionBase64;

      if (depositTx) {
        depositSig = await signAndSend(depositTx, signTransaction, {
          sendTo: depositRes.sendTo,
          signMessage: signMessage || undefined,
          publicKey: publicKey || undefined,
        });
        updateStep(0, { status: "done", sig: depositSig });
        toast.success("Total funds deposited into payroll vault");
      } else {
        updateStep(0, { status: "done" });
      }

      updateStep(1, {
        status: "active",
        label: `Building ${validEmployees.length} transfer${validEmployees.length > 1 ? "s" : ""}...`,
      });

      const transferResults: {
        base64: string;
        sendTo: string;
        empIdx: number;
      }[] = [];

      for (let i = 0; i < validEmployees.length; i += 1) {
        const employee = validEmployees[i];
        const res = await privateTransfer(
          owner,
          employee.address,
          employee.amount,
          undefined,
          undefined,
          undefined,
          PRIVATE_PAYOUT_PRIVACY,
        );

        if (res.transactionBase64) {
          transferResults.push({
            base64: res.transactionBase64,
            sendTo: res.sendTo || "base",
            empIdx: i,
          });
        }
      }

      if (transferResults.length === 0) {
        updateStep(1, { status: "done", label: "No transfers needed" });
        toast.success("Payroll complete (no transfers)");
        setRunning(false);
        return;
      }

      updateStep(1, {
        status: "active",
        label: `Approve ${transferResults.length} private transfer${transferResults.length > 1 ? "s" : ""} (1 signature)...`,
      });

      const sendTo = transferResults[0].sendTo;
      const batchResults = await batchSignAndSend(
        transferResults.map((transfer) => transfer.base64),
        signAllTransactions,
        sendTo,
        (phase: string, current: number) => {
          if (phase === "signing") {
            updateStep(1, { label: "Signing transfers..." });
          } else if (phase === "confirming") {
            const empIdx = transferResults[current - 1].empIdx;
            updateStep(empIdx + 2, { status: "active" });
          }
        },
      );

      updateStep(1, {
        status: "done",
        label: `${transferResults.length} private transfers signed`,
      });

      for (const result of batchResults) {
        const empIdx = transferResults[result.index].empIdx;
        const stepIdx = empIdx + 2;

        if (result.sig) {
          updateStep(stepIdx, { status: "done", sig: result.sig });
        } else {
          updateStep(stepIdx, { status: "error" });
        }
      }

      await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage: signMessage!,
        path: "/api/history",
        method: "POST",
        body: {
          kind: "payroll-run",
          wallet: publicKey.toBase58(),
          totalAmount,
          employeeCount: validEmployees.length,
          recipientAddresses: validEmployees.map((employee) => employee.address),
          depositSig,
          transferSig: batchResults[0]?.sig || undefined,
          status: "success",
        },
      });

      setSuccessModal({
        totalAmount,
        employeeCount: validEmployees.length,
        depositSig,
        transferSig: batchResults[0]?.sig || undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Manual payroll failed: ${message}`);
      setSteps((prev) =>
        prev.map((step) =>
          step.status === "pending" || step.status === "active"
            ? { ...step, status: "error" }
            : step,
        ),
      );
    } finally {
      setRunning(false);
    }
  }, [
    publicKey,
    signTransaction,
    signAllTransactions,
    signMessage,
    validEmployees,
    totalAmount,
  ]);

  const statusIcon = (status: StepStatus) => {
    switch (status) {
      case "active":
        return <Loader2 size={18} className="animate-spin text-neutral-50" />;
      case "done":
        return <CheckCircle2 size={18} className="text-emerald-400" />;
      case "error":
        return <AlertCircle size={18} className="text-red-400" />;
      default:
        return (
          <div className="h-4 w-4 rounded-full border-2 border-white/10" />
        );
    }
  };

  return (
    <>
      <Appbar />

      <main className="min-h-screen px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-12">
            <Link
              href="/disburse"
              className="group mb-8 inline-flex items-center gap-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-50 font-lexend"
            >
              <ChevronLeft
                size={14}
                className="transition-transform group-hover:-translate-x-0.5"
              />{" "}
              Back to PER Payroll
            </Link>

            <h1 className="mb-3 font-lexend text-4xl font-bold tracking-tight text-neutral-50 sm:text-5xl">
              Manual Batch Payroll
            </h1>
            <p className="max-w-2xl font-lexend text-sm text-neutral-400">
              Use the legacy batch flow to upload a CSV or enter wallet amounts
              manually, then distribute private payments in one payroll run.
            </p>
          </div>

          {!connected ? (
            <div className="flex flex-col items-center justify-center rounded-[2.5rem] border border-white/10 bg-white/5 py-24 text-center backdrop-blur-xl">
              <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-white/10 bg-white/5">
                <Wallet size={32} className="text-blue-200" />
              </div>
              <p className="mb-1 font-doto text-xl font-medium text-white">
                Connect your wallet to continue
              </p>
              <p className="font-lexend text-sm text-neutral-300">
                Manual batch payroll requires wallet signatures for deposit and
                transfers.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-6 rounded-4xl border border-blue-400/15 bg-blue-400/5 p-6 backdrop-blur-xl">
                <p className="mb-2 font-lexend text-xs font-bold uppercase tracking-[0.15em] text-blue-200">
                  Legacy Flow
                </p>
                <p className="font-lexend text-sm text-neutral-300">
                  This page is the older manual payout mode. For realtime
                  private payroll streams with PER onboarding and private state
                  preview, use the main{" "}
                  <Link
                    href="/disburse"
                    className="font-bold text-blue-200 hover:text-blue-100"
                  >
                    payroll dashboard
                  </Link>
                  .
                </p>
              </div>

              <div className="mb-8">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  onChange={handleCSV}
                  className="hidden"
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex cursor-pointer items-center gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-neutral-400 transition-all hover:bg-white/10 hover:text-neutral-50 backdrop-blur-sm font-lexend"
                >
                  <FileSpreadsheet size={18} />
                  Upload CSV
                  <span className="ml-1 font-mono text-[11px] font-bold uppercase tracking-tighter text-neutral-300">
                    address,amount
                  </span>
                </button>
              </div>

              <div className="mb-8 overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/5 backdrop-blur-3xl">
                <div className="grid grid-cols-[1fr_140px_50px] items-center gap-4 border-b border-white/5 bg-white/5 px-8 py-6">
                  <span className="font-lexend text-[12px] font-bold uppercase tracking-[0.15em] text-neutral-400">
                    Wallet Address
                  </span>
                  <span className="text-right font-lexend text-[12px] font-bold uppercase tracking-[0.15em] text-neutral-400">
                    Amount (USDC)
                  </span>
                  <span />
                </div>

                <div className="divide-y divide-white/5">
                  {employees.map((employee, index) => (
                    <div
                      key={index}
                      className="group grid grid-cols-[1fr_140px_50px] items-center gap-4 px-8 py-5 transition-colors hover:bg-white/5"
                    >
                      <input
                        type="text"
                        placeholder="wallet address"
                        value={employee.address}
                        onChange={(e) =>
                          updateRow(index, "address", e.target.value)
                        }
                        className="w-full bg-transparent font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-700"
                      />
                      <input
                        type="number"
                        placeholder="0.00"
                        value={employee.amount || ""}
                        onChange={(e) => updateRow(index, "amount", e.target.value)}
                        className="w-full bg-transparent text-right font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-700 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ MozAppearance: "textfield" }}
                        min={0}
                        step={0.01}
                      />
                      <button
                        onClick={() => removeRow(index)}
                        className="cursor-pointer p-2 text-neutral-600 opacity-0 transition-all hover:scale-110 hover:text-red-400 group-hover:opacity-100"
                        disabled={employees.length === 1}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  onClick={addRow}
                  className="flex w-full cursor-pointer items-center gap-3 border-t border-white/5 px-8 py-6 font-lexend text-base font-bold text-neutral-400 transition-all hover:bg-white/5 hover:text-neutral-50"
                >
                  <Plus size={18} /> Add Employee
                </button>
              </div>

              <div className="mb-12 mt-8 flex flex-col items-center justify-between gap-6 rounded-[2.5rem] border border-emerald-500/10 bg-emerald-500/5 p-8 backdrop-blur-xl sm:flex-row">
                <div>
                  <p className="mb-1 font-lexend text-sm text-neutral-400">
                    Total Disbursement
                  </p>
                  <p className="font-lexend text-3xl font-bold text-neutral-50">
                    {totalAmount.toFixed(2)}{" "}
                    <span className="font-doto text-xl text-emerald-400">
                      USDC
                    </span>
                  </p>
                </div>

                <button
                  onClick={runPayroll}
                  disabled={running || validEmployees.length === 0}
                  className="inline-flex w-full cursor-pointer items-center justify-center gap-3 rounded-[1.25rem] bg-neutral-50 px-10 py-4 font-lexend text-base font-bold text-black transition-all duration-300 hover:-translate-y-1 hover:bg-white hover:shadow-[0_10px_30px_rgba(255,255,255,0.2)] disabled:pointer-events-none disabled:opacity-30 sm:w-auto"
                >
                  {running ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : (
                    <Play size={18} fill="currentColor" />
                  )}
                  {running ? "Processing..." : "Run Payroll"}
                </button>
              </div>

              {steps.length > 0 && (
                <div className="rounded-[2.5rem] border border-white/10 bg-white/5 p-8 backdrop-blur-xl">
                  <h3 className="mb-6 font-lexend text-sm font-bold uppercase tracking-widest text-neutral-50">
                    Transaction Progress
                  </h3>

                  <div className="space-y-4">
                    {steps.map((step, index) => (
                      <div key={index} className="group flex items-center gap-4">
                        <div className="shrink-0">{statusIcon(step.status)}</div>
                        <span
                          className={`flex-1 font-mono text-sm ${
                            step.status === "done"
                              ? "text-neutral-500"
                              : step.status === "error"
                                ? "text-red-400"
                                : step.status === "active"
                                  ? "text-neutral-50"
                                  : "text-neutral-700"
                          }`}
                        >
                          {step.label}
                        </span>
                        {step.sig && (
                          <a
                            href={`https://explorer.solana.com/tx/${step.sig}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1 font-mono text-[12px] text-emerald-400 transition-colors hover:text-emerald-300 hover:underline"
                          >
                            tx <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {successModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setSuccessModal(null)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          <div
            className="relative w-full max-w-md rounded-[2.5rem] border border-white/10 bg-neutral-950/50 p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSuccessModal(null)}
              className="absolute right-6 top-6 rounded-xl p-2 text-neutral-600 transition-colors hover:bg-white/5 hover:text-neutral-300"
            >
              <X size={18} />
            </button>

            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
              <CheckCircle2 size={28} className="text-emerald-400" />
            </div>

            <h2 className="mb-1 font-lexend text-2xl font-bold text-neutral-50">
              Manual Payroll Complete
            </h2>
            <p className="mb-8 font-lexend text-sm text-neutral-500">
              All manual batch transfers were processed successfully.
            </p>

            <div className="mb-8 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                <p className="mb-1 font-lexend text-xs uppercase tracking-wider text-neutral-500">
                  Total Sent
                </p>
                <p className="font-lexend text-xl font-bold text-neutral-50">
                  {successModal.totalAmount.toFixed(2)}{" "}
                  <span className="font-doto text-sm text-emerald-400">
                    USDC
                  </span>
                </p>
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                <p className="mb-1 font-lexend text-xs uppercase tracking-wider text-neutral-500">
                  Recipients
                </p>
                <p className="font-lexend text-xl font-bold text-neutral-50">
                  {successModal.employeeCount}
                </p>
              </div>
            </div>

            {(successModal.depositSig || successModal.transferSig) && (
              <div className="mb-8 space-y-2">
                {successModal.depositSig && (
                  <a
                    href={`https://explorer.solana.com/tx/${successModal.depositSig}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex w-full items-center justify-between rounded-xl border border-white/5 bg-white/5 px-4 py-3 transition-all hover:border-white/10 hover:bg-white/10"
                  >
                    <span className="font-mono text-xs text-neutral-400 transition-colors group-hover:text-neutral-200">
                      Deposit tx
                    </span>
                    <div className="flex items-center gap-1.5 font-mono text-xs text-emerald-400">
                      {successModal.depositSig.slice(0, 8)}...
                      <ExternalLink size={11} />
                    </div>
                  </a>
                )}

                {successModal.transferSig && (
                  <a
                    href={`https://explorer.solana.com/tx/${successModal.transferSig}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex w-full items-center justify-between rounded-xl border border-white/5 bg-white/5 px-4 py-3 transition-all hover:border-white/10 hover:bg-white/10"
                  >
                    <span className="font-mono text-xs text-neutral-400 transition-colors group-hover:text-neutral-200">
                      Transfer tx
                    </span>
                    <div className="flex items-center gap-1.5 font-mono text-xs text-emerald-400">
                      {successModal.transferSig.slice(0, 8)}...
                      <ExternalLink size={11} />
                    </div>
                  </a>
                )}
              </div>
            )}

            <button
              onClick={() => setSuccessModal(null)}
              className="w-full rounded-2xl bg-neutral-50 py-3.5 font-lexend text-sm font-bold text-black transition-colors hover:bg-white"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <Footer />
    </>
  );
}
