"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Papa from "papaparse";
import { toast } from "sonner";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  Trash2,
  Play,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  ExternalLink,
  ChevronLeft,
  History,
  X,
} from "lucide-react";

import { EmployerLayout } from "@/components/employer-layout";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";
import type { PayrollMode } from "@/lib/payroll-mode";

interface Employee {
  address: string;
  amount: number;
  employeeId?: string;
  name?: string;
  department?: string;
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
  transferSig?: string;
}

interface EmployerEmployee {
  id: string;
  wallet: string;
  name: string;
  payrollMode?: PayrollMode;
  department?: string;
  role?: string;
  compensationAmountUsd?: number;
  monthlySalaryUsd?: number;
  paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
  privateRecipientInitStatus?: "pending" | "processing" | "confirmed" | "failed";
}

interface PayrollHistoryRun {
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
}

interface CompanySummary {
  id: string;
  name: string;
  treasuryPubkey: string;
}

function downloadPrivatePayrollRun(run: PayrollHistoryRun) {
  if (typeof window === "undefined") return;

  const blob = new Blob([JSON.stringify(run, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute(
    "download",
    `expaynse_private_payroll_run_${run.date.split("T")[0]}.json`,
  );
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getSuggestedPayoutAmount(employee: EmployerEmployee) {
  if (
    Number.isFinite(employee.monthlySalaryUsd) &&
    (employee.monthlySalaryUsd ?? 0) > 0
  ) {
    return employee.monthlySalaryUsd ?? 0;
  }

  if (
    Number.isFinite(employee.compensationAmountUsd) &&
    (employee.compensationAmountUsd ?? 0) > 0
  ) {
    return employee.compensationAmountUsd ?? 0;
  }

  return 0;
}

function employeeToPayoutRow(employee: EmployerEmployee): Employee {
  return {
    employeeId: employee.id,
    name: employee.name,
    department: employee.department,
    address: employee.wallet,
    amount: getSuggestedPayoutAmount(employee),
  };
}

function ManualBatchPayrollContent() {
  const searchParams = useSearchParams();
  const { publicKey, signMessage } = useWallet();

  const [employees, setEmployees] = useState<Employee[]>([
    { address: "", amount: 0 },
  ]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [successModal, setSuccessModal] = useState<PayrollSummary | null>(null);
  const [company, setCompany] = useState<CompanySummary | null>(null);
  const [companyEmployees, setCompanyEmployees] = useState<EmployerEmployee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [privateBalanceUsdc, setPrivateBalanceUsdc] = useState<number | null>(null);
  const [privateBalanceLoading, setPrivateBalanceLoading] = useState(false);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewSectionRef = useRef<HTMLDivElement>(null);
  const queryEmployeeId = searchParams.get("employee")?.trim() ?? "";
  const initialSelectionAppliedRef = useRef(false);

  const privatePayrollEmployees = useMemo(
    () => companyEmployees,
    [companyEmployees],
  );

  const readyPrivatePayrollEmployees = useMemo(
    () =>
      privatePayrollEmployees.filter(
        (employee) => employee.privateRecipientInitStatus === "confirmed",
      ),
    [privatePayrollEmployees],
  );

  const selectedEmployee = useMemo(
    () =>
      privatePayrollEmployees.find((employee) => employee.id === selectedEmployeeId) ??
      null,
    [privatePayrollEmployees, selectedEmployeeId],
  );

  const privatePayrollReadyCount = useMemo(
    () => readyPrivatePayrollEmployees.length,
    [readyPrivatePayrollEmployees],
  );

  const readyPrivatePayrollPendingCount =
    privatePayrollEmployees.length - readyPrivatePayrollEmployees.length;

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

        setSelectedEmployeeId("");
        setEmployees(parsed);
        toast.success(`Loaded ${parsed.length} employees from CSV`);
      },
    });

    e.target.value = "";
  };

  const addRow = () => {
    setSelectedEmployeeId("");
    setEmployees((prev) => [...prev, { address: "", amount: 0 }]);
  };

  const useSelectedEmployee = () => {
    if (!selectedEmployee) return;
    if (selectedEmployeeLoaded) {
      reviewSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      return;
    }
    if (selectedEmployee.privateRecipientInitStatus !== "confirmed") {
      toast.error(
        `${selectedEmployee.name} is not ready for private payouts yet. Wait for private account initialization first.`,
      );
      return;
    }
    setEmployees([employeeToPayoutRow(selectedEmployee)]);
  };

  const loadAllPrivatePayrollEmployees = () => {
    if (privatePayrollEmployees.length === 0) {
      toast.error("No private payroll employees available to load");
      return;
    }

    if (readyPrivatePayrollEmployees.length === 0) {
      toast.error(
        "No private payroll employees are ready yet. Finish private account initialization first.",
      );
      return;
    }

    setSelectedEmployeeId("");
    setEmployees(readyPrivatePayrollEmployees.map(employeeToPayoutRow));
    const skippedCount =
      privatePayrollEmployees.length - readyPrivatePayrollEmployees.length;
    toast.success(
      skippedCount > 0
        ? `Loaded ${readyPrivatePayrollEmployees.length} ready employee${readyPrivatePayrollEmployees.length === 1 ? "" : "s"} and skipped ${skippedCount} still initializing`
        : `Loaded ${readyPrivatePayrollEmployees.length} private payroll employee${readyPrivatePayrollEmployees.length === 1 ? "" : "s"}`,
    );
  };

  const clearBatch = () => {
    setSelectedEmployeeId("");
    setEmployees([{ address: "", amount: 0 }]);
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
          employeeId: undefined,
          name: undefined,
          department: undefined,
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

  const mappedEmployeeCount = useMemo(
    () => employees.filter((employee) => Boolean(employee.employeeId)).length,
    [employees],
  );

  const requiredDepositAmount = useMemo(() => {
    const available = privateBalanceUsdc ?? 0;
    return Math.max(0, totalAmount - available);
  }, [privateBalanceUsdc, totalAmount]);

  const treasuryFundedEnough =
    privateBalanceUsdc !== null && requiredDepositAmount <= 0.000001;

  const currentBatchSummary = useMemo(() => {
    if (queryEmployeeId && selectedEmployee) {
      return {
        label: "Private transfer",
        detail: selectedEmployee.name,
      };
    }

    if (employees.length === 1 && selectedEmployee) {
      return {
        label: "Selected employee",
        detail: selectedEmployee.name,
      };
    }

    if (mappedEmployeeCount > 0) {
      return {
        label: "Team batch",
        detail: `${mappedEmployeeCount} employee${mappedEmployeeCount === 1 ? "" : "s"} loaded.`,
      };
    }

    return {
      label: "Custom batch",
      detail: "Manual or CSV rows.",
    };
  }, [employees.length, mappedEmployeeCount, queryEmployeeId, selectedEmployee]);

  const selectedEmployeeLoaded = useMemo(() => {
    if (!selectedEmployee || employees.length !== 1) return false;

    const [row] = employees;
    return (
      row.employeeId === selectedEmployee.id ||
      row.address === selectedEmployee.wallet
    );
  }, [employees, selectedEmployee]);

  const directEmployeeFlow = Boolean(queryEmployeeId && selectedEmployee);

  useEffect(() => {
    if (!publicKey || !signMessage) return;

    let cancelled = false;
    const employerWallet = publicKey.toBase58();

    const loadEmployees = async () => {
      try {
        setEmployeesLoading(true);
        const [employeesResponse, companyResponse] = await Promise.all([
          walletAuthenticatedFetch({
            wallet: employerWallet,
            signMessage,
            path: `/api/employees?employerWallet=${employerWallet}`,
            method: "GET",
          }),
          walletAuthenticatedFetch({
            wallet: employerWallet,
            signMessage,
            path: `/api/company/me?employerWallet=${employerWallet}`,
            method: "GET",
          }),
        ]);

        const employeesPayload = (await employeesResponse.json()) as {
          employees?: EmployerEmployee[];
          error?: string;
        };

        if (!employeesResponse.ok) {
          throw new Error(employeesPayload.error || "Failed to load employees");
        }

        const companyPayload = (await companyResponse.json()) as {
          company?: CompanySummary;
          error?: string;
        };

        if (!companyResponse.ok) {
          throw new Error(companyPayload.error || "Failed to load company");
        }

        if (!cancelled) {
          setCompanyEmployees(employeesPayload.employees ?? []);
          setCompany(companyPayload.company ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to load private payroll employees";
          toast.error(message);
        }
      } finally {
        if (!cancelled) {
          setEmployeesLoading(false);
        }
      }
    };

    void loadEmployees();

    return () => {
      cancelled = true;
    };
  }, [publicKey, signMessage]);

  const refreshPrivateBalance = useCallback(async () => {
    if (!publicKey || !signMessage || !company?.id) {
      setPrivateBalanceUsdc(null);
      return;
    }

    try {
      setPrivateBalanceLoading(true);
      const wallet = publicKey.toBase58();
      const response = await walletAuthenticatedFetch({
        wallet,
        signMessage,
        path: `/api/company/${company.id}/balance?wallet=${wallet}`,
        method: "GET",
      });
      const payload = (await response.json()) as {
        balance?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load treasury balance");
      }
      const normalized = parseInt(payload.balance ?? "0", 10) / 1_000_000;
      setPrivateBalanceUsdc(normalized);
    } catch {
      setPrivateBalanceUsdc(null);
    } finally {
      setPrivateBalanceLoading(false);
    }
  }, [company?.id, publicKey, signMessage]);

  useEffect(() => {
    void refreshPrivateBalance();
  }, [refreshPrivateBalance]);

  useEffect(() => {
    if (privatePayrollEmployees.length === 0) return;

    const requestedId =
      queryEmployeeId &&
      privatePayrollEmployees.some((employee) => employee.id === queryEmployeeId)
        ? queryEmployeeId
        : "";

    if (!initialSelectionAppliedRef.current) {
      const fallbackEmployee = privatePayrollEmployees[0];
      const nextId = requestedId || fallbackEmployee.id;
      setSelectedEmployeeId(nextId);
      initialSelectionAppliedRef.current = true;
      return;
    }

    if (
      selectedEmployeeId &&
      privatePayrollEmployees.some((employee) => employee.id === selectedEmployeeId)
    ) {
      return;
    }

    setSelectedEmployeeId(requestedId || privatePayrollEmployees[0].id);
  }, [privatePayrollEmployees, queryEmployeeId, selectedEmployeeId]);

  useEffect(() => {
    if (!selectedEmployee) return;

    const suggestedAmount = getSuggestedPayoutAmount(selectedEmployee);
    setEmployees([
      {
        employeeId: selectedEmployee.id,
        name: selectedEmployee.name,
        department: selectedEmployee.department,
        address: selectedEmployee.wallet,
        amount: suggestedAmount,
      },
    ]);
  }, [selectedEmployee]);

  const runPayroll = useCallback(async () => {
    if (!publicKey || !signMessage || !company?.id) return;

    if (validEmployees.length === 0) {
      toast.error("No valid employees to pay");
      return;
    }

    setRunning(true);

    const initialSteps: Step[] = [
      {
        label: "Verify company treasury private balance",
        status: "active",
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
      const response = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/private-payroll/send",
        method: "POST",
        body: {
          employerWallet: publicKey.toBase58(),
          recipients: validEmployees.map((employee) => ({
            employeeId: employee.employeeId,
            name: employee.name,
            address: employee.address,
            amount: employee.amount,
          })),
        },
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        transferResults?: Array<{
          employeeId?: string;
          address: string;
          signature?: string;
        }>;
        payrollRun?: PayrollHistoryRun;
        missingAmountMicro?: number;
      };

      if (!response.ok) {
        if (response.status === 409 && typeof payload.missingAmountMicro === "number") {
          const missingUsdc = payload.missingAmountMicro / 1_000_000;
          setSteps([
            {
              label: `Treasury is short by ${missingUsdc.toFixed(2)} USDC`,
              status: "error",
            },
          ]);
        } else {
          updateStep(0, { status: "error" });
        }
        throw new Error(payload.error || "Private payroll failed");
      }

      updateStep(0, {
        status: "done",
        label: "Company treasury balance confirmed",
      });

      const transfers = payload.transferResults ?? [];
      transfers.forEach((transfer, index) => {
        updateStep(index + 1, {
          status: transfer.signature ? "done" : "error",
          sig: transfer.signature,
        });
      });

      setSuccessModal({
        totalAmount,
        employeeCount: validEmployees.length,
        transferSig: transfers[0]?.signature,
      });
      await refreshPrivateBalance();
      toast.success("Private payroll sent from company treasury");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Private payroll failed: ${message}`);
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
  }, [company?.id, publicKey, signMessage, totalAmount, validEmployees, refreshPrivateBalance]);

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
    <EmployerLayout>
      <div className="mx-auto max-w-3xl">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/people"
                className="group inline-flex items-center gap-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-50 font-lexend"
              >
                <ChevronLeft
                  size={14}
                  className="transition-transform group-hover:-translate-x-0.5"
                />{" "}
                Back to People
              </Link>
              <Link
                href="/disburse/manual/history"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-lexend text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-300 transition-all hover:bg-white/10 hover:text-white"
              >
                <History size={14} />
                Open History
              </Link>
            </div>
            <h1 className="font-lexend text-2xl font-bold tracking-tight text-neutral-50 sm:text-3xl">
              {directEmployeeFlow ? "Private Transfer" : "Private Payroll"}
            </h1>
          </div>

              {!directEmployeeFlow ? (
                <div className="mb-8 rounded-[2.5rem] border border-white/10 bg-white/5 p-6 backdrop-blur-3xl">
                  <div className="mb-5 flex items-center justify-between gap-4">
                    <div>
                      <p className="mb-1 font-lexend text-xs font-bold uppercase tracking-[0.15em] text-neutral-400">
                        Team
                      </p>
                    </div>
                    {employeesLoading ? (
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 font-lexend text-xs text-neutral-400">
                        <Loader2 size={14} className="animate-spin" />
                        Loading employees
                      </div>
                    ) : null}
                  </div>

                  <div className="mb-5 flex flex-wrap items-center gap-3">
                    <div className="rounded-full border border-white/10 bg-white/5 px-3 py-2 font-lexend text-xs text-neutral-300">
                      {privatePayrollEmployees.length} employee
                      {privatePayrollEmployees.length === 1 ? "" : "s"}
                    </div>
                    <div className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 font-lexend text-xs text-emerald-300">
                      {privatePayrollReadyCount} ready
                    </div>
                    {readyPrivatePayrollPendingCount > 0 ? (
                      <div className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-2 font-lexend text-xs text-amber-300">
                        {readyPrivatePayrollPendingCount} still initializing
                      </div>
                    ) : null}
                  </div>
                  {privatePayrollEmployees.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {privatePayrollEmployees.map((employee) => {
                        const isSelected = employee.id === selectedEmployeeId;
                        const suggestedAmount = getSuggestedPayoutAmount(employee);
                        const initReady =
                          employee.privateRecipientInitStatus === "confirmed";

                        return (
                          <button
                            key={employee.id}
                            type="button"
                            onClick={() => setSelectedEmployeeId(employee.id)}
                            className={`rounded-[1.5rem] border px-4 py-4 text-left transition-all ${
                              isSelected
                                ? "border-emerald-400/40 bg-emerald-400/10"
                                : "border-white/10 bg-white/5 hover:bg-white/10"
                            }`}
                          >
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="font-lexend text-base font-bold text-neutral-50">
                                {employee.name}
                              </p>
                              <span
                                className={`rounded-full px-2.5 py-1 font-lexend text-[11px] font-bold uppercase tracking-[0.12em] ${
                                  initReady
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : "bg-amber-500/15 text-amber-300"
                                }`}
                              >
                                {initReady ? "Private ready" : "Init pending"}
                              </span>
                            </div>
                            <p className="mb-2 font-mono text-xs text-neutral-400">
                              {employee.wallet}
                            </p>
                            <div className="flex items-center justify-between gap-3 font-lexend text-sm text-neutral-400">
                              <span>{employee.department || "No department"}</span>
                              <span>
                                {suggestedAmount > 0
                                  ? `${suggestedAmount.toFixed(2)} USDC`
                                  : "Set amount manually"}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4 font-lexend text-sm text-neutral-400">
                      No `Private Payroll Only` employees yet. Add one from{" "}
                      <Link href="/people" className="font-bold text-neutral-200 hover:text-white">
                        People
                      </Link>{" "}
                      or use CSV/manual rows below.
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={useSelectedEmployee}
                      disabled={!selectedEmployee}
                      className="inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5 font-lexend text-sm font-bold text-emerald-300 transition-all hover:bg-emerald-500/15 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Play size={16} />
                      {selectedEmployeeLoaded ? "Review Batch" : "Use Selected"}
                    </button>
                    <button
                      type="button"
                      onClick={loadAllPrivatePayrollEmployees}
                      disabled={readyPrivatePayrollEmployees.length === 0}
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 font-lexend text-sm font-bold text-neutral-200 transition-all hover:bg-white/10 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Plus size={16} />
                      Load Team
                    </button>
                    <button
                      type="button"
                      onClick={clearBatch}
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 font-lexend text-sm font-bold text-neutral-400 transition-all hover:bg-white/10 hover:text-neutral-200"
                    >
                      <Trash2 size={16} />
                      Custom Batch
                    </button>
                  </div>
                </div>
              ) : null}

              <div
                ref={reviewSectionRef}
                className="mb-4 flex flex-wrap items-center justify-between gap-4"
              >
                <div>
                  <p className="font-lexend text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">
                    {directEmployeeFlow ? "Transfer Details" : "Pick / Review / Pay"}
                  </p>
                  <p className="mt-1 font-lexend text-base font-bold text-white">
                    {currentBatchSummary.label}
                  </p>
                  <p className="mt-1 font-lexend text-sm text-[#8f8f95]">
                    {currentBatchSummary.detail}
                  </p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  onChange={handleCSV}
                  className="hidden"
                />
                {!directEmployeeFlow ? (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex cursor-pointer items-center gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-neutral-300 transition-all hover:bg-white/10 hover:text-neutral-50 backdrop-blur-sm font-lexend"
                  >
                    <FileSpreadsheet size={18} />
                    Upload CSV
                  </button>
                ) : null}
              </div>

              {directEmployeeFlow ? (
                <div className="mb-6 rounded-[1.75rem] border border-white/10 bg-[#0d0d0d] p-6">
                  <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
                    <div>
                      <p className="mb-3 font-lexend text-[11px] font-bold uppercase tracking-[0.18em] text-neutral-500">
                        Recipient
                      </p>
                      <div className="rounded-[1.35rem] border border-white/10 bg-white/5 px-5 py-4">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="font-lexend text-base font-bold text-neutral-100">
                            {employees[0]?.name || "Selected employee"}
                          </span>
                          {employees[0]?.department ? (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-lexend text-[10px] uppercase tracking-[0.12em] text-neutral-400">
                              {employees[0].department}
                            </span>
                          ) : null}
                        </div>
                        <p className="font-mono text-sm text-neutral-500">
                          {employees[0]?.address}
                        </p>
                      </div>
                    </div>

                    <div>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="font-lexend text-[11px] font-bold uppercase tracking-[0.18em] text-neutral-500">
                          Amount to send
                        </p>
                        {selectedEmployee ? (
                          <button
                            type="button"
                            onClick={() =>
                              setEmployees([employeeToPayoutRow(selectedEmployee)])
                            }
                            className="font-lexend text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300 transition-colors hover:text-emerald-200"
                          >
                            Reset to salary
                          </button>
                        ) : null}
                      </div>
                      <div className="rounded-[1.35rem] border border-white/10 bg-white/5 px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span className="font-lexend text-2xl font-bold text-neutral-500">
                            $
                          </span>
                          <input
                            type="number"
                            placeholder="0.00"
                            value={employees[0]?.amount || ""}
                            onChange={(e) => updateRow(0, "amount", e.target.value)}
                            className="w-full bg-transparent font-mono text-[42px] font-semibold leading-none text-neutral-100 outline-none placeholder:text-neutral-700 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ MozAppearance: "textfield" }}
                            min={0}
                            step={0.01}
                          />
                          <span className="font-lexend text-sm font-bold uppercase tracking-[0.12em] text-neutral-500">
                            USDC
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mb-8 overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/5 backdrop-blur-3xl">
                  <div className="grid grid-cols-[1fr_140px_50px] items-center gap-4 border-b border-white/5 bg-white/5 px-8 py-6">
                    <span className="font-lexend text-[12px] font-bold uppercase tracking-[0.15em] text-neutral-400">
                      Recipient
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
                        <div>
                          {employee.name ? (
                            <div className="mb-1 flex items-center gap-2">
                              <span className="font-lexend text-sm font-bold text-neutral-100">
                                {employee.name}
                              </span>
                              {employee.department ? (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-lexend text-[10px] uppercase tracking-[0.12em] text-neutral-400">
                                  {employee.department}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          <input
                            type="text"
                            placeholder="wallet address"
                            value={employee.address}
                            onChange={(e) =>
                              updateRow(index, "address", e.target.value)
                            }
                            className="w-full bg-transparent font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-700"
                          />
                        </div>
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
                          disabled={employees.length === 1 || directEmployeeFlow}
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
              )}

              {!directEmployeeFlow ? (
                <div className="mb-6 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4">
                    <p className="mb-1 font-lexend text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">
                      Treasury Private
                    </p>
                    <p className="font-lexend text-lg font-bold text-white">
                      {privateBalanceLoading
                        ? "Checking..."
                        : privateBalanceUsdc !== null
                          ? `${privateBalanceUsdc.toFixed(2)} USDC`
                          : "Unavailable"}
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4">
                    <p className="mb-1 font-lexend text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">
                      Need Funding
                    </p>
                    <p className="font-lexend text-lg font-bold text-white">
                      {requiredDepositAmount.toFixed(2)} USDC
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4">
                    <p className="mb-1 font-lexend text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">
                      Will Send
                    </p>
                    <p className="font-lexend text-lg font-bold text-white">
                      {totalAmount.toFixed(2)} USDC
                    </p>
                  </div>
                </div>
              ) : null}

              <div className={`mb-12 mt-6 flex flex-col items-center justify-between gap-6 ${directEmployeeFlow ? "rounded-[1.75rem] border-white/10 bg-white/[0.03] p-6" : "rounded-[2.5rem] border-emerald-500/10 bg-emerald-500/5 p-8 backdrop-blur-xl"} border sm:flex-row`}>
                <div>
                  <p className="mb-1 font-lexend text-sm text-neutral-400">
                    Total
                  </p>
                  <p className={`font-lexend ${directEmployeeFlow ? "text-[40px]" : "text-3xl"} font-semibold text-neutral-50`}>
                    {totalAmount.toFixed(2)}{" "}
                    <span className={`${directEmployeeFlow ? "font-lexend text-base" : "font-doto text-xl"} text-emerald-400`}>
                      USDC
                    </span>
                  </p>
                  <p className="mt-2 font-lexend text-sm text-neutral-400">
                    {privateBalanceLoading
                      ? "Checking treasury private balance..."
                      : treasuryFundedEnough
                        ? "Treasury is ready."
                        : `Fund treasury first. Missing ${requiredDepositAmount.toFixed(2)} USDC.`}
                  </p>
                </div>

                <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto">
                  <button
                    onClick={runPayroll}
                    disabled={
                      running ||
                      validEmployees.length === 0 ||
                      privateBalanceLoading ||
                      !treasuryFundedEnough
                    }
                    className={`inline-flex w-full cursor-pointer items-center justify-center gap-3 rounded-[1.1rem] ${directEmployeeFlow ? "bg-[#1eba98] px-8 py-3.5 text-sm shadow-none hover:translate-y-0 hover:bg-[#22c7a3]" : "bg-neutral-50 px-10 py-4 text-base hover:-translate-y-1 hover:bg-white hover:shadow-[0_10px_30px_rgba(255,255,255,0.2)]"} font-lexend font-bold text-black transition-all duration-300 disabled:pointer-events-none disabled:opacity-30 sm:w-auto`}
                  >
                    {running ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <Play size={18} fill="currentColor" />
                    )}
                    {running
                      ? "Processing..."
                      : directEmployeeFlow
                        ? "Send Private Transfer"
                        : "Pay Now"}
                  </button>
                  {!treasuryFundedEnough && !privateBalanceLoading ? (
                    <Link
                      href="/treasury?deposit=1"
                      className="inline-flex items-center justify-center rounded-[1rem] border border-white/10 bg-white/5 px-5 py-3 font-lexend text-sm font-bold text-neutral-200 transition-all hover:bg-white/10 hover:text-white"
                    >
                      Fund Treasury
                    </Link>
                  ) : null}
                </div>
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
                            href={`https://solscan.io/tx/${step.sig}?cluster=devnet`}
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
      </div>

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
              Private Payroll Complete
            </h2>
            <p className="mb-8 font-lexend text-sm text-neutral-500">
              All private payroll transfers were processed successfully.
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

            {successModal.transferSig && (
              <div className="mb-8 space-y-2">
                <a
                  href={`https://solscan.io/tx/${successModal.transferSig}?cluster=devnet`}
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
              </div>
            )}

            <button
              onClick={() => setSuccessModal(null)}
              className="w-full rounded-2xl bg-neutral-50 py-3.5 font-lexend text-sm font-bold text-black transition-colors hover:bg-white"
            >
              Done
            </button>
            <button
              onClick={() =>
                downloadPrivatePayrollRun({
                  id: "latest-success",
                  date: new Date().toISOString(),
                  mode: "private_payroll",
                  totalAmount: successModal.totalAmount,
                  employeeCount: successModal.employeeCount,
                  recipientAddresses: [],
                  transferSig: successModal.transferSig,
                  status: "success",
                })
              }
              className="mt-3 w-full rounded-2xl border border-white/10 bg-white/5 py-3.5 font-lexend text-sm font-bold text-white transition-colors hover:bg-white/10"
            >
              Export Run JSON
            </button>
          </div>
        </div>
      )}
    </EmployerLayout>
  );
}

export default function ManualBatchPayrollPage() {
  return (
    <Suspense fallback={null}>
      <ManualBatchPayrollContent />
    </Suspense>
  );
}
