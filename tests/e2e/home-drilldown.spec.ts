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

test("home expense drill-down preserves shared filters", async ({ page }) => {
  const note = `E2E home drilldown ${Date.now()}`;

  await logIn(page);
  await page.goto("/add");

  await page.getByLabel("Amount").fill("45.67");
  await page.getByRole("button", { name: "Groceries" }).click();
  await page.getByLabel("Who").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page).toHaveURL(/\/add\?/);
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("created")).toBe("1");
  expect(addUrl.searchParams.get("type")).toBe("expense");

  await page.goto("/home?perspective=spouse&range=last-30-days");
  await page.getByRole("link", { name: /Review expense records for this view/ }).click();

  await expect(page).toHaveURL(/\/records\?/);
  await expect(page.getByText(note)).toBeVisible();

  const recordsUrl = new URL(page.url());
  expect(recordsUrl.pathname).toBe("/records");
  expect(recordsUrl.searchParams.get("perspective")).toBe("spouse");
  expect(recordsUrl.searchParams.get("range")).toBe("last-30-days");
  expect(recordsUrl.searchParams.get("type")).toBe("expense");
});
