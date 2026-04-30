import assert from "assert";
import fs from "fs";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

const BASE = "https://payments.magicblock.app/v1/spl";
const DEVNET_RPC = "https://api.devnet.solana.com";
const EPHEMERAL_RPC = "https://devnet.magicblock.app";
const TEE_URL = "https://devnet-tee.magicblock.app";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_WALLET_PATH =
  "/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json";

type BalanceLocation = "base" | "ephemeral";

type BalanceResponse = {
  address: string;
  mint: string;
  ata: string;
  location: BalanceLocation;
  balance: string;
};

type DepositLikeResponse = {
  kind: string;
  version: string;
  transactionBase64?: string;
  sendTo?: BalanceLocation;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  instructionCount?: number;
  requiredSigners?: string[];
  validator?: string;
};

type MintInitializationResponse = {
  mint: string;
  validator: string;
  transferQueue: string;
  initialized: boolean;
};

type TransferBuildResponse = {
  kind: string;
  version: string;
  transactionBase64?: string;
  sendTo?: BalanceLocation;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  instructionCount?: number;
  requiredSigners?: string[];
  validator?: string;
};

function resolveWalletPath() {
  return process.env.ANCHOR_WALLET || DEFAULT_WALLET_PATH;
}

function loadAuthorityKeypair() {
  const walletPath = resolveWalletPath();
  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[],
  );
  return Keypair.fromSecretKey(secret);
}

function toUiAmount(amountMicro: bigint) {
  return Number(amountMicro) / 1_000_000;
}

function parseBalance(balance: string) {
  return BigInt(balance);
}

