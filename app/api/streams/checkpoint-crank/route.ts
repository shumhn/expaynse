import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  getEmployeeById,
  getStreamById,
  updateStreamRuntimeState,
} from "@/lib/server/payroll-store";
import {
  deriveCheckpointCrankMode,
  normalizeCheckpointTaskId,
} from "@/lib/server/checkpoint-crank";

const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
const TEE_URL = "https://devnet-tee.magicblock.app";

type BuildCheckpointCrankBody = {
  employerWallet?: string;
  streamId?: string;
  teeAuthToken?: string;
  executionIntervalMillis?: number;
  iterations?: number;
  taskId?: string;
  mode?: "schedule" | "cancel";
};

type FinalizeCheckpointCrankBody = {
  employerWallet?: string;
  streamId?: string;
  mode?: "schedule" | "cancel";
  taskId?: string;
  signature?: string;
  status?: "active" | "stopped" | "failed";
};

type BuildCheckpointCrankResponse = {
  employerWallet: string;
  streamId: string;
  mode: "schedule" | "cancel";
  taskId: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  transactions: {
    checkpointCrank: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
};

type ScheduleCheckpointAccrualMethods = {
  scheduleCheckpointAccrual(args: {
    taskId: BN;
    executionIntervalMillis: BN;
    iterations: BN;
  }): {
    accounts(input: {
      magicProgram: PublicKey;
      employer: PublicKey;
      employee: PublicKey;
      privatePayroll: PublicKey;
      permission: PublicKey;
    }): {
      instruction(): Promise<TransactionInstruction>;
    };
  };
  cancelCheckpointAccrual(taskId: BN): {
    accounts(input: {
      magicProgram: PublicKey;
      employer: PublicKey;
      employee: PublicKey;
      privatePayroll: PublicKey;
    }): {
      instruction(): Promise<TransactionInstruction>;
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

function assertPositiveInteger(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
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
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider) as anchor.Program<Idl>;
  return { connection, program };
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

function getCheckpointCrankMethods(
  program: anchor.Program<Idl>,
): ScheduleCheckpointAccrualMethods {
  return program.methods as unknown as ScheduleCheckpointAccrualMethods;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BuildCheckpointCrankBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!teeAuthToken) {
      return badRequest(
        "teeAuthToken is required to build checkpoint crank transactions",
      );
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const employee = await getEmployeeById(employerWallet, stream.employeeId);
    if (!employee) {
      return badRequest("Employee not found for this stream", 404);
    }

    if (
      !stream.employeePda ||
      !stream.privatePayrollPda ||
      !stream.permissionPda
    ) {
      return badRequest(
        "Stream must be PER onboarded before checkpoint crank scheduling",
      );
    }

    if (!stream.delegatedAt) {
      return badRequest(
        "Stream must be delegated to PER before checkpoint crank scheduling",
      );
    }

    const employerPubkey = new PublicKey(
      assertWallet(employerWallet, "Employer wallet"),
    );
    const employeePda = getEmployeePdaForStream(stream.employerWallet, stream.id);
    const privatePayrollPda = getPrivatePayrollPda(employeePda);
    const permissionPda = new PublicKey(stream.permissionPda);

    const taskId = normalizeCheckpointTaskId(body.taskId, streamId);
    const mode = deriveCheckpointCrankMode({
      requestedMode: body.mode,
      streamStatus: stream.status,
    });
    const shouldSchedule = mode === "schedule";

    const { connection, program } = await getTeeProgramForEmployer(
      employerPubkey,
      teeAuthToken,
    );
    const methods = getCheckpointCrankMethods(program);

    let checkpointCrankInstruction: TransactionInstruction;

    if (shouldSchedule) {
      const executionIntervalMillis = BigInt(
        assertPositiveInteger(
          body.executionIntervalMillis ?? 1000,
          "executionIntervalMillis",
        ),
      );
      const iterations = BigInt(
        assertPositiveInteger(body.iterations ?? 999_999_999, "iterations"),
      );

      checkpointCrankInstruction = await methods
        .scheduleCheckpointAccrual({
          taskId: new BN(taskId.toString()),
          executionIntervalMillis: new BN(executionIntervalMillis.toString()),
          iterations: new BN(iterations.toString()),
        })
        .accounts({
          magicProgram: MAGIC_PROGRAM_ID,
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
          permission: permissionPda,
        })
        .instruction();
    } else {
      checkpointCrankInstruction = await methods
        .cancelCheckpointAccrual(new BN(taskId.toString()))
        .accounts({
          magicProgram: MAGIC_PROGRAM_ID,
          employer: employerPubkey,
          employee: employeePda,
          privatePayroll: privatePayrollPda,
        })
        .instruction();
    }

    const serialized = await serializeUnsignedTransaction(
      connection,
      employerPubkey,
      new Transaction().add(checkpointCrankInstruction),
    );

    const response: BuildCheckpointCrankResponse = {
      employerWallet,
      streamId,
      mode,
      taskId: taskId.toString(),
      employeePda: employeePda.toBase58(),
      privatePayrollPda: privatePayrollPda.toBase58(),
      permissionPda: permissionPda.toBase58(),
      transactions: {
        checkpointCrank: {
          transactionBase64: Buffer.from(serialized).toString("base64"),
          sendTo: "ephemeral",
        },
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build checkpoint crank transaction";

    return badRequest(message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as FinalizeCheckpointCrankBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const mode = body.mode === "cancel" ? "cancel" : "schedule";
    const signature = body.signature?.trim();
    const taskId = body.taskId?.trim();
    const status =
      body.status === "failed"
        ? "failed"
        : body.status === "stopped"
          ? "stopped"
          : "active";

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!signature) {
      return badRequest("signature is required");
    }

    if (!taskId) {
      return badRequest("taskId is required");
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const updatedStream = await updateStreamRuntimeState({
      employerWallet,
      streamId,
      checkpointCrankTaskId: mode === "schedule" ? taskId : null,
      checkpointCrankSignature: signature,
      checkpointCrankStatus:
        mode === "schedule"
          ? status
          : status === "failed"
            ? "failed"
            : "stopped",
      checkpointCrankUpdatedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      message:
        mode === "schedule"
          ? "Checkpoint crank schedule recorded"
          : "Checkpoint crank cancellation recorded",
      stream: updatedStream,
      mode,
      signature,
      taskId,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize checkpoint crank";

    return badRequest(message, 500);
  }
}
