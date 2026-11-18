# Import Member Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded imported member aliases with household-scoped, source-scoped member mappings that users can save and reuse.

**Architecture:** Add a dedicated Prisma model for persisted member mappings and store only normalized external names on import draft rows. Draft creation resolves member ids from saved mappings; the import preview lets users save unresolved external names; confirmation rejects importable rows whose external member mapping is still unresolved.

**Tech Stack:** Next.js server actions, Prisma/PostgreSQL, Vitest unit and integration tests, Playwright e2e tests, existing BillBoard i18n in `src/lib/i18n.ts`.

---

## Repository Rule Notes

- Chat, plans, verification notes, and commit message drafts use Chinese; code and code comments use English.
- This repository requires a version bump for every commit. Do not commit after each task. Use task checkpoints, then do one final version bump and commit only after full verification passes and the user asks for a commit.
- This feature is a product feature. If committing, bump `package.json` and root `package-lock.json` from `1.1.1` to `1.2.0`, and use a commit subject starting with `v1.2.0`.
- Run the security review skill before final acceptance because the change touches import, Prisma, family financial data, and server actions.

## File Structure

- Modify `prisma/schema.prisma`: add `ImportMemberMapping`, relations, and `ImportDraftRow.actorExternalName` / `creatorExternalName`.
- Create `prisma/migrations/<timestamp>_add_import_member_mappings/migration.sql`: database migration for the new table, fields, indexes, and foreign keys.
- Modify `src/lib/imports/member-mapping.ts`: replace hard-coded alias logic with normalization and lookup-based resolution.
- Modify `src/lib/imports/drafts.ts`: load saved mappings, populate external name fields, expose member mapping summary, save mappings, update draft rows, and block confirmation while unresolved external mappings remain.
- Modify `src/app/(app)/records/import/actions.ts`: add a `saveImportMemberMappings` server action and keep legacy payment owner action for files without an external owner name.
- Modify `src/app/(app)/records/import/page.tsx`: render the member mapping form, preserve one-time payment owner fallback for ownerless payment files, and disable confirmation when needed.
- Modify `src/lib/i18n.ts`: add Chinese and English import member mapping strings.
- Modify `tests/unit/import-schema.test.ts`: assert schema contains member mapping model and draft row external name fields.
- Modify `tests/unit/sui-shou-ji-import.test.ts`: update imported member mapping unit tests.
- Modify `tests/integration/import-drafts.test.ts`: cover saved mapping reuse, unresolved mapping blocking, save/update behavior, and cross-household rejection.
- Modify `tests/integration/import-page-and-actions.test.ts`: cover action parsing and server-rendered member mapping UI.
- Modify `tests/e2e/db-cleanup.ts` and `tests/unit/e2e-cleanup-config.test.ts`: include `ImportMemberMapping` cleanup.
- Modify `tests/e2e/import-sui-shou-ji.spec.ts`, `tests/e2e/import-wechat-pay.spec.ts`, and `tests/e2e/import-alipay.spec.ts`: add or adjust member mapping steps.
- Modify `package.json` and `package-lock.json` only at final commit preparation if a commit is requested.

---

### Task 1: Prisma Schema And Migration

**Files:**
- Modify: `tests/unit/import-schema.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_import_member_mappings/migration.sql`

- [ ] **Step 1: Write the failing schema test**

In `tests/unit/import-schema.test.ts`, extend the first test:

```ts
expect(schema).toContain("model ImportMemberMapping");
expect(schema).toContain("importMemberMappings ImportMemberMapping[]");
expect(schema).toContain("actorExternalName     String?              @map(\"actor_external_name\")");
expect(schema).toContain("creatorExternalName   String?              @map(\"creator_external_name\")");
expect(schema).toContain(
  '@@unique([householdId, source, externalName], name: "household_source_external_name", map: "household_source_external_name")',
);
```

- [ ] **Step 2: Run the schema test and verify RED**

Run:

```powershell
npm run test:unit -- tests/unit/import-schema.test.ts
```

Expected: FAIL because `ImportMemberMapping`, `actorExternalName`, and `creatorExternalName` do not exist yet.

- [ ] **Step 3: Add Prisma schema fields**

In `prisma/schema.prisma`, update `Household`:

```prisma
model Household {
  id                     String                  @id @default(cuid())
  name                   String
  baseCurrency           String                  @default("CNY") @map("base_currency")
  timezone               String                  @default("Asia/Shanghai")
  createdAt              DateTime                @default(now()) @map("created_at")
  members                HouseholdMember[]
  transactions           Transaction[]
  importDrafts           ImportDraft[]
  importCategoryMappings ImportCategoryMapping[]
  importMemberMappings   ImportMemberMapping[]
}
```

Update `HouseholdMember`:

