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

async function createLargeIncome(page: Page) {
  const note = `E2E layout amount ${Date.now()}`;

  await page.goto("/add");
  await page.getByLabel("Income").check({ force: true });
  await page.getByLabel("Amount").fill("21474836.47");
  await page.getByRole("button", { name: "Salary" }).click();
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("Transaction saved")).toBeVisible();
}

test("home summary cards keep a stable mobile grid without amount overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  await createLargeIncome(page);
  await page.goto("/home?range=last-30-days");

  const summaryGrid = page.getByTestId("summary-grid");
  await expect(summaryGrid).toBeVisible();

  const columnCount = await summaryGrid.evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length;
  });

  expect(columnCount).toBe(2);

  const summaryCards = page.getByTestId("summary-card");
  await expect(summaryCards).toHaveCount(4);

  const overflowCount = await summaryCards.evaluateAll((cards) => {
    return cards.filter((card) => card.scrollWidth > card.clientWidth).length;
  });

  expect(overflowCount).toBe(0);
});

test("desktop navigation keeps accessible labels after icons are added", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await logIn(page);

  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Records", exact: true })).toBeVisible();
});
