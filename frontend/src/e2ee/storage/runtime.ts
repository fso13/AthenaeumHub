/**
 * Lazy owner of the browser E2EE storage.
 *
 * The production entry points (session/outbox/device flows, wired in E7-F5)
 * share one `E2eeStorage` instance. Keeping the factory here — instead of
 * constructing IndexedDB ad hoc — gives the logout hook a single place to wipe
 * every store and close the connection, and lets tests inject a memory store
 * without a browser.
 */
import { createIndexedDbStorage } from './indexedDb';
import type { E2eeStorage } from './types';

let current: E2eeStorage | null = null;

export function getE2eeStorage(): E2eeStorage {
  current ??= createIndexedDbStorage();
  return current;
}

/** Replaces the shared storage (tests, or an F5 bootstrap with a custom DB). */
export function configureE2eeStorage(storage: E2eeStorage | null): void {
  current = storage;
}

/** Drops the cached handle after the logout hook closed it. */
export function resetE2eeStorage(): void {
  current = null;
}
