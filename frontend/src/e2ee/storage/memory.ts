/**
 * In-memory storage adapter for unit tests and feature-detection fallbacks.
 *
 * It deliberately emulates IndexedDB's structured clone on read and write:
 * values are copied so a caller cannot mutate stored state (or key material)
 * through a returned reference. Transactions are serialised and commit by
 * swapping the affected store maps, so a rejected body leaves no trace.
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

type StoreMap = Map<string, unknown>;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function copyMap(source: StoreMap): StoreMap {
  const copy: StoreMap = new Map();
  for (const [key, value] of source) copy.set(key, cloneValue(value));
  return copy;
}

export function createMemoryE2eeStorage(): E2eeStorage {
  const stores = new Map<E2eeStoreName, StoreMap>();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  for (const store of E2EE_STORE_NAMES) stores.set(store, new Map());

  function assertOpen(): void {
    if (closed) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'E2EE storage is closed');
    }
  }

  function store(name: E2eeStoreName): StoreMap {
    assertOpen();
    const found = stores.get(name);
    if (!found) throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown E2EE object store');
    return found;
  }

  /** Serialises every mutation so transactions have a single writer. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(
      () => operation(),
      () => operation(),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function runTransaction<T>(
    storeNames: readonly E2eeStoreName[],
    mode: E2eeTransactionMode,
    body: (transaction: E2eeTransaction) => Promise<T>,
  ): Promise<T> {
    assertOpen();
    const names = assertTransactionStores(storeNames);
    const working = new Map<E2eeStoreName, StoreMap>();
    for (const name of names) working.set(name, copyMap(store(name)));

    function workingStore(name: E2eeStoreName): StoreMap {
      assertOpen();
      const found = working.get(name);
      if (!found) {
        throw new E2eeError(
          'KEY_STORAGE_UNAVAILABLE',
          'transaction does not include the requested store',
        );
      }
      return found;
    }

    function assertWritable(): void {
      if (mode !== 'readwrite') {
        throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'read-only E2EE transaction');
      }
    }

    const transaction: E2eeTransaction = {
      async get<R>(name: E2eeStoreName, key: string): Promise<R | null> {
        const value = workingStore(name).get(key);
        return value === undefined ? null : (cloneValue(value) as R);
      },
      async put<R>(name: E2eeStoreName, key: string, value: R): Promise<void> {
        assertWritable();
        workingStore(name).set(key, cloneValue(value));
      },
      async delete(name: E2eeStoreName, key: string): Promise<void> {
        assertWritable();
        workingStore(name).delete(key);
      },
      async keys(name: E2eeStoreName): Promise<string[]> {
        return [...workingStore(name).keys()].sort();
      },
    };

    const result = await body(transaction);
    for (const [name, map] of working) stores.set(name, map);
    return result;
  }

  return {
    kind: 'memory',
    async get<T>(name: E2eeStoreName, key: string): Promise<T | null> {
      assertOpen();
      await tail;
      const value = store(name).get(key);
      return value === undefined ? null : (cloneValue(value) as T);
    },
    async put<T>(name: E2eeStoreName, key: string, value: T): Promise<void> {
      await enqueue(async () => {
        store(name).set(key, cloneValue(value));
      });
    },
    async delete(name: E2eeStoreName, key: string): Promise<void> {
      await enqueue(async () => {
        store(name).delete(key);
      });
    },
    async keys(name: E2eeStoreName): Promise<string[]> {
      assertOpen();
      await tail;
      return [...store(name).keys()].sort();
    },
    async clear(name: E2eeStoreName): Promise<void> {
      await enqueue(async () => {
        store(name).clear();
      });
    },
    transact<T>(
      storeNames: readonly E2eeStoreName[],
      mode: E2eeTransactionMode,
      body: (transaction: E2eeTransaction) => Promise<T>,
    ): Promise<T> {
      return enqueue(() => runTransaction(storeNames, mode, body));
    },
    async close(): Promise<void> {
      await tail;
      closed = true;
      for (const map of stores.values()) map.clear();
    },
  };
}
