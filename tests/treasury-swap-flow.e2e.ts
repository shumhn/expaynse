import assert from "assert";

import {
  buildTreasuryPrivateSwapRequest,
  buildTreasurySwapQuoteParams,
  getTreasuryFundingAvailableBalance,
  getTreasuryFundingHistoryType,
  getTreasuryFundingSuccessMessage,
  validateTreasuryFundingInput,
} from "../lib/private-swap.ts";

function run() {
  const devnetUsdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  const solValidation = validateTreasuryFundingInput({
    mode: "swap-sol",
    amountUi: 1.25,
    treasuryPubkey: "treasury-demo",
    baseUsdc: 20,
    sol: 2,
    usdt: 0,
  });
  assert.equal(solValidation.ok, true, "SOL treasury funding should validate");

  const missingTreasury = validateTreasuryFundingInput({
    mode: "swap-sol",
    amountUi: 0.5,
    baseUsdc: 0,
    sol: 1,
    usdt: 0,
  });
  assert.equal(missingTreasury.ok, false);
  if (!missingTreasury.ok) {
    assert.match(missingTreasury.error, /Private treasury destination is missing/);
  }

  const insufficientUsdt = validateTreasuryFundingInput({
    mode: "swap-usdt",
    amountUi: 5,
    treasuryPubkey: "treasury-demo",
    baseUsdc: 0,
    sol: 0,
    usdt: 1,
  });
  assert.equal(insufficientUsdt.ok, false);
  if (!insufficientUsdt.ok) {
    assert.match(insufficientUsdt.error, /Insufficient devnet USDT balance/);
  }

  assert.equal(
    getTreasuryFundingAvailableBalance({
      mode: "deposit",
      baseUsdc: 12,
      sol: 1,
      usdt: 4,
    }),
    12,
  );
  assert.equal(
    getTreasuryFundingAvailableBalance({
      mode: "swap-sol",
      baseUsdc: 12,
      sol: 1,
      usdt: 4,
    }),
    1,
  );

  const solQuote = buildTreasurySwapQuoteParams({
    mode: "swap-sol",
    amountUi: 0.5,
    outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  });
  assert.equal(solQuote.inputMint, "So11111111111111111111111111111111111111112");
  assert.equal(solQuote.amount, "500000000");

  const usdtQuote = buildTreasurySwapQuoteParams({
    mode: "swap-usdt",
    amountUi: 7.25,
    devnetUsdtMint,
    outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  });
  assert.equal(usdtQuote.inputMint, devnetUsdtMint);
  assert.equal(usdtQuote.amount, "7250000");

  const quoteResponse = {
    inputMint: solQuote.inputMint,
    inAmount: solQuote.amount,
    outputMint: solQuote.outputMint,
    outAmount: "1230000",
    otherAmountThreshold: "1200000",
    swapMode: "ExactIn" as const,
    slippageBps: 50,
    priceImpactPct: "0",
    routePlan: [],
    contextSlot: 1,
    timeTaken: 1,
  };

  const buildReq = buildTreasuryPrivateSwapRequest({
    mode: "swap-sol",
    userPublicKey: "employer-demo",
    treasuryPubkey: "treasury-demo",
    quoteResponse,
  });
  assert.equal(buildReq.userPublicKey, "employer-demo");
  assert.equal(buildReq.visibility, "private");
  assert.equal(buildReq.privateOptions?.destination, "treasury-demo");
  assert.equal(buildReq.privateOptions?.maxDelayMs, "60000");

  assert.equal(getTreasuryFundingHistoryType("deposit"), "fund-treasury");
  assert.equal(getTreasuryFundingHistoryType("swap-sol"), "swap-sol-fund-treasury");
  assert.equal(getTreasuryFundingHistoryType("swap-usdt"), "swap-usdt-fund-treasury");

  assert.match(
    getTreasuryFundingSuccessMessage("swap-sol", 1.5),
    /1.5 SOL into private treasury USDC/,
  );
  assert.match(
    getTreasuryFundingSuccessMessage("swap-usdt", 10),
    /10 USDT into private treasury USDC/,
  );

  console.log("treasury swap flow e2e tests passed");
}

run();
