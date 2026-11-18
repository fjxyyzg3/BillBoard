import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionSettings } from "@/components/encryption-settings";
import { createEncryptionCandidate, type EncryptionCandidate } from "@/lib/encryption/client-recovery";
import { parseHouseholdCode } from "@/lib/encryption/crypto";

const harness = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], candidate: null as unknown, clear: vi.fn(), fetch: vi.fn(), remember: vi.fn(), promote: vi.fn() }));
const identity = { accountId: "account", householdId: "household", memberId: "member" };
const status = { mode: "UNENCRYPTED" as const, revision: 0, generation: null, keyVersion: 0, isOwner: true, operation: null };
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    const value = index === 2 ? harness.candidate : initial;
    harness.states[index] = value;
    return [value, (next: unknown) => { harness.states[index] = next; }];
  },
  useRef: (initial: unknown) => ({ current: initial }), useEffect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/encryption-provider", () => ({
  EncryptionProvider: ({ children }: { children: ReactNode }) => children,
  useEncryption: () => ({ identity, status, code: null, ready: true, activate: (nextStatus: unknown, code: string | null) => harness.promote(identity, nextStatus, code) }),
}));
vi.mock("@/lib/encryption/client-store", () => ({ clearClientEncryptionOperation: harness.clear, loadClientEncryptionOperation: vi.fn(), rememberHouseholdCode: harness.remember, saveClientEncryptionOperation: vi.fn() }));
vi.mock("@/lib/encryption/client", () => ({ encryptionClientGeneration: () => 1, setClientEncryption: harness.promote }));
vi.mock("@/components/encryption-lifecycle", () => ({ forgetEncryptionIdentity: vi.fn() }));

function clickAction(label = "取消") {
  const wrapper = EncryptionSettings({ identity, status, locale: "zh-CN" });
  const body = wrapper.props.children as ReactElement<{ locale: "zh-CN" }>;
  const tree = (body.type as (props: { locale: "zh-CN" }) => ReactNode)(body.props);
  let click: (() => void) | undefined;
  function visit(value: ReactNode) {
    Children.forEach(value, (child) => {
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      if (child.type === "button" && child.props.children === label) click = child.props.onClick;
      visit(child.props.children);
    });
  }
  visit(tree);
  if (!click) throw new Error("Action button missing");
  click();
}

describe("encryption cancellation after a lost local prepared-state write", () => {
  beforeEach(async () => {
    harness.cursor = 0; harness.states = []; harness.clear.mockReset().mockResolvedValue(undefined); harness.fetch.mockReset(); harness.remember.mockReset().mockResolvedValue(undefined); harness.promote.mockReset();
    harness.candidate = await createEncryptionCandidate(identity, "ENABLE", 0, null);
    vi.stubGlobal("fetch", harness.fetch);
  });

  it("obtains the original UUID cancellation tombstone before discarding a locally unprepared candidate", async () => {
    const candidate = harness.candidate as EncryptionCandidate;
    harness.fetch.mockResolvedValue(Response.json({ status, operation: { id: candidate.id, kind: "CANCELLED", status: "ABORTED", expiresAt: new Date().toISOString(), candidateGeneration: null, candidateKeyVersion: null, recoveryDigest: null, sourceRevision: 0, barrierRevision: 0 } }));
    clickAction();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(harness.fetch.mock.calls[0][1].body)).toEqual({ operation: "abort", id: candidate.id });
    await vi.waitFor(() => expect(harness.clear).toHaveBeenCalledWith(identity));
    expect(harness.states[2]).toBeNull();
  });

  it.each(["unknown", "mismatched"])("keeps the original candidate when cancellation returns %s", async (kind) => {
    const candidate = harness.candidate as EncryptionCandidate;
    harness.fetch.mockResolvedValue(Response.json({ status, operation: kind === "unknown" ? null : { id: candidate.id, kind: candidate.kind, status: "ABORTED", candidateGeneration: null, candidateKeyVersion: null, recoveryDigest: "wrong-digest", sourceRevision: 0, barrierRevision: 1 }, unknown: kind === "unknown" }));
    clickAction();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.states[6]).toBe("pending"));
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.states[2]).toBe(candidate);
  });

  it("promotes a verified committed code in memory and preserves a device-save failure notice", async () => {
    const candidate = { ...harness.candidate as EncryptionCandidate, prepared: true };
    harness.candidate = candidate;
    const parsed = parseHouseholdCode(candidate.code);
    const committedStatus = { ...status, mode: "ENCRYPTED", revision: 2, generation: parsed.generation, keyVersion: parsed.keyVersion };
    harness.remember.mockRejectedValue(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    harness.fetch.mockImplementation(async (_path, input: { body: string }) => JSON.parse(input.body).operation === "materials"
      ? Response.json({ status: committedStatus, sealedKeyRing: candidate.candidateKeyRing })
      : Response.json({ status: committedStatus, operation: { id: candidate.id, kind: candidate.kind, status: "COMMITTED", candidateGeneration: parsed.generation, candidateKeyVersion: parsed.keyVersion, recoveryDigest: candidate.recoveryDigest, sourceRevision: candidate.expectedRevision, barrierRevision: candidate.expectedRevision + 1 } }));
    clickAction("查询原操作");
    await vi.waitFor(() => expect(harness.promote).toHaveBeenCalledWith(identity, committedStatus, candidate.code));
    expect(harness.states[6]).toBe("completed");
    expect(harness.states[12]).toBe(true);
  });

  it("publishes the committed mode only after the matching code is ready for the next page", async () => {
    const candidate = { ...harness.candidate as EncryptionCandidate, prepared: true };
    harness.candidate = candidate;
    const parsed = parseHouseholdCode(candidate.code);
    const committedStatus = { ...status, mode: "ENCRYPTED", revision: 2, generation: parsed.generation, keyVersion: parsed.keyVersion };
    let finishSave!: () => void;
    harness.remember.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    harness.fetch.mockImplementation(async (_path, input: { body: string }) => JSON.parse(input.body).operation === "materials"
      ? Response.json({ status: committedStatus, sealedKeyRing: candidate.candidateKeyRing })
      : Response.json({ status: committedStatus, operation: { id: candidate.id, kind: candidate.kind, status: "COMMITTED", candidateGeneration: parsed.generation, candidateKeyVersion: parsed.keyVersion, recoveryDigest: candidate.recoveryDigest, sourceRevision: candidate.expectedRevision, barrierRevision: candidate.expectedRevision + 1 } }));
    clickAction("查询原操作");
    await vi.waitFor(() => expect(harness.remember).toHaveBeenCalled());
    expect(harness.states[0]).toEqual(status);
    expect(harness.states[2]).toBe(candidate);
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.promote).not.toHaveBeenCalled();
    finishSave();
    await vi.waitFor(() => expect(harness.promote).toHaveBeenCalledWith(identity, committedStatus, candidate.code));
    expect(harness.states[0]).toEqual(committedStatus);
    expect(harness.states[6]).toBe("completed");
  });
});
