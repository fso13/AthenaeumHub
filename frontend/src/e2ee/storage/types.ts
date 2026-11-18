/**
 * Key-value storage abstraction for E2EE material (§2.3, §2.4).
 *
 * Private keys and `K_storage` live in IndexedDB as non-extractable CryptoKeys.
 * `localStorage`/`sessionStorage`/cookies/logs are forbidden; this module only
 * talks to a structured-clone-capable store (IndexedDB in the browser, an
 * in-memory store in tests).
 *
 * E7-F2 adds `transact()`: the atomic unit required by §3.4.6, where a ratchet
 * state, the exact envelope bytes, the outbox row and the local plaintext copy
 * must commit together (or not at all). Transaction bodies must only await
 * storage operations; WebCrypto work belongs before the transaction opens.
 */
import { E2eeError } from '../errors';
import { assertPrivateKey, assertSecretKey } from '../crypto/keyGuards';

export const E2EE_STORE_NAMES = [
  'keys',
  'prekeys',
  'sessions',
  'outbox',
  'localMessages',
  'pins',
] as const;

export type E2eeStoreName = (typeof E2EE_STORE_NAMES)[number];

export type E2eeTransactionMode = 'readonly' | 'readwrite';

/**
 * Operations available inside one storage transaction. Writes issued through
 * this handle are only durable when the body resolves; a body rejection aborts
 * every write of the transaction.
 */
export interface E2eeTransaction {
  get<T>(store: E2eeStoreName, key: string): Promise<T | null>;
  put<T>(store: E2eeStoreName, key: string, value: T): Promise<void>;
  delete(store: E2eeStoreName, key: string): Promise<void>;
  keys(store: E2eeStoreName): Promise<string[]>;
}

export interface E2eeStorage {
  readonly kind: 'indexeddb' | 'memory';
  get<T>(store: E2eeStoreName, key: string): Promise<T | null>;
  put<T>(store: E2eeStoreName, key: string, value: T): Promise<void>;
  /** Resolves once the record is gone (idempotent: deleting a missing key is fine). */
  delete(store: E2eeStoreName, key: string): Promise<void>;
  keys(store: E2eeStoreName): Promise<string[]>;
  clear(store: E2eeStoreName): Promise<void>;
  /**
   * Runs `body` in one atomic transaction spanning `stores`. Either every write
   * commits once the body resolves, or (body throws / the transaction aborts)
   * none commits.
   */
  transact<T>(
    stores: readonly E2eeStoreName[],
    mode: E2eeTransactionMode,
    body: (transaction: E2eeTransaction) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export function assertStoreName(value: string): E2eeStoreName {
  if (!(E2EE_STORE_NAMES as readonly string[]).includes(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown E2EE object store');
  }
  return value as E2eeStoreName;
}

export function assertTransactionStores(
  stores: readonly E2eeStoreName[],
): readonly E2eeStoreName[] {
  if (!Array.isArray(stores) || stores.length === 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'a transaction needs at least one store');
  }
  for (const store of stores) assertStoreName(store);
  return [...new Set(stores)];
}

/** Persist a private CryptoKey, refusing extractable/materialised keys. */
export async function putPrivateKey(
  storage: E2eeStorage,
  store: E2eeStoreName,
  key: string,
  cryptoKey: CryptoKey,
): Promise<void> {
  assertPrivateKey(cryptoKey, `private key ${store}/${key}`);
  await storage.put(store, key, cryptoKey);
}

export async function getPrivateKey(
  storage: E2eeStorage,
  store: E2eeStoreName,
  key: string,
): Promise<CryptoKey | null> {
  const value = await storage.get<CryptoKey>(store, key);
  if (value === null) return null;
  return assertPrivateKey(value, `private key ${store}/${key}`);
}

/** Persist a non-extractable secret key (only `K_storage` today). */
export async function putSecretKey(
  storage: E2eeStorage,
  store: E2eeStoreName,
  key: string,
  cryptoKey: CryptoKey,
): Promise<void> {
  assertSecretKey(cryptoKey, `secret key ${store}/${key}`);
  await storage.put(store, key, cryptoKey);
}

export async function getSecretKey(
  storage: E2eeStorage,
  store: E2eeStoreName,
  key: string,
): Promise<CryptoKey | null> {
  const value = await storage.get<CryptoKey>(store, key);
  if (value === null) return null;
  return assertSecretKey(value, `secret key ${store}/${key}`);
}
