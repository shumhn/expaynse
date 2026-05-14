import { getSwapQuote } from "../lib/magicblock-api.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const OUTPUT_CANDIDATES = [
  { label: "devnet-usdc", mint: DEVNET_USDC, amount: "10000000" }, // 0.01 SOL
  { label: "mainnet-usdc", mint: MAINNET_USDC, amount: "10000000" },
  { label: "mainnet-usdt", mint: MAINNET_USDT, amount: "10000000" },
] as const;

async function main() {
  console.log("=== Treasury swap quote probe ===");

  for (const candidate of OUTPUT_CANDIDATES) {
    try {
      const quote = await getSwapQuote({
        inputMint: SOL_MINT,
        outputMint: candidate.mint,
        amount: candidate.amount,
        swapMode: "ExactIn",
        slippageBps: 50,
        restrictIntermediateTokens: true,
        asLegacyTransaction: false,
      });

      console.log(
        JSON.stringify(
          {
            label: candidate.label,
            ok: true,
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            outAmount: quote.outAmount,
            routePlanCount: Array.isArray(quote.routePlan)
              ? quote.routePlan.length
              : 0,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            label: candidate.label,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  }
}

main().catch((error) => {
  console.error("\n❌ treasury swap quote probe failed");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
