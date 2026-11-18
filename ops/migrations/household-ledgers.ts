import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";

type RawClient = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type TableManifest = { name: string; columns: string[]; key: string; rows: number; sha256: string; migrationIds?: string[] };
export type MigrationManifest = {
  version: 1;
  createdAt: string;
  tables: TableManifest[];
  transactionGroups: { groups: number; sha256: string };
};

class VerificationError extends Error {}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function compareManifests(before: MigrationManifest, after: MigrationManifest) {
  if (before.version !== 1 || after.version !== 1) throw new VerificationError("Unsupported manifest version");
  for (const original of before.tables) {
    const current = after.tables.find(({ name }) => name === original.name);
    if (!current || current.rows !== original.rows || current.sha256 !== original.sha256
      || JSON.stringify(current.columns) !== JSON.stringify(original.columns)) {
      throw new VerificationError(`Original fields differ in ${original.name}`);
    }
  }
  if (JSON.stringify(before.transactionGroups) !== JSON.stringify(after.transactionGroups)) {
    throw new VerificationError("Historical transaction aggregates differ");
  }
  return { tables: before.tables.length, rows: before.tables.reduce((total, table) => total + table.rows, 0), groups: before.transactionGroups.groups };
}

export async function captureManifest(client: RawClient, schema: string, baseline?: MigrationManifest): Promise<MigrationManifest> {
  const inventory = baseline?.tables ?? await discoverTables(client, schema);
  const tables: TableManifest[] = [];
  for (const original of inventory) {
    const qualified = `${quote(schema)}.${quote(original.name)}`;
    const hash = createHash("sha256");
    let rows = 0;
    let cursor: string | null = null;
    const migrationIds = original.name === "_prisma_migrations" ? [] as string[] : undefined;
    for (;;) {
      const values: unknown[] = [];
      const filters: string[] = [];
      if (cursor !== null) { values.push(cursor); filters.push(`${quote(original.key)}::text COLLATE "C" > $${values.length}`); }
      if (original.migrationIds) { values.push(original.migrationIds); filters.push(`${quote(original.key)}::text = ANY($${values.length}::text[])`); }
      const result: { key: string; value: string }[] = await client.$queryRawUnsafe(
        `SELECT ${quote(original.key)}::text AS key, to_jsonb(original)::text AS value FROM
          (SELECT ${original.columns.map(quote).join(", ")} FROM ${qualified}
           ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
           ORDER BY ${quote(original.key)}::text COLLATE "C" LIMIT 2000) original
         ORDER BY ${quote(original.key)}::text COLLATE "C"`, ...values,
      );
      for (const row of result) { hash.update(row.value).update("\n"); migrationIds?.push(row.key); }
      rows += result.length;
      if (result.length < 2000) break;
      cursor = result.at(-1)!.key;
    }
    tables.push({ ...original, rows, sha256: hash.digest("hex"), ...(migrationIds ? { migrationIds } : {}) });
  }
  const groupRows: { value: string }[] = await client.$queryRawUnsafe(`
    SELECT value FROM (SELECT jsonb_build_array(household_id, actor_member_id, created_by_member_id,
      to_char(occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'),
      type, deleted_at IS NOT NULL, count(*)::text, sum(amount_fen)::text)::text AS value
    FROM ${quote(schema)}."Transaction"
    GROUP BY household_id, actor_member_id, created_by_member_id,
      to_char(occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'), type, deleted_at IS NOT NULL
    ) grouped ORDER BY value COLLATE "C"`);
  return { version: 1, createdAt: new Date().toISOString(), tables,
    transactionGroups: { groups: groupRows.length, sha256: digest(groupRows.map(({ value }) => value).join("\n")) } };
}

async function discoverTables(client: RawClient, schema: string): Promise<TableManifest[]> {
  const columns: { table_name: string; column_name: string; ordinal_position: number }[] = await client.$queryRawUnsafe(
    `SELECT c.table_name, c.column_name, c.ordinal_position FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema=$1 AND t.table_type='BASE TABLE' ORDER BY c.table_name COLLATE "C", c.ordinal_position`, schema,
  );
  const grouped = new Map<string, string[]>();
  for (const column of columns) grouped.set(column.table_name, [...(grouped.get(column.table_name) ?? []), column.column_name]);
  return [...grouped].map(([name, fields]) => {
    const key = ["id", "slot", "key", "token"].find((candidate) => fields.includes(candidate));
    if (!key) throw new VerificationError(`No stable key in ${name}`);
    return { name, columns: fields, key, rows: 0, sha256: "" };
  });
}

