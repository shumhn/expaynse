import assert from "assert";
import { Keypair } from "@solana/web3.js";

import { POST as employeesPost } from "../app/api/employees/route.ts";
import { POST as streamsPost } from "../app/api/streams/route.ts";
import {
  GET as cashoutGet,
  POST as cashoutPost,
} from "../app/api/cashout-requests/route.ts";
import {
  makeAuthenticatedGetRequest,
  makeAuthenticatedJsonRequest,
} from "./wallet-auth-test-helpers.ts";

function wallet() {
  return Keypair.generate();
}

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

async function main() {
  const employer = wallet();
  const employee = wallet();
  const destination = wallet();

  const employerWallet = employer.publicKey.toBase58();
  const employeeWallet = employee.publicKey.toBase58();
  const destinationWallet = destination.publicKey.toBase58();

  const employeeResponse = await employeesPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/employees",
      wallet: employerWallet,
      signer: employer,
      body: {
        employerWallet,
        wallet: employeeWallet,
        name: "Payout Mode E2E Employee",
      },
    }),
  );
  assert.strictEqual(employeeResponse.status, 201);
  const employeeJson = await json<{
    employee?: {
      id: string;
      wallet: string;
    };
    error?: string;
  }>(employeeResponse);
  assert(employeeJson.employee, employeeJson.error || "Missing employee payload");

  const streamResponse = await streamsPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/streams",
      wallet: employerWallet,
      signer: employer,
      body: {
        employerWallet,
        employeeId: employeeJson.employee.id,
        ratePerSecond: 0.001,
        status: "active",
        payoutMode: "ephemeral",
        allowedPayoutModes: ["ephemeral", "base"],
      },
    }),
  );
  assert.strictEqual(streamResponse.status, 201);
  const streamJson = await json<{
    stream?: {
      id: string;
      payoutMode?: "base" | "ephemeral";
      allowedPayoutModes?: Array<"base" | "ephemeral">;
    };
    error?: string;
  }>(streamResponse);
  assert(streamJson.stream, streamJson.error || "Missing stream payload");
  assert.strictEqual(streamJson.stream.payoutMode, "ephemeral");
  assert.deepStrictEqual(
    [...(streamJson.stream.allowedPayoutModes ?? [])].sort(),
    ["base", "ephemeral"],
  );

  const streamId = streamJson.stream.id;

  const privateRequestResponse = await cashoutPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/cashout-requests",
      wallet: employeeWallet,
      signer: employee,
      body: {
        employeeWallet,
        streamId,
        requestedAmount: 11.25,
        payoutMode: "ephemeral",
        note: "Private payout request",
      },
    }),
  );
  assert.strictEqual(privateRequestResponse.status, 400);
  const privateRequestJson = await json<{
    error?: string;
  }>(privateRequestResponse);
  assert(
    privateRequestJson.error?.includes("Private recipient initialization"),
    "Expected ephemeral cashout to fail without private recipient initialization",
  );

  const baseRequestResponse = await cashoutPost(
    await makeAuthenticatedJsonRequest({
      url: "http://localhost/api/cashout-requests",
      wallet: employeeWallet,
      signer: employee,
      body: {
        employeeWallet,
        streamId,
        requestedAmount: 7.75,
        payoutMode: "base",
        destinationWallet,
        note: "Direct base payout request",
      },
    }),
  );
  assert.strictEqual(baseRequestResponse.status, 201);
  const baseRequestJson = await json<{
    request?: {
      id: string;
      status: string;
      payoutMode?: "base" | "ephemeral";
      destinationWallet?: string;
    };
    error?: string;
  }>(baseRequestResponse);
  assert(baseRequestJson.request, baseRequestJson.error || "Missing base request payload");
  assert.strictEqual(baseRequestJson.request.payoutMode, "base");
  assert.strictEqual(baseRequestJson.request.destinationWallet, destinationWallet);

  const employerListResponse = await cashoutGet(
    await makeAuthenticatedGetRequest({
      url: `http://localhost/api/cashout-requests?scope=employer&employerWallet=${employerWallet}`,
      wallet: employerWallet,
      signer: employer,
    }),
  );
  assert.strictEqual(employerListResponse.status, 200);
  const employerListJson = await json<{
    requests?: Array<{
      id: string;
      status: string;
      payoutMode?: "base" | "ephemeral";
      destinationWallet?: string;
    }>;
  }>(employerListResponse);
  assert(
    employerListJson.requests?.some(
      (entry) =>
        entry.id === baseRequestJson.request?.id &&
        entry.status === "pending" &&
        entry.payoutMode === "base" &&
        entry.destinationWallet === destinationWallet,
    ),
    "Expected pending base request with destination wallet in employer list",
  );

  const employeeListResponse = await cashoutGet(
    await makeAuthenticatedGetRequest({
      url: `http://localhost/api/cashout-requests?scope=employee&employeeWallet=${employeeWallet}`,
      wallet: employeeWallet,
      signer: employee,
    }),
  );
  assert.strictEqual(employeeListResponse.status, 200);
  const employeeListJson = await json<{
    requests?: Array<{
      id: string;
      status: string;
      payoutMode?: "base" | "ephemeral";
    }>;
  }>(employeeListResponse);
  assert(
    employeeListJson.requests?.some(
      (entry) =>
        entry.id === baseRequestJson.request?.id &&
        entry.status === "pending" &&
        entry.payoutMode === "base",
    ),
    "Expected pending base request in employee list",
  );

  console.log("Cashout payout mode e2e completed.");
  process.exit(0);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error("\n[cashout-payout-mode-e2e] FAILED");
  console.error(message);
  process.exit(1);
});