```prisma
model HouseholdMember {
  id                  String                @id @default(cuid())
  householdId         String                @map("household_id")
  userId              String                @unique @map("user_id")
  role                HouseholdRole
  memberName          String                @map("member_name")
  joinedAt            DateTime              @default(now()) @map("joined_at")
  household           Household             @relation(fields: [householdId], references: [id], onDelete: Cascade)
  user                User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  actorTransactions   Transaction[]         @relation("ActorTransactions")
  createdTransactions Transaction[]         @relation("CreatedTransactions")
  importDrafts        ImportDraft[]
  importMemberMappings ImportMemberMapping[]

  @@unique([householdId, memberName])
}
```

Add the model after `ImportCategoryMapping`:

```prisma
model ImportMemberMapping {
  id           String          @id @default(cuid())
  householdId  String          @map("household_id")
  source       String
  externalName String          @map("external_name")
  memberId     String          @map("member_id")
  createdAt    DateTime        @default(now()) @map("created_at")
  updatedAt    DateTime        @updatedAt @map("updated_at")
  household    Household       @relation(fields: [householdId], references: [id], onDelete: Cascade)
  member       HouseholdMember @relation(fields: [memberId], references: [id], onDelete: Cascade)

  @@unique([householdId, source, externalName], name: "household_source_external_name", map: "household_source_external_name")
  @@index([memberId])
}
```

Add fields to `ImportDraftRow` near the raw fields:

```prisma
  actorExternalName      String?              @map("actor_external_name")
  creatorExternalName    String?              @map("creator_external_name")
```

- [ ] **Step 4: Create the migration**

Use Prisma if the dev database is available:

```powershell
npm run prisma:migrate -- --name add_import_member_mappings
```

Expected: migration file is created and Prisma Client is regenerated.

If the database is not available, create the migration SQL manually with this content and run `npm run prisma:generate`:

```sql
ALTER TABLE "ImportDraftRow"
ADD COLUMN "actor_external_name" TEXT,
ADD COLUMN "creator_external_name" TEXT;

CREATE TABLE "ImportMemberMapping" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMemberMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "household_source_external_name" ON "ImportMemberMapping"("household_id", "source", "external_name");
CREATE INDEX "ImportMemberMapping_member_id_idx" ON "ImportMemberMapping"("member_id");

ALTER TABLE "ImportMemberMapping"
ADD CONSTRAINT "ImportMemberMapping_household_id_fkey"
FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportMemberMapping"
ADD CONSTRAINT "ImportMemberMapping_member_id_fkey"
FOREIGN KEY ("member_id") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Run the schema test and verify GREEN**

Run:

```powershell
npm run test:unit -- tests/unit/import-schema.test.ts
```

Expected: PASS.

---

### Task 2: Member Mapping Utility

**Files:**
- Modify: `tests/unit/sui-shou-ji-import.test.ts`
- Modify: `src/lib/imports/member-mapping.ts`

- [ ] **Step 1: Write failing utility tests**

Replace the current `resolveImportedMember` test in `tests/unit/sui-shou-ji-import.test.ts` with:

```ts
describe("import member mapping", () => {
  it("normalizes external names before lookup", () => {
    expect(normalizeImportedMemberName(" 老婆 ")).toBe("老婆");
    expect(normalizeImportedMemberName("  ")).toBeNull();
    expect(normalizeImportedMemberName(null)).toBeNull();
  });

  it("resolves imported members from saved mappings and marks unresolved names as fallback", () => {
    const mappingByExternalName = new Map([
      ["随手记老婆", "wife-member"],
      ["随手记老公", "husband-member"],
    ]);

    expect(resolveImportedMember(" 随手记老婆 ", mappingByExternalName, "current-member")).toEqual({
      externalName: "随手记老婆",
      fallbackApplied: false,
      memberId: "wife-member",
    });
    expect(resolveImportedMember("陌生昵称", mappingByExternalName, "current-member")).toEqual({
      externalName: "陌生昵称",
      fallbackApplied: true,
      memberId: "current-member",
    });
    expect(resolveImportedMember(" ", mappingByExternalName, "current-member")).toEqual({
      externalName: null,
      fallbackApplied: false,
      memberId: "current-member",
    });
  });
});
```

Update imports in that test file:

```ts
import {
  normalizeImportedMemberName,
  resolveImportedMember,
} from "@/lib/imports/member-mapping";
```

- [ ] **Step 2: Run the utility tests and verify RED**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: FAIL because `normalizeImportedMemberName` is not exported and `resolveImportedMember` still expects household members.

- [ ] **Step 3: Implement mapping utility**

Replace `src/lib/imports/member-mapping.ts` with:

```ts
export type ImportedMemberResolution = {
  externalName: string | null;
  fallbackApplied: boolean;
  memberId: string;
};

