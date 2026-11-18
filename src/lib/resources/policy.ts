export const RESOURCE_POLICIES = {
  import: { concurrent: { global: 2, household: 1, member: 1 }, perMinute: { global: 20, household: 10, member: 8 }, leaseMs: 180_000 },
  ai: { concurrent: { global: 1, household: 1, member: 1 }, perMinute: { global: 60, household: 20, member: 10 }, leaseMs: 75_000 },
  voice: { concurrent: { global: 4, household: 2, member: 1 }, perMinute: { global: 30, household: 12, member: 6 }, leaseMs: 75_000 },
  export: { concurrent: { global: 2, household: 1, member: 1 }, perMinute: { global: 12, household: 4, member: 2 }, leaseMs: 180_000 },
} as const;

export type ResourceKind = keyof typeof RESOURCE_POLICIES;
export type ResourceScope = "global" | "household" | "member";

export class ResourceBusyError extends Error {
  readonly code = "BUSY";
  constructor(readonly retryAfterSeconds = 2) { super("BUSY"); }
}

export class ResourceExpiredError extends Error {
  readonly code = "EXPIRED";
  constructor() { super("EXPIRED"); }
}

export function consumeResourceWindow(
  window: { startedAt: Date; used: number },
  now: Date,
  capacity: number,
) {
  const expiresAt = window.startedAt.getTime() + 60_000;
  const current = now.getTime() >= expiresAt ? { startedAt: now, used: 0 } : window;
  if (current.used >= capacity) throw new ResourceBusyError(Math.max(1, Math.ceil((expiresAt - now.getTime()) / 1000)));
  return { startedAt: current.startedAt, used: current.used + 1 };
}
