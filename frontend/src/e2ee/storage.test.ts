/**
 * Storage abstraction tests: in-memory adapter (always) and IndexedDB adapter
 * (through `fake-indexeddb`). Both must preserve non-extractable CryptoKeys and
 * structured-clone semantics; extractable private keys must be refused.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { createIndexedDbStorage } from './storage/indexedDb';
import { E2EE_STORE_NAMES, assertStoreName, getPrivateKey, putPrivateKey } from './storage/types';
import { generateEd25519KeyPair } from './crypto/ed25519';

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-test-${databaseCounter}`;
}

describe('memory storage adapter', () => {
  it('supports CRUD, key listing and clearing', async () => {
    const storage = createMemoryE2eeStorage();
    expect(storage.kind).toBe('memory');
    expect(await storage.get('keys', 'missing')).toBeNull();
    await storage.put('keys', 'b', { value: 2 });
    await storage.put('keys', 'a', { value: 1 });
    expect(await storage.get('keys', 'a')).toEqual({ value: 1 });
    expect(await storage.keys('keys')).toEqual(['a', 'b']);
    await storage.delete('keys', 'a');
    await storage.delete('keys', 'a');
    expect(await storage.keys('keys')).toEqual(['b']);
    await storage.clear('keys');
    expect(await storage.keys('keys')).toEqual([]);
    await storage.close();
  });

  it('emulates IndexedDB structured clone on read and write', async () => {
    const storage = createMemoryE2eeStorage();
    const source = { bytes: Uint8Array.of(1, 2, 3) };
    await storage.put('prekeys', 'k', source);
    source.bytes[0] = 99;
    const first = await storage.get<typeof source>('prekeys', 'k');
    expect(first?.bytes[0]).toBe(1);
    first!.bytes[1] = 42;
    const second = await storage.get<typeof source>('prekeys', 'k');
    expect(second?.bytes[1]).toBe(2);
  });

  it('keeps private CryptoKeys non-extractable through a round-trip', async () => {
    const storage = createMemoryE2eeStorage();
    const keyPair = await generateEd25519KeyPair();
    await putPrivateKey(storage, 'keys', 'ik-sig', keyPair.privateKey);
    const loaded = await getPrivateKey(storage, 'keys', 'ik-sig');
    expect(loaded).not.toBeNull();
    expect(loaded?.extractable).toBe(false);
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      loaded as CryptoKey,
      Uint8Array.of(7),
    );
    expect(signature.byteLength).toBe(64);
    const raw = await storage.get<CryptoKey>('keys', 'ik-sig');
    expect(raw?.extractable).toBe(false);
  });

  it('refuses extractable private keys', async () => {
    const storage = createMemoryE2eeStorage();
    const extractable = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await expect(
      putPrivateKey(storage, 'keys', 'bad', extractable.privateKey),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('refuses to read a non-key record as a private key', async () => {
    const storage = createMemoryE2eeStorage();
    await storage.put('keys', 'stringy', 'not-a-key');
    await expect(getPrivateKey(storage, 'keys', 'stringy')).rejects.toMatchObject({
      code: 'INVALID_KEY',
    });
  });

  it('rejects operations after close', async () => {
    const storage = createMemoryE2eeStorage();
    await storage.close();
    await expect(storage.get('keys', 'a')).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('rejects unknown store names', () => {
    expect(() => assertStoreName('nope')).toThrowError(
      expect.objectContaining({ code: 'KEY_STORAGE_UNAVAILABLE' }),
    );
    for (const store of E2EE_STORE_NAMES) {
      expect(assertStoreName(store)).toBe(store);
    }
  });
});

describe('IndexedDB storage adapter', () => {
  it('creates all stores and supports CRUD', async () => {
    const databaseName = nextDatabaseName();
    const storage = createIndexedDbStorage({ databaseName });
    expect(storage.kind).toBe('indexeddb');
    expect(storage.kind).toBe('indexeddb');
    expect(await storage.get('keys', 'missing')).toBeNull();
    await storage.put('sessions', 's2', { seq: 2 });
    await storage.put('sessions', 's1', { seq: 1 });
    expect(await storage.get('sessions', 's1')).toEqual({ seq: 1 });
    expect(await storage.keys('sessions')).toEqual(['s1', 's2']);
    await storage.delete('sessions', 's1');
    expect(await storage.keys('sessions')).toEqual(['s2']);
    await storage.clear('sessions');
    expect(await storage.keys('sessions')).toEqual([]);
    await storage.close();
  });

  it('persists records across adapter instances (same database)', async () => {
    const databaseName = nextDatabaseName();
    const first = createIndexedDbStorage({ databaseName });
    await first.put('pins', 'device-1', { fingerprint: 'abc', verified: false });
    await first.close();
    const second = createIndexedDbStorage({ databaseName });
    expect(await second.get('pins', 'device-1')).toEqual({
      fingerprint: 'abc',
      verified: false,
    });
    await second.close();
  });

  it('round-trips a non-extractable private key', async () => {
    const databaseName = nextDatabaseName();
    const storage = createIndexedDbStorage({ databaseName });
    const keyPair = await generateEd25519KeyPair();
    await putPrivateKey(storage, 'keys', 'ik-sig', keyPair.privateKey);
    const loaded = await getPrivateKey(storage, 'keys', 'ik-sig');
    expect(loaded?.extractable).toBe(false);
    expect(loaded?.type).toBe('private');
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      loaded as CryptoKey,
      Uint8Array.of(1, 2, 3),
    );
    expect(signature.byteLength).toBe(64);
    await storage.close();
  });

  it('refuses an extractable private key before touching the database', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    const extractable = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await expect(
      putPrivateKey(storage, 'keys', 'bad', extractable.privateKey),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await storage.close();
  });

  it('close is idempotent', async () => {
    const storage = createIndexedDbStorage({ databaseName: nextDatabaseName() });
    await storage.put('outbox', 'a', 1);
    await storage.close();
    await storage.close();
  });
});
