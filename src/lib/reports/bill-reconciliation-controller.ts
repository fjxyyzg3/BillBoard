import type { BillAnalysisErrorCode } from "./bill-analysis-types";
import { normalizeReconciliationManualGroups, normalizeReconciliationRetentionGroups, previewReconciliationSelection } from "./bill-reconciliation-selection";
import { defaultReconciliationRetentionGroups } from "./bill-reconciliation-grouping";
import type { BillReconciliationReportDto, ReconciliationApplyInput, ReconciliationApplyOutcome, ReconciliationManualGroup, ReconciliationManualSelectionGroup, ReconciliationRetentionGroup, ReconciliationSuggestion } from "./bill-reconciliation-types";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<globalThis.Storage, "length" | "key">>;
type Pointer = { identity: string; version: 1; requestId: string; reportId: string; generation: number };
type Options = { identity: string; uuid: () => string; storage: () => Storage; request: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>; requestByteLength?: (body: Record<string, unknown>) => number };
export type ReconciliationApplicationSnapshot = {
  ready: boolean;
  storageAvailable: boolean;
  pending: Omit<Pointer, "identity" | "version"> | null;
  phase: "submitting" | "querying" | "unknown" | null;
  outcome: ReconciliationApplyOutcome | null;
  accessError: BillAnalysisErrorCode | null;
  noticeVisible: boolean;
  selectionIds: string[] | null;
  manualGroups: ReconciliationManualSelectionGroup[] | null;
  draftRevision: number;
};
export type ReconciliationManualEditor = { noticeId: string; refs: string[]; keepRef: string | null; confirmed: boolean; editingGroupKey: string | null };
export type ReconciliationWorkspaceDraft = { suggestionIds: string[]; manualGroups: ReconciliationManualGroup[]; editor: ReconciliationManualEditor | null; retentionGroups?: ReconciliationRetentionGroup[]; generationReset?: boolean; dirty?: boolean };
export const RECONCILIATION_APPLICATION_STORAGE_KEY = "billboard:bill-reconciliation-application:v1";
export const RECONCILIATION_APPLICATION_STORAGE_PREFIX = `${RECONCILIATION_APPLICATION_STORAGE_KEY}:`;
export const MAX_RECONCILIATION_APPLICATION_POINTERS = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errors = new Set<BillAnalysisErrorCode>(["INVALID", "CONSENT_REQUIRED", "BUSY", "TOO_LARGE", "NO_DATA", "NOT_ACCEPTED", "CONFLICT", "UNAUTHORIZED", "ENCRYPTION_CHANGED", "TIMEOUT", "CANCELLED", "INTERRUPTED", "INVALID_RESPONSE", "UNAVAILABLE"]);
export const emptyReconciliationApplication: ReconciliationApplicationSnapshot = { ready: false, storageAvailable: true, pending: null, phase: null, outcome: null, accessError: null, noticeVisible: false, selectionIds: null, manualGroups: null, draftRevision: 0 };

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, maximum = 65_536): value is string { return typeof value === "string" && value.length <= maximum; }
function positiveFen(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647; }
function storageKeys(storage: Storage): string[] {
  if (typeof storage.key !== "function" || !Number.isSafeInteger(storage.length)) return [];
  const keys: string[] = [];
  for (let index = 0; index < Number(storage.length); index++) { const key = storage.key(index); if (key !== null) keys.push(key); }
  return keys;
}
export function reconciliationApplicationStorageKey(identity: string, requestId: string): string {
  return `${RECONCILIATION_APPLICATION_STORAGE_PREFIX}${encodeURIComponent(identity)}:${requestId}`;
}
export function clearReconciliationApplicationPointers(storage: Storage): void {
  for (const key of storageKeys(storage)) if (key.startsWith(RECONCILIATION_APPLICATION_STORAGE_PREFIX)) storage.removeItem(key);
  storage.removeItem(RECONCILIATION_APPLICATION_STORAGE_KEY);
}
function parsePointer(raw: string | null): Pointer | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return object(value) && Object.keys(value).length === 5 && text(value.identity, 512) && value.version === 1 &&
      text(value.requestId, 36) && uuidPattern.test(value.requestId) && text(value.reportId, 128) && value.reportId.length > 0 && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
      ? value as Pointer : null;
  } catch { return null; }
}

