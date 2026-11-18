/**
 * E7-F2 atomic multi-store transactions (§3.4.6).
 *
 * Both adapters must commit `sessions` + `outbox` + `localMessages` as one unit
 * or leave no trace. IndexedDB also has to keep the transaction alive across
 * the microtask continuations of sequential reads, because the send path is
 * `read revision -> put state -> put outbox -> put local copy`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { createIndexedDbStorage } from './storage/indexedDb';
import { delay } from './test/fixtures';

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-tx-${databaseCounter}`;
}

describe('memory storage transactions', () => {
  it('commits writes across several stores atomically', async () => {
    const storage = createMemoryE2eeStorage();
    await storage.transact(['sessions', 'outbox', 'localMessages'], 'readwrite', async (tx) => {
      await tx.put('sessions', 's1', { revision: 1 });
      await tx.put('outbox', 'o1', { pending: true });
      await tx.put('localMessages', 'l1', { text: 'secret' });
      expect(await tx.get('sessions', 's1')).toEqual({ revision: 1 });
    });
    expect(await storage.get('sessions', 's1')).toEqual({ revision: 1 });
    expect(await storage.get('outbox', 'o1')).toEqual({ pending: true });
    expect(await storage.get('localMessages', 'l1')).toEqual({ text: 'secret' });
    await storage.close();
  });

  it('leaves no partial write when the body throws', async () => {
    const storage = createMemoryE2eeStorage();
    await expect(
      storage.transact(['sessions', 'outbox'], 'readwrite', async (tx) => {
        await tx.put('sessions', 's1', { revision: 1 });
        await tx.put('outbox', 'o1', { pending: true });
        throw new Error('simulated crash');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await storage.get('sessions', 's1')).toBeNull();
    expect(await storage.get('outbox', 'o1')).toBeNull();
    await storage.close();
  });

  it('sees its own writes and deletes inside the transaction', async () => {
    const storage = createMemoryE2eeStorage();
    await storage.put('outbox', 'o1', { status: 'pending' });
    await storage.transact(['outbox'], 'readwrite', async (tx) => {
      await tx.delete('outbox', 'o1');
      expect(await tx.get('outbox', 'o1')).toBeNull();
      await tx.put('outbox', 'o2', { status: 'pending' });
      expect(await tx.keys('outbox')).toEqual(['o2']);
    });
    expect(await storage.keys('outbox')).toEqual(['o2']);
    await storage.close();
  });

  it('rejects writes in a read-only transaction', async () => {
    const storage = createMemoryE2eeStorage();
    await expect(
      storage.transact(['sessions'], 'readonly', async (tx) => {
        await tx.put('sessions', 's1', { revision: 1 });
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    await storage.close();
  });

  it('serialises concurrent read-modify-write transactions', async () => {
    const storage = createMemoryE2eeStorage();
    await storage.put('sessions', 'counter', { value: 0 });
    const increment = () =>
      storage.transact(['sessions'], 'readwrite', async (tx) => {
        const current = await tx.get<{ value: number }>('sessions', 'counter');
        await tx.put('sessions', 'counter', { value: (current?.value ?? 0) + 1 });
      });
    await Promise.all([increment(), increment(), increment()]);
    expect(await storage.get('sessions', 'counter')).toEqual({ value: 3 });
    await storage.close();
  });

  it('rejects unknown stores and empty store lists', async () => {
    const storage = createMemoryE2eeStorage();
    await expect(
      storage.transact(['nope' as 'sessions'], 'readwrite', async () => undefined),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    await expect(storage.transact([], 'readwrite', async () => undefined)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await storage.close();
  });
});

describe('IndexedDB storage transactions', () => {
  it('commits writes across several stores atomically', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    await storage.transact(['sessions', 'outbox', 'localMessages'], 'readwrite', async (tx) => {
      await tx.put('sessions', 's1', { revision: 1 });
      await tx.put('outbox', 'o1', { pending: true });
      await tx.put('localMessages', 'l1', { text: 'secret' });
      expect(await tx.get('sessions', 's1')).toEqual({ revision: 1 });
    });
    expect(await storage.get('sessions', 's1')).toEqual({ revision: 1 });
    expect(await storage.get('outbox', 'o1')).toEqual({ pending: true });
    expect(await storage.get('localMessages', 'l1')).toEqual({ text: 'secret' });
    await storage.close();
  });

  it('aborts every write when the body throws after some puts', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    await expect(
      storage.transact(['sessions', 'outbox'], 'readwrite', async (tx) => {
        await tx.put('sessions', 's1', { revision: 1 });
        await tx.put('outbox', 'o1', { pending: true });
        throw new Error('simulated crash');
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    expect(await storage.get('sessions', 's1')).toBeNull();
    expect(await storage.get('outbox', 'o1')).toBeNull();
    await storage.close();
  });

  it('serialises read-modify-write across two adapter instances', async () => {
    const databaseName = nextDatabaseName();
    const first = createIndexedDbStorage({ databaseName });
    const second = createIndexedDbStorage({ databaseName });
    await first.put('sessions', 'counter', { value: 0 });
    const increment = (storage: ReturnType<typeof createIndexedDbStorage>) => () =>
      storage.transact(['sessions'], 'readwrite', async (tx) => {
        const current = await tx.get<{ value: number }>('sessions', 'counter');
        await tx.put('sessions', 'counter', { value: (current?.value ?? 0) + 1 });
      });
    await Promise.all([increment(first)(), increment(second)()]);
    expect(await first.get('sessions', 'counter')).toEqual({ value: 2 });
    await first.close();
    await second.close();
  });

  it('refuses a write staged after the transaction auto-committed', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    await expect(
      storage.transact(['sessions'], 'readwrite', async (tx) => {
        await delay(10);
        await tx.put('sessions', 'late', { revision: 1 });
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    expect(await storage.get('sessions', 'late')).toBeNull();
    await storage.close();
  });

  it('supports overlay keys and deletes inside a transaction', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    await storage.put('outbox', 'o1', { status: 'pending' });
    await storage.transact(['outbox'], 'readwrite', async (tx) => {
      await tx.delete('outbox', 'o1');
      expect(await tx.get('outbox', 'o1')).toBeNull();
      await tx.put('outbox', 'o2', { status: 'pending' });
      expect(await tx.keys('outbox')).toEqual(['o2']);
    });
    expect(await storage.keys('outbox')).toEqual(['o2']);
    await storage.close();
  });
});
