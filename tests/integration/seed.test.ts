import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.loadEnvFile(".env.example");

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function withDatabase(databaseUrl: string, database: string) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  url.searchParams.set("schema", "public");
  return url.toString();
}

function execNode(args: string[], env: NodeJS.ProcessEnv) {
  execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}

describe("seed", () => {
  const database = `bb_seed_test_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = withDatabase(requireEnv("DATABASE_URL"), database);
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  let admin: PrismaClient;
  let created = false;

  beforeAll(async () => {
    const source = new URL(requireEnv("DATABASE_URL"));
    if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(source.hostname) || !/_(?:dev|test)$/.test(source.pathname)) {
      throw new Error("Seed tests require a local development/test database");
    }
    admin = new PrismaClient({ datasources: { db: { url: source.toString() } } });
    const [{ allowed }] = await admin.$queryRaw<Array<{ allowed: boolean }>>`SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user`;
    if (!allowed) throw new Error("Isolated seed tests require local CREATE DATABASE permission");
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    execNode(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"], env);
    const [{ current }] = await prisma.$queryRaw<Array<{ current: string }>>`SELECT current_database() AS current`;
    if (current !== database) throw new Error("Seed client did not select its isolated database");
  }, 60_000);

  afterAll(async () => {
    try {
      await prisma.$disconnect();
      if (created) {
        if (!/^bb_seed_test_[a-f0-9]{32}$/.test(database)) throw new Error("Unowned seed fixture database");
        await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
        created = false;
      }
    } finally {
      await admin?.$disconnect();
    }
  }, 30_000);

  it("updates default household users when seed emails change", async () => {
    execNode(["--import", "tsx", "prisma/seed.ts"], {
      ...env,
      SEED_USER_A_EMAIL: "old-husband@example.com",
      SEED_USER_A_PASSWORD: "old-password-a",
      SEED_USER_A_NAME: "老公",
      SEED_USER_B_EMAIL: "old-wife@example.com",
      SEED_USER_B_PASSWORD: "old-password-b",
      SEED_USER_B_NAME: "老婆",
    });

    execNode(["--import", "tsx", "prisma/seed.ts"], {
      ...env,
      SEED_USER_A_EMAIL: "new-husband@example.com",
      SEED_USER_A_PASSWORD: "new-password-a",
      SEED_USER_A_NAME: "老公",
      SEED_USER_B_EMAIL: "new-wife@example.com",
      SEED_USER_B_PASSWORD: "new-password-b",
      SEED_USER_B_NAME: "老婆",
    });

    const members = await prisma.householdMember.findMany({
      where: { householdId: "default-household" },
      include: { user: true },
      orderBy: { memberName: "asc" },
    });

    expect(await prisma.user.count()).toBe(2);
    expect(members).toHaveLength(2);
    expect(Object.fromEntries(members.map((member) => [member.memberName, member.user.email]))).toEqual({
      老公: "new-husband@example.com",
      老婆: "new-wife@example.com",
    });
  }, 60_000);
});
