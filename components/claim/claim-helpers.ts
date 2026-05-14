export function formatDisplayedUsdcBalance(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  if (value >= 0.01) return value.toFixed(2);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function getClaimErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export function getClaimDisabledReason(args: {
  registeredEmployeeWallet: boolean;
  privateAccountInitialized: boolean;
  hasPrimaryStreamId: boolean;
  hasPrivatePayrollMode: boolean;
  hasPendingRequest: boolean;
  hasLiveSnapshot: boolean;
  requestMaxUsdc: number;
}) {
  if (!args.registeredEmployeeWallet) {
    return "Your employer still needs to add this wallet to payroll.";
  }

  if (!args.privateAccountInitialized) {
    return "Set up your private account once before you claim salary.";
  }

  if (!args.hasPrimaryStreamId) {
    return args.hasPrivatePayrollMode
      ? "Your employer has not sent a private payroll payout yet."
      : "Your payroll stream is not ready yet.";
  }

  if (args.hasPendingRequest) {
    return "Finish your pending claim before starting a new one.";
  }

  if (!args.hasLiveSnapshot) {
    return args.hasPrivatePayrollMode
      ? "Your employer still needs to send a private payroll payout."
      : "Your employer still needs to finish private payroll setup.";
  }

  if (args.requestMaxUsdc <= 0) {
    return "No salary is available to claim yet.";
  }

  return null;
}
