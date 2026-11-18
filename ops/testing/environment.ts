import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export type DatabaseSuite = "integration" | "e2e";

export function resolveTestDatabases(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV === "production") {
    throw new Error("Tests must not run with NODE_ENV=production");
  }

  const urls = {} as Record<DatabaseSuite, string>;
  for (const suite of ["integration", "e2e"] as const) {
    const value = env[`${suite.toUpperCase()}_DATABASE_URL`];
    const message = `${suite} requires a loopback PostgreSQL database named billboard_*${suite}_test with the public schema`;
    let url: URL;
    try { url = new URL(value ?? ""); } catch { throw new Error(message); }
    if (!["postgresql:", "postgres:"].includes(url.protocol)
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || !new RegExp(`^/billboard_(?:[a-z0-9]+_)*${suite}_test$`).test(url.pathname)
      || url.pathname.length > 64
      || (url.searchParams.get("schema") ?? "public") !== "public"
      || new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length
      || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout", "connect_timeout"].includes(key))) {
      throw new Error(message);
    }
    urls[suite] = url.toString();
  }
  return urls;
}

export function loadTestEnvironment(suite: DatabaseSuite) {
  if (existsSync(".env.test.local")) loadEnvFile(".env.test.local");
  loadEnvFile(".env.example");
  const urls = resolveTestDatabases(process.env);
  // An inherited development/production DATABASE_URL never selects a test target.
  process.env.DATABASE_URL = urls[suite];
  return urls;
}
