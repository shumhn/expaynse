export type BuildOnboardingBody = {
  employerWallet?: string;
  streamId?: string;
  teeAuthToken?: string;
};

export type FinalizeOnboardingBody = {
  employerWallet?: string;
  streamId?: string;
  employeePda?: string;
  privatePayrollPda?: string;
  permissionPda?: string;
  teeAuthToken?: string;
};

export type BuildOnboardingResponse = {
  employeePda: string;
  privatePayrollPda: string;
  permissionPda: string;
  alreadyOnboarded?: boolean;
  transactions: {
    baseSetup?: {
      transactionBase64: string;
      sendTo: "base";
    };
    initializePrivatePayroll?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
    resumeStream?: {
      transactionBase64: string;
      sendTo: "ephemeral";
    };
  };
};
