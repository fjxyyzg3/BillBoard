import { CategoryType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";

describe("seed categories", () => {
  it("includes childcare and parent care as ordered expense categories", async () => {
    const categories = await db.category.findMany({
      where: {
        isActive: true,
        name: { in: ["Medical", "Childcare", "Parent Care", "Entertainment"] },
        type: CategoryType.EXPENSE,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true },
    });

    expect(categories.map((category) => category.name)).toEqual([
      "Medical",
      "Childcare",
      "Parent Care",
      "Entertainment",
    ]);
  });
});
