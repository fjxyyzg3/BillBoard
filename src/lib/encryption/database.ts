import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getEncryptionContext, type EncryptionRequestContext } from "./request-context";
import { EncryptionRequestError } from "./types";
import { aggregateRows, groupRows, matchesWhere, orderRows } from "./query";
import { opaqueIndexes } from "./crypto";
import { decryptRow, encryptRow, isProtectedModel, modelInfo, protectedFields, publicRow, rowToJson, type DataRow, type ProtectedModel } from "./protected-models";

type Client = PrismaClient | Prisma.TransactionClient;
type Delegate = Record<string, (args?: DataRow) => Promise<unknown>>;
const object = (value: unknown): value is DataRow => !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const delegate = (client: Client, model: string) => (client as unknown as Record<string, Delegate>)[model];
const invoke = (client: Client, model: string, method: string, args?: DataRow) => delegate(client, model)[method](args);
const rows = async (client: Client, model: string, args: DataRow) => await invoke(client, model, "findMany", args) as DataRow[];
const scalarFields = (model: string) => modelInfo.get(model)!.fields.filter((field) => field.kind !== "object");
const modelName = (name: string) => name[0].toLowerCase() + name.slice(1);
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const protectedTable = /"(?:Transaction|Ledger|ImportDraft|ImportDraftRow|ImportCategoryMapping|ImportMemberMapping|NaturalLanguageRequest|AppEvent|VoiceProcessingAdmission|BillAnalysisReport|BillAnalysisRequest|BillReconciliationApplication)"/i;
const financialColumn = new RegExp(`\\b(?:${[...new Set(Object.entries(protectedFields).flatMap(([model, fields]) => fields.map((name) => modelInfo.get(model)!.fields.find((field) => field.name === name)!.dbName ?? name)))].join("|")})\\b`, "i");
function hideStorageFields(model: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((row) => hideStorageFields(model, row));
  if (!object(value)) return value;
  const result = publicRow(value);
  for (const field of modelInfo.get(model)!.fields.filter((field) => field.kind === "object")) if (result[field.name] !== undefined) result[field.name] = hideStorageFields(modelName(field.type), result[field.name]);
  return result;
}

function metadataWhere(model: ProtectedModel, value: unknown): DataRow {
  if (!object(value)) return {};
  const output: DataRow = {};
  const sensitive: readonly string[] = protectedFields[model];
  const fields = new Set(scalarFields(model).map((field) => field.name));
  for (const [key, condition] of Object.entries(value)) {
    if (key === "AND" || key === "OR") {
      const terms = (Array.isArray(condition) ? condition : [condition]).map((term) => metadataWhere(model, term));
      // An OR arm with no metadata restriction must retain the complete candidate set.
      if (key === "AND" || terms.every((term) => Object.keys(term).length)) output[key] = terms;
    } else if (fields.has(key) && !sensitive.includes(key) && !key.startsWith("encryption") && key !== "encryptedPayload") output[key] = condition;
    else if (!fields.has(key) && object(condition) && Object.keys(condition).every((field) => fields.has(field))) Object.assign(output, metadataWhere(model, condition));
  }
  return output;
}

function metadataOnly(model: ProtectedModel, args: DataRow): boolean {
  if (!object(args.select) || !Object.keys(args.select).length || args.include) return false;
  const sensitive: readonly string[] = protectedFields[model];
  const fields = new Set(scalarFields(model).map((field) => field.name));
  if (Object.entries(args.select).some(([key, value]) => value && (!fields.has(key) || sensitive.includes(key) || key === "encryptedPayload" || key === "encryptionRevision"))) return false;
  return JSON.stringify(metadataWhere(model, args.where)) === JSON.stringify(args.where ?? {});
}

function directHousehold(model: ProtectedModel, args: DataRow): unknown {
  const data = object(args.data) ? args.data : Array.isArray(args.data) ? args.data[0] as DataRow : {};
  const where = object(args.where) ? args.where : {};
  if (data.householdId || where.householdId) return data.householdId ?? where.householdId;
  for (const value of Object.values(where)) if (object(value) && value.householdId) return value.householdId;
  if (model === "importDraftRow" && object(where.draft)) return where.draft.householdId;
  return undefined;
}

