import { createHash } from "crypto";

import { PublicKey } from "@solana/web3.js";

export const PAYROLL_PROGRAM_ID = new PublicKey(
  "EMM7YS2Jhzmu5fgF71vHty6P2tP7dErENL6tp3YppAYR",
);

const EMPLOYEE_SEED = "employee";
const PRIVATE_PAYROLL_SEED = "private-payroll";
const STREAM_SEED_DOMAIN = "expaynse-stream:v1";

export function getPayrollStreamSeed(streamId: string) {
  const value = streamId.trim();
  if (!value) {
    throw new Error("streamId is required");
  }

  return createHash("sha256")
    .update(STREAM_SEED_DOMAIN)
    .update(value)
    .digest();
}

export function getPayrollStreamSeedArg(streamId: string) {
  return Array.from(getPayrollStreamSeed(streamId));
}

export function getEmployeePdaForStream(
  employerWallet: string,
  streamId: string,
) {
  const employer = new PublicKey(employerWallet.trim());
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(EMPLOYEE_SEED), employer.toBuffer(), getPayrollStreamSeed(streamId)],
    PAYROLL_PROGRAM_ID,
  );
  return pda;
}

export function getPrivatePayrollPda(employeePda: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PRIVATE_PAYROLL_SEED), employeePda.toBuffer()],
    PAYROLL_PROGRAM_ID,
  );
  return pda;
}
