import type { Locale } from "@/lib/i18n";
import {
  BILL_ANALYSIS_VERSION, type BillAnalysisEntriesDto, type BillAnalysisEntryDto, type BillAnalysisErrorCode,
  type BillAnalysisOutcome, type BillAnalysisPhase, type BillAnalysisReportListItem,
  type BillAnalysisScope, type BillAnalysisTaskDto, type AnyBillReportDto,
} from "./bill-analysis-types";
import { isBillReconciliationReport } from "./bill-reconciliation-controller";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Options = {
  identity: string;
  uuid: () => string;
  storage: () => Storage;
  request: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;
};
type ScopeLabels = { ledger: string; member: string };
export type BillAnalysisPending = {
  requestId?: string;
  taskId?: string;
  canCancel: boolean;
  scope: BillAnalysisScope | null;
  scopeLabels: ScopeLabels | null;
  locale: Locale | null;
};
export type BillAnalysisClientSnapshot = {
  ready: boolean;
  storageAvailable: boolean;
  pending: BillAnalysisPending | null;
  phase: BillAnalysisPhase | "processing" | "unknown" | "stopping" | null;
  completedBatches: number;
  totalBatches: number;
  outcome: BillAnalysisOutcome | null;
  completedScope: BillAnalysisScope | null;
  completedLabels: ScopeLabels | null;
  focusedReport: { reportId: string; ownerScopeKey: string } | null;
  entries: BillAnalysisEntryDto[];
  entriesCursor: string | null;
  entriesReady: boolean;
  entriesLoading: boolean;
  entriesError: BillAnalysisErrorCode | null;
  activeEntry: BillAnalysisEntryDto | null;
};

