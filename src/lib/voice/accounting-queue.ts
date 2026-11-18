import type { Locale } from "@/lib/i18n";
import { entryContextStorageScope, matchesEntryIdentity, type EntryContext, type EntryTarget } from "@/lib/transactions/entry-context";
import type { EntryFeedback } from "@/lib/transactions/natural-language-controller";
import { MAX_NATURAL_LANGUAGE_TEXT_LENGTH, normalizeNaturalLanguageText } from "@/lib/transactions/natural-language-protocol";
import { isCurrentNaturalLanguageSuccessResult, NATURAL_LANGUAGE_RESULT_VERSION,
  type NaturalLanguageActionResult, type NaturalLanguageEntryInput } from "@/lib/transactions/natural-language-types";

export type VoiceTask = {
  id: string;
  phase: "queued" | "transcribing" | "submitting" | "processing" | "unknown" | "failed" | "success";
  text: string | null;
  feedback: EntryFeedback | null;
  error: string | null;
  target?: EntryTarget;
};
type State = { ready: boolean; tasks: VoiceTask[] };
type Dependencies = {
  memberId: string;
  context?: EntryContext;
  ledgerName?: string;
  targets?: EntryTarget[];
  legacyDefaultLedgerId?: string;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  uuid: () => string;
  transcribe: (audio: Blob, locale: Locale, signal: AbortSignal, context?: EntryContext, requestId?: string) => Promise<string>;
  submit: (input: NaturalLanguageEntryInput) => Promise<NaturalLanguageActionResult>;
  query: (id: string, version: number, context?: EntryContext) => Promise<NaturalLanguageActionResult>;
};
type AudioResult = { audio: Blob } | { error: unknown };
type Work = { locale: Locale; audio?: Promise<AudioResult> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retryDelay = 1000;
const voiceErrorCodes = new Set(["storage", "unavailable", "unauthorized", "forbidden", "text_too_long",
  "rate_limited", "timeout", "cancelled", "invalid_audio", "audio_too_large", "audio_too_long", "no_speech", "context_required", "consent_required"]);

function storedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && uuidPattern.test(id)))] : [];
  } catch { return []; }
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" && voiceErrorCodes.has(code) ? code : "unavailable";
}

export class VoiceAccountingError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Owns this member's voice jobs for the lifetime of the application tab. */
export class VoiceAccountingQueue {
  private readonly serverSnapshot: State = { ready: false, tasks: [] };
  private state = this.serverSnapshot;
  private listeners = new Set<() => void>();
  private work = new Map<string, Work>();
  private confirming = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private transcription: AbortController | null = null;
  private initialized = false;
  private running = false;
  private generation = 0;
  private target?: EntryTarget;

  constructor(private dependencies: Dependencies) {
    this.dependencies = { ...dependencies, context: dependencies.context ? { ...dependencies.context } : undefined };
    this.target = this.dependencies.context ? { context: this.dependencies.context, ledgerName: dependencies.ledgerName ?? this.dependencies.context.ledgerId } : undefined;
  }

  setTarget(context: EntryContext, ledgerName: string) {
    if (this.dependencies.context && !matchesEntryIdentity(this.dependencies.context, context)) throw new VoiceAccountingError("unauthorized");
    this.target = { context: { ...context }, ledgerName };
  }

  private storageKey(target = this.target) {
    return target ? `billboard:voice-pending:v2:${entryContextStorageScope(target.context)}` : `billboard:voice-pending:v1:${this.dependencies.memberId}`;
  }

