export function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];

  if (value == null) return fallback;

  return ["true", "1", "yes", "y"].includes(value.toLowerCase());
}