async function affectedEncrypted(client: Client, model: ProtectedModel, args: DataRow): Promise<boolean> {
  const householdId = Array.isArray(args.data) ? { in: [...new Set((args.data as DataRow[]).map((row) => row.householdId).filter(Boolean))] } : directHousehold(model, args);
  if (householdId && !(model === "importDraftRow")) return !!await invoke(client, "householdEncryption", "findFirst", { where: { householdId, mode: { not: "UNENCRYPTED" } }, select: { householdId: true } });
  const configured = await rows(client, "householdEncryption", { where: { mode: { not: "UNENCRYPTED" } }, select: { householdId: true } });
  if (!configured.length) return false;
  const scope = { householdId: { in: configured.map((row) => row.householdId) } };
  const data = object(args.data) ? args.data : Array.isArray(args.data) ? args.data[0] as DataRow : {};
  if (model === "importDraftRow" && args.data) {
    const values = (Array.isArray(args.data) ? args.data : [args.data]) as DataRow[];
    if (await invoke(client, "importDraft", "findFirst", { where: { ...scope, id: { in: values.map((row) => row.draftId).filter(Boolean) } }, select: { id: true } })) return true;
  }
  const candidates = { AND: [metadataWhere(model, args.where), model === "importDraftRow" ? { draft: scope } : scope, ...(data.draftId ? [{ draftId: data.draftId }] : [])] };
  return !!await invoke(client, model, "findFirst", { where: candidates, select: { id: true } });
}

