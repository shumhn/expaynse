export interface PayrollRun {
  id: string;
  date: string;
  totalAmount: number;
  employeeCount: number;
  recipientAddresses: string[];
  depositSig?: string;
  transferSig?: string;
  status: "success" | "failed";
}

export interface SetupAction {
  id: string;
  date: string;
  type: "initialize-mint" | "fund-treasury";
  wallet: string;
  amount?: number;
  txSig?: string;
  status: "success" | "failed";
}

export interface ClaimRecord {
  id: string;
  date: string;
  amount: number;
  recipient: string;
  txSig?: string;
  status: "success" | "failed";
}

export type WalletRole = "employer" | "employee";

const getKeys = (wallet: string) => ({
  PAYROLL_HISTORY: `expaynse_${wallet}_payroll`,
  CLAIM_HISTORY: `expaynse_${wallet}_claims`,
  SETUP_HISTORY: `expaynse_${wallet}_setup`,
  WALLET_ROLE: `expaynse_${wallet}_role`,
});

export const savePayrollRun = (
  wallet: string,
  run: Omit<PayrollRun, "id" | "date">,
) => {
  if (typeof window === "undefined" || !wallet) return;

  // Refetch history right before saving to handle multi-tab updates
  const history = getPayrollHistory(wallet);
  const newRun: PayrollRun = {
    ...run,
    id: Math.random().toString(36).substring(2, 9),
    date: new Date().toISOString(),
  };

  const updated = [newRun, ...history].slice(0, 50);
  localStorage.setItem(
    getKeys(wallet).PAYROLL_HISTORY,
    JSON.stringify(updated),
  );
};

export const getPayrollHistory = (wallet: string): PayrollRun[] => {
  if (typeof window === "undefined" || !wallet) return [];
  const stored = localStorage.getItem(getKeys(wallet).PAYROLL_HISTORY);
  return stored ? JSON.parse(stored) : [];
};

export const saveClaim = (
  wallet: string,
  claim: Omit<ClaimRecord, "id" | "date">,
) => {
  if (typeof window === "undefined" || !wallet) return;

  // Refetch history right before saving to handle multi-tab updates
  const history = getClaimHistory(wallet);
  const newClaim: ClaimRecord = {
    ...claim,
    id: Math.random().toString(36).substring(2, 9),
    date: new Date().toISOString(),
  };

  const updated = [newClaim, ...history].slice(0, 50);
  localStorage.setItem(getKeys(wallet).CLAIM_HISTORY, JSON.stringify(updated));
};

export const getClaimHistory = (wallet: string): ClaimRecord[] => {
  if (typeof window === "undefined" || !wallet) return [];
  const stored = localStorage.getItem(getKeys(wallet).CLAIM_HISTORY);
  return stored ? JSON.parse(stored) : [];
};

export const saveSetupAction = (
  wallet: string,
  action: Omit<SetupAction, "id" | "date">,
) => {
  if (typeof window === "undefined" || !wallet) return;

  const history = getSetupHistory(wallet);
  const newAction: SetupAction = {
    ...action,
    id: Math.random().toString(36).substring(2, 9),
    date: new Date().toISOString(),
  };

  const updated = [newAction, ...history].slice(0, 50);
  localStorage.setItem(getKeys(wallet).SETUP_HISTORY, JSON.stringify(updated));
};

export const getSetupHistory = (wallet: string): SetupAction[] => {
  if (typeof window === "undefined" || !wallet) return [];
  const stored = localStorage.getItem(getKeys(wallet).SETUP_HISTORY);
  return stored ? JSON.parse(stored) : [];
};

export const clearHistory = (wallet: string) => {
  if (typeof window === "undefined" || !wallet) return;
  localStorage.removeItem(getKeys(wallet).PAYROLL_HISTORY);
  localStorage.removeItem(getKeys(wallet).CLAIM_HISTORY);
  localStorage.removeItem(getKeys(wallet).SETUP_HISTORY);
};

export const saveWalletRole = (wallet: string, role: WalletRole) => {
  if (typeof window === "undefined" || !wallet) return;
  localStorage.setItem(getKeys(wallet).WALLET_ROLE, role);
};

export const getWalletRole = (wallet: string): WalletRole | null => {
  if (typeof window === "undefined" || !wallet) return null;
  const stored = localStorage.getItem(getKeys(wallet).WALLET_ROLE);

  if (stored === "employer" || stored === "employee") {
    return stored;
  }

  return null;
};

export const getHomePathForRole = (role: WalletRole) =>
  role === "employee" ? "/claim/dashboard" : "/dashboard";
