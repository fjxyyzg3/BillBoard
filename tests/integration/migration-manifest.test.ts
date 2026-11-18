import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureManifest, compareManifests } from "../../ops/migrations/household-ledgers";

process.loadEnvFile(".env.example");

let db: PrismaClient;
let sourceSchema: string;
const schemas = new Set<string>();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Migration manifest tests require a local development/test database");
  }
  sourceSchema = url.searchParams.get("schema") ?? "public";
  db = new PrismaClient({ log: [] });
});

afterEach(async () => {
  for (const schema of schemas) {
    if (!/^migration_manifest_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected migration fixture schema");
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    schemas.delete(schema);
  }
});

afterAll(async () => { await db?.$disconnect(); });

async function fixture(tables = ["ResourceLease", "ResourceWindow", "Transaction"]) {
  const schema = `migration_manifest_${randomUUID().replaceAll("-", "")}`;
  schemas.add(schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA ${quote(schema)}`);
  for (const table of tables) {
    // LIKE preserves the real columns and indexes without copying foreign keys into the fixture.
    await db.$executeRawUnsafe(`CREATE TABLE ${quote(schema)}.${quote(table)} (LIKE ${quote(sourceSchema)}.${quote(table)} INCLUDING ALL)`);
  }
  await db.$executeRawUnsafe(`INSERT INTO ${quote(schema)}."Transaction"
    (id, household_id, ledger_id, type, actor_member_id, created_by_member_id, category_id, amount_fen, occurred_at, updated_at, deleted_at)
    VALUES ('transaction-active', 'fixture-household', 'fixture-ledger', 'EXPENSE', 'fixture-member', 'fixture-member',
      'fixture-category', 1234, '2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z', NULL),
      ('transaction-deleted', 'fixture-household', 'fixture-ledger', 'EXPENSE', 'fixture-member', 'fixture-member',
      'fixture-category', 5678, '2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z')`);
  return schema;
}

async function resourceRows(schema: string, count: number) {
  await db.$executeRawUnsafe(`INSERT INTO ${quote(schema)}."ResourceWindow" (key, kind, scope, subject_id, started_at, used)
    SELECT 'ai:member:' || lpad(n::text, 5, '0'), 'ai', 'member', 'fixture-member-' || n,
      '2026-10-21T00:00:00Z'::timestamp, n % 3 FROM generate_series(1, $1::int) n`, count);
  await db.$executeRawUnsafe(`INSERT INTO ${quote(schema)}."ResourceLease" (token, kind, household_id, member_id, expires_at)
    SELECT 'lease-' || lpad(n::text, 5, '0'), 'ai', 'fixture-household', 'fixture-member-' || n,
      '2026-10-21T00:01:00Z'::timestamp FROM generate_series(1, $1::int) n`, count);
}

describe("real database migration manifests", () => {
  it("discovers current resource tables without a baseline and rejects changed quota with the same row count", async () => {
    const schema = await fixture();
    await resourceRows(schema, 3);
    const before = await captureManifest(db, schema);
    expect(before.tables.map(({ name, key, rows }) => ({ name, key, rows }))).toEqual([
      { name: "ResourceLease", key: "token", rows: 3 },
      { name: "ResourceWindow", key: "key", rows: 3 },
      { name: "Transaction", key: "id", rows: 2 },
    ]);
    expect(before.tables.find(({ name }) => name === "ResourceLease")!.columns).toEqual(expect.arrayContaining(["token", "household_id", "member_id", "expires_at", "task_key", "waiters"]));
    expect(before.tables.find(({ name }) => name === "ResourceWindow")!.columns).toEqual(expect.arrayContaining(["key", "kind", "scope", "subject_id", "started_at", "used"]));
    expect(before.transactionGroups.groups).toBe(2);
    expect(compareManifests(before, await captureManifest(db, schema, before))).toEqual({ tables: 3, rows: 8, groups: 2 });
    expect(compareManifests(before, await captureManifest(db, schema))).toEqual({ tables: 3, rows: 8, groups: 2 });

    await db.$executeRawUnsafe(`UPDATE ${quote(schema)}."ResourceWindow" SET used=used+1 WHERE key=$1`, "ai:member:00003");
    const changed = await captureManifest(db, schema, before);
    const original = before.tables.find(({ name }) => name === "ResourceWindow")!;
    const current = changed.tables.find(({ name }) => name === "ResourceWindow")!;
    expect(current.rows).toBe(original.rows);
    expect(current.sha256).not.toBe(original.sha256);
    expect(changed.transactionGroups).toEqual(before.transactionGroups);
    expect(() => compareManifests(before, changed)).toThrow("Original fields differ in ResourceWindow");
  });

  it("hashes every token and key row across the real cursor page boundary", async () => {
    const schema = await fixture();
    await resourceRows(schema, 2001);
    const before = await captureManifest(db, schema);
    for (const [table, key] of [["ResourceLease", "token"], ["ResourceWindow", "key"]]) {
      const allRows = await db.$queryRawUnsafe<Array<{ value: string }>>(
        `SELECT to_jsonb(original)::text AS value FROM ${quote(schema)}.${quote(table)} original ORDER BY ${quote(key)} COLLATE "C"`,
      );
      const hash = createHash("sha256");
      for (const row of allRows) hash.update(row.value).update("\n");
      expect(allRows).toHaveLength(2001);
      expect(before.tables.find(({ name }) => name === table)).toMatchObject({ key, rows: 2001, sha256: hash.digest("hex") });
    }
    expect(compareManifests(before, await captureManifest(db, schema, before))).toEqual({ tables: 3, rows: 4004, groups: 2 });
    await db.$executeRawUnsafe(`UPDATE ${quote(schema)}."ResourceLease" SET waiters=waiters+1 WHERE token=$1`, "lease-02001");
    await db.$executeRawUnsafe(`UPDATE ${quote(schema)}."ResourceWindow" SET used=used+1 WHERE key=$1`, "ai:member:02001");
    const after = await captureManifest(db, schema, before);
    for (const name of ["ResourceLease", "ResourceWindow"]) {
      expect(after.tables.find((table) => table.name === name)!.rows).toBe(2001);
      expect(after.tables.find((table) => table.name === name)!.sha256).not.toBe(before.tables.find((table) => table.name === name)!.sha256);
    }
  });

  it("continues to prefer id and then slot over newly supported key names", async () => {
    const schema = await fixture(["Transaction"]);
    await db.$executeRawUnsafe(`CREATE TABLE ${quote(schema)}."IdFirst" (id text PRIMARY KEY, slot int UNIQUE, key text UNIQUE, token text UNIQUE)`);
    await db.$executeRawUnsafe(`CREATE TABLE ${quote(schema)}."SlotFirst" (slot int PRIMARY KEY, key text UNIQUE, token text UNIQUE)`);
    await db.$executeRawUnsafe(`INSERT INTO ${quote(schema)}."IdFirst" VALUES ('second', 1, 'key-b', 'token-b'), ('first', 2, 'key-a', 'token-a')`);
    await db.$executeRawUnsafe(`INSERT INTO ${quote(schema)}."SlotFirst" VALUES (2, 'key-a', 'token-a'), (1, 'key-b', 'token-b')`);
    const before = await captureManifest(db, schema);
    expect(before.tables.find(({ name }) => name === "IdFirst")).toMatchObject({ key: "id", rows: 2 });
    expect(before.tables.find(({ name }) => name === "SlotFirst")).toMatchObject({ key: "slot", rows: 2 });
    expect(compareManifests(before, await captureManifest(db, schema, before))).toEqual({ tables: 3, rows: 6, groups: 2 });
  });

  it("still refuses an unknown table without a recognized stable key", async () => {
    const schema = await fixture(["Transaction"]);
    await db.$executeRawUnsafe(`CREATE TABLE ${quote(schema)}."UnknownTable" (record_number int PRIMARY KEY, value text)`);
    await expect(captureManifest(db, schema)).rejects.toThrow("No stable key in UnknownTable");
  });
});
