import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// These proofs belong to a trusted host supervisor, never an HTTP request.
export function parseStoppedRuntimes(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 32 || args.length % 2 !== 0) {
    throw new Error("Explicit stopped-runtime proof arguments are required");
  }
  const runtimes = [];
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] !== "--stopped-runtime" || typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value)) {
      throw new Error("Invalid stopped-runtime proof arguments");
    }
    runtimes.push(value);
  }
  return [...new Set(runtimes)];
}

export async function runReaper(args) {
  const runtimes = parseStoppedRuntimes(args);
  let database;
  try {
    const importedOwner = await import("../../src/lib/reports/bill-analysis-owner.ts");
    const importedDatabase = await import("../../src/lib/db.ts");
    const owners = importedOwner.default ?? importedOwner;
    database = (importedDatabase.default ?? importedDatabase).physicalDb;
    return await owners.reapStoppedBillAnalysisExecutions(runtimes);
  } finally { await database?.$disconnect(); }
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const reaped = await runReaper(process.argv.slice(2));
    process.stdout.write(JSON.stringify({ reaped }) + "\n");
  } catch {
    process.stderr.write("Stopped analysis execution cleanup failed; no unverified runtime may be reclaimed.\n");
    process.exitCode = 1;
  }
}