function parseUiAmountToMicro(uiAmount: string) {
  const normalized = uiAmount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
    throw new Error(
      `Invalid TEST_DEPOSIT_UI_AMOUNT "${uiAmount}". Use a numeric USDC amount with up to 6 decimals.`,
    );
  }

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const wholeMicro = BigInt(wholePart) * 1_000_000n;
  const fractionalMicro = BigInt(fractionalPart.padEnd(6, "0"));
  return wholeMicro + fractionalMicro;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSection(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${text}`);
  }

  return JSON.parse(text) as T;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }

  return JSON.parse(text) as T;
}

async function healthCheck() {
  const res = await fetch("https://payments.magicblock.app/health");
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Health check failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as { status: string };
}

async function isMintInitialized() {
  return getJson<MintInitializationResponse>(
    `${BASE}/is-mint-initialized?mint=${DEVNET_USDC}&cluster=devnet`,
  );
}

async function getBaseBalance(address: string) {
  return getJson<BalanceResponse>(
    `${BASE}/balance?address=${address}&mint=${DEVNET_USDC}&cluster=devnet`,
  );
}

async function getPrivateBalance(address: string, token?: string) {
  return getJson<BalanceResponse>(
    `${BASE}/private-balance?address=${address}&mint=${DEVNET_USDC}&cluster=devnet`,
    token,
  );
}

async function buildDeposit(owner: string, amountMicro: number) {
  return postJson<DepositLikeResponse>("/deposit", {
    owner,
    amount: amountMicro,
    mint: DEVNET_USDC,
    cluster: "devnet",
    initIfMissing: true,
    initVaultIfMissing: true,
    initAtasIfMissing: true,
    idempotent: true,
  });
}

async function buildWithdraw(
  owner: string,
  amountMicro: number,
  token: string,
) {
  return postJson<DepositLikeResponse>(
    "/withdraw",
    {
      owner,
      amount: amountMicro,
      mint: DEVNET_USDC,
      cluster: "devnet",
      initAtasIfMissing: true,
      idempotent: true,
    },
    token,
  );
}

async function buildPrivateTransfer(args: {
  from: string;
  to: string;
  amountMicro: number;
  token: string;
  fromBalance: BalanceLocation;
  toBalance: BalanceLocation;
  split?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  memo?: string;
}) {
  const body: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    mint: DEVNET_USDC,
    amount: args.amountMicro,
    visibility: "private",
    fromBalance: args.fromBalance,
    toBalance: args.toBalance,
    cluster: "devnet",
    initIfMissing: true,
    initAtasIfMissing: true,
    initVaultIfMissing: true,
  };

  if (typeof args.split === "number") {
    body.split = args.split;
  }

  if (typeof args.minDelayMs === "number") {
    body.minDelayMs = String(args.minDelayMs);
  }

  if (typeof args.maxDelayMs === "number") {
    body.maxDelayMs = String(args.maxDelayMs);
  }

  if (typeof args.memo === "string" && args.memo.trim()) {
    body.memo = args.memo.trim();
  }

  return postJson<TransferBuildResponse>(
    "/transfer",
    body,
    args.token,
  );
}

function deserializeTx(base64: string): Transaction | VersionedTransaction {
  const buf = Buffer.from(base64, "base64");
  try {
    return VersionedTransaction.deserialize(buf);
  } catch {
    return Transaction.from(buf);
  }
}

function summarizeLegacyTransaction(tx: Transaction) {
  return {
    kind: "legacy",
    feePayer: tx.feePayer?.toBase58() ?? null,
    recentBlockhash: tx.recentBlockhash ?? null,
    signatures: tx.signatures.map((sig, index) => ({
      index,
      publicKey: sig.publicKey.toBase58(),
      hasSignature: Boolean(sig.signature),
    })),
    instructions: tx.instructions.map((ix, instructionIndex) => ({
      instructionIndex,
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((key, keyIndex) => ({
        keyIndex,
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      dataLength: ix.data.length,
    })),
  };
}

function summarizeVersionedTransaction(tx: VersionedTransaction) {
  const message = tx.message;
  const staticKeys = message.staticAccountKeys.map((key, index) => ({
    index,
    pubkey: key.toBase58(),
    isSigner: index < message.header.numRequiredSignatures,
    isWritable:
      index <
        message.header.numRequiredSignatures -
          message.header.numReadonlySignedAccounts ||
      (index >= message.header.numRequiredSignatures &&
        index <
          message.staticAccountKeys.length -
            message.header.numReadonlyUnsignedAccounts),
  }));

  return {
    kind: "versioned",
    recentBlockhash: message.recentBlockhash,
    signatures: tx.signatures.map((sig, index) => ({
      index,
      hasSignature: sig.some((byte) => byte !== 0),
    })),
    staticAccountKeys: staticKeys,
    compiledInstructions: message.compiledInstructions.map(
      (ix, instructionIndex) => ({
        instructionIndex,
        programIdIndex: ix.programIdIndex,
        programId:
          staticKeys[ix.programIdIndex]?.pubkey ??
          `unknown:${ix.programIdIndex}`,
        accountKeyIndexes: Array.from(ix.accountKeyIndexes),
        accounts: Array.from(ix.accountKeyIndexes).map((accountIndex) => ({
          accountIndex,
          pubkey: staticKeys[accountIndex]?.pubkey ?? `unknown:${accountIndex}`,
          isSigner: staticKeys[accountIndex]?.isSigner ?? false,
          isWritable: staticKeys[accountIndex]?.isWritable ?? false,
        })),
        dataLength: ix.data.length,
      }),
    ),
    addressTableLookups: message.addressTableLookups.map((lookup, index) => ({
      index,
      accountKey: lookup.accountKey.toBase58(),
      writableIndexes: Array.from(lookup.writableIndexes),
      readonlyIndexes: Array.from(lookup.readonlyIndexes),
    })),
  };
}

function logTransactionDebug(
  txBase64: string,
  sendTo: BalanceLocation,
  tx: Transaction | VersionedTransaction,
) {
  console.log("=== Transaction Debug Summary ===");
  console.log(
    JSON.stringify(
      {
        sendTo,
        serializedLength: Buffer.from(txBase64, "base64").length,
        summary:
          tx instanceof VersionedTransaction
            ? summarizeVersionedTransaction(tx)
            : summarizeLegacyTransaction(tx),
      },
      null,
      2,
    ),
  );
  console.log("=== End Transaction Debug Summary ===");
}

async function signAndSendServerTransaction(
  txBase64: string,
  sendTo: BalanceLocation,
  signer: Keypair,
) {
  const tx = deserializeTx(txBase64);

  let raw: Uint8Array;
  if (tx instanceof VersionedTransaction) {
    tx.sign([signer]);
    raw = tx.serialize();
  } else {
    tx.partialSign(signer);
    raw = tx.serialize();
  }

  const connection =
    sendTo === "ephemeral"
      ? new Connection(EPHEMERAL_RPC, "confirmed")
      : new Connection(DEVNET_RPC, "confirmed");

  try {
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
    });
    await connection.confirmTransaction(signature, "confirmed");
    return signature;
  } catch (error) {
    console.log("=== sendRawTransaction FAILED ===");
    console.log("sendTo:", sendTo);
    console.log("rpc:", sendTo === "ephemeral" ? EPHEMERAL_RPC : DEVNET_RPC);
    console.log("signer:", signer.publicKey.toBase58());
    logTransactionDebug(txBase64, sendTo, tx);

    try {
      const simulated = await connection.simulateTransaction(tx, {
        sigVerify: true,
        commitment: "confirmed",
      });
      console.log("=== simulateTransaction result ===");
      console.log(JSON.stringify(simulated.value, null, 2));
      console.log("=== end simulateTransaction result ===");
    } catch (simulateError) {
      console.log("=== simulateTransaction threw ===");
      console.log(
        simulateError instanceof Error
          ? simulateError.stack || simulateError.message
          : String(simulateError),
      );
      console.log("=== end simulateTransaction threw ===");
    }

    if (error instanceof SendTransactionError) {
      try {
        const logs = await error.getLogs(connection);
        console.log("=== SendTransactionError logs ===");
        console.log(logs ? logs.join("\n") : "No logs returned");
        console.log("=== end SendTransactionError logs ===");
      } catch (logError) {
        console.log("=== getLogs() threw ===");
        console.log(
          logError instanceof Error
            ? logError.stack || logError.message
            : String(logError),
        );
        console.log("=== end getLogs() threw ===");
      }
    }

    throw error;
  }
}

async function fetchAuthToken(authority: Keypair) {
  const auth = await getAuthToken(
    TEE_URL,
    authority.publicKey,
    async (message: Uint8Array) =>
      nacl.sign.detached(message, authority.secretKey),
  );
  return auth.token;
}

async function waitForBalanceChange(args: {
  label: string;
  getBalance: () => Promise<BalanceResponse>;
  predicate: (next: bigint) => boolean;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = args.attempts ?? 12;
  const delayMs = args.delayMs ?? 2000;

  for (let i = 0; i < attempts; i += 1) {
    const next = await args.getBalance();
    const nextAmount = parseBalance(next.balance);
    console.log(
      `[poll:${args.label}] attempt ${i + 1}/${attempts}: ${toUiAmount(nextAmount).toFixed(6)} USDC (${next.location})`,
    );
    if (args.predicate(nextAmount)) {
      return next;
    }
    await sleep(delayMs);
  }

  throw new Error(`Timed out waiting for ${args.label} balance change`);
}

async function waitForDualPrivateBalanceChange(args: {
  fromLabel: string;
  toLabel: string;
  fromAddress: string;
  toAddress: string;
  token: string;
  fromPredicate: (next: bigint) => boolean;
  toPredicate: (next: bigint) => boolean;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = args.attempts ?? 12;
  const delayMs = args.delayMs ?? 2000;

  for (let i = 0; i < attempts; i += 1) {
    const [fromNext, toNext] = await Promise.all([
      getPrivateBalance(args.fromAddress, args.token),
      getPrivateBalance(args.toAddress, args.token),
    ]);

    const fromAmount = parseBalance(fromNext.balance);
    const toAmount = parseBalance(toNext.balance);

    console.log(
      `[poll:${args.fromLabel}] attempt ${i + 1}/${attempts}: ${toUiAmount(fromAmount).toFixed(6)} USDC (${fromNext.location})`,
    );
    console.log(
      `[poll:${args.toLabel}] attempt ${i + 1}/${attempts}: ${toUiAmount(toAmount).toFixed(6)} USDC (${toNext.location})`,
    );

    if (args.fromPredicate(fromAmount) && args.toPredicate(toAmount)) {
      return { fromNext, toNext, fromAmount, toAmount };
    }

    await sleep(delayMs);
  }

  throw new Error(
    `Timed out waiting for ${args.fromLabel} and ${args.toLabel} private balance changes`,
  );
}

async function main() {
  const authority = loadAuthorityKeypair();
  const owner = authority.publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();

  console.log("MagicBlock direct API smoke test");
  console.log("Owner:", owner);
  console.log("Recipient:", recipient);
  console.log("Wallet path:", resolveWalletPath());

  logSection("Health");
  const health = await healthCheck();
  console.log("Health:", health);
  assert.strictEqual(health.status, "ok");

  logSection("Mint initialization");
  const mintStatus = await isMintInitialized();
  console.log("Mint status:", mintStatus);
  assert.strictEqual(mintStatus.mint, DEVNET_USDC);
  assert.strictEqual(typeof mintStatus.initialized, "boolean");

  logSection("Auth token");
  const token = await fetchAuthToken(authority);
  assert(token.length > 0, "Expected non-empty auth token");
  console.log("TEE auth token acquired");

  logSection("Initial balances");
  const [baseBefore, privateBefore] = await Promise.all([
    getBaseBalance(owner),
    getPrivateBalance(owner, token),
  ]);

  const baseBeforeAmount = parseBalance(baseBefore.balance);
  const privateBeforeAmount = parseBalance(privateBefore.balance);

  console.log(
    "Base snapshot before optional reset:",
    `${toUiAmount(baseBeforeAmount).toFixed(6)} USDC`,
    baseBefore,
  );
  console.log(
    "Private snapshot before optional reset:",
    `${toUiAmount(privateBeforeAmount).toFixed(6)} USDC`,
    privateBefore,
  );

  const shouldResetPrivateToZero =
    process.env.TEST_RESET_PRIVATE_TO_ZERO === "1" ||
    process.env.TEST_RESET_PRIVATE_TO_ZERO === "true";

  let effectiveBaseBefore = baseBefore;
  let effectivePrivateBefore = privateBefore;
  let effectiveBaseBeforeAmount = baseBeforeAmount;
  let effectivePrivateBeforeAmount = privateBeforeAmount;

  if (shouldResetPrivateToZero && privateBeforeAmount > 0n) {
    logSection("Reset private balance to zero");

    assert(
      privateBeforeAmount <= BigInt(Number.MAX_SAFE_INTEGER),
      "Existing private balance is too large to serialize safely",
    );

    const resetWithdrawTx = await buildWithdraw(
      owner,
      Number(privateBeforeAmount),
      token,
    );

    console.log("Reset withdraw build response:", {
      kind: resetWithdrawTx.kind,
      version: resetWithdrawTx.version,
      sendTo: resetWithdrawTx.sendTo,
      validator: resetWithdrawTx.validator,
      instructionCount: resetWithdrawTx.instructionCount,
      requiredSigners: resetWithdrawTx.requiredSigners,
    });

    assert(
      resetWithdrawTx.transactionBase64,
      "Reset withdraw response missing transactionBase64",
    );
    assert(resetWithdrawTx.sendTo, "Reset withdraw response missing sendTo");

    const resetWithdrawSignature = await signAndSendServerTransaction(
      resetWithdrawTx.transactionBase64,
      resetWithdrawTx.sendTo,
      authority,
    );
    console.log("Reset withdraw signature:", resetWithdrawSignature);

    const baseAfterReset = await waitForBalanceChange({
      label: "base-after-reset",
      getBalance: () => getBaseBalance(owner),
      predicate: (next) => next >= baseBeforeAmount + privateBeforeAmount,
    });

    const privateAfterReset = await waitForBalanceChange({
      label: "private-after-reset",
      getBalance: () => getPrivateBalance(owner, token),
      predicate: (next) => next === 0n,
    });

    effectiveBaseBefore = baseAfterReset;
    effectivePrivateBefore = privateAfterReset;
    effectiveBaseBeforeAmount = parseBalance(baseAfterReset.balance);
    effectivePrivateBeforeAmount = parseBalance(privateAfterReset.balance);

    console.log(
      "Base after reset:",
      `${toUiAmount(effectiveBaseBeforeAmount).toFixed(6)} USDC`,
      effectiveBaseBefore,
    );
    console.log(
      "Private after reset:",
      `${toUiAmount(effectivePrivateBeforeAmount).toFixed(6)} USDC`,
      effectivePrivateBefore,
    );
  }

  logSection("Effective test start");
  console.log(
    "Base effective start:",
    `${toUiAmount(effectiveBaseBeforeAmount).toFixed(6)} USDC`,
    effectiveBaseBefore,
  );
  console.log(
    "Private effective start:",
    `${toUiAmount(effectivePrivateBeforeAmount).toFixed(6)} USDC`,
    effectivePrivateBefore,
  );

  const depositAmountUi = process.env.TEST_DEPOSIT_UI_AMOUNT || "1";
  const depositAmountMicroBigInt = parseUiAmountToMicro(depositAmountUi);
  assert(
    depositAmountMicroBigInt > 0n,
    "TEST_DEPOSIT_UI_AMOUNT must be greater than 0",
  );
  assert(
    depositAmountMicroBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
    "TEST_DEPOSIT_UI_AMOUNT is too large to serialize safely",
  );

  assert(
    effectiveBaseBeforeAmount >= depositAmountMicroBigInt,
    `Need at least ${toUiAmount(depositAmountMicroBigInt).toFixed(2)} base USDC in the wallet to run this smoke test`,
  );

  const depositAmountMicro = Number(depositAmountMicroBigInt);

  console.log(
    "Configured deposit amount:",
    `${toUiAmount(depositAmountMicroBigInt).toFixed(6)} USDC`,
  );

  logSection("Deposit");
  const depositTx = await buildDeposit(owner, depositAmountMicro);
  console.log("Deposit build response:", {
    kind: depositTx.kind,
    version: depositTx.version,
    sendTo: depositTx.sendTo,
    validator: depositTx.validator,
    instructionCount: depositTx.instructionCount,
    requiredSigners: depositTx.requiredSigners,
  });

  assert(
    depositTx.transactionBase64,
    "Deposit response missing transactionBase64",
  );
  assert(depositTx.sendTo, "Deposit response missing sendTo");

  const depositSignature = await signAndSendServerTransaction(
    depositTx.transactionBase64,
    depositTx.sendTo,
    authority,
  );
  console.log("Deposit signature:", depositSignature);

  const baseAfterDeposit = await waitForBalanceChange({
    label: "base-after-deposit",
    getBalance: () => getBaseBalance(owner),
    predicate: (next) =>
      next <= effectiveBaseBeforeAmount - depositAmountMicroBigInt,
  });

  const privateAfterDeposit = await waitForBalanceChange({
    label: "private-after-deposit",
    getBalance: () => getPrivateBalance(owner, token),
    predicate: (next) =>
      next >= effectivePrivateBeforeAmount + depositAmountMicroBigInt,
  });

  const baseAfterDepositAmount = parseBalance(baseAfterDeposit.balance);
  const privateAfterDepositAmount = parseBalance(privateAfterDeposit.balance);

  console.log(
    "Base after deposit:",
    `${toUiAmount(baseAfterDepositAmount).toFixed(6)} USDC`,
    baseAfterDeposit,
  );
  console.log(
    "Private after deposit:",
    `${toUiAmount(privateAfterDepositAmount).toFixed(6)} USDC`,
    privateAfterDeposit,
  );

  assert(
    baseAfterDeposit.location === "base",
    "Expected /balance location to be base",
  );
  assert(
    privateAfterDeposit.location === "ephemeral",
    "Expected /private-balance location to be ephemeral",
  );
  assert(
    baseAfterDepositAmount <=
      effectiveBaseBeforeAmount - depositAmountMicroBigInt,
    "Base balance did not decrease after deposit as expected",
  );
  assert(
    privateAfterDepositAmount >=
      effectivePrivateBeforeAmount + depositAmountMicroBigInt,
    "Private balance did not increase after deposit as expected",
  );

  logSection("Ephemeral -> Ephemeral private transfer");
  let recipientPrivateBefore = await getPrivateBalance(recipient, token);
  let recipientPrivateBeforeAmount = parseBalance(
    recipientPrivateBefore.balance,
  );

  console.log(
    "Recipient private before transfer:",
    `${toUiAmount(recipientPrivateBeforeAmount).toFixed(6)} USDC`,
    recipientPrivateBefore,
  );

  const bootstrapRecipientPrivateEnv =
    process.env.TEST_BOOTSTRAP_RECIPIENT_PRIVATE;
  const shouldBootstrapRecipientPrivate =
    bootstrapRecipientPrivateEnv == null
      ? true
      : bootstrapRecipientPrivateEnv === "1" ||
        bootstrapRecipientPrivateEnv === "true";

  if (shouldBootstrapRecipientPrivate && recipientPrivateBeforeAmount === 0n) {
    logSection("Bootstrap recipient private balance");

    const recipientBootstrapAmountMicro = 1;

    const recipientBootstrapTx = await buildPrivateTransfer({
      from: owner,
      to: recipient,
      amountMicro: recipientBootstrapAmountMicro,
      token,
      fromBalance: "base",
      toBalance: "ephemeral",
    });

    console.log("Recipient bootstrap transfer build response:", {
      kind: recipientBootstrapTx.kind,
      version: recipientBootstrapTx.version,
      sendTo: recipientBootstrapTx.sendTo,
      validator: recipientBootstrapTx.validator,
      instructionCount: recipientBootstrapTx.instructionCount,
      requiredSigners: recipientBootstrapTx.requiredSigners,
    });

    assert(
      recipientBootstrapTx.transactionBase64,
      "Recipient bootstrap transfer response missing transactionBase64",
    );
    assert(
      recipientBootstrapTx.sendTo,
      "Recipient bootstrap transfer response missing sendTo",
    );

    const recipientBootstrapSignature = await signAndSendServerTransaction(
      recipientBootstrapTx.transactionBase64,
      recipientBootstrapTx.sendTo,
      authority,
    );
    console.log(
      "Recipient bootstrap transfer signature:",
      recipientBootstrapSignature,
    );

    recipientPrivateBefore = await waitForBalanceChange({
      label: "recipient-private-after-bootstrap",
      getBalance: () => getPrivateBalance(recipient, token),
      predicate: (next) => next >= 1n,
    });
    recipientPrivateBeforeAmount = parseBalance(recipientPrivateBefore.balance);

    console.log(
      "Recipient private after bootstrap:",
      `${toUiAmount(recipientPrivateBeforeAmount).toFixed(6)} USDC`,
      recipientPrivateBefore,
    );
  }

  const transferAmountMicroBigInt = depositAmountMicroBigInt / 2n;
  assert(
    transferAmountMicroBigInt > 0n,
    "Deposit amount must be at least 0.000002 USDC to test ephemeral-to-ephemeral transfer",
  );
  assert(
    transferAmountMicroBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
    "Transfer amount is too large to serialize safely",
  );

  const transferAmountMicro = Number(transferAmountMicroBigInt);
  const transferSplit = Number.parseInt(process.env.TEST_TRANSFER_SPLIT || "3", 10);
  const transferDelayMinutes = Number.parseFloat(
    process.env.TEST_TRANSFER_DELAY_MINUTES || "10",
  );
  const transferDelayMs = Number.isFinite(transferDelayMinutes)
    ? Math.round(transferDelayMinutes * 60_000)
    : undefined;
  const transferMemo =
    process.env.TEST_TRANSFER_MEMO || "Expaynse delay/split/memo smoke";

  const privateTransferTx = await buildPrivateTransfer({
    from: owner,
    to: recipient,
    amountMicro: transferAmountMicro,
    token,
    fromBalance: "ephemeral",
    toBalance: "ephemeral",
    split: Number.isFinite(transferSplit) && transferSplit > 0 ? transferSplit : undefined,
    minDelayMs: transferDelayMs,
    maxDelayMs: transferDelayMs,
    memo: transferMemo,
  });

  console.log("Ephemeral transfer build response:", {
    kind: privateTransferTx.kind,
    version: privateTransferTx.version,
    sendTo: privateTransferTx.sendTo,
    validator: privateTransferTx.validator,
    instructionCount: privateTransferTx.instructionCount,
    requiredSigners: privateTransferTx.requiredSigners,
    split:
      Number.isFinite(transferSplit) && transferSplit > 0 ? transferSplit : null,
    delayMs: transferDelayMs ?? null,
    memo: transferMemo,
  });

  assert(
    privateTransferTx.transactionBase64,
    "Ephemeral transfer response missing transactionBase64",
  );
  assert(
    privateTransferTx.sendTo,
    "Ephemeral transfer response missing sendTo",
  );

  const privateTransferSignature = await signAndSendServerTransaction(
    privateTransferTx.transactionBase64,
    privateTransferTx.sendTo,
    authority,
  );
  console.log("Ephemeral transfer signature:", privateTransferSignature);

  const transferPoll = await waitForDualPrivateBalanceChange({
    fromLabel: "owner-private-after-ephemeral-transfer",
    toLabel: "recipient-private-after-ephemeral-transfer",
    fromAddress: owner,
    toAddress: recipient,
    token,
    fromPredicate: (next) =>
      next <= privateAfterDepositAmount - transferAmountMicroBigInt,
    toPredicate: (next) =>
      next >= recipientPrivateBeforeAmount + transferAmountMicroBigInt,
  });

  console.log(
    "Owner private after ephemeral transfer:",
    `${toUiAmount(transferPoll.fromAmount).toFixed(6)} USDC`,
    transferPoll.fromNext,
  );
  console.log(
    "Recipient private after ephemeral transfer:",
    `${toUiAmount(transferPoll.toAmount).toFixed(6)} USDC`,
    transferPoll.toNext,
  );

  assert(
    transferPoll.fromAmount <=
      privateAfterDepositAmount - transferAmountMicroBigInt,
    "Owner private balance did not decrease after ephemeral transfer as expected",
  );
  assert(
    transferPoll.toAmount >=
      recipientPrivateBeforeAmount + transferAmountMicroBigInt,
    "Recipient private balance did not increase after ephemeral transfer as expected",
  );

  logSection("Withdraw");
  const withdrawTx = await buildWithdraw(
    owner,
    depositAmountMicro - transferAmountMicro,
    token,
  );
  console.log("Withdraw build response:", {
    kind: withdrawTx.kind,
    version: withdrawTx.version,
    sendTo: withdrawTx.sendTo,
    validator: withdrawTx.validator,
    instructionCount: withdrawTx.instructionCount,
    requiredSigners: withdrawTx.requiredSigners,
  });

  assert(
    withdrawTx.transactionBase64,
    "Withdraw response missing transactionBase64",
  );
  assert(withdrawTx.sendTo, "Withdraw response missing sendTo");

  const withdrawSignature = await signAndSendServerTransaction(
    withdrawTx.transactionBase64,
    withdrawTx.sendTo,
    authority,
  );
  console.log("Withdraw signature:", withdrawSignature);

  const baseBeforeWithdrawAmount = baseAfterDepositAmount;
  const privateBeforeWithdrawAmount = transferPoll.fromAmount;

  const baseAfterWithdraw = await waitForBalanceChange({
    label: "base-after-withdraw",
    getBalance: () => getBaseBalance(owner),
    predicate: (next) => next > baseBeforeWithdrawAmount,
  });

  const privateAfterWithdraw = await waitForBalanceChange({
    label: "private-after-withdraw",
    getBalance: () => getPrivateBalance(owner, token),
    predicate: (next) => next < privateBeforeWithdrawAmount,
  });

  const baseAfterWithdrawAmount = parseBalance(baseAfterWithdraw.balance);
  const privateAfterWithdrawAmount = parseBalance(privateAfterWithdraw.balance);

  console.log(
    "Base after withdraw:",
    `${toUiAmount(baseAfterWithdrawAmount).toFixed(6)} USDC`,
    baseAfterWithdraw,
  );
  console.log(
    "Private after withdraw:",
    `${toUiAmount(privateAfterWithdrawAmount).toFixed(6)} USDC`,
    privateAfterWithdraw,
  );

  assert(
    baseAfterWithdraw.location === "base",
    "Expected /balance location to remain base",
  );
  assert(
    privateAfterWithdraw.location === "ephemeral",
    "Expected /private-balance location to remain ephemeral",
  );
  assert(
    baseAfterWithdrawAmount > baseBeforeWithdrawAmount,
    "Base balance did not increase after withdraw as expected",
  );
  assert(
    privateAfterWithdrawAmount < privateBeforeWithdrawAmount,
    "Private balance did not decrease after withdraw as expected",
  );

  logSection("Summary");
  console.log("\n=== Summary ===");
  console.log("Deposit moved funds from base -> ephemeral");
  console.log(
    "Ephemeral transfer moved funds from owner private -> recipient private",
  );
  console.log("Withdraw moved remaining owner funds from ephemeral -> base");
  console.log(
    "This confirms base and private balances are separate, and verifies whether direct private -> private transfer works on devnet.",
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error("\n[magicblock-api-e2e] FAILED");
  console.error(message);
  process.exit(1);
});
