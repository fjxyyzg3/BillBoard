import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NaturalLanguageProvider } from "@/components/natural-language-provider";
import type { NaturalLanguageController } from "@/lib/transactions/natural-language-controller";
import type { VoiceAccountingQueue } from "@/lib/voice/accounting-queue";

const harness = vi.hoisted(() => ({
  generation: 0,
  ready: false,
  stateCursor: 0,
  effectCursor: 0,
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void | (() => void)>,
  restore: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.stateCursor++;
    if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? initial() : initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
  },
  useRef: () => harness.refs[0] ??= { current: false },
  useEffect: (work: () => void | (() => void), deps: unknown[]) => {
    const index = harness.effectCursor++;
    const previous = harness.effects[index];
    if (!previous || deps.some((value, key) => value !== previous.deps[key])) {
      previous?.cleanup?.();
      const effect = { deps, cleanup: undefined as (() => void) | undefined };
      harness.effects[index] = effect;
      harness.pending.push(() => { const cleanup = work(); if (cleanup) effect.cleanup = cleanup; });
    }
  },
}));
vi.mock("@/components/ledger-provider", () => ({ useOptionalLedgerSelection: () => null }));
vi.mock("@/components/encryption-provider", () => ({ useOptionalEncryption: () => ({ ready: harness.ready, status: { mode: "UNENCRYPTED", revision: 0 } }) }));
vi.mock("@/lib/encryption/client", () => ({
  encryptionClientGeneration: () => harness.generation,
  restoreEntryBrowserState: harness.restore,
  entryBrowserStorage: () => ({ getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }),
  ensureDurableEntryRequest: vi.fn(), getEncryptionInput: () => undefined, invokeEncryptedAction: vi.fn(),
}));
vi.mock("@/app/(app)/add/natural-language-actions", () => ({ queryNaturalLanguageEntry: vi.fn(), submitNaturalLanguageEntry: vi.fn() }));

function render() {
  harness.stateCursor = 0; harness.effectCursor = 0;
  const tree = NaturalLanguageProvider({ currentMemberId: "member", children: null }) as ReactElement<{ value: { entry: NaturalLanguageController; voice: VoiceAccountingQueue } }>;
  for (const effect of harness.pending.splice(0)) effect();
  return tree.props.value;
}

describe("entry controller startup around encryption initialization", () => {
  beforeEach(() => {
    harness.generation = 0; harness.ready = false; harness.states = []; harness.refs = []; harness.effects = []; harness.pending = [];
    harness.restore.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), length: 0 } });
  });

  it("initializes unencrypted controllers after the parent establishes its first runtime generation", async () => {
    const controllers = render();
    harness.generation += 1;
    harness.ready = true;
    render();
    await vi.waitFor(() => {
      expect(controllers.entry.getSnapshot().ready).toBe(true);
      expect(controllers.voice.getSnapshot().ready).toBe(true);
    });
  });

  it("does not initialize old controllers when the identity changes during protected restore", async () => {
    let finish!: () => void;
    harness.ready = true;
    harness.restore.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const controllers = render();
    harness.generation += 1;
    finish();
    await Promise.resolve();
    expect(controllers.entry.getSnapshot().ready).toBe(false);
    expect(controllers.voice.getSnapshot().ready).toBe(false);
  });
});
