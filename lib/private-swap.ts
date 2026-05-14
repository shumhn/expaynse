import type {
  BuildSwapRequest,
  SwapQuoteParams,
  SwapQuoteResponse,
} from "@/lib/magicblock-api";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export type TreasuryFundingMode = "deposit" | "swap-sol" | "swap-usdt";

export type TreasuryFundingModeMeta = {
  label: string;
  inputLabel: string;
  inputSymbol: string;
  buttonLabel: string;
  balanceLabel: string;
  inputMint?: string;
};

export function getTreasuryFundingModeMeta(
  devnetUsdtMint?: string,
): Record<TreasuryFundingMode, TreasuryFundingModeMeta> {
  return {
    deposit: {
      label: "Deposit USDC",
      inputLabel: "Amount (USDC)",
      inputSymbol: "USDC",
      buttonLabel: "Confirm Deposit",
      balanceLabel: "Your Wallet Balance",
    },
    "swap-sol": {
      label: "Swap SOL",
      inputLabel: "Amount (SOL)",
      inputSymbol: "SOL",
      buttonLabel: "Swap to Treasury",
      balanceLabel: "Your SOL Balance",
      inputMint: SOL_MINT,
    },
    "swap-usdt": {
      label: "Swap USDT",
      inputLabel: "Amount (USDT)",
      inputSymbol: "USDT",
      buttonLabel: "Swap to Treasury",
      balanceLabel: "Your USDT Balance",
      inputMint: devnetUsdtMint,
    },
  };
}

export function hasDevnetUsdt(devnetUsdtMint?: string) {
  return Boolean(devnetUsdtMint?.trim());
}

export function getTreasuryFundingHistoryType(mode: TreasuryFundingMode) {
  if (mode === "swap-sol") return "swap-sol-fund-treasury";
  if (mode === "swap-usdt") return "swap-usdt-fund-treasury";
  return "fund-treasury";
}

export function getTreasuryFundingSuccessMessage(
  mode: TreasuryFundingMode,
  amountUi: number,
) {
  if (mode === "swap-sol") {
    return `Successfully swapped ${amountUi} SOL into private treasury USDC`;
  }
  if (mode === "swap-usdt") {
    return `Successfully swapped ${amountUi} USDT into private treasury USDC`;
  }
  return `Successfully deposited ${amountUi} USDC`;
}

export function getTreasuryFundingAssetLabel(mode: TreasuryFundingMode) {
  if (mode === "swap-sol") return "devnet SOL";
  if (mode === "swap-usdt") return "devnet USDT";
  return "base USDC";
}

export function getTreasuryFundingAvailableBalance(args: {
  mode: TreasuryFundingMode;
  baseUsdc: number;
  sol: number;
  usdt: number;
}) {
  if (args.mode === "swap-sol") return args.sol;
  if (args.mode === "swap-usdt") return args.usdt;
  return args.baseUsdc;
}

export function validateTreasuryFundingInput(args: {
  mode: TreasuryFundingMode;
  amountUi: number;
  treasuryPubkey?: string;
  baseUsdc: number;
  sol: number;
  usdt: number;
}) {
  if (!Number.isFinite(args.amountUi) || args.amountUi <= 0) {
    return { ok: false as const, error: "Enter a valid amount" };
  }

  if (args.mode !== "deposit" && !args.treasuryPubkey) {
    return {
      ok: false as const,
      error: "Private treasury destination is missing.",
    };
  }

  const available = getTreasuryFundingAvailableBalance({
    mode: args.mode,
    baseUsdc: args.baseUsdc,
    sol: args.sol,
    usdt: args.usdt,
  });
  const assetLabel = getTreasuryFundingAssetLabel(args.mode);

  if (args.amountUi > available) {
    return {
      ok: false as const,
      error:
        args.mode === "deposit"
          ? "Insufficient base balance"
          : `Insufficient ${assetLabel} balance.`,
    };
  }

  if (available <= 0) {
    return {
      ok: false as const,
      error:
        args.mode === "deposit"
          ? "Current wallet has no live base USDC. Fund this wallet with devnet USDC first."
          : `Current wallet has no ${assetLabel}. Fund this wallet first.`,
    };
  }

  return { ok: true as const };
}

export function toSwapInputAmountRaw(
  mode: TreasuryFundingMode,
  uiAmount: number,
) {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
    throw new Error("Swap amount must be a positive number");
  }

  if (mode === "swap-sol") {
    return String(Math.round(uiAmount * 1_000_000_000));
  }

  if (mode === "swap-usdt") {
    return String(Math.round(uiAmount * 1_000_000));
  }

  throw new Error("Deposit mode does not build swap input amounts");
}

export function buildTreasurySwapQuoteParams(args: {
  mode: Exclude<TreasuryFundingMode, "deposit">;
  amountUi: number;
  devnetUsdtMint?: string;
  outputMint?: string;
}): SwapQuoteParams {
  const meta = getTreasuryFundingModeMeta(args.devnetUsdtMint);
  return {
    inputMint: meta[args.mode].inputMint || SOL_MINT,
    outputMint: args.outputMint || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amount: toSwapInputAmountRaw(args.mode, args.amountUi),
    swapMode: "ExactIn",
    slippageBps: 50,
    restrictIntermediateTokens: true,
    asLegacyTransaction: false,
  };
}

export function buildTreasuryPrivateSwapRequest(args: {
  mode: Exclude<TreasuryFundingMode, "deposit">;
  userPublicKey: string;
  treasuryPubkey: string;
  quoteResponse: SwapQuoteResponse;
}): BuildSwapRequest {
  return {
    userPublicKey: args.userPublicKey,
    payer: args.userPublicKey,
    quoteResponse: args.quoteResponse,
    wrapAndUnwrapSol: args.mode === "swap-sol",
    useSharedAccounts: true,
    dynamicComputeUnitLimit: true,
    visibility: "private",
    privateOptions: {
      destination: args.treasuryPubkey,
      minDelayMs: "0",
      maxDelayMs: "60000",
      split: 3,
    },
  };
}