export function normalizeImportedMemberName(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();

  return normalized ? normalized : null;
}

export function resolveImportedMember(
  rawName: string | null | undefined,
  mappingByExternalName: Map<string, string>,
  currentMemberId: string,
): ImportedMemberResolution {
  const externalName = normalizeImportedMemberName(rawName);

  if (!externalName) {
    return { externalName: null, fallbackApplied: false, memberId: currentMemberId };
  }

  const mappedMemberId = mappingByExternalName.get(externalName);

  if (!mappedMemberId) {
    return { externalName, fallbackApplied: true, memberId: currentMemberId };
  }

  return { externalName, fallbackApplied: false, memberId: mappedMemberId };
}
```

- [ ] **Step 4: Run the utility tests and verify GREEN**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: PASS.

---

### Task 3: Draft Creation Uses Saved Member Mappings

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/drafts.ts`

- [ ] **Step 1: Write failing integration tests for unresolved and saved mappings**

Add two tests near the beginning of `describe("import draft services", () => {`:

```ts
it("creates Sui Shou Ji draft rows with unresolved external member names", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook({
      rawCreatedBy: "随手记老婆",
      rawMember: "随手记老婆",
    }),
    fileName: "member-mapping-unresolved.xlsx",
    sessionUser,
  });

  const summary = await services.getImportDraftSummary(draft.id, sessionUser);

  expect(summary.memberMappings).toMatchObject([
    {
      count: 1,
      externalName: "随手记老婆",
      fallbackApplied: true,
      memberId: sessionUser.memberId,
    },
  ]);
  expect(summary.rows[0]).toMatchObject({
    actorExternalName: "随手记老婆",
    actorFallbackApplied: true,
    actorMemberId: sessionUser.memberId,
    creatorExternalName: "随手记老婆",
    createdByMemberId: sessionUser.memberId,
    creatorFallbackApplied: true,
  });
});

it("reuses saved member mappings when creating Sui Shou Ji drafts", async () => {
  const { sessionUser, wifeMember } = await createHouseholdFixture();
  await db.importMemberMapping.create({
    data: {
      externalName: "随手记老婆",
      householdId: sessionUser.householdId,
      memberId: wifeMember.id,
      source: "sui_shou_ji",
    },
  });

  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook({
      rawCreatedBy: "随手记老婆",
      rawMember: "随手记老婆",
    }),
    fileName: "member-mapping-reused.xlsx",
    sessionUser,
  });

  const summary = await services.getImportDraftSummary(draft.id, sessionUser);

  expect(summary.memberMappings).toMatchObject([
    {
      count: 1,
      externalName: "随手记老婆",
      fallbackApplied: false,
      memberId: wifeMember.id,
    },
  ]);
  expect(summary.rows[0]).toMatchObject({
    actorExternalName: "随手记老婆",
    actorFallbackApplied: false,
    actorMemberId: wifeMember.id,
    creatorExternalName: "随手记老婆",
    createdByMemberId: wifeMember.id,
    creatorFallbackApplied: false,
  });
});
```

Update cleanup in `afterEach`:

```ts
await db.importMemberMapping.deleteMany({ where: { householdId } });
await db.importCategoryMapping.deleteMany({ where: { householdId } });
```

- [ ] **Step 2: Run the integration tests and verify RED**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `summary.memberMappings`, external name fields, and `db.importMemberMapping` support are not wired into draft creation.

- [ ] **Step 3: Extend draft summary types**

In `src/lib/imports/drafts.ts`, extend `ImportDraftRowSummary`:

```ts
  actorExternalName: string | null;
  creatorExternalName: string | null;
```

Add the summary mapping type:

```ts
type ImportDraftMemberMappingSummary = {
  count: number;
  externalName: string;
  fallbackApplied: boolean;
  memberId: string;
};
```

Extend `ImportDraftSummary`:

```ts
  hasUnresolvedMemberMappings: boolean;
  memberMappings: ImportDraftMemberMappingSummary[];
```

- [ ] **Step 4: Build member mapping groups in summary**

In `buildSummary`, add a map that groups actor and creator external names:

```ts
  const memberMappingGroups = new Map<string, ImportDraftMemberMappingSummary>();

  for (const row of rows) {
    const candidates = [
      {
        externalName: row.actorExternalName,
        fallbackApplied: row.actorFallbackApplied,
        memberId: row.actorMemberId,
      },
      {
        externalName: row.creatorExternalName,
        fallbackApplied: row.creatorFallbackApplied,
        memberId: row.createdByMemberId,
      },
    ];

    for (const candidate of candidates) {
      if (!candidate.externalName || !candidate.memberId) {
        continue;
      }

      const current = memberMappingGroups.get(candidate.externalName);

      if (current) {
        current.count += 1;
        current.fallbackApplied = current.fallbackApplied || candidate.fallbackApplied;
      } else {
        memberMappingGroups.set(candidate.externalName, {
          count: 1,
          externalName: candidate.externalName,
          fallbackApplied: candidate.fallbackApplied,
          memberId: candidate.memberId,
        });
      }
    }
  }
```

