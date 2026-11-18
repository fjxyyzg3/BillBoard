import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { loadTestEnvironment } from "./environment";

async function main() {
  const urls = loadTestEnvironment("integration");
  for (const suite of ["integration", "e2e"] as const) {
    const target = new URL(urls[suite]);
    const database = target.pathname.slice(1);
    const adminUrl = new URL(target);
    adminUrl.pathname = "/postgres";
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
    try {
      const databases = await admin.$queryRaw<Array<{ datname: string }>>`SELECT datname FROM pg_database WHERE datname = ${database}`;
      if (!databases.length) {
        // The identifier is restricted to ASCII letters, digits and underscores above.
        await admin.$executeRawUnsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
      }
    } finally { await admin.$disconnect(); }
    const env = { ...process.env, DATABASE_URL: target.toString() };
    for (const args of [
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      ["--import", "tsx", "prisma/seed.ts"],
    ]) {
      execFileSync(process.execPath, args, { env, windowsHide: true, stdio: "pipe", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    }
    process.stdout.write(`Prepared ${suite} test database (migrations and synthetic seed).\n`);
  }
}

main().catch(() => {
  process.stderr.write("Test database preparation failed. Check local PostgreSQL, CREATE DATABASE permission and test configuration. Private database details were suppressed.\n");
  process.exitCode = 1;
});
