import type {
  EmployerEmployee,
  ManualPayrollEmployee,
  PayrollHistoryRun,
} from "./manual-types";

export function downloadPrivatePayrollRun(run: PayrollHistoryRun) {
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

export function getSuggestedPayoutAmount(employee: EmployerEmployee) {
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

export function employeeToPayoutRow(
  employee: EmployerEmployee,
): ManualPayrollEmployee {
  return {
    employeeId: employee.id,
    name: employee.name,
    department: employee.department,
    address: employee.wallet,
    amount: getSuggestedPayoutAmount(employee),
  };
}

export function isSelectedEmployeeLoaded(args: {
  employees: ManualPayrollEmployee[];
  selectedEmployee: EmployerEmployee | null;
}) {
  if (!args.selectedEmployee || args.employees.length !== 1) return false;

  const [row] = args.employees;
  return (
    row.employeeId === args.selectedEmployee.id ||
    row.address === args.selectedEmployee.wallet
  );
}

export function getCurrentBatchSummary(args: {
  employeesLength: number;
  mappedEmployeeCount: number;
  queryEmployeeId: string;
  selectedEmployee: EmployerEmployee | null;
}) {
  if (args.queryEmployeeId && args.selectedEmployee) {
    return {
      label: "Private transfer",
      detail: args.selectedEmployee.name,
    };
  }

  if (args.employeesLength === 1 && args.selectedEmployee) {
    return {
      label: "Selected employee",
      detail: args.selectedEmployee.name,
    };
  }

  if (args.mappedEmployeeCount > 0) {
    return {
      label: "Team batch",
      detail: `${args.mappedEmployeeCount} employee${args.mappedEmployeeCount === 1 ? "" : "s"} loaded.`,
    };
  }

  return {
    label: "Custom batch",
    detail: "Manual or CSV rows.",
  };
}
