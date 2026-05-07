import { CategoryType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";

describe("seed categories", () => {
  it("keeps the active default expense categories in the expected order", async () => {
    const categories = await db.category.findMany({
      where: {
        isActive: true,
        type: CategoryType.EXPENSE,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true },
    });

    expect(categories.map((category) => category.name)).toEqual([
      "Dining",
      "Transport",
      "Shopping",
      "Home",
      "Medical",
      "Childcare",
      "Parent Care",
      "Entertainment",
      "Social",
      "Travel",
      "Study",
      "Other",
    ]);
  });
});
