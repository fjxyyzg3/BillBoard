import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const removalMigration = "20261024030000_remove_client_diagnostic_reports";
const migrationsDirectory = path.resolve("prisma/migrations");
const ownedDatabases = new Set<string>();
const clients = new Set<PrismaClient>();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
let admin: PrismaClient;
let databaseUrl: URL;
let migrations: string[];

function ownedDatabase(name: string, requireOwnership = true) {
  if (!/^bb_diagnostic_removal_[a-f0-9]{32}$/.test(name) || (requireOwnership && !ownedDatabases.has(name))) {
    throw new Error("Unowned diagnostic removal database");
  }
  return quote(name);
}

async function executeMigrations(url: URL, selected: string[]) {
  if (!ownedDatabases.has(url.pathname.slice(1))) throw new Error("Migrations require an owned isolated database");
  if (selected.length === 0) return;
  const scripts = await Promise.all(selected.map((migration) => readFile(path.join(migrationsDirectory, migration, "migration.sql"), "utf8")));
  // Preserve migration boundaries, including enum changes that must commit before later scripts.
  const sql = scripts.map((script) => `${script}\nCOMMIT;\n`).join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/prisma/build/index.js", "db", "execute", "--stdin", "--schema", "prisma/schema.prisma"], {
      cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
      env: { DATABASE_URL: url.toString(), NODE_ENV: "test", PATH: process.env.PATH ?? process.env.Path,
        SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-16384); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated diagnostic removal migration timed out")); }, 60_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Isolated diagnostic removal migration could not start")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Isolated diagnostic removal migration failed (${diagnostic.match(/\b(?:P\d{4}|ENOENT|EACCES|ENOTFOUND)\b/)?.[0] ?? "CLI"})`));
    });
    child.stdin.end(sql);
  });
}

async function isolatedDatabase() {
  const name = `bb_diagnostic_removal_${randomUUID().replaceAll("-", "")}`;
  await admin.$executeRawUnsafe(`CREATE DATABASE ${ownedDatabase(name, false)} TEMPLATE template0`);
  ownedDatabases.add(name);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  clients.add(client);
  const [{ current }] = await client.$queryRaw<Array<{ current: string }>>`SELECT current_database() AS current`;
  if (current !== name) throw new Error("Diagnostic removal client did not select its isolated database");
  return { client, url };
}

async function schemaShape(client: PrismaClient) {
  return client.$queryRaw<Array<{ table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>>`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public'
    ORDER BY table_name COLLATE "C", ordinal_position`;
}

async function snapshot(client: PrismaClient) {
  const tables = await client.$queryRaw<Array<{ name: string }>>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE "C"`;
  const rows = [];
  for (const { name } of tables) {
    const [{ value }] = await client.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(original) ORDER BY to_jsonb(original)::text), '[]'::jsonb)::text AS value
       FROM "public".${quote(name)} original`,
    );
    rows.push({ name, value });
  }
  return rows;
}

async function assertReportsRemoved(client: PrismaClient) {
  const [{ table, status }] = await client.$queryRaw<Array<{ table: string | null; status: string | null }>>`
    SELECT to_regclass('public."ClientDiagnosticReport"')::text AS "table",
      to_regtype('public."ClientDiagnosticReportStatus"')::text AS status`;
  expect(table).toBeNull();
  expect(status).toBeNull();
}

async function businessFixture(client: PrismaClient) {
  const stamp = new Date("2026-10-01T01:02:03.456Z");
  const ids = Object.fromEntries(["household", "ownerUser", "formerUser", "owner", "former", "ledger", "archive", "category", "active", "deleted", "session", "revoked", "event", "draft", "row", "request"].map((key) => [key, randomUUID()]));
  await client.household.create({ data: { id: ids.household, name: "Synthetic migration household", createdAt: stamp } });
  await client.user.createMany({ data: [
    { id: ids.ownerUser, email: "migration-owner@example.com", displayName: "Synthetic owner", passwordHash: "SYNTHETIC_PASSWORD_HASH", createdAt: stamp },
    { id: ids.formerUser, email: "migration-former@example.com", displayName: "Synthetic former member", passwordHash: "SYNTHETIC_OLD_HASH", status: "DEACTIVATED", createdAt: stamp },
  ] });
  await client.householdMember.createMany({ data: [
    { id: ids.owner, householdId: ids.household, userId: ids.ownerUser, role: "OWNER", memberName: "Current owner", joinedAt: stamp },
    { id: ids.former, householdId: ids.household, userId: ids.formerUser, role: "MEMBER", memberName: "Historical member", joinedAt: stamp, leftAt: stamp },
  ] });
  await client.ledger.createMany({ data: [
    { id: ids.ledger, householdId: ids.household, name: "Synthetic default ledger", isDefault: true, acceptsLegacyDrafts: true, createdAt: stamp },
    { id: ids.archive, householdId: ids.household, name: "Synthetic archived ledger", archivedAt: stamp, createdAt: stamp },
  ] });
  await client.category.create({ data: { id: ids.category, name: "Dining", type: "EXPENSE", sortOrder: 1 } });
  await client.transaction.createMany({ data: [
    { id: ids.active, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.former, createdByMemberId: ids.owner,
      type: "EXPENSE", categoryId: ids.category, amountFen: 12345, occurredAt: stamp, clientRequestId: randomUUID(),
      note: "SYNTHETIC_PRESERVED_NOTE", source: "wechat_pay", sourceFingerprint: "SYNTHETIC_PRESERVED_SOURCE", sourceImportedAt: stamp },
    { id: ids.deleted, householdId: ids.household, ledgerId: ids.archive, actorMemberId: ids.owner, createdByMemberId: ids.owner,
      type: "EXPENSE", categoryId: ids.category, amountFen: 6789, occurredAt: stamp, deletedAt: stamp },
  ] });
  await client.appSession.createMany({ data: [
    { id: ids.session, userId: ids.ownerUser, memberId: ids.owner, sessionKey: "SYNTHETIC_ACTIVE_SESSION", expiresAt: new Date("2030-01-01T00:00:00Z"), loginAt: stamp, lastSeenAt: stamp },
    { id: ids.revoked, userId: ids.formerUser, memberId: ids.former, sessionKey: "SYNTHETIC_REVOKED_SESSION", expiresAt: stamp, revokedAt: stamp, loginAt: stamp, lastSeenAt: stamp },
  ] });
  await client.appEvent.create({ data: { id: ids.event, householdId: ids.household, memberId: ids.owner, eventType: "TRANSACTION_CREATED",
    path: "/add", summary: "SYNTHETIC_PRESERVED_EVENT", metadata: { count: 1, amountFen: 12345 }, createdAt: stamp } });
  await client.importDraft.create({ data: { id: ids.draft, householdId: ids.household, ledgerId: ids.ledger,
    createdByMemberId: ids.owner, source: "wechat_pay", fileName: "synthetic.xlsx", createdAt: stamp } });
  await client.importDraftRow.create({ data: { id: ids.row, draftId: ids.draft, rowNumber: 1, transactionType: "EXPENSE",
    actorMemberId: ids.former, createdByMemberId: ids.owner, categoryId: ids.category, occurredAt: stamp, amountFen: 12345, status: "READY",
    note: "SYNTHETIC_DRAFT_NOTE", sourceFingerprint: "SYNTHETIC_DRAFT_SOURCE" } });
  await client.naturalLanguageRequest.create({ data: { id: ids.request, householdId: ids.household, ledgerId: ids.ledger,
    createdByMemberId: ids.owner, clientRequestId: randomUUID(), inputHash: "SYNTHETIC_ORIGINAL_HASH", referenceAt: stamp,
    status: "SUCCEEDED", result: { rows: [{ id: ids.active, amountFen: 12345 }] } } });
  await client.$executeRaw`
    INSERT INTO "ClientDiagnosticReport" (id, client_report_id, household_id, member_id, payload, created_at, status, resolved_at, resolved_by)
    VALUES (${randomUUID()}, ${randomUUID()}, ${ids.household}, ${ids.owner}, '{"synthetic":"open report"}'::jsonb, ${stamp}, 'OPEN', NULL, NULL),
      (${randomUUID()}, ${randomUUID()}, ${ids.household}, ${ids.former}, '{"synthetic":"resolved report"}'::jsonb, ${stamp}, 'RESOLVED', ${stamp}, 'synthetic-resolver')`;
}

beforeAll(async () => {
  process.loadEnvFile(".env.example");
  databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/_(?:dev|test)$/.test(databaseUrl.pathname)) {
    throw new Error("Diagnostic removal tests require a local development/test database");
  }
  databaseUrl.searchParams.set("schema", "public");
  admin = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  const [{ allowed }] = await admin.$queryRaw<Array<{ allowed: boolean }>>`SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user`;
  if (!allowed) throw new Error("Isolated diagnostic removal tests require local CREATE DATABASE permission");
  migrations = (await readdir(migrationsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
});

afterAll(async () => {
  for (const client of clients) await client.$disconnect();
  for (const name of ownedDatabases) {
    await admin.$executeRawUnsafe(`DROP DATABASE ${ownedDatabase(name)}`);
    ownedDatabases.delete(name);
  }
  await admin?.$disconnect();
}, 30_000);

describe("diagnostic report removal migration", () => {
  it("deletes all report history without changing any other table or stored field", async () => {
    const { client, url } = await isolatedDatabase();
    await executeMigrations(url, migrations.filter((name) => name !== removalMigration));
    await businessFixture(client);
    expect(await client.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "ClientDiagnosticReport"`).toEqual([{ count: 2 }]);
    const before = (await snapshot(client)).filter(({ name }) => name !== "ClientDiagnosticReport");
    const shape = (await schemaShape(client)).filter(({ table_name }) => table_name !== "ClientDiagnosticReport");

    await executeMigrations(url, migrations.filter((name) => name === removalMigration));

    await assertReportsRemoved(client);
    expect(await snapshot(client)).toEqual(before);
    expect(await schemaShape(client)).toEqual(shape);
  }, 120_000);

  it("replays the entire migration chain into a new database without leaving diagnostic storage", async () => {
    const { client, url } = await isolatedDatabase();
    await executeMigrations(url, migrations);
    await assertReportsRemoved(client);
    const tables = [...new Set((await schemaShape(client)).map(({ table_name }) => table_name))];
    expect(tables).toEqual(expect.arrayContaining(["Household", "HouseholdMember", "Ledger", "Transaction", "AppEvent", "AppSession", "ImportDraft", "NaturalLanguageRequest"]));
  }, 120_000);
});
