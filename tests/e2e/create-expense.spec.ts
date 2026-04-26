import { expect, test, type Page } from "@playwright/test";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("Password").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("users can create an expense and confirm what was saved", async ({ page }) => {
  const note = `E2E expense ${Date.now()}`;

  await logIn(page);
  await page.goto("/add?perspective=spouse&range=last-30-days");

  await page.getByLabel("Amount").fill("12.34");
  await page.getByRole("button", { name: "Groceries" }).click();
  await page.getByLabel("Who").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save transaction" }).click();

  await expect(page.getByText("Transaction saved")).toBeVisible();
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("created")).toBe("1");
  expect(addUrl.searchParams.get("perspective")).toBe("spouse");
  expect(addUrl.searchParams.get("range")).toBe("last-30-days");
  expect(addUrl.searchParams.get("type")).toBe("expense");
  await expect(page.getByText("Expense: 12.34")).toBeVisible();
  await expect(page.getByRole("link", { name: "Add another" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return home" })).toBeVisible();

  await page.getByRole("link", { name: "Records" }).click();
  await expect(page).toHaveURL(/\/records/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);
  const createdRecord = page.getByRole("link", { name: new RegExp(note) });
  await expect(createdRecord).toBeVisible();
  await expect(createdRecord).toContainText("-12.34");
});