Return these fields:

```ts
    hasUnresolvedMemberMappings: Array.from(memberMappingGroups.values()).some(
      (mapping) => mapping.fallbackApplied,
    ),
    memberMappings: Array.from(memberMappingGroups.values()).sort((a, b) =>
      a.externalName.localeCompare(b.externalName),
    ),
```

- [ ] **Step 5: Load persisted mappings during draft creation**

Add helper functions in `src/lib/imports/drafts.ts`:

```ts
function importedActorName(row: ParsedImportRow) {
  return normalizeImportedMemberName(row.rawMember) ?? normalizeImportedMemberName(row.rawCreatedBy);
}

function importedCreatorName(row: ParsedImportRow) {
  return normalizeImportedMemberName(row.rawCreatedBy);
}

async function loadMemberMappings(
  householdId: string,
  source: ImportSource,
  externalNames: string[],
) {
  const uniqueNames = Array.from(new Set(externalNames));

  if (uniqueNames.length === 0) {
    return new Map<string, string>();
  }

  const mappings = await db.importMemberMapping.findMany({
    where: {
      externalName: { in: uniqueNames },
      householdId,
      source,
    },
    select: {
      externalName: true,
      memberId: true,
    },
  });

  return new Map(mappings.map((mapping) => [mapping.externalName, mapping.memberId]));
}
```

Import `normalizeImportedMemberName` and use the new `resolveImportedMember` signature.

- [ ] **Step 6: Store external names when creating draft rows**

Change `buildParsedRowCreateInput` input from `householdMembers` to `mappingByExternalName` and populate external name fields:

```ts
  const actor = resolveImportedMember(
    importedActorName(input.row),
    input.mappingByExternalName,
    input.currentMemberId,
  );
  const createdBy = resolveImportedMember(
    importedCreatorName(input.row),
    input.mappingByExternalName,
    input.currentMemberId,
  );
```

Add fields to the returned object:

```ts
    actorExternalName: actor.externalName,
    creatorExternalName: createdBy.externalName,
```

In `createImportDraft`, collect external names:

```ts
  const memberExternalNames = parsedWorkbook.rows.flatMap((row) => [
    importedActorName(row),
    importedCreatorName(row),
  ]).filter((name): name is string => Boolean(name));
```

Load them in the existing `Promise.all`:

```ts
    loadMemberMappings(input.sessionUser.householdId, input.source, memberExternalNames),
```

Pass `mappingByExternalName` to `buildParsedRowCreateInput`.

- [ ] **Step 7: Run the integration tests and verify GREEN for draft creation**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: the two new tests pass. Other failures may remain if confirmation now needs the guard from Task 4.

---

### Task 4: Confirmation Blocks Unresolved External Member Mappings

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/drafts.ts`

- [ ] **Step 1: Write failing confirmation guard test**

Add:

```ts
it("rejects confirmation when importable rows still have unresolved external member mappings", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const { expenseCategory } = await getSeededCategories();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook({
      rawCreatedBy: "随手记老婆",
      rawMember: "随手记老婆",
    }),
    fileName: "unresolved-member-confirm.xlsx",
    sessionUser,
  });

  await services.saveImportDraftMappings(
    draft.id,
    [{ categoryId: expenseCategory.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }],
    sessionUser,
  );

  await expect(services.confirmImportDraft(draft.id, sessionUser)).rejects.toThrow(
    "Import draft has unresolved member mappings",
  );
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `confirmImportDraft` currently does not reject unresolved member mappings.

- [ ] **Step 3: Add the server-side guard**

In `confirmImportDraft`, after the `needsMappingCount` guard, add:

```ts
    const unresolvedMemberMappingCount = draft.rows.filter((row) => {
      if (!isImportableRow({ status: row.status, userDecision: row.userDecision })) {
        return false;
      }

      return (
        (row.actorExternalName && row.actorFallbackApplied) ||
        (row.creatorExternalName && row.creatorFallbackApplied)
      );
    }).length;

    if (unresolvedMemberMappingCount > 0) {
      throw new Error("Import draft has unresolved member mappings");
    }
```

- [ ] **Step 4: Run and verify GREEN for confirmation guard**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: confirmation guard test passes.

---

