import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const artDirectory = join(process.cwd(), "src", "assets", "art");
const homeAssets = [
  "home-title.webp",
  "summary-income.webp",
  "summary-expense.webp",
  "summary-net.webp",
  "summary-records.webp",
] as const;

function readWebpAsset(fileName: string) {
  const path = join(artDirectory, fileName);
  const contents = readFileSync(path);

  expect(contents.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(contents.subarray(8, 12).toString("ascii")).toBe("WEBP");

  return statSync(path).size;
}

describe("weak-network decorative assets", () => {
  it("keeps the home artwork within the shared transfer budget", () => {
    const totalBytes = homeAssets.reduce((sum, fileName) => sum + readWebpAsset(fileName), 0);

    expect(totalBytes).toBeLessThanOrEqual(250 * 1024);
  });

  it("keeps the add-page artwork within its transfer budget", () => {
    expect(readWebpAsset("add-title.webp")).toBeLessThanOrEqual(50 * 1024);
  });
});
