import assert from "assert";
import fs from "fs";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import { DEVNET_USDC, buildSwap, getBalance, getPrivateBalance, getSwapQuote, signAndSend } from "../lib/magicblock-api.ts";
import {
  buildTreasuryPrivateSwapRequest,
  buildTreasurySwapQuoteParams,
  getTreasuryFundingAssetLabel,
  validateTreasuryFundingInput,
  type TreasuryFundingMode,
} from "../lib/private-swap.ts";

const DEFAULT_WALLET_PATH =
  "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";
const DEVNET_RPC = "https://api.devnet.solana.com";
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const TEE_URL = "https://devnet-tee.magicblock.app";
const DEVNET_USDT_MINT =
  process.env.NEXT_PUBLIC_DEVNET_USDT_MINT?.trim() ||
  process.env.TEST_DEVNET_USDT_MINT?.trim() ||
  "";
const OUTPUT_MINT =
  process.env.TEST_SWAP_OUTPUT_MINT?.trim() || DEVNET_USDC;
const EXECUTION_RPC =
  process.env.TEST_SWAP_RPC_URL?.trim() ||
  (OUTPUT_MINT === DEVNET_USDC ? DEVNET_RPC : MAINNET_RPC);

function resolveWalletPath() {
  return process.env.ANCHOR_WALLET || DEFAULT_WALLET_PATH;
}

function loadKeypairFromPath(walletPath: string) {
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[],
  );
  return Keypair.fromSecretKey(secret);
}

function loadAuthorityKeypair() {
  return loadKeypairFromPath(resolveWalletPath());
}