const storageKey = "billboard:bill-analysis-pending:v1";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phases = new Set(["preparing", "analyzing", "waiting", "summarizing", "saving"]);
const errorCodes = new Set<BillAnalysisErrorCode>([
  "INVALID", "CONSENT_REQUIRED", "BUSY", "TOO_LARGE", "NO_DATA", "NOT_ACCEPTED", "CONFLICT",
  "UNAUTHORIZED", "ENCRYPTION_CHANGED", "TIMEOUT", "CANCELLED", "INTERRUPTED", "INVALID_RESPONSE", "UNAVAILABLE",
]);
const initial: BillAnalysisClientSnapshot = {
  ready: false, storageAvailable: true, pending: null, phase: null,
  completedBatches: 0, totalBatches: 0, outcome: null, completedScope: null, completedLabels: null, focusedReport: null,
  entries: [], entriesCursor: null, entriesReady: false, entriesLoading: false, entriesError: null, activeEntry: null,
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validProgress(value: Record<string, unknown>) {
  return (value.phase === undefined || value.phase === null || phases.has(String(value.phase))) &&
    [value.completedBatches, value.totalBatches].every((count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0)) &&
    (value.completedBatches === undefined || value.totalBatches === undefined || Number(value.completedBatches) <= Number(value.totalBatches));
}

function outcome(value: unknown, requestId: string): BillAnalysisOutcome {
  if (!object(value) || value.requestId !== requestId || !["processing", "stopping", "unknown", "error", "success"].includes(String(value.status)) || !validProgress(value)) {
    throw new Error("Invalid analysis receipt");
  }
  if (value.error !== undefined && !errorCodes.has(value.error as BillAnalysisErrorCode)) throw new Error("Invalid analysis error");
  if (value.status === "error" && value.error === undefined) throw new Error("Missing analysis error");
  if (value.status === "success" && (typeof value.reportId !== "string" || !Number.isSafeInteger(value.generation))) {
    throw new Error("Invalid successful analysis receipt");
  }
  return value as unknown as BillAnalysisOutcome;
}

function validScope(value: unknown): value is BillAnalysisScope {
  return object(value) && (value.mode === "month" || value.mode === "year") && typeof value.period === "string" &&
    (value.ledgerId === null || typeof value.ledgerId === "string") && (value.actorMemberId === null || typeof value.actorMemberId === "string");
}

function validLabels(value: unknown): value is ScopeLabels {
  return object(value) && typeof value.ledger === "string" && typeof value.member === "string";
}

function validReport(value: unknown): value is BillAnalysisReportListItem {
  return object(value) && typeof value.id === "string" && validScope(value.scope) && validLabels(value.scopeLabels) &&
    (value.purpose === undefined || value.purpose === "analysis" || value.purpose === "reconciliation") &&
    (value.locale === "zh-CN" || value.locale === "en-US") && typeof value.generatedAt === "string" && typeof value.snapshotAt === "string" &&
    object(value.range) && typeof value.range.from === "string" && typeof value.range.to === "string" && Number.isSafeInteger(value.generation);
}

function validTask(value: unknown): value is BillAnalysisTaskDto {
  return object(value) && typeof value.id === "string" && ["processing", "stopping", "error", "success"].includes(String(value.status)) &&
    (value.phase === null || phases.has(String(value.phase))) && Number.isSafeInteger(value.completedBatches) && Number.isSafeInteger(value.totalBatches) && validProgress(value) &&
    typeof value.startedAt === "string" && typeof value.updatedAt === "string" && typeof value.canCancel === "boolean" &&
    (value.error === undefined || errorCodes.has(value.error as BillAnalysisErrorCode)) && (value.status !== "error" || value.error !== undefined) &&
    (value.requestId === undefined || (typeof value.requestId === "string" && uuidPattern.test(value.requestId))) &&
    (!value.canCancel || ((value.status === "processing" || value.status === "stopping") && typeof value.requestId === "string"));
}

function validEntry(value: unknown): value is BillAnalysisEntryDto {
  return object(value) && typeof value.id === "string" && validScope(value.scope) && validLabels(value.scopeLabels) && typeof value.updatedAt === "string" &&
    (value.report === null || validReport(value.report)) && (value.task === null || validTask(value.task));
}

function mergeEntries(current: BillAnalysisEntryDto[], incoming: BillAnalysisEntryDto[]) {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const previous = entries.get(entry.id);
    if (!previous || entry.updatedAt > previous.updatedAt ||
      (entry.updatedAt === previous.updatedAt && (entry.task?.updatedAt ?? "") >= (previous.task?.updatedAt ?? ""))) entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function billAnalysisScopeKey(scope: BillAnalysisScope): string {
  return JSON.stringify([scope.mode, scope.period, scope.ledgerId, scope.actorMemberId]);
}

export class BillAnalysisClientError extends Error {
  constructor(readonly code: BillAnalysisErrorCode) { super(code); }
}

export class BillAnalysisController {
  private state: BillAnalysisClientSnapshot = initial;
  private listeners = new Set<() => void>();
  private run = 0;
  private discovery = 0;
  private disposed = false;
  private submission: AbortController | null = null;
  private observations = new Set<AbortController>();
  private locale: Locale | undefined;
  private expandedEntries = false;

  constructor(private readonly options: Options) {}

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setLocale = (locale: Locale) => { this.locale = locale; };

  private update(patch: Partial<BillAnalysisClientSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private owns(requestId: string, run: number) {
    return !this.disposed && this.run === run && this.state.pending?.requestId === requestId;
  }

  private removePointer() {
    try { this.options.storage().removeItem(storageKey); } catch { /* Server discovery does not depend on browser storage. */ }
  }

  private stopObservations() {
    for (const observation of this.observations) observation.abort();
    this.observations.clear();
  }

  private apply(result: BillAnalysisOutcome) {
    if (this.state.pending?.requestId !== result.requestId || this.disposed) return;
    if (result.status === "processing" || result.status === "stopping" || result.status === "unknown") {
      const phase = result.status === "processing" ? result.phase ?? (this.state.phase === "unknown" ? "processing" : this.state.phase ?? "processing") : result.status;
      this.update({ outcome: result, phase, pending: { ...this.state.pending, canCancel: result.status !== "unknown" },
        completedBatches: result.completedBatches ?? this.state.completedBatches, totalBatches: result.totalBatches ?? this.state.totalBatches });
      return;
    }
    const completedScope = this.state.pending.scope;
    const completedLabels = this.state.pending.scopeLabels;
    this.removePointer();
    this.update({ pending: null, phase: null, outcome: result, completedScope, completedLabels });
  }

  initialize = async () => {
    this.disposed = false;
    const run = ++this.run;
    this.submission?.abort();
    this.submission = null;
    this.stopObservations();
    this.expandedEntries = false;
    let requestId: string | undefined;
    let storageAvailable = true;
    try {
      const raw = this.options.storage().getItem(storageKey);
      if (raw) {
        try {
          const pointer: unknown = JSON.parse(raw);
          if (object(pointer) && pointer.identity === this.options.identity && pointer.version === BILL_ANALYSIS_VERSION &&
            typeof pointer.requestId === "string" && uuidPattern.test(pointer.requestId) && Object.keys(pointer).length === 3) requestId = pointer.requestId;
          else this.removePointer();
        } catch { this.removePointer(); }
      }
    } catch { storageAvailable = false; }
    if (this.disposed || this.run !== run) return;
    this.update({ ...initial, ready: true, storageAvailable,
      pending: requestId ? { requestId, canCancel: false, scope: null, scopeLabels: null, locale: null } : null, phase: requestId ? "unknown" : null });
    if (requestId) await this.confirm();
    if (!this.disposed && this.run === run) await this.discover();
  };

  start(scope: BillAnalysisScope, locale: Locale, scopeLabels?: ScopeLabels): "started" | "busy" | "not-ready" {
    if (this.state.pending) return "busy";
    if (this.disposed || !this.state.ready) return "not-ready";
    const requestId = this.options.uuid();
    if (!uuidPattern.test(requestId)) return "not-ready";
    let storageAvailable = true;
    try {
      this.options.storage().setItem(storageKey, JSON.stringify({ identity: this.options.identity, requestId, version: BILL_ANALYSIS_VERSION }));
    } catch { storageAvailable = false; }
    const fixedScope = { ...scope };
    const run = ++this.run;
    this.stopObservations();
    this.submission = new AbortController();
    this.update({ pending: { requestId, canCancel: false, scope: fixedScope, scopeLabels: scopeLabels ? { ...scopeLabels } : null, locale }, phase: "preparing", outcome: null,
      completedScope: null, completedLabels: null, focusedReport: null, completedBatches: 0, totalBatches: 0, storageAvailable, entriesLoading: false });
    void this.generate(requestId, fixedScope, locale, run, this.submission.signal);
    return "started";
  }

  private async generate(requestId: string, scope: BillAnalysisScope, locale: Locale, run: number, signal: AbortSignal) {
    try {
      const response = await this.options.request({ operation: "generate", requestId, scope, locale }, signal);
      const body: unknown = await response.json();
      if (!this.owns(requestId, run)) return;
      if (!response.ok) {
        const error = response.status === 401 ? "UNAUTHORIZED" : object(body) && errorCodes.has(body.error as BillAnalysisErrorCode)
          ? body.error as BillAnalysisErrorCode : null;
        if (error) this.apply({ requestId, status: "error", error });
        else throw new Error("Unconfirmed analysis admission");
        return;
      }
      if (!object(body)) throw new Error("Invalid analysis response");
      this.apply(outcome(body.result, requestId));
    } catch {
      if (this.owns(requestId, run)) this.apply({ requestId, status: "unknown" });
    } finally {
      if (this.run === run) this.submission = null;
    }
  }

  confirm = async () => {
    const requestId = this.state.pending?.requestId;
    if (!requestId) { await this.discover(); return; }
    if (this.disposed) return;
    const run = this.run;
    const observation = new AbortController();
    this.observations.add(observation);
    try {
      const response = await this.options.request({ operation: "query", requestId }, observation.signal);
      const body: unknown = await response.json();
      if (!this.owns(requestId, run)) return;
      if (response.status === 401) { this.apply({ requestId, status: "error", error: "UNAUTHORIZED" }); return; }
      if (!response.ok && object(body) && body.error === "CONFLICT") { this.apply({ requestId, status: "error", error: "CONFLICT" }); return; }
      if (!response.ok || !object(body)) throw new Error("Unconfirmed analysis status");
      this.apply(outcome(body.result, requestId));
    } catch {
      if (this.owns(requestId, run)) this.apply({ requestId, status: "unknown" });
    } finally { this.observations.delete(observation); }
  };

  discover = async () => {
    if (this.disposed) return;
    const run = this.run;
    const discovery = ++this.discovery;
    const observation = new AbortController();
    this.observations.add(observation);
    this.update({ entriesLoading: true });
    try {
      const result = await this.listEntries(undefined, observation.signal);
      if (this.disposed || this.run !== run || this.discovery !== discovery) return;
      const overlaps = result.entries.some((entry) => this.state.entries.some((saved) => saved.id === entry.id));
      const cursor = this.expandedEntries && (overlaps || !result.cursor) ? this.state.entriesCursor : result.cursor;
      this.update({ entries: mergeEntries(this.state.entries, [...result.entries, ...(result.active ? [result.active] : [])]), entriesCursor: cursor,
        entriesReady: true, entriesLoading: false, entriesError: null, activeEntry: result.active });
      const pending = this.state.pending;
      const matching = [...result.entries, ...(result.active ? [result.active] : [])].find((entry) => entry.task &&
        ((pending?.requestId && entry.task.requestId === pending.requestId) || (pending?.taskId && entry.task.id === pending.taskId)));
      if (matching?.task && (matching.task.status === "success" || matching.task.status === "error")) {
        if (pending?.requestId && matching.task.requestId === pending.requestId) {
          if (matching.task.status === "error") this.apply({ requestId: pending.requestId, status: "error", error: matching.task.error });
          else if (matching.report) this.apply({ requestId: pending.requestId, status: "success", reportId: matching.report.id, generation: matching.report.generation });
        } else this.update({ pending: null, phase: null, outcome: null, completedScope: matching.scope, completedLabels: matching.scopeLabels });
      }
      const active = result.active;
      if (active?.task && (active.task.status === "processing" || active.task.status === "stopping")) {
        if (!pending?.requestId || active.task.requestId === pending.requestId || matching) {
          this.update({ pending: { requestId: active.task.requestId, taskId: active.task.id,
            canCancel: active.task.canCancel && Boolean(active.task.requestId), scope: active.scope, scopeLabels: active.scopeLabels,
            locale: pending?.requestId === active.task.requestId ? pending?.locale ?? null : null },
          phase: active.task.status === "stopping" ? "stopping" : active.task.phase ?? "processing",
          completedBatches: active.task.completedBatches, totalBatches: active.task.totalBatches, outcome: null });
        }
      } else if (this.state.pending && !this.state.pending.requestId) this.update({ pending: null, phase: null });
    } catch (error) {
      if (this.disposed || this.run !== run || this.discovery !== discovery) return;
      this.update({ entriesReady: true, entriesLoading: false, entriesError: error instanceof BillAnalysisClientError ? error.code : "UNAVAILABLE",
        ...(this.state.pending ? { phase: "unknown" as const, pending: { ...this.state.pending, canCancel: false } } : {}) });
    } finally { this.observations.delete(observation); }
  };

  observe = async () => {
    const run = this.run;
    if (this.state.pending?.requestId && !this.submission) await this.confirm();
    if (!this.disposed && this.run === run) await this.discover();
  };

  cancel = async () => {
    const pending = this.state.pending;
    const requestId = pending?.requestId;
    if (!requestId || !pending.canCancel || this.disposed || this.state.phase === "stopping") return;
    const run = ++this.run;
    this.submission?.abort();
    this.submission = null;
    this.stopObservations();
    this.update({ phase: "stopping", entriesLoading: false });
    const observation = new AbortController();
    this.observations.add(observation);
    try {
      const response = await this.options.request({ operation: "cancel", requestId }, observation.signal);
      const body: unknown = await response.json();
      if (!this.owns(requestId, run)) return;
      if (response.status === 401) { this.apply({ requestId, status: "error", error: "UNAUTHORIZED" }); return; }
      if (!response.ok || !object(body)) throw new Error("Unconfirmed analysis cancellation");
      this.apply(outcome(body.result, requestId));
    } catch {
      if (this.owns(requestId, run)) this.apply({ requestId, status: "unknown" });
    } finally { this.observations.delete(observation); }
  };

  async loadReport(target: { reportId: string } | { scope: BillAnalysisScope }, signal?: AbortSignal): Promise<AnyBillReportDto | null> {
    const body = await this.json({ operation: "report", ...target }, signal);
    if (body.report === null) return null;
    if (!validReport(body.report) || (body.report.purpose === "reconciliation" ? !isBillReconciliationReport(body.report)
      : !("body" in body.report) || !object(body.report.body) || !("metrics" in body.report) || !Array.isArray(body.report.metrics) || !("evidence" in body.report) || !Array.isArray(body.report.evidence))) {
      throw new BillAnalysisClientError("INVALID_RESPONSE");
    }
    return body.report as unknown as AnyBillReportDto;
  }

  async listReports(cursor?: string, signal?: AbortSignal): Promise<{ reports: BillAnalysisReportListItem[]; cursor: string | null }> {
    const body = await this.json({ operation: "list", ...(cursor ? { cursor } : {}) }, signal);
    if (!Array.isArray(body.reports) || body.reports.length > 20 || !body.reports.every(validReport) || (body.cursor !== null && typeof body.cursor !== "string")) throw new BillAnalysisClientError("INVALID_RESPONSE");
    return body as unknown as { reports: BillAnalysisReportListItem[]; cursor: string | null };
  }

  async listEntries(cursor?: string, signal?: AbortSignal): Promise<BillAnalysisEntriesDto> {
    const body = await this.json({ operation: "entries", ...(cursor ? { cursor } : {}), ...(this.locale ? { locale: this.locale } : {}) }, signal);
    if (!Array.isArray(body.entries) || body.entries.length > 20 || !body.entries.every(validEntry) ||
      (body.cursor !== null && typeof body.cursor !== "string") || (body.active !== null && (!validEntry(body.active) || !body.active.task || !["processing", "stopping"].includes(body.active.task.status)))) {
      throw new BillAnalysisClientError("INVALID_RESPONSE");
    }
    return body as unknown as BillAnalysisEntriesDto;
  }

  loadMoreEntries = async () => {
    const cursor = this.state.entriesCursor;
    if (!cursor || this.state.entriesLoading || this.disposed) return;
    const run = this.run;
    const observation = new AbortController();
    this.observations.add(observation);
    this.update({ entriesLoading: true });
    try {
      const result = await this.listEntries(cursor, observation.signal);
      if (this.disposed || this.run !== run) return;
      this.expandedEntries = true;
      this.update({ entries: mergeEntries(this.state.entries, result.entries), entriesCursor: result.cursor, entriesLoading: false, entriesError: null });
    } catch (error) {
      if (!this.disposed && this.run === run) this.update({ entriesLoading: false, entriesError: error instanceof BillAnalysisClientError ? error.code : "UNAVAILABLE" });
    } finally { this.observations.delete(observation); }
  };

  private async json(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.options.request(input, signal);
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = response.status === 401 ? "UNAUTHORIZED" : object(body) && errorCodes.has(body.error as BillAnalysisErrorCode)
        ? body.error as BillAnalysisErrorCode : "UNAVAILABLE";
      throw new BillAnalysisClientError(error);
    }
    if (!object(body)) throw new BillAnalysisClientError("INVALID_RESPONSE");
    return body;
  }

  interrupt = () => {
    ++this.run;
    this.submission?.abort();
    this.submission = null;
    this.stopObservations();
    this.update({ entriesLoading: false, ...(this.state.pending ? { phase: "unknown" as const, pending: { ...this.state.pending, canCancel: false } } : {}) });
  };

  dismiss = () => {
    if (!this.state.pending) this.update({ outcome: null, completedScope: null, completedLabels: null });
  };

  focusReport = (reportId: string | null, scope: BillAnalysisScope | null) => {
    this.update({ focusedReport: reportId ? { reportId, ownerScopeKey: scope ? billAnalysisScopeKey(scope) : "none" } : null });
  };

  dispose = (preservePending = false) => {
    this.disposed = true;
    ++this.run;
    this.submission?.abort();
    this.submission = null;
    this.stopObservations();
    if (!preservePending) this.removePointer();
    this.update({ ...initial });
  };
}
