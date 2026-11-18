import { AsyncLocalStorage } from "node:async_hooks";

const authenticationStorage = new AsyncLocalStorage<{ unavailable: boolean }>();

export class AuthStorageUnavailable extends Error {
  constructor() {
    super("Authentication storage is unavailable");
    this.name = "AuthStorageUnavailable";
  }
}

export function markAuthStorageUnavailable() {
  const current = authenticationStorage.getStore();
  if (current) current.unavailable = true;
  // Auth.js logs caught callback errors; never attach a database error or cause.
  return new AuthStorageUnavailable();
}

export function withAuthStorageGuard<T>(operation: () => Promise<T>): Promise<T> {
  const state = { unavailable: false };
  return authenticationStorage.run(state, async () => {
    try {
      const result = await operation();
      if (state.unavailable) throw new AuthStorageUnavailable();
      return result;
    } catch (error) {
      if (state.unavailable) throw new AuthStorageUnavailable();
      throw error;
    }
  });
}
