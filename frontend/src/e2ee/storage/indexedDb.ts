/**
 * IndexedDB storage adapter (the browser adapter; §2.3/§2.4).
 *
 * Only one database per `databaseName` is opened; every record lives in a
 * dedicated object store. Values are stored through IndexedDB's structured
 * clone, which preserves non-extractable `CryptoKey` objects.
 *
 * `transact()` implements the atomic unit of §3.4.6: all reads run first, then
 * every staged write is issued on the same IDB transaction. A body rejection
 * aborts the transaction before any write is issued, so a partially shifted
 * ratchet state can never be persisted. Transaction bodies must not await
 * anything except storage operations (WebCrypto work belongs before commit).
 */
import { E2eeError } from '../errors';
import {
  E2EE_STORE_NAMES,
  assertTransactionStores,
  type E2eeStorage,
  type E2eeStoreName,
  type E2eeTransaction,
  type E2eeTransactionMode,
} from './types';

export interface IndexedDbStorageOptions {
  readonly databaseName?: string;
  readonly version?: number;
  /** Injection point for tests; defaults to `globalThis.indexedDB`. */
  readonly factory?: IDBFactory;
}

export const DEFAULT_DATABASE_NAME = 'krug-e2ee';
const DEFAULT_VERSION = 1;

function storageError(error: unknown): E2eeError {
  if (error instanceof E2eeError) return error;
  return new E2eeError('KEY_STORAGE_UNAVAILABLE', 'IndexedDB operation failed');
}

function resolveFactory(factory: IDBFactory | undefined): IDBFactory {
  const resolved = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!resolved) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'IndexedDB is unavailable in this context');
  }
  return resolved;
}

type StagedOperation =
  { readonly kind: 'put'; readonly value: unknown } | { readonly kind: 'delete' };

interface StagedState {
  readonly stores: Map<E2eeStoreName, Map<string, StagedOperation>>;
}

function stagedStore(state: StagedState, name: E2eeStoreName): Map<string, StagedOperation> {
  const existing = state.stores.get(name);
  if (!existing) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'transaction does not include the requested store',
    );
  }
  return existing;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
  });
}

function applyStagedKeys(
  base: readonly string[],
  operations: Map<string, StagedOperation>,
): string[] {
  const keys = new Set(base.filter((key): key is string => typeof key === 'string'));
  for (const [key, operation] of operations) {
    if (operation.kind === 'delete') keys.delete(key);
    else keys.add(key);
  }
  return [...keys].sort();
}

