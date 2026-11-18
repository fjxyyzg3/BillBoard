import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/add");
}

test("quick entry offers direct member choices and restores a collapsed note", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  await expect(page.getByRole("textbox", { name: "备注", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("时间")).toHaveAttribute("type", "datetime-local");
  await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
  await page.getByLabel("金额").fill("23.45");
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill("Keep my draft note");
  await page.getByRole("button", { name: "收起备注", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "备注", exact: true })).toHaveCount(0);

  await page.reload();

  await expect(page.getByLabel("金额")).toHaveValue("23.45");
  await expect(page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true })).toBeChecked();
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue("Keep my draft note");
  await expect(page.getByRole("button", { name: "收起备注", exact: true })).toHaveAttribute("aria-expanded", "true");
});

test("mobile save remains reachable above navigation while categories expand", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();

  const saveButton = page.getByRole("button", { name: "保存记录", exact: true });
  const navigation = page.locator("nav").filter({ has: page.getByRole("link", { name: "记一笔", exact: true }) }).last();

  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(saveButton).toBeInViewport();

    const saveBox = await saveButton.boundingBox();
    const navigationBox = await navigation.boundingBox();

    expect(saveBox).not.toBeNull();
    expect(navigationBox).not.toBeNull();
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(navigationBox!.y);
    expect(navigationBox!.y - (saveBox!.y + saveBox!.height)).toBeLessThanOrEqual(24);
  }
});