async function guard(client: Client, context: EncryptionRequestContext, writing: boolean) {
  getEncryptionContext();
  if (writing && context.readOnly) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  if (writing) {
    await client.$queryRaw`SELECT id FROM "Household" WHERE id = ${context.session.householdId} FOR UPDATE`;
    await client.$queryRaw`SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id=m.user_id WHERE m.id=${context.session.memberId} AND m.household_id=${context.session.householdId} FOR UPDATE OF m,u`;
    await client.$queryRaw`SELECT id FROM "AppSession" WHERE id=${context.session.appSessionId} FOR SHARE`;
  }
  const config = await invoke(client, "householdEncryption", "findUnique", { where: { householdId: context.session.householdId } }) as DataRow | null;
  if ((config?.revision ?? 0) !== context.revision || (config?.mode ?? "UNENCRYPTED") !== context.configMode) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (writing && (context.configMode !== context.mode || config?.activeOperationId)) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  const member = await invoke(client, "householdMember", "findFirst", { where: { id: context.session.memberId, householdId: context.session.householdId, userId: context.session.id, leftAt: null, household: { closedAt: null }, user: { status: "ACTIVE" } }, select: { id: true } });
  const valid = await client.$queryRaw<Array<{ id: string }>>`SELECT id FROM "AppSession" WHERE id=${context.session.appSessionId} AND user_id=${context.session.id} AND member_id=${context.session.memberId} AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
  if (!member || !valid.length) throw new Error("Unauthorized");
}

function requiredRelations(model: string, args: DataRow): Map<string, DataRow> {
  const names = new Set(modelInfo.get(model)!.fields.filter((field) => field.kind === "object").map((field) => field.name));
  const needed = new Map<string, DataRow>();
  const collect = (value: unknown, fromWhere = false) => {
    if (Array.isArray(value)) { value.forEach((item) => collect(item, fromWhere)); return; }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (["AND", "OR", "NOT"].includes(key)) collect(item, fromWhere);
      else if (names.has(key) && item) {
        const nested = object(item) ? item : {};
        const relationWhere = object(nested.is) ? nested.is : object(nested.isNot) ? nested.isNot : nested;
        const previous = needed.get(key) ?? {};
        // Predicates need complete related scalar rows; selection can be applied afterwards.
        needed.set(key, fromWhere ? { ...previous, relationPredicate: relationWhere } : { ...previous, ...nested });
      }
    }
  };
  collect(args.where, true); collect(args.relationPredicate, true); collect(args.orderBy, true); collect(args.include); collect(args.select);
  return needed;
}

function project(model: string, row: DataRow, args: DataRow): DataRow {
  const select = object(args.select) ? args.select : null;
  const include = object(args.include) ? args.include : {};
  const output = select ? {} as DataRow : publicRow(Object.fromEntries(scalarFields(model).map((field) => [field.name, row[field.name]])));
  for (const [key, selection] of Object.entries(select ?? include)) {
    if (!selection) continue;
    const field = modelInfo.get(model)!.fields.find((field) => field.name === key);
    if (!field) throw new Error("Unsupported encrypted projection");
    if (field.kind !== "object") { if (key === "encryptedPayload" || key === "encryptionRevision") throw new Error("Private encryption field"); output[key] = row[key]; }
    else {
      const nested = object(selection) ? selection : {};
      const relatedModel = modelName(field.type);
      const value = row[key];
      output[key] = Array.isArray(value) ? pageRows(value as DataRow[], nested).map((item) => project(relatedModel, item, nested)) : object(value) ? project(relatedModel, value, nested) : null;
    }
  }
  return output;
}

function pageRows(input: DataRow[], args: DataRow): DataRow[] {
  let selected = orderRows(input.filter((row) => matchesWhere(row, args.where as DataRow | undefined)), args.orderBy as DataRow | DataRow[] | undefined);
  if (args.distinct) {
    const fields = Array.isArray(args.distinct) ? args.distinct : [args.distinct];
    const seen = new Set<string>();
    selected = selected.filter((row) => { const key = JSON.stringify(fields.map((field) => row[String(field)])); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  if (object(args.cursor)) { const cursor = args.cursor; const index = selected.findIndex((row) => matchesWhere(row, cursor)); selected = index < 0 ? [] : selected.slice(index); }
  const skip = Number(args.skip ?? 0), take = args.take === undefined ? undefined : Number(args.take);
  if (!Number.isSafeInteger(skip) || skip < 0 || (take !== undefined && (!Number.isSafeInteger(take) || take < 0))) throw new Error("Unsupported encrypted pagination");
  return selected.slice(skip, take === undefined ? undefined : skip + take);
}

export async function bulkReplace(client: Client, model: ProtectedModel, replacements: DataRow[], columns?: string[]): Promise<void> {
  const info = modelInfo.get(model)!;
  const fields = scalarFields(model);
  const table = Prisma.raw(`"${info.dbName ?? info.name}"`);
  const column = (name: string) => Prisma.raw(`"${fields.find((field) => field.name === name)!.dbName ?? name}"`);
  for (let offset = 0; offset < replacements.length; offset += 500) {
    const batch = replacements.slice(offset, offset + 500);
    const json = JSON.stringify(batch.map((row) => {
      const value = rowToJson(model, row);
      return Object.fromEntries(fields.map((field) => [field.dbName ?? field.name, value[field.name] ?? null]));
    }));
    const assignments = fields.filter((field) => field.name !== "id" && (!columns || columns.includes(field.name))).map((field) => Prisma.sql`${column(field.name)} = v.${column(field.name)}`);
    await client.$executeRaw(Prisma.sql`UPDATE ${table} AS t SET ${Prisma.join(assignments)} FROM jsonb_populate_recordset(NULL::${table}, ${json}::jsonb) AS v WHERE t.id=v.id`);
  }
}

export function encryptionDatabase(physical: Client, inTransaction = false): PrismaClient {
  let facade: PrismaClient;
  const delegates = new Map<string, Delegate>();
  const overrides = new Map<PropertyKey, unknown>();
  const methods = new Map<PropertyKey, unknown>();
  const read = async (model: ProtectedModel, args: DataRow, context: EncryptionRequestContext): Promise<DataRow[]> => {
    await guard(physical, context, false);
    if (!context.ring) throw new EncryptionRequestError("ENCRYPTION_REQUIRED");
    const where = metadataWhere(model, args.where);
    const scope = model === "importDraftRow" ? { draft: { householdId: context.session.householdId } } : { householdId: context.session.householdId };
    const records: DataRow[] = [];
    let cursor: string | undefined;
    let byteCount = 0;
    const metadataPage = JSON.stringify(where) === JSON.stringify(args.where ?? {}) && JSON.stringify(args.orderBy) === JSON.stringify({ id: "asc" }) && !args.skip && !args.cursor && Number.isSafeInteger(args.take) && Number(args.take) >= 0 && Number(args.take) <= 500;
    const pageLimit = metadataPage ? Number(args.take) : undefined;
    if (pageLimit === 0) return [];
    do {
      const chunkSize = pageLimit === undefined ? 500 : Math.min(500, pageLimit - records.length);
      const chunk = await rows(physical, model, { where: { AND: [scope, where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: chunkSize });
      if (!chunk.length) break;
      let draftMap = new Map<string, DataRow>();
      if (model === "importDraftRow") draftMap = new Map((await rows(physical, "importDraft", { where: { householdId: context.session.householdId, id: { in: [...new Set(chunk.map((row) => row.draftId))] } }, select: { id: true, ledgerId: true } })).map((row) => [String(row.id), row]));
      for (const row of chunk) {
        getEncryptionContext();
        byteCount += String(row.encryptedPayload ?? "").length;
        if (byteCount > 512 * 1024 * 1024) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
        const draft = draftMap.get(String(row.draftId));
        if (model === "importDraftRow" && !draft) throw new EncryptionRequestError("ENCRYPTION_INVALID");
        records.push(await decryptRow(model, row, context.ring, context.session.householdId, draft ? String(draft.ledgerId) : undefined));
      }
      cursor = String(chunk.at(-1)!.id);
      if (chunk.length < chunkSize || (pageLimit !== undefined && records.length >= pageLimit)) break;
    } while (true);
    await hydrate(model, records, args, context);
    return records;
  };

  const hydrate = async (model: string, records: DataRow[], args: DataRow, context: EncryptionRequestContext): Promise<void> => {
    if (!records.length) return;
    for (const [name, nested] of requiredRelations(model, args)) {
      const field = modelInfo.get(model)!.fields.find((field) => field.name === name)!;
      const other = modelName(field.type);
      let from = [...(field.relationFromFields ?? [])], to = [...(field.relationToFields ?? [])];
      if (!from.length) {
        const inverse = modelInfo.get(other)!.fields.find((item) => item.kind === "object" && item.relationName === field.relationName && (item.relationFromFields?.length ?? 0) > 0);
        if (!inverse) throw new Error("Unsupported encrypted relation");
        from = [...inverse.relationToFields!]; to = [...inverse.relationFromFields!];
      }
      const keys = [...new Map(records.filter((row) => from.every((key) => row[key] != null)).map((row) => [JSON.stringify(from.map((key) => row[key])), Object.fromEntries(to.map((key, index) => [key, row[from[index]]]))])).values()];
      const relatedWhere = to.length === 1 ? { [to[0]]: { in: keys.map((key) => key[to[0]]) } } : { OR: keys };
      const relatedArgs = { where: relatedWhere };
      let related: DataRow[] = [];
      if (keys.length) {
        // A single batch per relation; repeated parent IDs never cause per-row queries.
        const candidateArgs = { ...relatedArgs, select: undefined, include: undefined };
        related = isProtectedModel(other) ? await read(other, { ...relationArgs(nested), ...candidateArgs, relationPredicate: nested.relationPredicate }, context) : await rows(physical, other, candidateArgs);
        if (!isProtectedModel(other)) await hydrate(other, related, relationArgs(nested), context);
      }
      const groups = new Map<string, DataRow[]>();
      for (const row of related) { const key = JSON.stringify(to.map((part) => row[part])); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
      for (const row of records) { const found = groups.get(JSON.stringify(from.map((part) => row[part]))) ?? []; row[name] = field.isList ? found : found[0] ?? null; }
    }
  };
  const relationArgs = (nested: DataRow): DataRow => {
    const copy = { ...nested };
    if (copy.relationPredicate) { copy.where = copy.relationPredicate; delete copy.relationPredicate; }
    return copy;
  };

  const write = async (model: ProtectedModel, method: string, args: DataRow, context: EncryptionRequestContext): Promise<unknown> => {
    await guard(physical, context, true);
    const category = await invoke(physical, "category", "findFirst", { orderBy: { id: "asc" }, select: { id: true } }) as DataRow | null;
    if (model === "transaction" && !category) throw new Error("No existing category is available");
    const draftMap = new Map<string, DataRow>();
    const prepareDrafts = async (values: DataRow[]) => {
      if (model !== "importDraftRow") return;
      const ids = [...new Set(values.map((row) => String(row.draftId)))];
      for (let offset = 0; offset < ids.length; offset += 500) for (const draft of await rows(physical, "importDraft", { where: { id: { in: ids.slice(offset, offset + 500) }, householdId: context.session.householdId }, select: { id: true, ledgerId: true } })) draftMap.set(String(draft.id), draft);
    };
    const encode = async (row: DataRow) => {
      if (model !== "importDraftRow" && row.householdId !== context.session.householdId) throw new Error("Unauthorized");
      let ledgerId: string | undefined;
      if (model === "importDraftRow") {
        const draft = draftMap.get(String(row.draftId));
        if (!draft) throw new Error("Unauthorized");
        ledgerId = String(draft.ledgerId);
      }
      return encryptRow(model, row, context.ring!, context.session.householdId, String(category?.id ?? ""), ledgerId);
    };
    if (["create", "createMany", "createManyAndReturn"].includes(method)) {
      let input = (Array.isArray(args.data) ? args.data : [args.data]) as DataRow[];
      if (model === "transaction") {
        const existing: DataRow[] = [];
        for (let offset = 0; offset < input.length; offset += 250) {
          const batch = input.slice(offset, offset + 250), tags: string[] = [];
          for (const item of batch) if (item.source != null && item.sourceFingerprint != null) tags.push(...await opaqueIndexes(context.ring!, "transaction-source", JSON.stringify([item.source, item.sourceFingerprint])));
          const conditions: DataRow[] = [{ id: { in: batch.map((item) => item.id).filter(Boolean) } }, ...batch.filter((item) => item.clientRequestId != null).map((item) => ({ createdByMemberId: item.createdByMemberId, clientRequestId: item.clientRequestId }))];
          for (let start = 0; start < tags.length; start += 10000) conditions.push({ source: "encrypted", sourceFingerprint: { in: tags.slice(start, start + 10000) } });
          const candidates = await rows(physical, model, { where: { householdId: context.session.householdId, OR: conditions }, select: { id: true } });
          if (candidates.length) existing.push(...await read(model, { where: { id: { in: candidates.map((row) => row.id) } } }, context));
        }
        const keys = (item: DataRow) => [item.id ? `id:${item.id}` : null, item.clientRequestId != null ? `request:${JSON.stringify([item.createdByMemberId, item.clientRequestId])}` : null, item.source != null && item.sourceFingerprint != null ? `source:${JSON.stringify([item.source, item.sourceFingerprint])}` : null].filter((key): key is string => key !== null);
        const used = new Set(existing.flatMap(keys));
        input = input.filter((item) => {
          const unique = keys(item);
          if (unique.some((key) => used.has(key))) {
            if (args.skipDuplicates === true && method !== "create") return false;
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: Prisma.prismaVersion.client });
          }
          unique.forEach((key) => used.add(key)); return true;
        });
      }
      const plain: DataRow[] = [];
      const encoded: DataRow[] = [];
      const nestedRows: Array<{ parent: DataRow; nested: DataRow }> = [];
      await prepareDrafts(input);
      for (const item of input) {
        const complete = defaults(model, item);
        if (model === "importDraft" && object(item.rows)) { nestedRows.push({ parent: complete, nested: item.rows }); delete complete.rows; }
        plain.push(complete); encoded.push(await encode(complete));
      }
      let inserted: DataRow[];
      if (method === "create") inserted = [await invoke(physical, model, "create", { data: prismaData(model, encoded[0]) }) as DataRow];
      else {
        inserted = [];
        for (let offset = 0; offset < encoded.length; offset += 500) inserted.push(...await invoke(physical, model, "createManyAndReturn", { data: encoded.slice(offset, offset + 500).map((row) => prismaData(model, row)), skipDuplicates: args.skipDuplicates === true }) as DataRow[]);
      }
      for (const { parent, nested } of nestedRows) {
        const createMany = object(nested.createMany) ? nested.createMany : undefined;
        const children = createMany?.data ?? nested.create;
        if (!Array.isArray(children)) throw new Error("Unsupported encrypted nested write");
        await (facade.importDraftRow.createMany as unknown as (args: DataRow) => Promise<unknown>)({ data: children.map((child) => ({ ...(child as DataRow), draftId: parent.id })) });
      }
      const ids = new Set(inserted.map((row) => row.id));
      const accepted = plain.filter((row) => ids.has(row.id));
      if (method === "createMany") return { count: accepted.length };
      await hydrate(model, accepted, args, context);
      const projected = accepted.map((row) => project(model, row, args));
      return method === "create" ? projected[0] : projected;
    }
    const current = (await read(model, { where: args.where }, context)).filter((row) => matchesWhere(row, args.where as DataRow));
    if (method === "upsert") {
      if (!current.length) return write(model, "create", { ...args, data: args.create }, context);
      return write(model, "update", { ...args, where: { id: current[0].id }, data: args.update }, context);
    }
    if (["update", "delete"].includes(method) && current.length !== 1) throw new Prisma.PrismaClientKnownRequestError("Record is unavailable", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
    if (method === "delete" || method === "deleteMany") {
      await invoke(physical, model, "deleteMany", { where: { id: { in: current.map((row) => row.id) } } });
      return method === "deleteMany" ? { count: current.length } : project(model, current[0], args);
    }
    const replacements = current.map((row) => applyUpdate(model, row, args.data as DataRow));
    const encoded: DataRow[] = [];
    await prepareDrafts(replacements);
    for (const row of replacements) encoded.push(await encode(row));
    await bulkReplace(physical, model, encoded);
    if (method === "updateMany") return { count: current.length };
    await hydrate(model, replacements, args, context);
    const projected = replacements.map((row) => project(model, row, args));
    return method === "update" ? projected[0] : projected;
  };

  const dispatch = async (model: ProtectedModel, method: string, args: DataRow = {}): Promise<unknown> => {
    const context = getEncryptionContext();
    const writing = WRITE_METHODS.has(method);
    if (writing && !inTransaction) return (physical as PrismaClient).$transaction(async (tx) => invoke(encryptionDatabase(tx, true), model, method, args), { timeout: 120000 });
    if (context?.mode === "ENCRYPTED" && !writing && !inTransaction) return (physical as PrismaClient).$transaction(async (tx) => invoke(encryptionDatabase(tx, true), model, method, args), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 120000 });
    if (!context || context.mode === "UNENCRYPTED") {
      if (context) await guard(physical, context, writing);
      if (!context && writing) {
        const data = object(args.data) ? [args.data] : Array.isArray(args.data) ? args.data as DataRow[] : [];
        let ids = [...new Set(data.map((row) => row.householdId).filter((id): id is string => typeof id === "string"))];
        if (!ids.length && model === "importDraftRow" && data.length) ids = (await rows(physical, "importDraft", { where: { id: { in: data.map((row) => row.draftId).filter(Boolean) } }, select: { householdId: true } })).map((draft) => String(draft.householdId));
        if (!ids.length) {
          const targets = await rows(physical, model, { where: metadataWhere(model, args.where), select: model === "importDraftRow" ? { draft: { select: { householdId: true } } } : { householdId: true } });
          ids = [...new Set(targets.map((row) => model === "importDraftRow" && object(row.draft) ? row.draft.householdId : row.householdId).filter((id): id is string => typeof id === "string"))];
        }
        for (const id of ids.sort()) await physical.$queryRaw`SELECT id FROM "Household" WHERE id=${id} FOR UPDATE`;
      }
      if (context?.configMode === "ENABLING" && context.readOnly && !writing) {
        const scope = model === "importDraftRow" ? { draft: { householdId: context.session.householdId } } : { householdId: context.session.householdId };
        return hideStorageFields(model, await invoke(physical, model, method, { ...args, where: { ...(args.where as DataRow ?? {}), AND: [args.where ?? {}, scope] } }));
      }
      const encrypted = await affectedEncrypted(physical, model, args);
      if (encrypted && !(metadataOnly(model, args) && !writing)) throw new EncryptionRequestError(writing ? "ENCRYPTION_BUSY" : "ENCRYPTION_REQUIRED");
      const value = await invoke(physical, model, method, args);
      if (context && writing) await guard(physical, context, true);
      return hideStorageFields(model, value);
    }
    if (writing) {
      const value = await write(model, method, args, context);
      await guard(physical, context, true);
      return value;
    }
    let records = await read(model, args, context);
    if (method === "aggregate") return aggregateRows(records.filter((row) => matchesWhere(row, args.where as DataRow)), args);
    if (method === "groupBy") records = groupRows(records.filter((row) => matchesWhere(row, args.where as DataRow)), args);
    records = pageRows(records, method === "groupBy" ? { ...args, where: args.having } : args);
    if (method === "count") return args.select ? aggregateRows(records, { _count: args.select })._count : records.length;
    if (method === "groupBy") return records;
    if (!["findMany", "findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow"].includes(method)) throw new Error("Unsupported encrypted operation");
    const result = records.map((row) => project(model, row, args));
    if (method.endsWith("OrThrow") && !result.length) throw new Prisma.PrismaClientKnownRequestError("Record is unavailable", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
    return method === "findMany" ? result : result[0] ?? null;
  };

  facade = new Proxy(physical, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      if (property === "$transaction") {
        if (methods.has(property)) return methods.get(property);
        const transaction = (input: unknown, options?: DataRow) => {
        if (typeof input !== "function") {
          if (getEncryptionContext()?.mode === "ENCRYPTED") throw new Error("Encrypted transactions require a callback");
          return (target as PrismaClient).$transaction(input as Prisma.PrismaPromise<unknown>[], options);
        }
        return (target as PrismaClient).$transaction((tx) => input(encryptionDatabase(tx, true)), options);
        };
        methods.set(property, transaction); return transaction;
      }
      if (typeof property === "string" && isProtectedModel(property)) {
        if (!delegates.has(property)) delegates.set(property, Object.fromEntries([...WRITE_METHODS, "findMany", "findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"].map((method) => [method, (args?: DataRow) => dispatch(property, method, args)])));
        return delegates.get(property);
      }
      if (typeof property === "string" && ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"].includes(property)) return (...args: unknown[]) => {
        if (getEncryptionContext()?.mode === "ENCRYPTED") {
          const first = args[0];
          const sql = Array.isArray(first) ? first.join("?") : object(first) && Array.isArray(first.strings) ? first.strings.join("?") : typeof first === "string" ? first : "";
          // Protected tables permit metadata row locks only; every financial read uses delegates.
          if (protectedTable.test(sql) && (!/^\s*SELECT\b/i.test(sql) || !/\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i.test(sql) || financialColumn.test(sql) || /\*/.test(sql))) throw new Error("Financial SQL requires the encryption adapter");
        }
        const fn = Reflect.get(target, property) as (...values: unknown[]) => unknown;
        return fn.apply(target, args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, property, value) { overrides.set(property, value); return true; },
    defineProperty(_target, property, descriptor) { if ("value" in descriptor) overrides.set(property, descriptor.value); return true; },
    deleteProperty(_target, property) { overrides.delete(property); return true; },
  }) as PrismaClient;
  return facade;
}

function defaults(model: ProtectedModel, input: DataRow): DataRow {
  const result: DataRow = {};
  for (const field of scalarFields(model)) {
    if (Object.hasOwn(input, field.name) && input[field.name] !== undefined) result[field.name] = input[field.name];
    else if (field.name === "id") result.id = randomUUID();
    else if (field.type === "DateTime" && (field.name === "createdAt" || field.name === "updatedAt")) result[field.name] = new Date();
    else if (field.hasDefaultValue && typeof field.default !== "object") result[field.name] = field.default;
    else if (field.isList) result[field.name] = [];
    else if (!field.isRequired) result[field.name] = null;
  }
  for (const [key, value] of Object.entries(input)) if (value !== undefined) result[key] = value;
  return result;
}
function prismaData(model: ProtectedModel, row: DataRow): DataRow {
  const data = { ...row };
  for (const field of scalarFields(model)) if (field.type === "Json" && data[field.name] === null) data[field.name] = Prisma.DbNull;
  return data;
}
function applyUpdate(model: ProtectedModel, row: DataRow, input: DataRow): DataRow {
  const result = { ...row };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const field = scalarFields(model).find((field) => field.name === key);
    if (!field || ["id", "householdId", "draftId", "encryptedPayload", "encryptionRevision"].includes(key)) throw new Error("Unsupported encrypted update");
    if (object(value) && field.type !== "Json") {
      if (Object.hasOwn(value, "set")) result[key] = value.set;
      else if (typeof result[key] === "number" && ("increment" in value || "decrement" in value)) result[key] = Number(result[key]) + Number(value.increment ?? 0) - Number(value.decrement ?? 0);
      else throw new Error("Unsupported encrypted update");
    } else result[key] = value === Prisma.DbNull || value === Prisma.JsonNull ? null : value;
  }
  if (scalarFields(model).some((field) => field.name === "updatedAt") && input.updatedAt === undefined) result.updatedAt = new Date();
  return result;
}