export async function preflight(client: RawClient, schema: string, foundation = false) {
  const s = quote(schema);
  const active = foundation ? "AND m.left_at IS NULL" : "";
  const checks: [string, string][] = [
    ["household_owner", `SELECT count(*)::int n FROM ${s}."Household" h WHERE ${foundation ? "h.closed_at IS NULL AND" : ""}
      (SELECT count(*) FROM ${s}."HouseholdMember" m WHERE m.household_id=h.id AND m.role='OWNER' ${active}) <> 1`],
    ["duplicate_identity", `SELECT count(*)::int n FROM (SELECT user_id FROM ${s}."HouseholdMember" m WHERE true ${active} GROUP BY user_id HAVING count(*)>1) invalid`],
    ["transaction_members", `SELECT count(*)::int n FROM ${s}."Transaction" t LEFT JOIN ${s}."HouseholdMember" a ON a.id=t.actor_member_id
      LEFT JOIN ${s}."HouseholdMember" c ON c.id=t.created_by_member_id WHERE a.id IS NULL OR c.id IS NULL OR a.household_id<>t.household_id OR c.household_id<>t.household_id`],
    ["draft_creator", `SELECT count(*)::int n FROM ${s}."ImportDraft" d LEFT JOIN ${s}."HouseholdMember" m ON m.id=d.created_by_member_id WHERE m.id IS NULL OR m.household_id<>d.household_id`],
    ["draft_row_members", `SELECT count(*)::int n FROM ${s}."ImportDraftRow" r JOIN ${s}."ImportDraft" d ON d.id=r.draft_id
      LEFT JOIN ${s}."HouseholdMember" a ON a.id=r.actor_member_id LEFT JOIN ${s}."HouseholdMember" c ON c.id=r.created_by_member_id
      WHERE (r.actor_member_id IS NOT NULL AND (a.id IS NULL OR a.household_id<>d.household_id)) OR (r.created_by_member_id IS NOT NULL AND (c.id IS NULL OR c.household_id<>d.household_id))`],
    ["member_mapping", `SELECT count(*)::int n FROM ${s}."ImportMemberMapping" x LEFT JOIN ${s}."HouseholdMember" m ON m.id=x.member_id WHERE m.id IS NULL OR m.household_id<>x.household_id`],
    ["request_member", `SELECT count(*)::int n FROM ${s}."NaturalLanguageRequest" r LEFT JOIN ${s}."HouseholdMember" m ON m.id=r.created_by_member_id WHERE m.id IS NULL OR m.household_id<>r.household_id`],
    ["unbound_live_session", `SELECT count(*)::int n FROM ${s}."AppSession" a JOIN ${s}."User" u ON u.id=a.user_id
      WHERE a.revoked_at IS NULL AND a.expires_at>now() AND u.status='ACTIVE' AND
      (SELECT count(*) FROM ${s}."HouseholdMember" m WHERE m.user_id=a.user_id ${active} ${foundation ? "AND m.id=a.member_id" : ""})<>1`],
  ];
  if (foundation) {
    checks.push(["default_ledger", `SELECT count(*)::int n FROM ${s}."Household" h WHERE h.closed_at IS NULL AND
      (SELECT count(*) FROM ${s}."Ledger" l WHERE l.household_id=h.id AND l.is_default AND l.archived_at IS NULL)<>1`]);
    for (const table of ["Transaction", "ImportDraft", "NaturalLanguageRequest"]) {
      checks.push([`${table}_ledger`, `SELECT count(*)::int n FROM ${s}.${quote(table)} r LEFT JOIN ${s}."Ledger" l ON l.id=r.ledger_id
        WHERE l.id IS NULL OR l.household_id<>r.household_id`]);
    }
  }
  for (const [name, sql] of checks) {
    const [{ n }] = await client.$queryRawUnsafe<{ n: number }[]>(sql);
    if (n !== 0) throw new VerificationError(`Preflight ${name} failed (${n})`);
  }
  return { checks: checks.length };
}

async function quiesce(client: PrismaClient, schema: string) {
  const s = quote(schema);
  // Call only after stopping every writer; expired attempts then cannot acquire a new lease.
  const writers = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`);
  if (writers[0].n > 0) throw new VerificationError("Other database clients remain connected");
  const active = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM ${s}."NaturalLanguageRequest"
    WHERE status='PROCESSING' AND lease_expires_at>clock_timestamp()`);
  if (active[0].n > 0) throw new VerificationError("Natural-language leases remain active");
  const settled = await client.$executeRawUnsafe(`UPDATE ${s}."NaturalLanguageRequest"
    SET status='FAILED', error_code='EXPIRED', attempt_id=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
    WHERE status='PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())`);
  return { expiredAttemptsSettled: settled };
}

async function main() {
  const { values, positionals } = parseArgs({ options: { output: { type: "string" }, baseline: { type: "string" }, foundation: { type: "boolean" } }, allowPositionals: true });
  const mode = positionals[0];
  if (!["snapshot", "verify", "preflight", "quiesce"].includes(mode)) throw new VerificationError("Choose snapshot, verify, preflight or quiesce");
  const url = process.env.DATABASE_URL;
  if (!url) throw new VerificationError("DATABASE_URL is required");
  const schema = new URL(url).searchParams.get("schema") ?? "public";
  const client = new PrismaClient({ log: [] });
  try {
    if (mode === "quiesce") { process.stdout.write(`${JSON.stringify(await quiesce(client, schema))}\n`); return; }
    const checked = await preflight(client, schema, Boolean(values.foundation));
    if (mode === "preflight") { process.stdout.write(`${JSON.stringify(checked)}\n`); return; }
    const baseline: MigrationManifest | undefined = values.baseline ? JSON.parse(await readFile(values.baseline, "utf8")) : undefined;
    if (mode === "verify" && !baseline) throw new VerificationError("Verification requires a baseline manifest");
    const current = await captureManifest(client, schema, baseline);
    const compared = baseline ? compareManifests(baseline, current) : { tables: current.tables.length, rows: current.tables.reduce((n, t) => n+t.rows, 0), groups: current.transactionGroups.groups };
    if (values.output) {
      const target = path.resolve(values.output);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } else if (mode === "snapshot") throw new VerificationError("Snapshot requires a private output file");
    process.stdout.write(`${JSON.stringify({ status: "passed", ...checked, ...compared })}\n`);
  } finally { await client.$disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof VerificationError ? error.message : "Migration verification failed; private database details were suppressed"}\n`);
    process.exitCode = 1;
  });
}