export function createIndexedDbStorage(options: IndexedDbStorageOptions = {}): E2eeStorage {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const version = options.version ?? DEFAULT_VERSION;
  let databasePromise: Promise<IDBDatabase> | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise;
    let factory: IDBFactory;
    try {
      factory = resolveFactory(options.factory);
    } catch (error) {
      return Promise.reject(storageError(error));
    }
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(databaseName, version);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of E2EE_STORE_NAMES) {
          if (!database.objectStoreNames.contains(store)) {
            database.createObjectStore(store);
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () =>
        reject(new E2eeError('KEY_STORAGE_UNAVAILABLE', 'IndexedDB upgrade is blocked'));
    });
    databasePromise.catch(() => {
      databasePromise = null;
    });
    return databasePromise;
  }

  async function run<T>(
    name: E2eeStoreName,
    mode: IDBTransactionMode,
    operation: (objectStore: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await openDatabase();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(name, mode);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let request: IDBRequest<T>;
      try {
        request = operation(transaction.objectStore(name));
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(storageError(error));
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(request.result);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error);
    });
  }

  async function runTransaction<T>(
    storeNames: readonly E2eeStoreName[],
    mode: E2eeTransactionMode,
    body: (transaction: E2eeTransaction) => Promise<T>,
  ): Promise<T> {
    const names = assertTransactionStores(storeNames);
    const database = await openDatabase();

    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(names, mode);
      } catch (error) {
        reject(storageError(error));
        return;
      }

      const staged: StagedState = {
        stores: new Map(names.map((name) => [name, new Map<string, StagedOperation>()])),
      };
      let bodySettled = false;
      let transactionFinished = false;
      let result: T;
      let failure: unknown = null;
      let transactionFailure: unknown = null;
      let resolved = false;
      let rejected = false;

      const rejectOnce = (error: unknown) => {
        if (rejected) return;
        rejected = true;
        reject(storageError(error));
      };
      const resolveOnce = (value: T) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const flushWrites = (): boolean => {
        let wrote = false;
        for (const [name, operations] of staged.stores) {
          if (operations.size === 0) continue;
          const objectStore = transaction.objectStore(name);
          for (const [key, operation] of operations) {
            if (operation.kind === 'delete') objectStore.delete(key);
            else objectStore.put(operation.value, key);
            wrote = true;
          }
        }
        return wrote;
      };

      transaction.oncomplete = () => {
        transactionFinished = true;
        if (failure) {
          rejectOnce(failure);
          return;
        }
        if (bodySettled) resolveOnce(result);
      };
      transaction.onabort = () => {
        transactionFinished = true;
        rejectOnce(
          failure ??
            transactionFailure ??
            transaction.error ??
            new E2eeError('KEY_STORAGE_UNAVAILABLE', 'IndexedDB transaction aborted'),
        );
      };
      transaction.onerror = () => {
        // The abort handler reports the actual reason; keep the request error
        // captured separately so it cannot mask a body failure.
        if (transactionFailure === null) transactionFailure = transaction.error ?? null;
      };

      const stagedApi: E2eeTransaction = {
        async get<R>(name: E2eeStoreName, key: string): Promise<R | null> {
          const operations = stagedStore(staged, name);
          const operation = operations.get(key);
          if (operation) {
            return operation.kind === 'put' ? (structuredClone(operation.value) as R) : null;
          }
          const value = await requestResult<unknown>(transaction.objectStore(name).get(key));
          return value === undefined ? null : (value as R);
        },
        async put<R>(name: E2eeStoreName, key: string, value: R): Promise<void> {
          if (mode === 'readonly') {
            throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'read-only E2EE transaction');
          }
          stagedStore(staged, name).set(key, { kind: 'put', value: structuredClone(value) });
        },
        async delete(name: E2eeStoreName, key: string): Promise<void> {
          if (mode === 'readonly') {
            throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'read-only E2EE transaction');
          }
          stagedStore(staged, name).set(key, { kind: 'delete' });
        },
        async keys(name: E2eeStoreName): Promise<string[]> {
          const operations = stagedStore(staged, name);
          const base = await requestResult<IDBValidKey[]>(
            transaction.objectStore(name).getAllKeys(),
          );
          return applyStagedKeys(
            base.filter((key): key is string => typeof key === 'string'),
            operations,
          );
        },
      };

      Promise.resolve()
        .then(() => body(stagedApi))
        .then(
          (value) => {
            bodySettled = true;
            result = value;
            if (transactionFinished) {
              // The body awaited something non-IDB and the transaction had no
              // pending request left; it may already have committed.
              const touched = [...staged.stores.values()].some((operations) => operations.size > 0);
              if (touched) {
                rejectOnce(
                  new E2eeError(
                    'KEY_STORAGE_UNAVAILABLE',
                    'transaction body awaited non-storage work; writes were not committed',
                  ),
                );
                return;
              }
              resolveOnce(value);
              return;
            }
            try {
              flushWrites();
            } catch (error) {
              failure = error;
              try {
                transaction.abort();
              } catch {
                rejectOnce(error);
              }
            }
          },
          (error) => {
            bodySettled = true;
            failure = error;
            if (transactionFinished) {
              rejectOnce(error);
              return;
            }
            try {
              transaction.abort();
            } catch {
              rejectOnce(error);
            }
          },
        );
    });
  }

  return {
    kind: 'indexeddb',
    async get<T>(name: E2eeStoreName, key: string) {
      const value = await run<unknown>(name, 'readonly', (objectStore) => objectStore.get(key));
      return value === undefined ? null : (value as T);
    },
    async put<T>(name: E2eeStoreName, key: string, value: T) {
      await run(name, 'readwrite', (objectStore) => objectStore.put(value, key));
    },
    async delete(name: E2eeStoreName, key: string) {
      await run<undefined>(name, 'readwrite', (objectStore) => objectStore.delete(key));
    },
    async keys(name: E2eeStoreName) {
      const keys = await run<IDBValidKey[]>(name, 'readonly', (objectStore) =>
        objectStore.getAllKeys(),
      );
      return keys.filter((key): key is string => typeof key === 'string').sort();
    },
    async clear(name: E2eeStoreName) {
      await run(name, 'readwrite', (objectStore) => objectStore.clear());
    },
    transact<T>(
      storeNames: readonly E2eeStoreName[],
      mode: E2eeTransactionMode,
      body: (transaction: E2eeTransaction) => Promise<T>,
    ): Promise<T> {
      return runTransaction(storeNames, mode, body);
    },
    async close() {
      if (!databasePromise) return;
      try {
        const database = await databasePromise;
        database.close();
      } finally {
        databasePromise = null;
      }
    },
  };
}
