import { loadCompanyKeypair } from "./company-key-vault";

/**
 * Internal-only helpers for backend worker.
 * Never expose these keypairs from API routes.
 */

export function loadCompanyTreasuryKeypair(companyId: string) {
  return loadCompanyKeypair({
    companyId,
    kind: "treasury",
  });
}

export function loadCompanySettlementKeypair(companyId: string) {
  return loadCompanyKeypair({
    companyId,
    kind: "settlement",
  });
}
