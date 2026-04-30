import { NextRequest, NextResponse } from "next/server";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "expaynse";

const clientPromise =
  (global as unknown as { __expaynseRealPayrollRunMongoClientPromise?: Promise<MongoClient> })
    .__expaynseRealPayrollRunMongoClientPromise ??
  new MongoClient(MONGODB_URI).connect();
if (process.env.NODE_ENV !== "production") {
  (global as unknown as { __expaynseRealPayrollRunMongoClientPromise?: Promise<MongoClient> }).__expaynseRealPayrollRunMongoClientPromise =
    clientPromise;
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getEmployerWalletFromRequest(request: NextRequest) {
  const employerWallet = request.nextUrl.searchParams
    .get("employerWallet")
    ?.trim();
  if (!employerWallet) {
    throw new Error("Missing employerWallet query parameter");
  }
  return employerWallet;
}

export async function GET(request: NextRequest) {
  try {
    const employerWallet = getEmployerWalletFromRequest(request);

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const client = await clientPromise;
    const db = client.db(MONGODB_DB);
    const runs = db.collection("payroll_runs_real");

    const runList = await runs
      .find({ employerWallet })
      .sort({ createdAt: -1 })
      .toArray();

    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "payroll-runs.runs.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "payroll-run",
      status: "success",
      metadata: { runCount: runList.length },
    });

    return NextResponse.json({ runs: runList });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch payroll runs";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
