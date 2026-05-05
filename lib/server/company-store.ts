import { Collection } from "mongodb";
import { getMongoDb } from "./mongodb";
import type { Company } from "./company-types";

// ── MongoDB collection ──

async function companiesCollection(): Promise<Collection<Company>> {
  const db = await getMongoDb();
  return db.collection<Company>("companies");
}

// ── Public API ──

export async function findCompanyByEmployerWallet(employerWallet: string): Promise<Company | null> {
  const normalized = employerWallet.trim();
  const collection = await companiesCollection();
  return collection.findOne({ employerWallet: normalized });
}

export async function findCompanyById(companyId: string): Promise<Company | null> {
  const collection = await companiesCollection();
  return collection.findOne({ id: companyId });
}

export async function createCompanyRecord(company: Company): Promise<Company> {
  const collection = await companiesCollection();

  const existing = await collection.findOne({
    employerWallet: company.employerWallet,
  });

  if (existing) {
    throw new Error("Company already exists for this employer wallet.");
  }

  await collection.insertOne(company);

  return company;
}

export async function listCompanies(): Promise<Company[]> {
  const collection = await companiesCollection();
  return collection.find({}).sort({ createdAt: 1 }).toArray();
}
