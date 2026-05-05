import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";

import { createReadonlyAnchorWallet } from "@/lib/server/anchor-wallet";
import { loadPayrollIdl } from "@/lib/server/payroll-idl";
import {
  getEmployeePdaForStream,
  getPrivatePayrollPda,
} from "@/lib/server/payroll-pdas";
import {
  createStream,
  getEmployeeById,
  getStreamById,
  listStreams,
  type PayrollStreamRecord,
} from "@/lib/server/payroll-store";

const PROGRAM_ID = new PublicKey(
  "HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6",
);
const DEVNET_RPC = clusterApiUrl("devnet");
const TEE_URL = "https://devnet-tee.magicblock.app";
const PRIVATE_PAYROLL_STATE_LEN = 114;

type BuildRestartBody = {
  employerWallet?: string;
  streamId?: string;
  teeAuthToken?: string;
};

type RestartTransactions = {
  closePrivatePayroll?: {
    transactionBase64: string;
    sendTo: "ephemeral";
  };

  undelegateEmployee?: {
    transactionBase64: string;
    sendTo: "ephemeral";
  };
  closeEmployee?: {
    transactionBase64: string;
    sendTo: "base";
  };
};

type BuildRestartResponse = {
  employerWallet: string;
  streamId: string;
  employeeId: string;
  employeeWallet: string;
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  status: "ready" | "already-reset";
  actualAccruedUnpaidMicro: string;
  actualTotalPaidPrivateMicro: string;
  transactions: RestartTransactions;
};

type FinalizeRestartBody = {
  employerWallet?: string;
  streamId?: string;
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  teeAuthToken?: string;
  signatures?: {
    closePrivatePayroll?: string;

    undelegateEmployee?: string;
    closeEmployee?: string;
  };
};