export function isBillReconciliationReport(value: unknown): value is BillReconciliationReportDto {
  if (!object(value) || value.purpose !== "reconciliation" || value.version !== 1 || "assertions" in value ||
    !Array.isArray(value.records) || value.records.length > 1000 || !Array.isArray(value.suggestions) || value.suggestions.length > 200) return false;
  const refs = new Set<string>();
  for (const row of value.records) {
    if (!object(row) || !text(row.ref, 100) || !/^r[1-9]\d*$/.test(row.ref) || refs.has(row.ref) ||
      !text(row.occurredAt, 40) || !Number.isFinite(Date.parse(row.occurredAt)) || !text(row.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !["income", "expense"].includes(String(row.type)) || !positiveFen(row.amountFen) || !text(row.categoryName, 400) ||
      !text(row.memberLabel, 400) || !text(row.ledgerLabel, 400) || !text(row.memberAlias, 100) || !text(row.ledgerAlias, 100) ||
      (row.note !== null && !text(row.note)) || (row.source !== null && !text(row.source, 100)) ||
      !["second", "minute", "day", "unknown"].includes(String(row.timePrecision)) || typeof row.timeSupplemented !== "boolean" || typeof row.aggregated !== "boolean" ||
      "sourceFingerprint" in row || "id" in row) return false;
    refs.add(row.ref);
  }
  const ids = new Set<string>();
  for (const item of value.suggestions) {
    if (!object(item) || !text(item.id, 128) || ids.has(item.id) || !text(item.title, 400) || !text(item.reason, 4000) ||
      !["duplicate", "refund", "reimbursement", "combined", "notice"].includes(String(item.kind)) || !["high", "review"].includes(String(item.confidence)) ||
      typeof item.defaultSelected !== "boolean" || typeof item.canApply !== "boolean" || (item.applied !== undefined && typeof item.applied !== "boolean") ||
      (item.readOnlyReason !== null && !text(item.readOnlyReason, 400)) || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 1000 ||
      item.evidenceRefs.some((ref) => typeof ref !== "string" || !refs.has(ref)) || !Array.isArray(item.actions) || item.actions.length > 1000 ||
      item.actions.some((action) => !object(action) || !text(action.ref, 100) || !refs.has(action.ref) || !["keep", "delete", "update"].includes(String(action.action)) || !positiveFen(action.amountFen))) return false;
    ids.add(item.id);
  }
  if (value.manualReview !== undefined) {
    if (!object(value.manualReview) || Object.keys(value.manualReview).length !== 2 || typeof value.manualReview.processing !== "boolean" || !Array.isArray(value.manualReview.records) || value.manualReview.records.length > value.records.length) return false;
    const seen = new Set<string>();
    for (const row of value.manualReview.records) {
      if (!object(row) || Object.keys(row).length !== 2 || typeof row.ref !== "string" || !refs.has(row.ref) || seen.has(row.ref) || !["available", "handled", "archived"].includes(String(row.status))) return false;
      seen.add(row.ref);
    }
  }
  return true;
}

export function defaultReconciliationSelection(suggestions: ReconciliationSuggestion[]): string[] {
  const selected: string[] = [];
  const used = new Set<string>();
  for (const item of suggestions) {
    if (!item.canApply || item.applied || !item.defaultSelected || item.confidence !== "high" || item.evidenceRefs.some((ref) => used.has(ref))) continue;
    selected.push(item.id);
    item.evidenceRefs.forEach((ref) => used.add(ref));
  }
  return selected;
}

export function defaultReconciliationWorkspaceDraft(report: BillReconciliationReportDto): ReconciliationWorkspaceDraft {
  return { suggestionIds: defaultReconciliationSelection(report.suggestions), manualGroups: [], editor: null, retentionGroups: defaultReconciliationRetentionGroups(report) };
}

export function toggleReconciliationSelection(suggestions: ReconciliationSuggestion[], selectedIds: string[], id: string): string[] {
  const item = suggestions.find((suggestion) => suggestion.id === id);
  if (!item?.canApply || item.applied) return selectedIds;
  if (selectedIds.includes(id)) return selectedIds.filter((selected) => selected !== id);
  const overlap = new Set(item.evidenceRefs);
  return [...selectedIds.filter((selected) => {
    const other = suggestions.find((suggestion) => suggestion.id === selected);
    return other?.canApply && !other.applied && !other.evidenceRefs.some((ref) => overlap.has(ref));
  }), id];
}

export class ReconciliationApplicationController {
  private state = emptyReconciliationApplication;
  private listeners = new Set<() => void>();
  private run = 0;
  private disposed = false;
  private request: AbortController | null = null;
  private inFlight = false;
  private recoveryQueue: Pointer[] = [];
  private recoveryCursor = "";
  private selections = new Map<string, string[]>();
  private submittedGroups = new Map<string, ReconciliationManualSelectionGroup[]>();
  private submittedRefs = new Map<string, string[]>();
  private drafts = new Map<string, ReconciliationWorkspaceDraft>();
  private generations = new Map<string, number>();
  private handledRefs = new Map<string, Set<string>>();
  private completedRetentionGroups = new Map<string, ReconciliationRetentionGroup[]>();
  constructor(private readonly options: Options) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => emptyReconciliationApplication;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  requestByteLength = (body: Record<string, unknown>) => {
    try {
      const bytes = this.options.requestByteLength ? this.options.requestByteLength(body) : new TextEncoder().encode(JSON.stringify(body)).byteLength;
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.POSITIVE_INFINITY;
    } catch { return Number.POSITIVE_INFINITY; }
  };
  private update(patch: Partial<ReconciliationApplicationSnapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private draftKey(report: Pick<BillReconciliationReportDto, "id" | "generation">) { return `${report.id}:${report.generation}`; }
  draftFor = (report: BillReconciliationReportDto): ReconciliationWorkspaceDraft => {
    if ((this.generations.get(report.id) ?? report.generation) > report.generation) return { suggestionIds: [], manualGroups: [], editor: null };
    const key = this.draftKey(report);
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = defaultReconciliationWorkspaceDraft(report);
      this.drafts.set(key, draft);
    }
    return draft;
  };
  activateReport = (report: BillReconciliationReportDto) => {
    const previous = this.generations.get(report.id);
    if (previous !== undefined && previous >= report.generation) return;
    this.generations.set(report.id, report.generation);
    if (previous === undefined) return;
    const discarded = [...this.drafts.keys()].some((key) => key.startsWith(`${report.id}:`) && this.drafts.get(key)?.dirty);
    for (const key of this.drafts.keys()) if (key.startsWith(`${report.id}:`)) this.drafts.delete(key);
    this.drafts.set(this.draftKey(report), { ...defaultReconciliationWorkspaceDraft(report), generationReset: discarded });
    this.update({ draftRevision: this.state.draftRevision + 1 });
  };
  saveDraft = (report: BillReconciliationReportDto, draft: ReconciliationWorkspaceDraft) => {
    if ((this.generations.get(report.id) ?? report.generation) > report.generation) return;
    this.activateReport(report);
    this.drafts.set(this.draftKey(report), structuredClone({ ...draft, dirty: true }));
    this.update({ draftRevision: this.state.draftRevision + 1 });
  };
  hasUnsavedDrafts = () => {
    const pending = this.state.pending;
    const submittedKey = pending ? this.draftKey({ id: pending.reportId, generation: pending.generation }) : null;
    return [...this.drafts.entries()].some(([key, draft]) => key !== submittedKey && draft.dirty && (draft.manualGroups.length > 0 || Boolean(draft.retentionGroups?.length) || draft.editor !== null || draft.suggestionIds.length > 0));
  };
  handledRefsFor = (report: BillReconciliationReportDto) => new Set([
    ...(this.handledRefs.get(this.draftKey(report)) ?? []),
    ...(report.manualReview?.records.filter((row) => row.status === "handled").map((row) => row.ref) ?? []),
  ]);
  completedRetentionGroupsFor = (report: BillReconciliationReportDto) => structuredClone(this.completedRetentionGroups.get(this.draftKey(report)) ?? []);
  private removePointer(requestId = this.state.pending?.requestId) {
    if (!requestId) return;
    try {
      const storage = this.options.storage();
      storage.removeItem(reconciliationApplicationStorageKey(this.options.identity, requestId));
      const legacy = parsePointer(storage.getItem(RECONCILIATION_APPLICATION_STORAGE_KEY));
      if (legacy?.identity === this.options.identity && legacy.requestId === requestId) storage.removeItem(RECONCILIATION_APPLICATION_STORAGE_KEY);
    } catch { this.update({ storageAvailable: false }); }
  }
  private storedPointers(): Pointer[] {
    const storage = this.options.storage();
    const ownerPrefix = `${RECONCILIATION_APPLICATION_STORAGE_PREFIX}${encodeURIComponent(this.options.identity)}:`;
    const keys = storageKeys(storage).filter((key) => key.startsWith(RECONCILIATION_APPLICATION_STORAGE_PREFIX));
    for (const key of keys) if (!key.startsWith(ownerPrefix)) storage.removeItem(key);
    const owned = keys.filter((key) => key.startsWith(ownerPrefix));
    if (storage.getItem(RECONCILIATION_APPLICATION_STORAGE_KEY) !== null) owned.push(RECONCILIATION_APPLICATION_STORAGE_KEY);
    owned.sort();
    const ordered = [...owned.filter((key) => key > this.recoveryCursor), ...owned.filter((key) => key <= this.recoveryCursor)].slice(0, MAX_RECONCILIATION_APPLICATION_POINTERS);
    const found = new Map<string, Pointer>();
    for (const key of ordered) {
      this.recoveryCursor = key;
      const pointer = parsePointer(storage.getItem(key));
      if (!pointer || pointer.identity !== this.options.identity || key !== RECONCILIATION_APPLICATION_STORAGE_KEY && key !== reconciliationApplicationStorageKey(pointer.identity, pointer.requestId)) {
        storage.removeItem(key);
        continue;
      }
      found.set(pointer.requestId, pointer);
    }
    return [...found.values()];
  }
  private recoverNext() {
    try {
      if (!this.recoveryQueue.length) this.recoveryQueue = this.storedPointers();
      const pointer = this.recoveryQueue.shift();
      if (pointer) this.update({ pending: { requestId: pointer.requestId, reportId: pointer.reportId, generation: pointer.generation }, phase: "unknown", selectionIds: this.selections.get(pointer.requestId) ?? null, manualGroups: this.submittedGroups.get(pointer.requestId) ?? null });
    } catch { this.update({ storageAvailable: false }); }
  }
  private owns(run: number, requestId: string) { return !this.disposed && this.run === run && this.state.pending?.requestId === requestId; }

  initialize = async () => {
    this.disposed = false;
    ++this.run;
    this.request?.abort();
    this.request = null;
    this.inFlight = false;
    this.recoveryQueue = [];
    this.recoveryCursor = "";
    this.selections.clear();
    this.submittedGroups.clear();
    this.submittedRefs.clear();
    let pointer: Pointer | null = null;
    let storageAvailable = true;
    try {
      this.recoveryQueue = this.storedPointers();
      pointer = this.recoveryQueue.shift() ?? null;
    } catch { storageAvailable = false; }
    this.update({ ...emptyReconciliationApplication, ready: true, storageAvailable,
      pending: pointer ? { requestId: pointer.requestId, reportId: pointer.reportId, generation: pointer.generation } : null,
      phase: pointer ? "unknown" : null });
    if (pointer) await this.confirm();
  };

  apply(report: BillReconciliationReportDto, suggestionIds: string[], manualGroups: ReconciliationManualSelectionGroup[] = []): "started" | "busy" | "invalid" | "not-ready" {
    if (this.state.pending) return "busy";
    if (this.disposed || !this.state.ready) return "not-ready";
    const ids = [...new Set(suggestionIds)];
    const chosen = report.suggestions.filter((item) => ids.includes(item.id));
    const refs = new Set<string>();
    if ((!ids.length && !manualGroups.length) || ids.length !== suggestionIds.length || chosen.length !== ids.length || chosen.some((item) => {
      if (!item.canApply || item.applied || item.evidenceRefs.some((ref) => refs.has(ref))) return true;
      item.evidenceRefs.forEach((ref) => refs.add(ref));
      return false;
    })) return "invalid";
    let groups: ReconciliationManualSelectionGroup[] = [];
    const retention = manualGroups.some((group) => "keepRefs" in group);
    if (manualGroups.length) {
      try {
        if (retention && !manualGroups.every((group) => "keepRefs" in group)) return "invalid";
        groups = retention ? normalizeReconciliationRetentionGroups(manualGroups as ReconciliationRetentionGroup[]) : normalizeReconciliationManualGroups(manualGroups as ReconciliationManualGroup[]);
        previewReconciliationSelection(report.records, report.suggestions, { suggestionIds: ids, manualGroups: groups });
      } catch { return "invalid"; }
      const unavailable = new Set(report.manualReview?.records.filter((row) => row.status !== "available").map((row) => row.ref));
      const handled = this.handledRefsFor(report);
      if (report.manualReview?.processing || groups.some((group) => group.refs.some((ref) => unavailable.has(ref) || handled.has(ref)))) return "invalid";
      groups.forEach((group) => group.refs.forEach((ref) => refs.add(ref)));
    }
    const requestId = this.options.uuid();
    if (!uuidPattern.test(requestId)) return "invalid";
    const base = { requestId, reportId: report.id, generation: report.generation, suggestionIds: [...ids].sort() };
    const input: ReconciliationApplyInput = groups.length ? retention
      ? { ...base, version: 3, manualGroups: structuredClone(groups) as ReconciliationRetentionGroup[] }
      : { ...base, version: 2, manualGroups: structuredClone(groups) as ReconciliationManualGroup[] } : base;
    if (this.requestByteLength({ operation: "apply", ...input }) > 16 * 1024) return "invalid";
    const pointer: Pointer = { identity: this.options.identity, version: 1, requestId, reportId: report.id, generation: report.generation };
    let storageAvailable = true;
    try {
      const storage = this.options.storage();
      const key = reconciliationApplicationStorageKey(this.options.identity, requestId);
      const prefix = `${RECONCILIATION_APPLICATION_STORAGE_PREFIX}${encodeURIComponent(this.options.identity)}:`;
      if (storage.getItem(key) !== null || storageKeys(storage).filter((stored) => stored.startsWith(prefix)).length >= MAX_RECONCILIATION_APPLICATION_POINTERS) {
        void this.initialize();
        return "busy";
      }
      const encoded = JSON.stringify(pointer);
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded) throw new Error("Result-check metadata was not saved");
    } catch { storageAvailable = false; }
    const run = ++this.run;
    this.selections.set(requestId, [...ids]);
    this.submittedGroups.set(requestId, structuredClone(groups));
    this.submittedRefs.set(requestId, [...refs]);
    this.update({ pending: { requestId, reportId: report.id, generation: report.generation }, phase: "submitting", outcome: null, accessError: null, storageAvailable, noticeVisible: true, selectionIds: [...ids], manualGroups: structuredClone(groups) });
    void this.send({ operation: "apply", ...input }, run);
    return "started";
  }

  private async send(body: Record<string, unknown>, run: number) {
    const pending = this.state.pending;
    if (!pending) return;
    this.inFlight = true;
    this.request = new AbortController();
    try {
      const response = await this.options.request(body, this.request.signal);
      const value: unknown = await response.json();
      if (!this.owns(run, pending.requestId)) return;
      if (!response.ok) {
        const code = response.status === 401 ? "UNAUTHORIZED" : object(value) && errors.has(value.error as BillAnalysisErrorCode) ? value.error as BillAnalysisErrorCode : "UNAVAILABLE";
        this.update({ phase: "unknown", accessError: code });
        return;
      }
      if (!object(value) || !object(value.result) || value.result.requestId !== pending.requestId || !["success", "error", "unknown"].includes(String(value.result.status)) ||
        (value.result.status === "error" && !errors.has(value.result.error as BillAnalysisErrorCode))) throw new Error("Invalid application receipt");
      const result = value.result as ReconciliationApplyOutcome;
      if (result.status === "unknown" || result.error === "UNAUTHORIZED" || result.error === "ENCRYPTION_CHANGED") {
        this.update({ phase: "unknown", accessError: result.error ?? null });
        return;
      }
      if (result.status === "success" && (result.reportId !== pending.reportId || result.generation !== pending.generation || !Array.isArray(result.suggestionIds))) throw new Error("Invalid successful application receipt");
      if (result.manualGroups !== undefined) {
        if (result.version === 3) normalizeReconciliationRetentionGroups(result.manualGroups as ReconciliationRetentionGroup[]);
        else normalizeReconciliationManualGroups(result.manualGroups as ReconciliationManualGroup[]);
      }
      if (result.status === "success") {
        const key = this.draftKey({ id: pending.reportId, generation: pending.generation });
        const handled = this.handledRefs.get(key) ?? new Set<string>();
        for (const ref of [...(this.submittedRefs.get(pending.requestId) ?? []), ...(result.manualGroups?.flatMap((group) => group.refs) ?? [])]) handled.add(ref);
        this.handledRefs.set(key, handled);
        if (result.version === 3 && result.manualGroups?.length) {
          this.completedRetentionGroups.set(key, [...(this.completedRetentionGroups.get(key) ?? []), ...structuredClone(result.manualGroups as ReconciliationRetentionGroup[])]);
        }
        const draft = this.drafts.get(key);
        if (draft) this.drafts.set(key, { ...draft, suggestionIds: draft.suggestionIds.filter((id) => !result.suggestionIds?.includes(id)), manualGroups: draft.manualGroups.filter((group) => !group.refs.some((ref) => handled.has(ref))), editor: null, dirty: false });
      }
      this.removePointer(pending.requestId);
      this.selections.delete(pending.requestId);
      this.submittedGroups.delete(pending.requestId);
      this.submittedRefs.delete(pending.requestId);
      this.update({ pending: null, phase: null, accessError: null, noticeVisible: true, selectionIds: null, manualGroups: null, draftRevision: this.state.draftRevision + 1, outcome: { ...result, reportId: result.reportId ?? pending.reportId, generation: result.generation ?? pending.generation } });
    } catch {
      if (this.owns(run, pending.requestId)) this.update({ phase: "unknown", accessError: null });
    } finally {
      if (this.run === run) { this.inFlight = false; this.request = null; }
    }
  }

  confirm = async () => {
    if (this.disposed || this.inFlight) return;
    if (!this.state.pending) this.recoverNext();
    if (!this.state.pending) return;
    const pending = this.state.pending;
    const run = this.run;
    this.update({ phase: "querying" });
    await this.send({ operation: "query-application", requestId: pending.requestId }, run);
    if (this.disposed || this.run !== run) return;
    // Query each recovered UUID fairly, without removing an unresolved pointer or replaying its input.
    if (!this.state.pending || this.state.pending.requestId === pending.requestId) this.recoverNext();
  };
  interrupt = () => {
    ++this.run;
    this.request?.abort();
    this.request = null;
    this.inFlight = false;
    if (this.state.pending) this.update({ phase: "unknown" });
  };
  dismiss = () => { if (!this.state.pending && this.state.outcome?.status === "success") this.update({ noticeVisible: false }); };
  dispose = (preservePending = false) => {
    this.interrupt();
    this.disposed = true;
    if (!preservePending) this.removePointer();
    this.recoveryQueue = [];
    this.selections.clear();
    this.submittedGroups.clear();
    this.submittedRefs.clear();
    this.drafts.clear();
    this.generations.clear();
    this.handledRefs.clear();
    this.completedRetentionGroups.clear();
    this.update({ ...emptyReconciliationApplication });
  };
}
