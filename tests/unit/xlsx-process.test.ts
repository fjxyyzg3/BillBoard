import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { loadXlsxWorkbook } from "@/lib/imports/xlsx";

function processDouble() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  spawn.mockReset();
});

describe("isolated XLSX parsing", () => {
  it("kills cancelled work but retains its slot until the child actually closes", async () => {
    const controller = new AbortController();
    const child = processDouble();
    spawn.mockReturnValueOnce(child);
    const result = loadXlsxWorkbook(Buffer.from("file"), controller.signal).catch((error: Error) => error.message);
    try {
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      let settled = false;
      void result.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      child.emit("close", null);
      await result;
    }
    expect(await result).toBe("xlsx-timeout");
  });

  it("does not spawn a parser for an already cancelled admission", async () => {
    const controller = new AbortController();
    controller.abort();
    spawn.mockImplementationOnce(() => { throw new Error("Unexpected parser spawn"); });
    await expect(loadXlsxWorkbook(Buffer.from("file"), controller.signal)).rejects.toThrow("xlsx-timeout");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills overdue work and retains both slots until the processes actually close", async () => {
    vi.useFakeTimers();
    const children = [processDouble(), processDouble()];
    children.forEach((child) => spawn.mockReturnValueOnce(child));
    const first = loadXlsxWorkbook(Buffer.from("file")).catch((error: Error) => error.message);
    const second = loadXlsxWorkbook(Buffer.from("file")).catch((error: Error) => error.message);
    await expect(loadXlsxWorkbook(Buffer.from("file"))).rejects.toThrow("xlsx-busy");
    await vi.advanceTimersByTimeAsync(30_000);
    children.forEach((child) => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    await expect(loadXlsxWorkbook(Buffer.from("file"))).rejects.toThrow("xlsx-busy");
    children.forEach((child) => child.emit("close", null));
    expect(await first).toBe("xlsx-timeout");
    expect(await second).toBe("xlsx-timeout");

    const recovered = processDouble();
    spawn.mockReturnValueOnce(recovered);
    const result = loadXlsxWorkbook(Buffer.from("file"));
    recovered.stdout.emit("data", Buffer.from('{"worksheets":[]}'));
    recovered.emit("close", 0);
    await expect(result).resolves.toEqual({ worksheets: [] });
  });

  it("bounds returned data, drops parser diagnostics, and does not pass application secrets", async () => {
    vi.stubEnv("AUTH_SECRET", "test-only-private-value");
    vi.stubEnv("DATABASE_URL", "test-only-private-value");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    const child = processDouble();
    spawn.mockReturnValueOnce(child);
    const result = loadXlsxWorkbook(Buffer.from("file"));
    const options = spawn.mock.calls[0][2];
    expect(options.env).not.toHaveProperty("AUTH_SECRET");
    expect(options.env).not.toHaveProperty("DATABASE_URL");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.stdio[2]).toBe("ignore");
    child.stdout.emit("data", Buffer.alloc(32 * 1024 * 1024 + 1));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
    await expect(result).rejects.toThrow("xlsx-resource-limit");
  });

  it("recovers admission after a spawn failure without exposing the raw error", async () => {
    spawn.mockImplementationOnce(() => { throw new Error("sensitive internal path"); });
    await expect(loadXlsxWorkbook(Buffer.from("file"))).rejects.toThrow("unreadable-xlsx-file");
    const child = processDouble();
    spawn.mockReturnValueOnce(child);
    const result = loadXlsxWorkbook(Buffer.from("file"));
    child.stdout.emit("data", Buffer.from('{"worksheets":[]}'));
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ worksheets: [] });
  });
});
