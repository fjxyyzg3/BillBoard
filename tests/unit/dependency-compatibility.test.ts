import { createRequire } from "node:module";
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import ExcelJS from "exceljs";
import { defineConfig } from "prisma/config";
import { describe, expect, it } from "vitest";

const requireFromExcel = createRequire(import.meta.resolve("exceljs"));
const requireFromPrismaConfig = createRequire(import.meta.resolve("@prisma/config"));

type NamespaceUuid = {
  (name: string, namespace: string, buffer?: Uint8Array, offset?: number): string | Uint8Array;
  DNS: string;
};

const uuid = requireFromExcel("uuid") as {
  v3: NamespaceUuid;
  v4(): string;
  v5: NamespaceUuid;
  stringify(buffer: Uint8Array): string;
};
const { deepmerge } = requireFromPrismaConfig("deepmerge-ts") as {
  deepmerge(...values: unknown[]): unknown;
};

describe("dependency compatibility", () => {
  it("keeps the CommonJS UUID API used by ExcelJS", () => {
    expect(uuid.v4()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  it.each(["v3", "v5"] as const)("rejects undersized %s buffers without changing valid results", (kind) => {
    const generate = uuid[kind];
    const buffer = new Uint8Array(16);
    expect(generate("dependency-fixture", generate.DNS, buffer)).toBe(buffer);
    expect(uuid.stringify(buffer)).toBe(generate("dependency-fixture", generate.DNS));
    for (const [size, offset] of [[15, 0], [32, 17]]) {
      const invalid = new Uint8Array(size);
      expect(() => generate("dependency-fixture", generate.DNS, invalid, offset)).toThrow(RangeError);
      expect([...invalid]).toEqual(Array(size).fill(0));
    }
  });

  it("round-trips literal financial cells and ExcelJS conditional-format UUIDs", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("兼容检查");
    sheet.addRows([["Note", "AmountFen"], ["=1+1", 101], ["中文", 201], ["Income", 301]]);
    sheet.addConditionalFormatting({
      ref: "B2:B4",
      rules: [{
        type: "iconSet", iconSet: "3Stars", priority: 1,
        cfvo: [{ type: "num", value: 0 }, { type: "num", value: 100 }, { type: "num", value: 200 }],
      }],
    });
    const parsed = new ExcelJS.Workbook();
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    await parsed.xlsx.load(bytes);
    const result = parsed.worksheets[0];
    expect(result.getCell("A2").value).toBe("=1+1");
    expect(result.getCell("A2").type).toBe(ExcelJS.ValueType.String);
    expect(result.getCell("A3").value).toBe("中文");
    expect([2, 3, 4].map((index) => result.getRow(index).getCell(2).value)).toEqual([101, 201, 301]);
    const archive = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    try {
      const entry = (await archive.getEntries()).find((item) => item.filename === "xl/worksheets/sheet1.xml");
      if (!entry || entry.directory) throw new Error("The conditional-format worksheet XML is missing");
      const xml = await entry.getData!(new TextWriter());
      expect(xml).toContain('iconSet="3Stars"');
    } finally { await archive.close(); }
  });

  it("preserves nested configuration merging through Prisma's CommonJS dependency", () => {
    expect(deepmerge(
      { schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, tables: { external: ["first"] } },
      { migrations: { seed: "node prisma/seed.ts" }, tables: { external: ["second"] } },
    )).toEqual({
      schema: "prisma/schema.prisma",
      migrations: { path: "prisma/migrations", seed: "node prisma/seed.ts" },
      tables: { external: ["first", "second"] },
    });
    const configuration = defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" } });
    expect(configuration.schema).toBe("prisma/schema.prisma");
    expect(configuration.migrations).toEqual({ path: "prisma/migrations" });
  });

  it("merges circular configuration objects without overflowing or mutating their inputs", () => {
    const left: { value: string; self?: unknown } = { value: "left" };
    const right: { value: string; self?: unknown } = { value: "right" };
    left.self = left;
    right.self = right;
    const result = deepmerge(left, right) as { value: string; self: unknown };
    expect(result).not.toBe(left);
    expect(result).not.toBe(right);
    expect(result.value).toBe("right");
    expect(result.self).toBe(result);
    expect(left.self).toBe(left);
    expect(right.self).toBe(right);
  });
});
