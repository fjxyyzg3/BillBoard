import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { expect, it } from "vitest";
import nextConfig from "../../next.config";

const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
const glob = requireFromProject("next/dist/compiled/glob") as {
  sync: (pattern: string, options: { cwd: string; nodir: boolean; dot: boolean }) => string[];
};

it("reads an XLSX with only the standalone import tracing files available", async () => {
  const configExport = nextConfig as NextConfig | ((phase: string) => Promise<NextConfig>);
  const config = typeof configExport === "function"
    ? await configExport(PHASE_PRODUCTION_BUILD)
    : configExport;
  const includePatterns = config.outputFileTracingIncludes?.["/records/import"] ?? [];
  const files = new Set(includePatterns.flatMap((pattern) => glob.sync(pattern, {
    cwd: process.cwd(), nodir: true, dot: true,
  })));
  const tempPrefix = path.join(tmpdir(), "billboard-xlsx-standalone-");
  const isolatedRoot = await mkdtemp(tempPrefix);

  try {
    for (const file of files) {
      const destination = path.join(isolatedRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.resolve(file), destination);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Synthetic").addRow(["fixture", 42]);
    const input = Buffer.from(await workbook.xlsx.writeBuffer());
    const child = spawnSync(process.execPath, ["src/lib/imports/xlsx-reader.mjs"], {
      cwd: isolatedRoot,
      input,
      timeout: 20_000,
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      worksheets: [{ name: "Synthetic", rows: [{ values: ["fixture", 42] }] }],
    });
  } finally {
    if (!path.resolve(isolatedRoot).startsWith(path.resolve(tempPrefix))) {
      throw new Error("The isolated XLSX test directory escaped its temporary prefix");
    }
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}, 30_000);
