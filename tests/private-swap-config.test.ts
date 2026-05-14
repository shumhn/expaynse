import assert from "assert";

import {
  buildTreasuryPrivateSwapRequest,
  getTreasuryFundingModeMeta,
  hasDevnetUsdt,
  SOL_MINT,
  toSwapInputAmountRaw,
} from "../lib/private-swap.ts";

function run() {
  const withoutUsdt = getTreasuryFundingModeMeta("");
  assert.equal(withoutUsdt.deposit.inputSymbol, "USDC");
  assert.equal(withoutUsdt["swap-sol"].inputMint, SOL_MINT);
  assert.equal(withoutUsdt["swap-usdt"].inputMint, "");
  assert.equal(hasDevnetUsdt(""), false, "blank mint should disable USDT mode");
  assert.equal(
    hasDevnetUsdt("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    true,
    "real-looking mint should enable USDT mode",
  );

  assert.equal(
    toSwapInputAmountRaw("swap-sol", 0.25),
    "250000000",
    "SOL mode should convert to lamports",
  );
  assert.equal(
    toSwapInputAmountRaw("swap-usdt", 12.34),
    "12340000",
    "USDT mode should convert to 6-decimal token units",
  );
  assert.throws(
    () => toSwapInputAmountRaw("deposit", 1),
    /Deposit mode does not build swap input amounts/,
  );

  const fakeQuote = {
    inputMint: SOL_MINT,
    inAmount: "1000000000",
    outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    outAmount: "1000000",
    otherAmountThreshold: "990000",
    swapMode: "ExactIn" as const,
    slippageBps: 50,
    priceImpactPct: "0",
    routePlan: [],
    contextSlot: 1,
    timeTaken: 1,
  };

  const req = buildTreasuryPrivateSwapRequest({
    mode: "swap-sol",
    userPublicKey: "user-demo",
    treasuryPubkey: "treasury-demo",
    quoteResponse: fakeQuote,
  });

  assert.equal(req.userPublicKey, "user-demo");
  assert.equal(req.payer, "user-demo");
  assert.equal(req.visibility, "private");
  assert.equal(req.wrapAndUnwrapSol, true);
  assert.equal(req.privateOptions?.destination, "treasury-demo");
  assert.equal(req.privateOptions?.split, 3);

  const usdtReq = buildTreasuryPrivateSwapRequest({
    mode: "swap-usdt",
    userPublicKey: "user-demo",
    treasuryPubkey: "treasury-demo",
    quoteResponse: {
      ...fakeQuote,
      inputMint: "usdt-demo",
    },
  });

  assert.equal(usdtReq.wrapAndUnwrapSol, false);

  console.log("private swap config tests passed");
}

run();