### Task 5: Save Member Mappings Service

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/drafts.ts`

- [ ] **Step 1: Write failing save service tests**

Add:

```ts
it("saves import member mappings and updates matching draft rows", async () => {
  const { sessionUser, wifeMember } = await createHouseholdFixture();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook({
      rawCreatedBy: "随手记老婆",
      rawMember: "随手记老婆",
    }),
    fileName: "save-member-mapping.xlsx",
    sessionUser,
  });

  await services.saveImportDraftMemberMappings(
    draft.id,
    [{ externalName: "随手记老婆", memberId: wifeMember.id }],
    sessionUser,
  );

  const summary = await services.getImportDraftSummary(draft.id, sessionUser);
  const persistedMapping = await db.importMemberMapping.findFirstOrThrow({
    where: {
      externalName: "随手记老婆",
      householdId: sessionUser.householdId,
      source: "sui_shou_ji",
    },
  });

  expect(persistedMapping.memberId).toBe(wifeMember.id);
  expect(summary.hasUnresolvedMemberMappings).toBe(false);
  expect(summary.rows[0]).toMatchObject({
    actorFallbackApplied: false,
    actorMemberId: wifeMember.id,
    createdByMemberId: wifeMember.id,
    creatorFallbackApplied: false,
  });
});

it("rejects import member mappings to members from another household", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const outsideSessionUser = await createOutsideSessionUser();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook({
      rawCreatedBy: "随手记老婆",
      rawMember: "随手记老婆",
    }),
    fileName: "reject-outside-member-mapping.xlsx",
    sessionUser,
  });

  await expect(
    services.saveImportDraftMemberMappings(
      draft.id,
      [{ externalName: "随手记老婆", memberId: outsideSessionUser.memberId }],
      sessionUser,
    ),
  ).rejects.toThrow("Member not found");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `saveImportDraftMemberMappings` is not exported.

- [ ] **Step 3: Implement the service**

Add near the other input types:

```ts
type ImportDraftMemberMappingInput = {
  externalName: string;
  memberId: string;
};
```

Add helper:

```ts
function uniqueMemberMappingInputs(mappings: ImportDraftMemberMappingInput[]) {
  const unique = new Map<string, string>();

  for (const mapping of mappings) {
    const externalName = normalizeImportedMemberName(mapping.externalName);

    if (!externalName || !mapping.memberId) {
      continue;
    }

    unique.set(externalName, mapping.memberId);
  }

  return Array.from(unique.entries()).map(([externalName, memberId]) => ({ externalName, memberId }));
}
```

Export the new service:

```ts
export async function saveImportDraftMemberMappings(
  draftId: string,
  mappings: ImportDraftMemberMappingInput[],
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);
  const normalizedMappings = uniqueMemberMappingInputs(mappings);

  if (normalizedMappings.length === 0) {
    return;
  }

  await db.$transaction(async (tx) => {
    const draft = await tx.importDraft.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: draftId,
      },
      select: {
        id: true,
        source: true,
        status: true,
      },
    });

    if (!draft) {
      throw new Error("Import draft not found");
    }

    if (draft.status !== ImportDraftStatus.PENDING) {
      throw new Error("Import draft is already completed");
    }

    const memberIds = Array.from(new Set(normalizedMappings.map((mapping) => mapping.memberId)));
    const members = await tx.householdMember.findMany({
      where: {
        householdId: sessionUser.householdId,
        id: { in: memberIds },
      },
      select: { id: true },
    });
    const validMemberIds = new Set(members.map((member) => member.id));

    if (memberIds.some((memberId) => !validMemberIds.has(memberId))) {
      throw new Error("Member not found");
    }

    for (const mapping of normalizedMappings) {
      await tx.importMemberMapping.upsert({
        where: {
          household_source_external_name: {
            externalName: mapping.externalName,
            householdId: sessionUser.householdId,
            source: draft.source,
          },
        },
        create: {
          externalName: mapping.externalName,
          householdId: sessionUser.householdId,
          memberId: mapping.memberId,
          source: draft.source,
        },
        update: {
          memberId: mapping.memberId,
        },
      });

      await tx.importDraftRow.updateMany({
        where: {
          actorExternalName: mapping.externalName,
          draftId: draft.id,
          status: {
            notIn: [ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE],
          },
        },
        data: {
          actorFallbackApplied: false,
          actorMemberId: mapping.memberId,
        },
      });

      await tx.importDraftRow.updateMany({
        where: {
          creatorExternalName: mapping.externalName,
          draftId: draft.id,
          status: {
            notIn: [ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE],
          },
        },
        data: {
          createdByMemberId: mapping.memberId,
          creatorFallbackApplied: false,
        },
      });
    }
  });
}
```

- [ ] **Step 4: Run and verify GREEN for service tests**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: save service tests pass.

---

### Task 6: Actions And Server-Rendered Import UI

**Files:**
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Write failing action test**

In `tests/integration/import-page-and-actions.test.ts`, add hoisted mock:

```ts
saveImportDraftMemberMappingsMock: vi.fn(),
```

Mock export:

