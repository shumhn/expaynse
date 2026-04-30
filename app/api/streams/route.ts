import { NextRequest, NextResponse } from "next/server";
import {
  createStream,
  listEmployees,
  listStreams,
  resolveEmployeePrivateRecipientInitializedAt,
  updateStreamConfig,
  updateStreamRuntimeState,
  type PayrollPayoutMode,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import { saveComplianceEvent } from "@/lib/server/compliance-store";
import {
  isWalletAuthorizationError,
  verifyAuthorizedWalletRequest,
} from "@/lib/wallet-request-auth";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const employerWallet = request.nextUrl.searchParams.get("employerWallet");

    if (!employerWallet) {
      return badRequest("Missing employerWallet query parameter");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: employerWallet,
      method: request.method,
      path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    });

    const [employees, streams] = await Promise.all([
      listEmployees(employerWallet),
      listStreams(employerWallet),
    ]);
    const employeeInitById = new Map<string, string | null>();
    for (const employee of employees) {
      const inferredFromStreams =
        streams.find(
          (stream) =>
            stream.employeeId === employee.id &&
            !!stream.recipientPrivateInitializedAt,
        )?.recipientPrivateInitializedAt ?? null;

      const resolvedInit =
        employee.privateRecipientInitializedAt ??
        inferredFromStreams ??
        (await resolveEmployeePrivateRecipientInitializedAt(
          employerWallet,
          employee.id,
        ));

      employeeInitById.set(employee.id, resolvedInit ?? null);
    }
    const resolvedStreams = await Promise.all(
      streams.map(async (stream) => {
        const employeeInit = employeeInitById.get(stream.employeeId) ?? null;

        if (!stream.recipientPrivateInitializedAt && employeeInit) {
          await updateStreamRuntimeState({
            employerWallet,
            streamId: stream.id,
            recipientPrivateInitializedAt: employeeInit,
          });

          return {
            ...stream,
            recipientPrivateInitializedAt: employeeInit,
          };
        }

        return stream;
      }),
    );
    await saveComplianceEvent({
      actorWallet: employerWallet,
      action: "streams.read",
      route: request.nextUrl.pathname,
      subjectWallet: employerWallet,
      resourceType: "stream",
      status: "success",
    });

    return NextResponse.json({ streams: resolvedStreams });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to fetch payroll streams";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      employeeId?: string;
      ratePerSecond?: number;
      status?: PayrollStreamStatus;
      startsAt?: string | null;
      payoutMode?: PayrollPayoutMode;
      allowedPayoutModes?: PayrollPayoutMode[];
      compensationSnapshot?: {
        employmentType?: "full_time" | "part_time" | "contract";
        paySchedule?: "monthly" | "semi_monthly" | "biweekly" | "weekly";
        compensationUnit?: "monthly" | "weekly" | "hourly";
        compensationAmountUsd?: number;
        weeklyHours?: number;
        monthlySalaryUsd?: number;
        startsAt?: string | null;
      };
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.employeeId) {
      return badRequest("employeeId is required");
    }

    if (typeof body.ratePerSecond !== "number") {
      return badRequest("ratePerSecond must be a number");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const stream = await createStream({
      employerWallet: body.employerWallet,
      employeeId: body.employeeId,
      ratePerSecond: body.ratePerSecond,
      status: body.status,
      startsAt: body.startsAt,
      payoutMode: body.payoutMode,
      allowedPayoutModes: body.allowedPayoutModes,
      compensationSnapshot: body.compensationSnapshot,
    });

    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "streams.create",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "stream",
      resourceId: stream.id,
      status: "success",
    });

    return NextResponse.json({ stream }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to create payroll stream";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody || "{}") as {
      employerWallet?: string;
      streamId?: string;
      status?: PayrollStreamStatus;
      ratePerSecond?: number;
    };

    if (!body.employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!body.streamId) {
      return badRequest("streamId is required");
    }

    if (body.status === undefined && typeof body.ratePerSecond !== "number") {
      return badRequest("status or ratePerSecond is required");
    }

    if (
      body.status !== undefined &&
      !["active", "paused", "stopped"].includes(body.status)
    ) {
      return badRequest("status must be active, paused, or stopped");
    }

    await verifyAuthorizedWalletRequest({
      headers: request.headers,
      expectedWallet: body.employerWallet,
      method: request.method,
      path: request.nextUrl.pathname,
      body: rawBody,
    });

    const stream = await updateStreamConfig({
      employerWallet: body.employerWallet,
      streamId: body.streamId,
      ratePerSecond: body.ratePerSecond,
      status: body.status,
    });
    await saveComplianceEvent({
      actorWallet: body.employerWallet,
      action: "streams.update",
      route: request.nextUrl.pathname,
      subjectWallet: body.employerWallet,
      resourceType: "stream",
      resourceId: stream.id,
      status: "success",
    });

    return NextResponse.json({ stream });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update payroll stream";
    return badRequest(message, isWalletAuthorizationError(error) ? 401 : 400);
  }
}
