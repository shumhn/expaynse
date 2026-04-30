import { randomUUID } from "crypto";
import { MongoClient, Db, Collection } from "mongodb";

export interface PrivacyConfigRecord {
  visibility?: "private";
  fromBalance?: "base" | "ephemeral";
  toBalance?: "base" | "ephemeral";
  minDelayMs?: number;
  maxDelayMs?: number;
  split?: number;
  memo?: string;
  destinationStrategy?: "connected-wallet" | "custom-address";
}

export interface ProviderMetaRecord {
  provider?: "magicblock";
  sendTo?: string;
  clientRefId?: string;
}

export interface PayrollRun {
  id: string;
  date: string;
  wallet: string;
  totalAmount: number;
  employeeCount: number;
  recipientAddresses: string[];
  depositSig?: string;
  transferSig?: string;
  status: "success" | "failed";
  privacyConfig?: PrivacyConfigRecord;
  providerMeta?: ProviderMetaRecord;
}

export interface SetupAction {
  id: string;
  date: string;
  wallet: string;
  type: "initialize-mint" | "fund-treasury";
  amount?: number;
  txSig?: string;
  status: "success" | "failed";
}

export interface ClaimRecord {
  id: string;
  date: string;
  wallet: string;
  amount: number;
  recipient: string;
  txSig?: string;
  status: "success" | "failed";
  privacyConfig?: PrivacyConfigRecord;
  providerMeta?: ProviderMetaRecord;
}

type PayrollRunDoc = PayrollRun;
type SetupActionDoc = SetupAction;
type ClaimRecordDoc = ClaimRecord;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "expaynse";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI environment variable");
}

declare global {
  var __expaynseHistoryMongoClientPromise: Promise<MongoClient> | undefined;
}

const clientPromise =
  global.__expaynseHistoryMongoClientPromise ??
  new MongoClient(MONGODB_URI).connect();

if (process.env.NODE_ENV !== "production") {
  global.__expaynseHistoryMongoClientPromise = clientPromise;
}

function normalizeWallet(wallet: string) {
  return wallet.trim();
}

function assertWallet(wallet: string, fieldName = "wallet") {
  const value = normalizeWallet(wallet);
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db(MONGODB_DB);
}

async function payrollRunsCollection(): Promise<Collection<PayrollRunDoc>> {
  return (await getDb()).collection<PayrollRunDoc>("payroll_runs");
}

async function setupActionsCollection(): Promise<Collection<SetupActionDoc>> {
  return (await getDb()).collection<SetupActionDoc>("setup_actions");
}

async function claimRecordsCollection(): Promise<Collection<ClaimRecordDoc>> {
  return (await getDb()).collection<ClaimRecordDoc>("claim_records");
}

export async function listPayrollRuns(wallet: string) {
  const normalizedWallet = assertWallet(wallet);
  return (await payrollRunsCollection())
    .find({ wallet: normalizedWallet })
    .sort({ date: -1 })
    .toArray();
}

export async function listSetupActions(wallet: string) {
  const normalizedWallet = assertWallet(wallet);
  return (await setupActionsCollection())
    .find({ wallet: normalizedWallet })
    .sort({ date: -1 })
    .toArray();
}

export async function listClaimRecords(wallet: string) {
  const normalizedWallet = assertWallet(wallet);
  return (await claimRecordsCollection())
    .find({ wallet: normalizedWallet })
    .sort({ date: -1 })
    .toArray();
}

export async function getWalletActivityHistory(wallet: string) {
  const normalizedWallet = assertWallet(wallet);

  const [payrollRuns, setupActions, claimRecords] = await Promise.all([
    listPayrollRuns(normalizedWallet),
    listSetupActions(normalizedWallet),
    listClaimRecords(normalizedWallet),
  ]);

  return {
    wallet: normalizedWallet,
    payrollRuns,
    setupActions,
    claimRecords,
  };
}

export async function savePayrollRun(
  run: Omit<PayrollRun, "id" | "date">
): Promise<PayrollRun> {
  const wallet = assertWallet(run.wallet);
  const record: PayrollRun = {
    ...run,
    wallet,
    id: randomUUID(),
    date: nowIso(),
  };

  await (await payrollRunsCollection()).insertOne(record);
  return record;
}

export async function saveSetupAction(
  action: Omit<SetupAction, "id" | "date">
): Promise<SetupAction> {
  const wallet = assertWallet(action.wallet);
  const record: SetupAction = {
    ...action,
    wallet,
    id: randomUUID(),
    date: nowIso(),
  };

  await (await setupActionsCollection()).insertOne(record);
  return record;
}

export async function updateSetupActionStatus(args: {
  id: string;
  wallet: string;
  status: "success" | "failed";
}): Promise<SetupAction | null> {
  const wallet = assertWallet(args.wallet);
  const coll = await setupActionsCollection();
  const result = await coll.findOneAndUpdate(
    { id: args.id, wallet },
    { $set: { status: args.status } },
    { returnDocument: "after" },
  );

  return result;
}

export async function saveClaimRecord(
  claim: Omit<ClaimRecord, "id" | "date">
): Promise<ClaimRecord> {
  const wallet = assertWallet(claim.wallet);
  const recipient = assertWallet(claim.recipient, "recipient");
  const record: ClaimRecord = {
    ...claim,
    wallet,
    recipient,
    id: randomUUID(),
    date: nowIso(),
  };

  await (await claimRecordsCollection()).insertOne(record);
  return record;
}

export async function clearWalletActivityHistory(wallet: string) {
  const normalizedWallet = assertWallet(wallet);

  const [payrollResult, setupResult, claimResult] = await Promise.all([
    (await payrollRunsCollection()).deleteMany({ wallet: normalizedWallet }),
    (await setupActionsCollection()).deleteMany({ wallet: normalizedWallet }),
    (await claimRecordsCollection()).deleteMany({ wallet: normalizedWallet }),
  ]);

  return {
    wallet: normalizedWallet,
    deletedCounts: {
      payrollRuns: payrollResult.deletedCount,
      setupActions: setupResult.deletedCount,
      claimRecords: claimResult.deletedCount,
    },
  };
}