  private query(task: VoiceTask) {
    return task.target ? this.dependencies.query(task.id, NATURAL_LANGUAGE_RESULT_VERSION, task.target.context)
      : this.dependencies.query(task.id, NATURAL_LANGUAGE_RESULT_VERSION);
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

  private updateTask(id: string, value: Partial<VoiceTask>) {
    this.update({ tasks: this.state.tasks.map((task) => task.id === id ? { ...task, ...value } : task) });
  }

  private current(generation: number) {
    return this.initialized && this.generation === generation;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    const generation = this.generation;
    const restored: VoiceTask[] = [];
    try {
      const storage = this.dependencies.storage();
      const legacyKey = `billboard:voice-pending:v1:${this.dependencies.memberId}`;
      const targets = this.dependencies.targets ?? (this.target ? [this.target] : [undefined]);
      for (const target of targets) {
        if (target && this.dependencies.context && !matchesEntryIdentity(this.dependencies.context, target.context)) continue;
        const key = this.storageKey(target);
        let raw = storage.getItem(key);
        if (!raw && target?.context.ledgerId === this.dependencies.legacyDefaultLedgerId) {
          raw = storage.getItem(legacyKey);
          if (raw) { storage.setItem(key, raw); storage.removeItem(legacyKey); }
        }
        const ids = storedIds(raw);
        if (raw && raw !== JSON.stringify(ids)) {
          if (ids.length) storage.setItem(key, JSON.stringify(ids));
          else storage.removeItem(key);
        }
        for (const id of ids) {
          if (!restored.some((task) => task.id === id)) restored.push({ id, phase: "unknown", text: null, feedback: null, error: null,
            ...(target ? { target: { context: { ...target.context }, ledgerName: target.ledgerName } } : {}) });
        }
      }
    } catch { /* Submission still requires a successful write and read-back. */ }
    this.update({ ready: true, tasks: restored });
    if (this.current(generation)) await Promise.all(restored.map((task) => this.confirm(task.id)));
  }

  enqueue(audio: Promise<Blob>, locale: Locale, target = this.target): string {
    // Observe rejection immediately, even if earlier jobs keep this recording queued.
    const outcome: Promise<AudioResult> = audio.then((value) => ({ audio: value }), (error: unknown) => ({ error }));
    if (this.state.tasks.filter((task) => task.phase !== "failed" && task.phase !== "success").length >= 8) throw new VoiceAccountingError("rate_limited");
    const task = this.createTask(target);
    this.work.set(task.id, { locale, audio: outcome });
    this.update({ tasks: [...this.state.tasks, task] });
    this.pump();
    return task.id;
  }

  enqueueText(failedId: string, text: string, locale: Locale): string {
    const failed = this.state.tasks.find((task) => task.id === failedId && task.phase === "failed");
    if (!failed) {
      throw new VoiceAccountingError("unavailable");
    }
    if (this.state.tasks.filter((task) => task.phase !== "failed" && task.phase !== "success").length >= 8) throw new VoiceAccountingError("rate_limited");
    const task = { ...this.createTask(failed.target), text: normalizeNaturalLanguageText(text) };
    this.work.set(task.id, { locale });
    this.update({ tasks: [...this.state.tasks.filter((item) => item.id !== failedId), task] });
    this.pump();
    return task.id;
  }

  private createTask(target = this.target): VoiceTask {
    if (!this.state.ready) throw new VoiceAccountingError("unavailable");
    const id = this.dependencies.uuid();
    if (!uuidPattern.test(id) || this.state.tasks.some((task) => task.id === id)) throw new VoiceAccountingError("unavailable");
    return { id, phase: "queued", text: null, feedback: null, error: null,
      ...(target ? { target: { context: { ...target.context }, ledgerName: target.ledgerName } } : {}) };
  }

  dismiss(id: string) {
    const task = this.state.tasks.find((item) => item.id === id);
    if (task?.phase === "success" || task?.phase === "failed") {
      this.update({ tasks: this.state.tasks.filter((item) => item.id !== id) });
    }
  }

  confirm(id: string): Promise<void> {
    const existing = this.confirming.get(id);
    if (existing) return existing;
    const task = this.state.tasks.find((item) => item.id === id);
    if (!this.initialized || (task?.phase !== "unknown" && task?.phase !== "processing")) return Promise.resolve();
    this.clearTimer(id);
    const generation = this.generation;
    const promise = this.account(id, () => this.query(task), generation)
      .finally(() => {
        if (!this.current(generation) || this.confirming.get(id) !== promise) return;
        this.confirming.delete(id);
        this.pump();
      });
    this.confirming.set(id, promise);
    return promise;
  }

  private pump() {
    if (!this.initialized || this.running) return;
    const task = this.state.tasks.find((item) => item.phase !== "failed" && item.phase !== "success");
    if (task?.phase !== "queued") return;
    const work = this.work.get(task.id);
    if (!work) return;
    this.running = true;
    const generation = this.generation;
    void this.run(task, work, generation).finally(() => {
      if (!this.current(generation)) return;
      this.running = false;
      this.pump();
    });
  }

  private async run(task: VoiceTask, work: Work, generation: number) {
    let text = task.text;
    try {
      if (work.audio) {
        const controller = new AbortController();
        this.transcription = controller;
        this.updateTask(task.id, { phase: "transcribing" });
        const outcome = await work.audio;
        if (!this.current(generation)) return;
        if ("error" in outcome) throw outcome.error;
        text = await this.dependencies.transcribe(outcome.audio, work.locale, controller.signal, task.target?.context, task.id);
        if (!this.current(generation)) return;
      }
      text = normalizeNaturalLanguageText(text ?? "");
      if (!text) throw new VoiceAccountingError("no_speech");
      if (text.length > MAX_NATURAL_LANGUAGE_TEXT_LENGTH) throw new VoiceAccountingError("text_too_long");
    } catch (error) {
      if (this.current(generation)) this.updateTask(task.id, { phase: "failed", error: errorCode(error) });
      return;
    } finally {
      if (this.current(generation)) {
        this.transcription = null;
        this.work.delete(task.id);
      }
    }
    this.updateTask(task.id, { phase: "submitting", text });
    if (!this.current(generation)) return;
    if (!this.persist(task.id)) {
      this.updateTask(task.id, { phase: "failed", error: "storage" });
      return;
    }
    const input: NaturalLanguageEntryInput = { requestId: task.id, text, locale: work.locale, resultVersion: NATURAL_LANGUAGE_RESULT_VERSION,
      ...(task.target ? { context: task.target.context } : {}) };
    await this.account(task.id, () => this.dependencies.submit(input), generation);
  }

  private persist(id: string): boolean {
    try {
      const storage = this.dependencies.storage();
      const key = this.storageKey(this.state.tasks.find((task) => task.id === id)?.target);
      const ids = [...new Set([...storedIds(storage.getItem(key)), id])];
      const value = JSON.stringify(ids);
      storage.setItem(key, value);
      if (storage.getItem(key) === value) return true;
    } catch { /* Do not invoke accounting without a durable request identifier. */ }
    this.clearStored(id);
    return false;
  }

  private clearStored(id: string) {
    try {
      const storage = this.dependencies.storage();
      const key = this.storageKey(this.state.tasks.find((task) => task.id === id)?.target);
      const ids = storedIds(storage.getItem(key));
      if (!ids.includes(id)) return;
      const remaining = ids.filter((value) => value !== id);
      if (remaining.length) storage.setItem(key, JSON.stringify(remaining));
      else storage.removeItem(key);
    } catch { /* A retained UUID only restores the immutable result on reload. */ }
  }

  private async account(id: string, operation: () => Promise<NaturalLanguageActionResult>, generation: number) {
    try {
      let result = await operation();
      if (!this.current(generation)) return;
      if (result?.requestId === id && result.status === "error" && result.code === "CONFLICT") {
        this.updateTask(id, { text: null });
        if (!this.current(generation)) return;
        const task = this.state.tasks.find((item) => item.id === id);
        if (!task) return;
        result = await this.query(task);
        if (!this.current(generation)) return;
      }
      if (!result || result.requestId !== id || (result.status === "error" && result.code === "CONFLICT") ||
        (result.status !== "success" && result.status !== "error" && result.status !== "processing" && result.status !== "unknown") ||
        (result.status === "success" && !isCurrentNaturalLanguageSuccessResult(result))) {
        this.updateTask(id, { phase: "unknown" });
      } else if (result.status === "processing" || result.status === "unknown") {
        this.updateTask(id, { phase: result.status });
      } else {
        const text = result.status === "error" ? this.state.tasks.find((task) => task.id === id)?.text ?? null : null;
        const target = this.state.tasks.find((task) => task.id === id)?.target;
        this.clearStored(id);
        this.updateTask(id, { phase: result.status === "success" ? "success" : "failed", text,
          feedback: { source: "voice", snapshotText: text, result, ...(target ? { target } : {}) }, error: null });
      }
    } catch {
      if (this.current(generation)) this.updateTask(id, { phase: "unknown" });
    } finally {
      if (this.current(generation)) this.scheduleConfirmation(id);
    }
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private scheduleConfirmation(id: string) {
    this.clearTimer(id);
    const task = this.state.tasks.find((item) => item.id === id);
    if (task?.phase !== "unknown" && task?.phase !== "processing") return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.confirm(id);
    }, retryDelay));
  }

  dispose() {
    this.initialized = false;
    this.generation++;
    this.transcription?.abort();
    this.transcription = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.confirming.clear();
    this.work.clear();
    this.running = false;
    this.update({ ready: false, tasks: [] });
  }
}
