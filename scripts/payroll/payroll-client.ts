import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  getAuthToken,
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { Payroll } from "../../target/types/payroll";
import { initializeMint, deposit } from "../../lib/magicblock-api";

const DEVNET_TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

// Constants
export const TEE_URL = "https://devnet-tee.magicblock.app";

export class PayrollClient {
  public baseConnection: Connection;
  public teeConnection: Connection | null = null;
  public program: Program<Payroll>;

  constructor(
    baseRpcUrl: string = "https://api.devnet.solana.com",
    program: Program<Payroll>
  ) {
    this.baseConnection = new Connection(baseRpcUrl, "confirmed");
    this.program = program;
  }

  /**
   * Step 6.5: Authenticate with the TEE using the Employer's signature.
   * Required before any TEE RPC interactions.
   */
  async authenticateTee(employer: Keypair): Promise<string> {
    const auth = await getAuthToken(
      TEE_URL,
      employer.publicKey,
      async (message: Uint8Array) => {
        return nacl.sign.detached(message, employer.secretKey);
      }
    );
    this.teeConnection = new Connection(
      `${TEE_URL}?token=${auth.token}`,
      "confirmed"
    );
    return auth.token;
  }

  /**
   * Get Employee PDA
   */
  getEmployeePda(employer: PublicKey, streamId: Uint8Array): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("employee"), employer.toBuffer(), Buffer.from(streamId)],
      this.program.programId
    );
    return pda;
  }

  /**
   * Step 6.4: Call create_employee on the base chain.
   */
  async createEmployee(
    employer: Keypair,
    streamId: Uint8Array,
    _ratePerSecond: number
  ): Promise<string> {
    void _ratePerSecond;
    const streamIdArg = Array.from(streamId);

    const txSignature = await this.program.methods
      .createEmployee(streamIdArg)
      .accounts({
        employer: employer.publicKey,
      })
      .signers([employer])
      .rpc();

    return txSignature;
  }

  /**
   * Final stages of Step 4 + Step 5 + Step 6
   * Assigns Permissions, Delegates Permission to PER, and Delegates Employee to PER in a single atomic payload
   */
  async delegateEmployeeToTee(
    employer: Keypair,
    streamId: Uint8Array
  ): Promise<string> {
    const streamIdArg = Array.from(streamId);
    const employeePda = this.getEmployeePda(employer.publicKey, streamId);
    const permissionPda = permissionPdaFromAccount(employeePda);

    await this.program.methods
      .createPermission(streamIdArg)
      .accounts({
        employer: employer.publicKey,
        permission: permissionPda,
      })
      .signers([employer])
      .rpc();

    const transaction = new Transaction();

    // 1. Delegate the Permission itself to the TEE
    const delegatePermissionIx = createDelegatePermissionInstruction({
      payer: employer.publicKey,
      authority: [employer.publicKey, true],
      permissionedAccount: [employeePda, false],
      ownerProgram: PERMISSION_PROGRAM_ID,
      validator: DEVNET_TEE_VALIDATOR,
    });

    // 2. Setup Employee Delegation Hook (Base -> TEE)
    const delegateEmployeeIx = await this.program.methods
      .delegateEmployee(streamIdArg)
      .accounts({
        employer: employer.publicKey,
        employee: employeePda,
      })
      .instruction();

    // Bundle permission delegation and employee delegation on base
    transaction.add(delegatePermissionIx, delegateEmployeeIx);

    const signature = await sendAndConfirmTransaction(
      this.baseConnection,
      transaction,
      [employer]
    );

    return signature;
  }

  /**
   * Final stages of Step 4:
   * Initialize the token mint on the Private Payments API and Deposit Employer Funds
   */
  async fundPayroll(
    employerKey: string,
    amountSOL: number,
    teeToken: string
  ): Promise<unknown> {
    await initializeMint(employerKey, teeToken);
    const result = await deposit(employerKey, amountSOL, teeToken);

    return result;
  }
}
