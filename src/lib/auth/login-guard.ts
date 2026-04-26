export type LoginGuardState = {
  attemptCount: number;
  lockedUntil: Date | null;
  updatedAt?: Date | null;
};

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function applyFailedAttempt(state: LoginGuardState | null, now: Date): LoginGuardState {
  const activeState =
    (state?.lockedUntil && state.lockedUntil <= now) ||
    (state?.updatedAt && now.getTime() - state.updatedAt.getTime() >= LOCKOUT_WINDOW_MS)
      ? null
      : state;
  const attemptCount = (activeState?.attemptCount ?? 0) + 1;

  return {
    attemptCount,
    lockedUntil: attemptCount >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_WINDOW_MS) : null,
    updatedAt: now,
  };
}

export function isLocked(state: LoginGuardState | null, now: Date) {
  return Boolean(state?.lockedUntil && state.lockedUntil > now);
}