function loadTreasuryKeypairFromEnv() {
  const walletPath = process.env.TEST_TREASURY_WALLET?.trim();
  if (!walletPath) return null;
  return loadKeypairFromPath(walletPath);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBalanceMicro(balance: string | null | undefined) {
  return BigInt(balance || "0");
}

function toUiAmount(amountMicro: bigint) {
  return Number(amountMicro) / 1_000_000;
}

function getMode(): TreasuryFundingMode {
  const raw = process.env.TEST_TREASURY_SWAP_MODE?.trim() || "swap-sol";
  if (raw === "swap-sol" || raw === "swap-usdt") return raw;
  throw new Error(
    `Unsupported TEST_TREASURY_SWAP_MODE "${raw}". Use "swap-sol" or "swap-usdt".`,
  );
}

function getAmountUi(mode: TreasuryFundingMode) {
  const fallback = mode === "swap-sol" ? "0.01" : "1";
  const raw = process.env.TEST_TREASURY_SWAP_UI_AMOUNT?.trim() || fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid TEST_TREASURY_SWAP_UI_AMOUNT "${raw}". Use a positive number.`,
    );
  }
  return parsed;
}

function signTransactionFactory(signer: Keypair) {
  return async (tx: Transaction | VersionedTransaction) => {
    if (tx instanceof VersionedTransaction) {
      tx.sign([signer]);
      return tx;
    }
    tx.partialSign(signer);
    return tx;
  };
}

async function fetchPrivateAuthToken(authority: Keypair) {
  const auth = await getAuthToken(
    TEE_URL,
    authority.publicKey,
    async (message: Uint8Array) =>
      nacl.sign.detached(message, authority.secretKey),
  );
  return auth.token;
}

async function waitForPrivateBalanceIncrease(args: {
  address: string;
  token: string;
  previousBalanceMicro: bigint;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = args.attempts ?? 25;
  const delayMs = args.delayMs ?? 4000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const next = await getPrivateBalance(args.address, args.token);
      const nextMicro = parseBalanceMicro(next.balance);
      console.log(
        `[poll:private-destination] attempt ${attempt + 1}/${attempts}: ${toUiAmount(
          nextMicro,
        ).toFixed(6)} USDC (${next.location})`,
      );
      if (nextMicro > args.previousBalanceMicro) {
        return { next, nextMicro };
      }
    } catch (error) {
      console.log(
        `[poll:private-destination] attempt ${attempt + 1}/${attempts}: balance not available yet (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    await sleep(delayMs);
  }

  throw new Error("Timed out waiting for private treasury destination balance increase");
}

async function main() {
  const signer = loadAuthorityKeypair();
  const signerAddress = signer.publicKey.toBase58();
  const mode = getMode();
  const amountUi = getAmountUi(mode);
  const treasuryKeypair = loadTreasuryKeypairFromEnv() || Keypair.generate();
  const treasuryPubkey = treasuryKeypair.publicKey.toBase58();
  const shouldVerifyPrivateBalance = OUTPUT_MINT === DEVNET_USDC;
  const treasuryToken = shouldVerifyPrivateBalance
    ? await fetchPrivateAuthToken(treasuryKeypair)
    : null;

  console.log("=== Treasury private swap live test ===");
  console.log("Mode:", mode);
  console.log("Signer:", signerAddress);
  console.log("Destination treasury:", treasuryPubkey);
  console.log("Wallet path:", resolveWalletPath());
  console.log("Output mint:", OUTPUT_MINT);
  console.log("Execution RPC:", EXECUTION_RPC);

  if (mode === "swap-usdt" && !DEVNET_USDT_MINT) {
    throw new Error(
      "TEST_TREASURY_SWAP_MODE=swap-usdt requires NEXT_PUBLIC_DEVNET_USDT_MINT or TEST_DEVNET_USDT_MINT.",
    );
  }

  const connection = new Connection(EXECUTION_RPC, "confirmed");
  const solBalance = (await connection.getBalance(signer.publicKey)) / 1_000_000_000;
  const usdcBalance =
    parseInt((await getBalance(signerAddress)).balance ?? "0", 10) / 1_000_000;
  const usdtBalance =
    mode === "swap-usdt"
      ? parseInt(
          (
            await getBalance(signerAddress, undefined, DEVNET_USDT_MINT)
          ).balance ?? "0",
          10,
        ) / 1_000_000
      : 0;

  const validation = validateTreasuryFundingInput({
    mode,
    amountUi,
    treasuryPubkey,
    baseUsdc: usdcBalance,
    sol: solBalance,
    usdt: usdtBalance,
  });
  assert.equal(validation.ok, true, validation.ok ? "" : validation.error);

  console.log(
    `Input balance (${getTreasuryFundingAssetLabel(mode)}): ${
      mode === "swap-sol" ? solBalance.toFixed(6) : usdtBalance.toFixed(6)
    }`,
  );

  let previousPrivateMicro = 0n;
  if (shouldVerifyPrivateBalance && treasuryToken) {
    const previousPrivate = await getPrivateBalance(
      treasuryPubkey,
      treasuryToken,
    ).catch(() => null);
    previousPrivateMicro = parseBalanceMicro(previousPrivate?.balance);
    console.log(
      `Previous private treasury balance: ${toUiAmount(previousPrivateMicro).toFixed(6)} USDC`,
    );
  } else {
    console.log(
      "Skipping private balance verification because the output mint is not the devnet payroll USDC mint.",
    );
  }

  const quote = await getSwapQuote(
    buildTreasurySwapQuoteParams({
      mode,
      amountUi,
      devnetUsdtMint: DEVNET_USDT_MINT,
      outputMint: OUTPUT_MINT,
    }),
  );

  console.log(
    `Quote out amount: ${(parseInt(quote.outAmount, 10) / 1_000_000).toFixed(6)} USDC`,
  );

  const swapBuild = await buildSwap(
    buildTreasuryPrivateSwapRequest({
      mode,
      userPublicKey: signerAddress,
      treasuryPubkey,
      quoteResponse: quote,
    }),
  );

  if (!swapBuild.swapTransaction) {
    throw new Error("Swap build did not return a swapTransaction");
  }

  const signature = await signAndSend(
    swapBuild.swapTransaction,
    signTransactionFactory(signer),
    { sendTo: "base", publicKey: signer.publicKey, rpcUrl: EXECUTION_RPC },
  );

  console.log("Submitted signature:", signature);

  if (shouldVerifyPrivateBalance && treasuryToken) {
    const { nextMicro } = await waitForPrivateBalanceIncrease({
      address: treasuryPubkey,
      token: treasuryToken,
      previousBalanceMicro: previousPrivateMicro,
    });

    console.log(
      `New private treasury balance: ${toUiAmount(nextMicro).toFixed(6)} USDC`,
    );
  } else {
    console.log(
      "Swap transaction submitted on a tradable route. Private destination verification was skipped for this non-devnet-payroll output mint.",
    );
  }
  console.log("treasury private swap live test passed");
}

main().catch((error) => {
  console.error("\n❌ treasury private swap live test failed");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
