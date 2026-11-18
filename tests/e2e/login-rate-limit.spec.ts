import { PrismaClient } from "@prisma/client";
import { expect, test } from "./fixtures";
import { resetLoginBudget } from "./db-cleanup";

test("global login exhaustion shows retry guidance while an existing session still works", async ({ page, browser, baseURL }) => {
  const email = process.env.SEED_USER_A_EMAIL!;
  const password = process.env.SEED_USER_A_PASSWORD!;
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const guestContext = await browser.newContext({ baseURL });
  try {
    const guest = await guestContext.newPage();
    await guest.goto("/login");
    await guest.getByLabel("邮箱").fill(email);
    await guest.getByLabel("密码").fill(password);
    await resetLoginBudget(0);
    await guest.getByRole("button", { name: "登录" }).click();
    await expect(guest.getByText("登录尝试过于频繁，请稍后重试。", { exact: true })).toBeVisible();
    await expect(guest).toHaveURL(/\/login$/);
    await page.goto("/add");
    await expect(page).toHaveURL(/\/add(?:\?|$)/);

    // Admission uses the database clock, which can move independently of the test host.
    const database = new PrismaClient();
    try {
      await expect.poll(async () => {
        const [budget] = await database.$queryRaw<Array<{ elapsedMs: number }>>`
          SELECT EXTRACT(EPOCH FROM (clock_timestamp() - "refilled_at"))::float8 * 1000 AS "elapsedMs"
          FROM "LoginBudget" WHERE "id" = 1
        `;
        return budget.elapsedMs;
      }, { timeout: 10_000 }).toBeGreaterThanOrEqual(3_100);
    } finally {
      await database.$disconnect();
    }
    await guest.getByRole("button", { name: "登录" }).click();
    await expect(guest).toHaveURL(/\/home$/);
  } finally {
    await guestContext.close();
  }
});
