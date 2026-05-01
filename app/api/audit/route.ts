import { NextRequest, NextResponse } from "next/server";
import { validateAuditorToken } from "@/lib/server/payroll-store";
import { getWalletActivityHistory } from "@/lib/server/history-store";

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token")?.trim();
    if (!token || !token.startsWith("exp_")) {
      return NextResponse.json({ error: "Invalid token format" }, { status: 400 });
    }

    // Validate token against MongoDB
    const tokenDoc = await validateAuditorToken(token);
    const wallet = tokenDoc.employerWallet;

    // Fetch the real history from the database
    const history = await getWalletActivityHistory(wallet);

    return NextResponse.json(history);
  } catch (error: unknown) {
    console.error("Audit API Error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.includes("Invalid") || message.includes("expired") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
