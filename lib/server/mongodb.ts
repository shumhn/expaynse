import { MongoClient, Db } from "mongodb";

const mongodbUri = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "expaynse";

if (!mongodbUri) {
  throw new Error("Missing MONGODB_URI environment variable");
}

const MONGODB_URI: string = mongodbUri;

type GlobalMongoCache = {
  clientPromise?: Promise<MongoClient>;
};

const globalForMongo = globalThis as typeof globalThis & {
  __mongo?: GlobalMongoCache;
};

const mongoCache = globalForMongo.__mongo ?? {};

if (!globalForMongo.__mongo) {
  globalForMongo.__mongo = mongoCache;
}

function createClientPromise() {
  const client = new MongoClient(MONGODB_URI);
  return client.connect();
}

export function getMongoClient(): Promise<MongoClient> {
  if (!mongoCache.clientPromise) {
    mongoCache.clientPromise = createClientPromise();
  }

  return mongoCache.clientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(MONGODB_DB);
}
