import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_RPC = "https://api.devnet.solana.com";
const DEFAULT_ER_RPC = "https://devnet-tee.magicblock.app";
const DEFAULT_KEY_DIR = "/Users/sumangiri/Desktop/Homie/keys";
const DEFAULT_ANCHOR_WALLET = path.join(DEFAULT_KEY_DIR, "payroll-authority.json");
const DEFAULT_EMPLOYEE_KEYPAIR = path.join(DEFAULT_KEY_DIR, "employee.json");

function parseEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function loadPayrollRuntimeEnv() {
  const rootDir = process.cwd();
  parseEnvFile(path.join(rootDir, ".env.local"));
  parseEnvFile(path.join(rootDir, ".env"));

  if (!process.env.NEXT_PUBLIC_SOLANA_RPC_URL) {
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL = DEFAULT_BASE_RPC;
  }

  if (!process.env.BASE_RPC_URL) {
    process.env.BASE_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  }

  if (!process.env.ER_RPC_URL) {
    process.env.ER_RPC_URL = DEFAULT_ER_RPC;
  }

  if (!process.env.ANCHOR_WALLET && fs.existsSync(DEFAULT_ANCHOR_WALLET)) {
    process.env.ANCHOR_WALLET = DEFAULT_ANCHOR_WALLET;
  }

  if (!process.env.EMPLOYER_KEYPAIR && process.env.ANCHOR_WALLET) {
    process.env.EMPLOYER_KEYPAIR = process.env.ANCHOR_WALLET;
  }

  if (!process.env.EMPLOYEE_KEYPAIR && fs.existsSync(DEFAULT_EMPLOYEE_KEYPAIR)) {
    process.env.EMPLOYEE_KEYPAIR = DEFAULT_EMPLOYEE_KEYPAIR;
  }
}
