import type { Locale } from "@/lib/i18n";
import { entryContextStorageScope, matchesEntryIdentity, type EntryContext, type EntryTarget } from "./entry-context";
import { MAX_NATURAL_LANGUAGE_TEXT_LENGTH, normalizeNaturalLanguageText } from "./natural-language-protocol";
import { isCurrentNaturalLanguageSuccessResult, NATURAL_LANGUAGE_RESULT_VERSION,
  type NaturalLanguageActionResult, type NaturalLanguageEntryInput } from "./natural-language-types";

type Snapshot = { requestId: string; text: string | null; source: string | null; target?: EntryTarget };
export type EntryFeedback = { result: NaturalLanguageActionResult; snapshotText: string | null; source: string | null; target?: EntryTarget };
type State = {
  ready: boolean;
  phase: "editing" | "submitting" | "processing" | "unknown";
  reservation: symbol | null;
  pending: Snapshot | null;
  feedback: EntryFeedback | null;
};
type Dependencies = {
  memberId: string;
  context?: EntryContext;
  ledgerName?: string;
  targets?: EntryTarget[];
  legacyDefaultLedgerId?: string;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  uuid: () => string;
  submit: (input: NaturalLanguageEntryInput) => Promise<NaturalLanguageActionResult>;
  query: (requestId: string, version: number, context?: EntryContext) => Promise<NaturalLanguageActionResult>;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One owner for the member's pending request in this application tab. */
export class NaturalLanguageController {
  private readonly serverSnapshot: State = { ready: false, phase: "editing", reservation: null, pending: null, feedback: null };
  private state: State = this.serverSnapshot;
  private listeners = new Set<() => void>();
  private initialized = false;
  private sending = false;
  private target?: EntryTarget;
  private textDrafts = new Map<string, { text: string; pendingRequestId?: string }>();
  private generation = 0;

  constructor(private dependencies: Dependencies) {
    this.dependencies = { ...dependencies, context: dependencies.context ? { ...dependencies.context } : undefined };
    this.target = this.dependencies.context ? { context: this.dependencies.context, ledgerName: dependencies.ledgerName ?? this.dependencies.context.ledgerId } : undefined;
  }

  setTarget(context: EntryContext, ledgerName: string) {
    if (this.dependencies.context && !matchesEntryIdentity(this.dependencies.context, context)) throw new Error("Unauthorized");
    this.target = { context: { ...context }, ledgerName };
  }

  textDraftSource(context = this.target?.context) {
    if (context && this.dependencies.context && !matchesEntryIdentity(this.dependencies.context, context)) throw new Error("Unauthorized");
    return `natural-language-text:${context ? entryContextStorageScope(context) : this.dependencies.memberId}`;
  }

  getTextDraft(context = this.target?.context) {
    return this.textDrafts.get(this.textDraftSource(context))?.text ?? "";
  }

  setTextDraft(text: string, context = this.target?.context) {
    this.textDrafts.set(this.textDraftSource(context), { text });
  }

  hasUnsavedTextDrafts() {
    return [...this.textDrafts.values()].some((draft) => Boolean(draft.text.trim()));
  }

  private storageKey(target = this.target) {
    return target ? `billboard:natural-language-pending:v2:${entryContextStorageScope(target.context)}`
      : `billboard:natural-language-pending:v1:${this.dependencies.memberId}`;
  }

  private query(snapshot: Snapshot) {
    return snapshot.target ? this.dependencies.query(snapshot.requestId, NATURAL_LANGUAGE_RESULT_VERSION, snapshot.target.context)
      : this.dependencies.query(snapshot.requestId, NATURAL_LANGUAGE_RESULT_VERSION);
  }

  getSnapshot = () => this.state;
  getServerSnapshot = () => this.serverSnapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(value: Partial<State>) {
    this.state = { ...this.state, ...value };
    this.listeners.forEach((listener) => listener());
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    let pending: Snapshot | null = null;
    try {
      const storage = this.dependencies.storage();
      const legacyKey = `billboard:natural-language-pending:v1:${this.dependencies.memberId}`;
      const targets = this.dependencies.targets ?? (this.target ? [this.target] : [undefined]);
      for (const target of targets) {
        if (target && this.dependencies.context && !matchesEntryIdentity(this.dependencies.context, target.context)) continue;
        const key = this.storageKey(target);
        let saved = storage.getItem(key);
        if (!saved && target?.context.ledgerId === this.dependencies.legacyDefaultLedgerId) {
          saved = storage.getItem(legacyKey);
          if (saved) { storage.setItem(key, saved); storage.removeItem(legacyKey); }
        }
        if (saved && uuidPattern.test(saved)) {
          pending = { requestId: saved, text: null, source: null, ...(target ? { target: { context: { ...target.context }, ledgerName: target.ledgerName } } : {}) };
          break;
        }
        if (saved) storage.removeItem(key);
      }
    } catch { /* Text entry retains its existing storage fallback. */ }
    this.update({ ready: true });
    if (pending) await this.run(pending, "query");
  }

  reserve(): symbol | null {
    if (!this.state.ready || this.state.pending || this.state.reservation || this.sending) return null;
    const token = Symbol("voice-operation");
    this.update({ reservation: token });
    return token;
  }

  release(token: symbol) {
    if (this.state.reservation === token) this.update({ reservation: null });
  }

  clearFeedback(source: string | null) {
    if (this.state.feedback?.source === source) this.update({ feedback: null });
  }

  submit(source: string, rawText: string, locale: Locale, token?: symbol): "started" | "busy" | "invalid" | "storage-unavailable" {
    if (!this.state.ready || this.state.pending || this.sending ||
      (token ? this.state.reservation !== token : this.state.reservation !== null)) return "busy";
    const text = normalizeNaturalLanguageText(rawText);
    if (!text || text.length > MAX_NATURAL_LANGUAGE_TEXT_LENGTH) {
      this.update({ reservation: null, feedback: { source, snapshotText: null,
        result: { status: "error", requestId: "", code: text ? "INPUT_TOO_LONG" : "INPUT_EMPTY" } } });
      return "invalid";
    }
    const requestId = this.dependencies.uuid();
    const snapshot: Snapshot = { requestId, text, source, ...(this.target ? { target: { context: { ...this.target.context }, ledgerName: this.target.ledgerName } } : {}) };
    let stored = false;
    try {
      const storage = this.dependencies.storage();
      storage.setItem(this.storageKey(snapshot.target), requestId);
      stored = storage.getItem(this.storageKey(snapshot.target)) === requestId;
    } catch { /* Voice requires a durable UUID before invoking accounting. */ }
    if (token && !stored) {
      this.clearStored(snapshot);
      this.update({ reservation: null });
      return "storage-unavailable";
    }
    const draft = this.textDrafts.get(source);
    if (draft && normalizeNaturalLanguageText(draft.text) === text) this.textDrafts.set(source, { ...draft, pendingRequestId: requestId });
    // run sets pending synchronously before releasing the reservation to subscribers.
    void this.run(snapshot, "submit", locale);
    return "started";
  }

  async confirm() {
    if (this.state.pending && !this.sending) await this.run(this.state.pending, "query");
  }

  private clearStored(snapshot: Snapshot) {
    try {
      const storage = this.dependencies.storage();
      const key = this.storageKey(snapshot.target);
      if (storage.getItem(key) === snapshot.requestId) storage.removeItem(key);
    } catch { /* A retained UUID can only replay the immutable result after reload. */ }
  }

  private async run(snapshot: Snapshot, operation: "submit" | "query", locale: Locale = "zh-CN") {
    if (this.sending) return;
    const generation = this.generation;
    this.sending = true;
    this.update({ pending: snapshot, reservation: null, feedback: null, phase: "submitting" });
    try {
      let result = operation === "submit" && snapshot.text !== null
        ? await this.dependencies.submit({ requestId: snapshot.requestId, text: snapshot.text, locale, resultVersion: NATURAL_LANGUAGE_RESULT_VERSION, ...(snapshot.target ? { context: snapshot.target.context } : {}) })
        : await this.query(snapshot);
      let snapshotText = snapshot.text;
      if (generation !== this.generation) return;
      if (result.requestId === snapshot.requestId && result.status === "error" && result.code === "CONFLICT") {
        snapshotText = null;
        result = await this.query(snapshot);
      }
      if (generation !== this.generation || this.state.pending?.requestId !== snapshot.requestId) return;
      if (result.requestId !== snapshot.requestId || (result.status === "error" && result.code === "CONFLICT")) {
        this.update({ phase: "unknown" });
      } else if (result.status === "processing" || result.status === "unknown") {
        this.update({ phase: result.status });
      } else if ((result.status !== "success" && result.status !== "error") ||
        (result.status === "success" && !isCurrentNaturalLanguageSuccessResult(result))) {
        this.update({ phase: "unknown" });
      } else {
        this.clearStored(snapshot);
        if (result.status === "success" && snapshot.source && this.textDrafts.get(snapshot.source)?.pendingRequestId === snapshot.requestId) this.textDrafts.delete(snapshot.source);
        this.update({ pending: null, phase: "editing", feedback: { source: snapshot.source, result,
          snapshotText: result.status === "error" ? snapshotText : null, ...(snapshot.target ? { target: snapshot.target } : {}) } });
      }
    } catch {
      if (generation === this.generation && this.state.pending?.requestId === snapshot.requestId) this.update({ phase: "unknown" });
    } finally {
      if (generation === this.generation) this.sending = false;
    }
  }

  dispose() {
    this.generation++;
    this.initialized = false;
    this.sending = false;
    this.textDrafts.clear();
    this.update({ ready: false, pending: null, reservation: null, feedback: null, phase: "editing" });
  }
}