```ts
saveImportDraftMemberMappings: saveImportDraftMemberMappingsMock,
```

Reset it in `beforeEach`, then add:

```ts
it("saves import member mappings from member mapping entries and redirects back to the draft", async () => {
  const formData = new FormData();
  formData.set("draftId", "draft-1");
  formData.set("memberMapping:随手记老婆", "member-2");

  const { saveImportMemberMappings } = await import("@/app/(app)/records/import/actions");

  await expect(saveImportMemberMappings(formData)).rejects.toThrow(
    "REDIRECT:/records/import?draft=draft-1",
  );
  expect(saveImportDraftMemberMappingsMock).toHaveBeenCalledWith(
    "draft-1",
    [{ externalName: "随手记老婆", memberId: "member-2" }],
    sessionUser,
  );
});
```

- [ ] **Step 2: Write failing page rendering test**

Add:

```ts
it("renders member mapping form and disables confirm while member mappings are unresolved", async () => {
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "老公" },
    { id: "member-2", memberName: "老婆" },
  ]);
  getImportDraftSummaryMock.mockResolvedValue(
    buildPendingDraftSummary({
      counts: {
        importable: 1,
        invalid: 0,
        needsMapping: 0,
        possibleDuplicate: 0,
        ready: 1,
        sourceDuplicate: 0,
        total: 1,
        userSkipped: 0,
      },
      hasUnresolvedMemberMappings: true,
      memberMappings: [
        {
          count: 1,
          externalName: "随手记老婆",
          fallbackApplied: true,
          memberId: "member-1",
        },
      ],
      missingMappings: [],
    }),
  );

  const { default: ImportPage } = await import("@/app/(app)/records/import/page");
  const markup = renderToStaticMarkup(
    await ImportPage({
      searchParams: Promise.resolve({ draft: "draft-1" }),
    }),
  );

  expect(markup).toContain("成员映射");
  expect(markup).toContain("外部账号");
  expect(markup).toContain("随手记老婆");
  expect(markup).toContain("name=\"memberMapping:随手记老婆\"");
  expect(markup).toContain("value=\"member-1\" selected=\"\"");
  expect(markup).toContain("还有成员未映射，暂不能确认导入。");
  expect(markup).toContain("disabled=\"\"");
});
```

Update `buildPendingDraftSummary` defaults to include:

```ts
    hasUnresolvedMemberMappings: false,
    memberMappings: [],
```

- [ ] **Step 3: Run and verify RED**

Run:

```powershell
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: FAIL because action, messages, and page UI do not exist.

- [ ] **Step 4: Add i18n strings**

In `src/lib/i18n.ts`, add Chinese import strings:

```ts
      memberMappingTitle: "成员映射",
      memberMappingDescription:
        "把外部账单里的用户名对应到 BillBoard 成员，保存后同一来源下次会自动复用。",
      externalAccount: "外部账号",
      saveMemberMappings: "保存成员映射",
      confirmDisabledByMemberMappings: "还有成员未映射，暂不能确认导入。",
```

Add English equivalents:

```ts
      memberMappingTitle: "Member mappings",
      memberMappingDescription:
        "Map external bill names to BillBoard members. Saved mappings are reused next time for the same source.",
      externalAccount: "External account",
      saveMemberMappings: "Save member mappings",
      confirmDisabledByMemberMappings: "Resolve member mappings before confirming the import.",
```

- [ ] **Step 5: Add server action**

In `src/app/(app)/records/import/actions.ts`, import `saveImportDraftMemberMappings` and add:

```ts
export async function saveImportMemberMappings(formData: FormData) {
  const draftId = readDraftId(formData);
  const sessionUser = await requireAppSession();
  const mappings = Array.from(formData.entries()).flatMap(([key, value]) => {
    if (!key.startsWith("memberMapping:") || typeof value !== "string" || !value) {
      return [];
    }

    return [
      {
        externalName: key.slice("memberMapping:".length),
        memberId: value,
      },
    ];
  });

  if (mappings.length > 0) {
    await saveImportDraftMemberMappings(draftId, mappings, sessionUser);
  }

  redirectToDraft(draftId);
}
```

- [ ] **Step 6: Render member mapping form**

In `src/app/(app)/records/import/page.tsx`, import `saveImportMemberMappings` and calculate:

```ts
  const shouldShowMemberMappingForm =
    summary?.status === ImportDraftStatus.PENDING && summary.memberMappings.length > 0;
  const shouldShowPaymentOwnerForm =
    summary?.status === ImportDraftStatus.PENDING &&
    summary.memberMappings.length === 0 &&
    (summary.source === WECHAT_PAY_SOURCE || summary.source === ALIPAY_SOURCE);
