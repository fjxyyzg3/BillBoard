import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hash } from "argon2";
import ExcelJS from "exceljs";
import { expect, test } from "./fixtures";
import { workbookAtUploadBoundary } from "../fixtures/import-capacity";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, sealKeyRing } from "../../src/lib/encryption/crypto";
import { decryptRow, encryptRow } from "../../src/lib/encryption/protected-models";
import { createSourceFingerprint } from "../../src/lib/imports/fingerprint";

test("uploads a near-20 MiB encrypted statement through the real multipart action without exposing the key outside its body", async ({ page }) => {
  test.setTimeout(120_000);
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Upload capacity fixtures require a local development/test database");
  const prisma = new PrismaClient();
  let householdId: string | undefined, userId: string | undefined;
  try {
    const password = "synthetic-upload-capacity-password";
    const user = await prisma.user.create({ data: { email: `upload-boundary-${randomUUID()}@example.test`, displayName: "Boundary owner", passwordHash: await hash(password) } }); userId = user.id;
    const household = await prisma.household.create({ data: { name: "Synthetic encrypted upload", members: { create: { userId: user.id, memberName: "Boundary owner", role: "OWNER" } }, ledgers: { create: { name: "Boundary ledger", isDefault: true, acceptsLegacyDrafts: true } } }, include: { ledgers: true } }); householdId = household.id;
    const ledger = household.ledgers[0], code = createHouseholdCode(household.id), ring = createKeyRing(code), encoded = encodeHouseholdCode(code);
    const protectedLedger = await encryptRow("ledger", ledger, ring, household.id, "");
    await prisma.ledger.update({ where: { id: ledger.id }, data: { name: String(protectedLedger.name), encryptedPayload: String(protectedLedger.encryptedPayload), encryptionRevision: String(protectedLedger.encryptionRevision) } });
    await prisma.householdEncryption.create({ data: { householdId: household.id, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: await sealKeyRing(code, ring) } });

    const note = `Boundary private statement ${randomUUID()}`;
    const primaryCategory = `Private category ${randomUUID()}`;
    const sourceFingerprint = createSourceFingerprint({ amountText: "12.34", createdByName: "Boundary owner", memberName: "Boundary owner", note, occurredAtText: "2026-04-03 12:00:00", primaryCategory, rawAccount: "现金", rawCurrency: "CNY", rawMerchant: "Synthetic", secondaryCategory: "Boundary", source: "sui_shou_ji", transactionType: "EXPENSE" });
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("支出").addRows([
      ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户2", "账户币种", "金额", "成员", "商家", "项目分类", "项目", "记账人", "备注"],
      ["支出", "2026-04-03 12:00:00", primaryCategory, "Boundary", "现金", "", "CNY", "12.34", "Boundary owner", "Synthetic", "", "", "Boundary owner", note],
    ]);
    const bytes = await workbookAtUploadBoundary(new Uint8Array(await workbook.xlsx.writeBuffer()));
    expect(bytes.length).toBeGreaterThan(20 * 1024 * 1024 - 128 * 1024);

    await page.goto("/login");
    await page.getByLabel("邮箱", { exact: true }).fill(user.email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.getByLabel("家庭解锁码", { exact: true }).fill(encoded);
    await page.getByRole("button", { name: "导入并解锁", exact: true }).click();
    await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();
    await page.goto("/records/import");
    await expect(page.getByRole("combobox", { name: "记入账本", exact: true })).toHaveValue(ledger.id);
    await page.getByLabel("随手记", { exact: true }).check();
    await page.getByLabel("文件", { exact: true }).setInputFiles({ name: "boundary-statement.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bytes });
    const admitted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/records/import" && Boolean(request.headers()["next-action"]));
    await page.getByRole("button", { name: "上传并解析", exact: true }).click();
    const request = await admitted;
    expect(Number(await request.headerValue("content-length"))).toBeGreaterThan(bytes.length);
    const observedBody = request.postDataBuffer();
    if (observedBody) expect(observedBody.includes(Buffer.from(encoded))).toBe(true);
    expect(request.url()).not.toContain(encoded);
    expect(JSON.stringify(request.headers())).not.toContain(encoded);
    await expect(page).toHaveURL(/\/records\/import\?draft=/, { timeout: 60_000 });
    const draftId = new URL(page.url()).searchParams.get("draft")!;
    const stored = await prisma.importDraft.findUniqueOrThrow({ where: { id: draftId }, include: { rows: true } });
    expect(stored).toMatchObject({ householdId: household.id, ledgerId: ledger.id, source: "encrypted", fileName: "encrypted", encryptedPayload: expect.stringMatching(/^BBE1\./) });
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(note);
    expect(JSON.stringify(stored)).not.toContain(primaryCategory);
    expect(JSON.stringify(stored)).not.toContain(sourceFingerprint);
    expect(stored.rows[0]).toMatchObject({ amountFen: null, note: null, sourceFingerprint: null, encryptedPayload: expect.stringMatching(/^BBE1\./) });
    // The existing SSJ parser uses the original note only in the source fingerprint.
    expect(await decryptRow("importDraftRow", stored.rows[0], ring, household.id, ledger.id)).toMatchObject({ amountFen: 1234, note: null, primaryCategory, secondaryCategory: "Boundary", sourceFingerprint });
    expect(await prisma.resourceLease.count({ where: { householdId: household.id } })).toBe(0);
  } finally {
    if (householdId) await prisma.appEvent.deleteMany({ where: { householdId } });
    if (householdId) await prisma.household.deleteMany({ where: { id: householdId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
