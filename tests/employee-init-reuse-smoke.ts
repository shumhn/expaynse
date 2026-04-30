import assert from "assert";
import { Keypair } from "@solana/web3.js";

import { GET as streamsGet } from "../app/api/streams/route.ts";
import {
  createEmployee,
  createStream,
  markEmployeePrivateRecipientInitialized,
  updateStreamStatus,
} from "../lib/server/payroll-store.ts";
import { makeAuthenticatedGetRequest } from "./wallet-auth-test-helpers.ts";

function wallet() {
  return Keypair.generate();
}

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

async function main() {
  const employer = wallet();
  const employee = wallet();
  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();

  const employeeRecord = await createEmployee({
    employerWallet,
    wallet: employeeWallet,
    name: "Init Reuse Employee",
  });

  const firstStream = await createStream({
    employerWallet,
    employeeId: employeeRecord.id,
    ratePerSecond: 0.002,
    status: "active",
  });

  const initializedAt = new Date().toISOString();
  await markEmployeePrivateRecipientInitialized(employeeWallet, initializedAt);

  await updateStreamStatus({
    employerWallet,
    streamId: firstStream.id,
    status: "stopped",
  });

  const restartedStream = await createStream({
    employerWallet,
    employeeId: employeeRecord.id,
    ratePerSecond: 0.003,
    status: "paused",
  });

  assert.strictEqual(
    restartedStream.recipientPrivateInitializedAt,
    initializedAt,
    "Expected recreated stream to inherit employee private recipient initialization",
  );

  const streamsResponse = await streamsGet(
    await makeAuthenticatedGetRequest({
      url: `http://localhost/api/streams?employerWallet=${employerWallet}`,
      wallet: employerWallet,
      signer: employer,
    }),
  );

  assert.strictEqual(streamsResponse.status, 200);
  const streamsJson = await json<{
    streams?: Array<{
      id: string;
      employeeId: string;
      recipientPrivateInitializedAt: string | null;
      status: string;
    }>;
  }>(streamsResponse);

  const refreshedRestartedStream = streamsJson.streams?.find(
    (stream) => stream.id === restartedStream.id,
  );

  assert(refreshedRestartedStream, "Expected recreated stream in GET /api/streams");
  assert.strictEqual(
    refreshedRestartedStream?.recipientPrivateInitializedAt,
    initializedAt,
    "Expected GET /api/streams to return inherited recipient initialization",
  );

  console.log("Employee init reuse smoke test completed.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error("\n[employee-init-reuse-smoke] FAILED");
  console.error(message);
  process.exit(1);
});
