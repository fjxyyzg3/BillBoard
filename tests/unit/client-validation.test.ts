import { expect, it, vi } from "vitest";

it("validates bounded browser inputs without probing or compiling runtime code", async () => {
  vi.resetModules();
  const compile = vi.spyOn(globalThis, "Function");
  try {
    await import("../../src/instrumentation-client");
    const { z } = await import("zod");
    const schema = z.object({ amountFen: z.number().int().positive(), tags: z.array(z.string()).max(2) });

    expect(schema.safeParse({ amountFen: 123, tags: ["expense"] }).success).toBe(true);
    expect(schema.safeParse({ amountFen: 1.5, tags: [] }).success).toBe(false);
    expect(schema.safeParse({ amountFen: 123, tags: ["a", "b", "c"] }).success).toBe(false);
    expect(compile).not.toHaveBeenCalled();
  } finally { compile.mockRestore(); }
});