type PrivatePayrollStateSnapshot = {
  accruedUnpaidMicro: bigint;
  totalPaidPrivateMicro: bigint;
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

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function serializeBigint(value: bigint) {
  return value.toString();
}

async function getBaseProgramForEmployer(employerPubkey: PublicKey) {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = createReadonlyAnchorWallet(employerPubkey);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = await loadPayrollIdl(provider);
  const program = new anchor.Program(idl, provider);
  return { connection, provider, program };
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
  const program = new anchor.Program(idl, provider);
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

async function getAccountInfo(connection: Connection, address: PublicKey) {
  return connection.getAccountInfo(address, "confirmed");
}

async function fetchPrivatePayrollState(args: {
  teeConnection: Connection;
  privatePayrollPda: PublicKey;
}): Promise<PrivatePayrollStateSnapshot | null> {
  const accountInfo = await args.teeConnection.getAccountInfo(
    args.privatePayrollPda,
    "confirmed",
  );

  if (!accountInfo?.data) {
    return null;
  }

  const data = Buffer.from(accountInfo.data);
  if (data.length < PRIVATE_PAYROLL_STATE_LEN) {
    throw new Error("Private payroll state account is not initialized");
  }

  return {
    accruedUnpaidMicro: readU64LE(data, 97),
    totalPaidPrivateMicro: readU64LE(data, 105),
  };
}

function isOwnedByProgram(
  accountInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  return Boolean(accountInfo && accountInfo.owner.equals(programId));
}

async function resolveRestartState(args: {
  employerWallet: string;
  stream: PayrollStreamRecord;
  teeAuthToken: string;
}) {
  const employerWallet = assertWallet(args.employerWallet, "Employer wallet");
  const stream = args.stream;

  if (stream.status !== "stopped") {
    throw new Error("Only stopped streams can be restarted");
  }

  const employee = await getEmployeeById(employerWallet, stream.employeeId);
  if (!employee) {
    throw new Error("Employee not found for this stream");
  }

  const employerPubkey = new PublicKey(employerWallet);
  const employeePda = stream.employeePda
    ? new PublicKey(stream.employeePda)
    : getEmployeePdaForStream(stream.employerWallet, stream.id);
  const privatePayrollPda = stream.privatePayrollPda
    ? new PublicKey(stream.privatePayrollPda)
    : getPrivatePayrollPda(employeePda);
  const permissionPda = stream.permissionPda
    ? new PublicKey(stream.permissionPda)
    : permissionPdaFromAccount(employeePda);

  const { connection: baseConnection, program: baseProgram } =
    await getBaseProgramForEmployer(employerPubkey);
  const { connection: teeConnection, program: teeProgram } =
    await getTeeProgramForEmployer(employerPubkey, args.teeAuthToken);

  const [employeeAccountInfo, permissionAccountInfo, privatePayrollState] =
    await Promise.all([
      getAccountInfo(baseConnection, employeePda),
      getAccountInfo(baseConnection, permissionPda),
      fetchPrivatePayrollState({
        teeConnection,
        privatePayrollPda,
      }),
    ]);

  const employeeExistsOnBase = Boolean(employeeAccountInfo);
  const permissionExistsOnBase = Boolean(permissionAccountInfo);
  const employeeDelegated =
    employeeExistsOnBase && !isOwnedByProgram(employeeAccountInfo, PROGRAM_ID);
  return {
    employerPubkey,
    employee,
    employeePda,
    privatePayrollPda,
    permissionPda,
    baseConnection,
    teeConnection,
    baseProgram: baseProgram as anchor.Program<Idl>,
    teeProgram: teeProgram as anchor.Program<Idl>,
    employeeExistsOnBase,
    permissionExistsOnBase,
    privatePayrollState,
    employeeDelegated,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BuildRestartBody;

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
        "teeAuthToken is required to build stopped-stream restart transactions",
      );
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const activeOrPausedDuplicate = (await listStreams(employerWallet)).find(
      (candidate) =>
        candidate.employeeId === stream.employeeId &&
        candidate.id !== stream.id &&
        candidate.status !== "stopped",
    );

    if (activeOrPausedDuplicate) {
      return NextResponse.json(
        {
          employerWallet,
          streamId,
          employeeId: stream.employeeId,
          employeeWallet: (
            await getEmployeeById(employerWallet, stream.employeeId)
          )?.wallet,
          employeePda:
            activeOrPausedDuplicate.employeePda ?? stream.employeePda,
          privatePayrollPda:
            activeOrPausedDuplicate.privatePayrollPda ??
            stream.privatePayrollPda,
          permissionPda:
            activeOrPausedDuplicate.permissionPda ?? stream.permissionPda,
          status: "already-reset",
          actualAccruedUnpaidMicro: "0",
          actualTotalPaidPrivateMicro: "0",
          transactions: {},
          message:
            "A newer active or paused stream already exists for this employee",
        },
        { status: 200 },
      );
    }

    const state = await resolveRestartState({
      employerWallet,
      stream,
      teeAuthToken,
    });

    const actualAccruedUnpaidMicro =
      state.privatePayrollState?.accruedUnpaidMicro ?? BigInt(0);
    const actualTotalPaidPrivateMicro =
      state.privatePayrollState?.totalPaidPrivateMicro ?? BigInt(0);

    if (actualAccruedUnpaidMicro > BigInt(0)) {
      return badRequest(
        `Cannot restart this stopped stream because it still has ${(
          Number(actualAccruedUnpaidMicro) / 1_000_000
        ).toFixed(
          6,
        )} USDC of accrued unpaid payroll on-chain. Final settlement support for stopped streams must be completed first.`,
        409,
      );
    }

    if (!state.privatePayrollState) {
      const response: BuildRestartResponse = {
        employerWallet,
        streamId,
        employeeId: stream.employeeId,
        employeeWallet: state.employee.wallet,
        employeePda: state.employeePda.toBase58(),
        privatePayrollPda: state.privatePayrollPda.toBase58(),
        permissionPda: state.permissionPda.toBase58(),
        status: "ready",
        actualAccruedUnpaidMicro: "0",
        actualTotalPaidPrivateMicro: "0",
        transactions: {},
      };

      return NextResponse.json(response, { status: 201 });
    }

    const transactions: RestartTransactions = {};

    if (state.privatePayrollState) {
      const closePrivatePayrollIx = await state.teeProgram.methods
        .closePrivatePayroll()
        .accounts({
          employer: state.employerPubkey,
          employee: state.employeePda,
          privatePayroll: state.privatePayrollPda,
        })
        .instruction();

      const serialized = await serializeUnsignedTransaction(
        state.teeConnection,
        state.employerPubkey,
        new Transaction().add(closePrivatePayrollIx),
      );

      transactions.closePrivatePayroll = {
        transactionBase64: Buffer.from(serialized).toString("base64"),
        sendTo: "ephemeral",
      };
    }

    if (state.employeeDelegated) {
      const undelegateEmployeeIx = await state.teeProgram.methods
        .undelegateEmployee()
        .accounts({
          employer: state.employerPubkey,
          employee: state.employeePda,
        })
        .instruction();

      const serialized = await serializeUnsignedTransaction(
        state.teeConnection,
        state.employerPubkey,
        new Transaction().add(undelegateEmployeeIx),
      );

      transactions.undelegateEmployee = {
        transactionBase64: Buffer.from(serialized).toString("base64"),
        sendTo: "ephemeral",
      };
    }

    if (state.employeeExistsOnBase) {
      const closeEmployeeIx = await state.baseProgram.methods
        .closeEmployee()
        .accounts({
          employer: state.employerPubkey,
          employee: state.employeePda,
          privatePayroll: state.privatePayrollPda,
        })
        .instruction();

      const serialized = await serializeUnsignedTransaction(
        state.baseConnection,
        state.employerPubkey,
        new Transaction().add(closeEmployeeIx),
      );

      transactions.closeEmployee = {
        transactionBase64: Buffer.from(serialized).toString("base64"),
        sendTo: "base",
      };
    }

    const response: BuildRestartResponse = {
      employerWallet,
      streamId,
      employeeId: stream.employeeId,
      employeeWallet: state.employee.wallet,
      employeePda: state.employeePda.toBase58(),
      privatePayrollPda: state.privatePayrollPda.toBase58(),
      permissionPda: state.permissionPda.toBase58(),
      status:
        Object.keys(transactions).length === 0 ? "already-reset" : "ready",
      actualAccruedUnpaidMicro: serializeBigint(actualAccruedUnpaidMicro),
      actualTotalPaidPrivateMicro: serializeBigint(actualTotalPaidPrivateMicro),
      transactions,
    };

    return NextResponse.json(response, {
      status: response.status === "already-reset" ? 200 : 201,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build stopped-stream restart transactions";

    return badRequest(message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as FinalizeRestartBody;

    const employerWallet = body.employerWallet?.trim();
    const streamId = body.streamId?.trim();
    const employeePda = body.employeePda?.trim();
    const privatePayrollPda = body.privatePayrollPda?.trim();
    const permissionPda = body.permissionPda?.trim();
    const teeAuthToken = body.teeAuthToken?.trim();
    const signatures = body.signatures ?? {};

    if (!employerWallet) {
      return badRequest("employerWallet is required");
    }

    if (!streamId) {
      return badRequest("streamId is required");
    }

    if (!employeePda || !privatePayrollPda || !permissionPda) {
      return badRequest(
        "employeePda, privatePayrollPda, and permissionPda are required",
      );
    }

    if (!teeAuthToken) {
      return badRequest(
        "teeAuthToken is required to finalize stopped-stream restart",
      );
    }

    const stream = await getStreamById(employerWallet, streamId);
    if (!stream) {
      return badRequest("Stream not found for this employer", 404);
    }

    const state = await resolveRestartState({
      employerWallet,
      stream,
      teeAuthToken,
    });

    const actualAccruedUnpaidMicro =
      state.privatePayrollState?.accruedUnpaidMicro ?? BigInt(0);
    if (actualAccruedUnpaidMicro > BigInt(0)) {
      return badRequest(
        "Cannot finalize restart while this stopped stream still has accrued unpaid payroll on-chain",
        409,
      );
    }

    if (state.privatePayrollState && !signatures.closePrivatePayroll?.trim()) {
      return badRequest(
        "closePrivatePayroll signature is required to finalize restart",
      );
    }

    if (
      state.privatePayrollState &&
      state.employeeDelegated &&
      !signatures.undelegateEmployee?.trim()
    ) {
      return badRequest(
        "undelegateEmployee signature is required to finalize restart",
      );
    }

    if (
      state.privatePayrollState &&
      state.employeeExistsOnBase &&
      !signatures.closeEmployee?.trim()
    ) {
      return badRequest(
        "closeEmployee signature is required to finalize restart",
      );
    }

    const existingReplacement = (await listStreams(employerWallet)).find(
      (candidate) =>
        candidate.employeeId === stream.employeeId &&
        candidate.id !== stream.id &&
        candidate.status !== "stopped",
    );

    if (existingReplacement) {
      return NextResponse.json(
        {
          message:
            "A fresh replacement stream already exists for this employee",
          previousStream: stream,
          stream: existingReplacement,
          signatures,
        },
        { status: 200 },
      );
    }

    const restartedStream = await createStream({
      employerWallet,
      employeeId: stream.employeeId,
      ratePerSecond: stream.ratePerSecond,
      recipientPrivateInitializedAt:
        stream.recipientPrivateInitializedAt ??
        state.employee.privateRecipientInitializedAt ??
        undefined,
      status: "paused",
    });

    return NextResponse.json(
      {
        message:
          "Stopped stream reset completed. A fresh paused stream has been created for this employee.",
        previousStream: stream,
        stream: restartedStream,
        signatures,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize stopped-stream restart";

    return badRequest(message);
  }
}
