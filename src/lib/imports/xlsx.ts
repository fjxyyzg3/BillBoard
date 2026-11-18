import { spawn } from "node:child_process";
import path from "node:path";

import { IMPORT_FILE_TOO_LARGE_MESSAGE, MAX_IMPORT_FILE_BYTES } from "./limits";

export const XLSX_RESOURCE_LIMIT = "xlsx-resource-limit";
export const XLSX_TIMEOUT = "xlsx-timeout";
export const XLSX_BUSY = "xlsx-busy";
export const XLSX_UNREADABLE = "unreadable-xlsx-file";
const maxResultBytes = 32 * 1024 * 1024;
const parseTimeoutMs = 30_000;
const maxConcurrentParsers = 2;

export type XlsxRow = { number: number; values: unknown[]; texts: string[] };
export type XlsxSheet = { name: string; rows: XlsxRow[] };
export type XlsxWorkbook = { worksheets: XlsxSheet[] };

// Share the admission count across Next.js route modules and development reloads.
const state = globalThis as typeof globalThis & { billboardXlsxJobs?: number };

export async function loadXlsxWorkbook(buffer: Buffer, signal?: AbortSignal): Promise<XlsxWorkbook> {
  if (buffer.length > MAX_IMPORT_FILE_BYTES) throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
  if (signal?.aborted) throw new Error(XLSX_TIMEOUT);
  if ((state.billboardXlsxJobs ?? 0) >= maxConcurrentParsers) throw new Error(XLSX_BUSY);
  state.billboardXlsxJobs = (state.billboardXlsxJobs ?? 0) + 1;

  const output = await new Promise<Buffer>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [
        "--max-old-space-size=256",
        path.join(process.cwd(), "src/lib/imports/xlsx-reader.mjs"),
      ], {
        env: { NODE_ENV: "production", TZ: "Asia/Shanghai", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      state.billboardXlsxJobs! -= 1;
      reject(new Error(XLSX_UNREADABLE));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(XLSX_TIMEOUT), parseTimeoutMs);
    const abort = () => stop(XLSX_TIMEOUT);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", () => { failure ??= XLSX_UNREADABLE; });
    child.stdin!.on("error", () => stop(XLSX_UNREADABLE));
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxResultBytes) stop(XLSX_RESOURCE_LIMIT);
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // A timeout must kill the work, not just abandon its promise or free a slot.
      state.billboardXlsxJobs! -= 1;
      if (failure || code !== 0) reject(new Error(failure ?? XLSX_RESOURCE_LIMIT));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin!.end(buffer);
  });

  let result: XlsxWorkbook & { error?: string };
  try {
    result = JSON.parse(output.toString("utf8"), (_key, value) =>
      value && typeof value === "object" && typeof value.date === "string" ? new Date(value.date) : value,
    );
  } catch {
    throw new Error(XLSX_UNREADABLE);
  }
  if (result.error) throw new Error(result.error === XLSX_RESOURCE_LIMIT ? XLSX_RESOURCE_LIMIT : XLSX_UNREADABLE);
  return result;
}
