import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  getEmployeeById,
  getStreamById,
  updateStreamConfig,
  updateStreamRuntimeState,
  updateStreamStatus,
  type PayrollStreamStatus,
} from "@/lib/server/payroll-store";
import { canResumeStreamNow } from "@/lib/server/checkpoint-crank";

const TEE_URL = "https://devnet-tee.magicblock.app";

type StreamControlAction = "update-rate" | "pause" | "resume" | "stop";

type BuildControlBody = {
  employerWallet?: string;
  streamId?: string;
  action?: StreamControlAction;
  ratePerSecond?: number;
  teeAuthToken?: string;
};

type FinalizeControlBody = {
  employerWallet?: string;
  streamId?: string;
  action?: StreamControlAction;
  ratePerSecond?: number;
  employeePda?: string;
  privatePayrollPda?: string;
  controlSignature?: string;
  commitSignature?: string;
};

type BuildControlResponse = {
  employerWallet: string;
  streamId: string;
  action: StreamControlAction;
  employeePda: string;
  privatePayrollPda: string;
  nextStatus: PayrollStreamStatus;
  transactions: {
    control: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    commitEmployee: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function assertWallet(wallet: string, fieldName: string) {
  const value = wallet.trim();
  if (value.length < 32) {
    throw new Error(`${fieldName} must be a valid wallet address`);
  }
  return value;
}

function assertPositiveRate(ratePerSecond: number) {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error("ratePerSecond must be a positive number");
  }
  return ratePerSecond;
}

function toRateMicroUnits(ratePerSecond: number) {
  return Math.round(assertPositiveRate(ratePerSecond) * 1_000_000);
}

async function loadIdl(provider: anchor.AnchorProvider) {
  return loadPayrollIdl(provider);
}

async function getTeeProgramForEmployer(
  employerPubkey: PublicKey,
  teeAuthToken: string,
) {
  const connection = new Connection(
    `${TEE_URL}?token=${encodeURIComponent(teeAuthToken)}`,
    "confirmed",
  );
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadIdl(provider);
  const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
  return { connection, provider, program };
}

async function serializeUnsignedTransaction(
  connection: Connection,
  feePayer: PublicKey,
  transaction: Transaction,
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = feePayer;
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
}

function assertAction(action: string | undefined): StreamControlAction {
  if (!action) {
    throw new Error("action is required");
  }

  if (!["update-rate", "pause", "resume", "stop"].includes(action)) {
    throw new Error("action must be update-rate, pause, resume, or stop");
  }

  return action as StreamControlAction;
}

function deriveNextStatus(action: StreamControlAction): PayrollStreamStatus {
  switch (action) {
    case "update-rate":
      return "active";
    case "pause":
      return "paused";
    case "resume":
      return "active";
    case "stop":
      return "stopped";
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BuildControlBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();
    const action = assertAction(body.action);

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!teeAuthToken) {
      return badRequest(
        "teeAuthToken is required to build employer-signed stream control transactions",
      );
    }

    const employerPubkey = new PublicKey(
      assertWallet(employerWallet, "Employer wallet"),
    );

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    if (action === "resume" && !canResumeStreamNow(stream.startsAt)) {
      return badRequest(
        `This stream is scheduled to start at ${stream.startsAt}. Resume is allowed only after that time.`,
        409,
      );
    }

    const employee = await getEmployeeById(employerWallet, stream.employeeId);
    if (!employee) {
      return badRequest("Employee not found for this stream", 404);
    }

    if (
      !stream.employeePda ||
      !stream.privatePayrollPda ||
      !stream.delegatedAt
    ) {
      return badRequest(
        "Stream must be PER onboarded before control actions can be signed",
      );
    }

    const employeePda = getEmployeePdaForStream(stream.employerWallet, stream.id);
    const privatePayrollPda = getPrivatePayrollPda(employeePda);

    const { connection, program } = await getTeeProgramForEmployer(
      employerPubkey,
      teeAuthToken,
    );

    let controlIx: Transaction;
    if (action === "update-rate") {
      if (typeof body.ratePerSecond !== "number") {
        return badRequest("ratePerSecond is required for update-rate");
      }

      const rateMicroUnits = toRateMicroUnits(body.ratePerSecond);
      const ix = await program.methods
        .updatePrivateTerms(new BN(rateMicroUnits))
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();

      controlIx = new Transaction().add(ix);
    } else if (action === "pause") {
      const ix = await program.methods
        .pauseStream()
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();

      controlIx = new Transaction().add(ix);
    } else if (action === "resume") {
      const ix = await program.methods
        .resumeStream()
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();

      controlIx = new Transaction().add(ix);
    } else {
      const ix = await program.methods
        .stopStream()
        .accounts({
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();

      controlIx = new Transaction().add(ix);
    }

    const commitIx = await program.methods
      .commitEmployee()
      .accountsPartial({
        employer: employerPubkey,
        employee: employeePda,
      })
      .instruction();

    const [controlSerialized, commitSerialized] = await Promise.all([
      serializeUnsignedTransaction(connection, employerPubkey, controlIx),
      serializeUnsignedTransaction(
        connection,
        employerPubkey,
        new Transaction().add(commitIx),
      ),
    ]);

    const response: BuildControlResponse = {
      employerWallet,
      streamId,
      action,
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
      nextStatus:
        action === "update-rate" ? stream.status : deriveNextStatus(action),
      transactions: {
        control: {
          transactionBase64: Buffer.from(controlSerialized).toString("base64"),
          sendTo: "ephemeral",
        },
        commitEmployee: {
          transactionBase64: Buffer.from(commitSerialized).toString("base64"),
          sendTo: "ephemeral",
        },
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build stream control transactions";
    return badRequest(message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as FinalizeControlBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const employeePda = body.employeePda?.trim();
    const privatePayrollPda = body.privatePayrollPda?.trim();
    const controlSignature = body.controlSignature?.trim();
    const commitSignature = body.commitSignature?.trim();
    const action = assertAction(body.action);

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!employeePda || !privatePayrollPda) {
      return badRequest("employeePda and privatePayrollPda are required");
    }

    if (!controlSignature || !commitSignature) {
      return badRequest("controlSignature and commitSignature are required");
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    new PublicKey(assertWallet(employerWallet, "Employer wallet"));
    new PublicKey(employeePda);

    const nextStatus =
      action === "update-rate" ? stream.status : deriveNextStatus(action);

    let updatedStream;
    if (action === "update-rate") {
      if (typeof body.ratePerSecond !== "number") {
        return badRequest("ratePerSecond is required for update-rate");
      }

      const configStream = await updateStreamConfig({
        employerWallet,
        streamId,
        ratePerSecond: body.ratePerSecond,
        status: nextStatus,
      });

      updatedStream = await updateStreamRuntimeState({
        employerWallet,
        streamId,
        employeePda,
        privatePayrollPda,
        delegatedAt: stream.delegatedAt ?? new Date().toISOString(),
      });

      updatedStream = {
        ...updatedStream,
        ratePerSecond: configStream.ratePerSecond,
        status: configStream.status,
      };
    } else {
      await updateStreamStatus({
        employerWallet,
        streamId,
        status: nextStatus,
      });

      updatedStream = await updateStreamRuntimeState({
        employerWallet,
        streamId,
        employeePda,
        privatePayrollPda,
        delegatedAt: stream.delegatedAt ?? new Date().toISOString(),
      });

      updatedStream = {
        ...updatedStream,
        status: nextStatus,
      };
    }

    return NextResponse.json(
      {
        message: "Employer-signed stream control recorded",
        stream: updatedStream,
        action,
        status: nextStatus,
        signatures: {
          controlSignature,
          commitSignature,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize stream control";
    return badRequest(message);
  }
}
