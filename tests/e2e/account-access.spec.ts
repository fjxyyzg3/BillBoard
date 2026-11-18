import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "./fixtures";

test("a signed-in account without an active household sees a restricted state and can sign out", async ({ page }) => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Account-access fixtures require a local development/test database");
  }
  const database = new PrismaClient();
  const email = `account-access-${randomUUID()}@example.com`;
  const password = `Fixture-${randomUUID()}`;
  const user = await database.user.create({ data: { email, displayName: "Account access fixture", passwordHash: await hash(password) } });
  try {
    await page.goto("/login");
    await page.getByLabel("邮箱").fill(email);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "当前没有可访问的家庭", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(await page.evaluate(async () => (await fetch(`/api/voice/entry?${new URLSearchParams({ requestId: crypto.randomUUID(), resultVersion: "2" })}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })).status)).toBe(401);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await database.appSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  } finally {
    await database.user.delete({ where: { id: user.id } });
    await database.$disconnect();
  }
});
