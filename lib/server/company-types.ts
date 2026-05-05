export type Currency = "USDC";

export type Company = {
  id: string;
  name: string;
  employerWallet: string;
  treasuryPubkey: string;
  settlementPubkey: string;
  currency: Currency;
  createdAt: string;
  updatedAt: string;
};

export type CreateCompanyInput = {
  name: string;
  employerWallet: string;

  /**
   * Optional for dev.
   * Production should require a signed wallet message proving wallet ownership.
   */
  message?: string;
  signature?: string;
};

export type PublicCompanyResponse = {
  id: string;
  name: string;
  employerWallet: string;
  treasuryPubkey: string;
  settlementPubkey: string;
  currency: Currency;
  createdAt: string;
  updatedAt: string;
};

export type EncryptedCompanyKey = {
  id: string;
  companyId: string;
  kind: "treasury" | "settlement";
  pubkey: string;
  encryptedSecretKeyBase64: string;
  ivBase64: string;
  authTagBase64: string;
  createdAt: string;
};