```

Render before category mapping:

```tsx
          {shouldShowMemberMappingForm ? (
            <form action={saveImportMemberMappings} className="ios-panel space-y-4 p-5">
              <input name="draftId" type="hidden" value={summary.id} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.memberMappingTitle}</h2>
                <p className="text-sm text-stone-500">{messages.import.memberMappingDescription}</p>
              </div>
              <div className="space-y-3">
                {summary.memberMappings.map((mapping) => (
                  <label
                    className="block space-y-2 rounded-2xl border border-stone-100 bg-stone-50 p-3"
                    key={mapping.externalName}
                  >
                    <span className="block text-xs text-stone-500">
                      {messages.import.externalAccount}
                    </span>
                    <span className="block text-sm font-medium text-stone-800">
                      {mapping.externalName}
                    </span>
                    <select
                      className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"
                      defaultValue={mapping.memberId}
                      name={`memberMapping:${mapping.externalName}`}
                      required
                    >
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.memberName}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <button
                className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
                type="submit"
              >
                {messages.import.saveMemberMappings}
              </button>
            </form>
          ) : null}
```

Load `members` when either member mapping form or payment owner form is needed:

```ts
  const needsMemberOptions =
    summary?.status === ImportDraftStatus.PENDING &&
    (summary.memberMappings.length > 0 ||
      summary.source === WECHAT_PAY_SOURCE ||
      summary.source === ALIPAY_SOURCE);
```

Disable confirmation when either category mappings or member mappings are unresolved:

```tsx
            {summary.hasUnresolvedMemberMappings ? (
              <p className="text-sm text-stone-500">
                {messages.import.confirmDisabledByMemberMappings}
              </p>
            ) : null}
            <button
              disabled={summary.counts.needsMapping > 0 || summary.hasUnresolvedMemberMappings}
```

- [ ] **Step 7: Run and verify GREEN for action/page tests**

Run:

```powershell
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: new action and page tests pass.

---

### Task 7: Keep Payment Owner Fallback For Ownerless Payment Files

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `src/lib/imports/drafts.ts`
- Modify: `src/app/(app)/records/import/page.tsx`

- [ ] **Step 1: Write tests for ownerless payment behavior**

In `tests/integration/import-drafts.test.ts`, add:

```ts
it("keeps ownerless payment drafts editable through the one-time owner member action", async () => {
  const { sessionUser, wifeMember } = await createHouseholdFixture();
  const draft = await services.createAlipayImportDraft({
    buffer: buildAlipayCsv("", "alipay-ownerless-order"),
    fileName: "alipay-ownerless.csv",
    sessionUser,
  });

  const before = await services.getImportDraftSummary(draft.id, sessionUser);

  expect(before.memberMappings).toEqual([]);
  expect(before.hasUnresolvedMemberMappings).toBe(false);

  await services.savePaymentImportDraftOwnerMember(draft.id, wifeMember.id, sessionUser);
  const after = await services.getImportDraftSummary(draft.id, sessionUser);

  expect(after.rows[0]).toMatchObject({
    actorMemberId: wifeMember.id,
    createdByMemberId: wifeMember.id,
  });
});
```

In `tests/integration/import-page-and-actions.test.ts`, ensure the existing payment owner selector tests set:

```ts
hasUnresolvedMemberMappings: false,
memberMappings: [],
```

Add a page test that a payment draft with `memberMappings` renders member mapping form and not `ownerMemberId`.

- [ ] **Step 2: Run and verify RED or regression**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts tests/integration/import-page-and-actions.test.ts
```

Expected: FAIL if ownerless payment drafts are blocked by unresolved mapping logic or if both forms render at once.

- [ ] **Step 3: Adjust behavior**

Ensure payment rows with empty owner names have:

```ts
actorExternalName: null
creatorExternalName: null
actorFallbackApplied: false
creatorFallbackApplied: false
```

Keep `savePaymentImportDraftOwnerMember` unchanged except that it does not write persistent mappings. In page logic, show payment owner form only when `summary.memberMappings.length === 0`.

- [ ] **Step 4: Run and verify GREEN**

Run:

```powershell
npm run test:integration -- tests/integration/import-drafts.test.ts tests/integration/import-page-and-actions.test.ts
```

Expected: payment owner fallback tests pass.

---

### Task 8: E2E Cleanup And User Flows

**Files:**
- Modify: `tests/e2e/db-cleanup.ts`
- Modify: `tests/unit/e2e-cleanup-config.test.ts`
- Modify: `tests/e2e/import-sui-shou-ji.spec.ts`
- Modify: `tests/e2e/import-wechat-pay.spec.ts`
- Modify: `tests/e2e/import-alipay.spec.ts`

- [ ] **Step 1: Write failing cleanup test**

In `tests/unit/e2e-cleanup-config.test.ts`, add an assertion that the cleanup source contains:

```ts
expect(cleanupSource).toContain("prisma.importMemberMapping.deleteMany({})");
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npm run test:unit -- tests/unit/e2e-cleanup-config.test.ts
```

Expected: FAIL because cleanup does not delete import member mappings.

- [ ] **Step 3: Add cleanup**

In `tests/e2e/db-cleanup.ts`, delete member mappings after drafts and before transactions:

```ts
      prisma.importDraftRow.deleteMany({}),
      prisma.importDraft.deleteMany({}),
      prisma.importCategoryMapping.deleteMany({}),
      prisma.importMemberMapping.deleteMany({}),
      prisma.transaction.deleteMany({}),
```

- [ ] **Step 4: Update Sui Shou Ji e2e flow**

After upload in `tests/e2e/import-sui-shou-ji.spec.ts`, add:

```ts
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await expect(memberMappingForm).toBeVisible();
  const wifeMapping = memberMappingForm.locator("label", { hasText: "老婆" });
  await expect(wifeMapping).toBeVisible();
  await wifeMapping.getByRole("combobox").selectOption({ label: "老婆" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();
```

Then continue with category mapping.

- [ ] **Step 5: Update payment e2e flows**

In `tests/e2e/import-wechat-pay.spec.ts`, replace the owner form section with member mapping form:

```ts
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await expect(memberMappingForm).toBeVisible();
  const ownerMapping = memberMappingForm.locator("label", { hasText: "老婆" });
  await expect(ownerMapping).toBeVisible();
  await expect(ownerMapping.getByRole("combobox").locator("option:checked")).toHaveText("老公");
  await ownerMapping.getByRole("combobox").selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();
```

Use the same pattern in `tests/e2e/import-alipay.spec.ts`, matching the owner name used by that fixture.

- [ ] **Step 6: Run targeted e2e-related tests**

Run:

```powershell
npm run test:unit -- tests/unit/e2e-cleanup-config.test.ts
npm run test:e2e -- tests/e2e/import-sui-shou-ji.spec.ts tests/e2e/import-wechat-pay.spec.ts tests/e2e/import-alipay.spec.ts
```

Expected: unit cleanup test passes; import e2e tests pass against the dev/test database.

---

### Task 9: Focused Regression And Final Verification

**Files:**
- Review all modified files.
- Modify: `package.json` and `package-lock.json` only if committing.

- [ ] **Step 1: Run focused import checks**

Run:

```powershell
npm run test:unit -- tests/unit/import-schema.test.ts tests/unit/sui-shou-ji-import.test.ts tests/unit/e2e-cleanup-config.test.ts
npm run test:integration -- tests/integration/import-drafts.test.ts tests/integration/import-page-and-actions.test.ts
```

Expected: all targeted unit and integration tests pass.

- [ ] **Step 2: Run lint**

Run:

```powershell
npm run lint
```

Expected: exit code 0, no warnings.

- [ ] **Step 3: Run full verification before acceptance**

Run:

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all tests pass. If any test fails, fix the issue with a new failing test first when the failure reveals missing behavior.

- [ ] **Step 4: Run security review checks**

Run:

```powershell
git status --short
git diff --stat
rg -n "AUTH_SECRET|NEXTAUTH_SECRET|POSTGRES_PASSWORD|DATABASE_URL|NEXT_ALLOWED_DEV_ORIGINS|APP_DOMAIN|frp|ECS|password|secret|token" .
rg -n "deletedAt|householdId|memberId|sourceFingerprint|amountFen|Asia/Shanghai" src tests prisma
```

Expected: no real credentials, hostnames, public IPs, or private service URLs in tracked changes. Import and permission-sensitive code uses `householdId` and current session data.

- [ ] **Step 5: Prepare version bump only if a commit is requested**

If the user asks to commit after full verification passes, update `package.json`:

```json
"version": "1.2.0"
```

Update root `package-lock.json` root package versions from `1.1.1` to `1.2.0`.

Commit message draft:

```text
v1.2.0 添加导入成员映射

新增外部账号到家庭成员的导入映射保存与复用，确认导入前阻止未完成成员映射，并补充导入流程测试。
```

Before committing, run:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all four commands pass.

---

## Self-Review

- Spec coverage: the plan covers the new persisted table, source-scoped lookup, draft row external names, unresolved mapping guard, save action, preview UI, i18n, e2e cleanup, and full verification.
- Placeholder scan: the plan contains no open placeholders or undefined future work.
- Type consistency: the plan consistently uses `ImportMemberMapping`, `actorExternalName`, `creatorExternalName`, `memberMappings`, `hasUnresolvedMemberMappings`, `saveImportDraftMemberMappings`, and `saveImportMemberMappings`.
- Scope check: the plan avoids member management pages, category mapping changes, amount/date logic changes, and broad import framework refactors.
