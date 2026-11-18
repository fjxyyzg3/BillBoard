import { expect, test, type Locator, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function expectAmountError(amount: Locator, message: string) {
  await expect(amount).toBeFocused();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect.poll(() => amount.evaluate((input) => {
    const ids = input.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  })).toContain(message);
}

test("manual and edited amounts associate validation errors with the focused field", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await page.goto("/add");
  const amount = page.getByLabel("金额", { exact: true });
  const manualForm = page.locator("form").filter({ has: amount });

  for (const [value, message] of [["0", "金额必须大于 0"], ["12+", "请输入有效金额"], ["1/0", "请输入有效金额"]]) {
    await amount.fill(value);
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expectAmountError(amount, message);
    await expect(manualForm.getByRole("alert")).toHaveText(message);
  }

  const note = `Amount field feedback ${Date.now()}`;
  await amount.fill("12+3");
  await expect(amount).not.toHaveAttribute("aria-invalid", "true");
  await expect(manualForm.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill(note);
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  await page.goto("/records?mode=all");
  await page.getByRole("link").filter({ hasText: note }).click();

  const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
  const editedAmount = editor.getByLabel("金额", { exact: true });
  await editedAmount.fill("0");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expectAmountError(editedAmount, "金额必须大于 0");
  await expect(editor.getByRole("alert")).toHaveText("金额必须大于 0");
  await editedAmount.fill("10/3");
  await expect(editedAmount).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByRole("alert")).toHaveCount(0);
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("link").filter({ hasText: note })).toContainText("-3.33");
});
