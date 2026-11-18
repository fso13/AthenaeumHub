/**
 * Prekey destruction tests (§3.4.5.1, E2EE-AC-12).
 *
 * OPK private keys must be consumable exactly once and must survive a failed
 * first-message transaction. SPK retention is current + 2 previous inside a
 * 90-day window; there is no shorter "unused" TTL (CR1b P1-03). Private keys
 * are non-extractable CryptoKeys, never raw bytes.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { createIndexedDbStorage } from './storage/indexedDb';
import { generateX25519KeyPair } from './crypto/x25519';
import { b64, bytes } from './test/fixtures';
import {
  consumeOneTimePrekey,
  countAvailableOneTimePrekeys,
  deleteSignedPrekey,
  destroyPrekeyMaterial,
  getCurrentSignedPrekey,
  getOneTimePrekey,
  getSignedPrekey,
  listOneTimePrekeys,
  listSignedPrekeys,
  pruneExpiredOneTimePrekeys,
  putOneTimePrekey,
  rotateSignedPrekey,
  type OneTimePrekeyRecord,
  type SignedPrekeyRecord,
} from './session/prekeyStore';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

async function makeOpk(
  keyId: string,
  createdAt = NOW,
  ttlMs = 30 * DAY,
): Promise<OneTimePrekeyRecord> {
  const pair = await generateX25519KeyPair();
  return {
    v: 1,
    keyId,
    publicKey: b64(pair.publicKeyBytes),
    privateKey: pair.privateKey,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
}

async function makeSpk(keyId: string, createdAt = NOW): Promise<SignedPrekeyRecord> {
  const pair = await generateX25519KeyPair();
  return {
    v: 1,
    keyId,
    publicKey: b64(pair.publicKeyBytes),
    signature: b64(bytes(64, 4)),
    privateKey: pair.privateKey,
    createdAt,
    expiresAt: createdAt + 30 * DAY,
    retiredAt: null,
  };
}

describe('one-time prekeys', () => {
  it('stores, lists and counts OPKs', async () => {
    const storage = createMemoryE2eeStorage();
    await putOneTimePrekey(storage, await makeOpk('opk-1', NOW));
    await putOneTimePrekey(storage, await makeOpk('opk-2', NOW + 1));
    const records = await listOneTimePrekeys(storage);
    expect(records.map((record) => record.keyId)).toEqual(['opk-1', 'opk-2']);
    expect(records[0]?.privateKey.extractable).toBe(false);
    expect(await countAvailableOneTimePrekeys(storage, NOW)).toBe(2);
    expect(await getOneTimePrekey(storage, 'opk-1')).not.toBeNull();
    await storage.close();
  });

  it('rejects duplicate key ids instead of silently replacing key material', async () => {
    const storage = createMemoryE2eeStorage();
    const first = await makeOpk('opk-1');
    await putOneTimePrekey(storage, first);
    await expect(putOneTimePrekey(storage, await makeOpk('opk-1'))).rejects.toMatchObject({
      code: 'INVALID_KEY',
    });
    expect(await getOneTimePrekey(storage, 'opk-1')).not.toBeNull();
    await storage.close();
  });

  it('consumes an OPK exactly once and removes its private key', async () => {
    const storage = createMemoryE2eeStorage();
    const record = await makeOpk('opk-1');
    await putOneTimePrekey(storage, record);
    const consumed = await consumeOneTimePrekey(storage, 'opk-1', NOW);
    expect(consumed.keyId).toBe('opk-1');
    expect(consumed.publicKey).toHaveLength(32);
    expect(consumed.privateKey.extractable).toBe(false);
    expect(await getOneTimePrekey(storage, 'opk-1')).toBeNull();
    await expect(consumeOneTimePrekey(storage, 'opk-1', NOW)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
    await storage.close();
  });

  it('wins exactly one of two concurrent consumes', async () => {
    const storage = createMemoryE2eeStorage();
    await putOneTimePrekey(storage, await makeOpk('opk-1'));
    const results = await Promise.allSettled([
      consumeOneTimePrekey(storage, 'opk-1', NOW),
      consumeOneTimePrekey(storage, 'opk-1', NOW),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await storage.close();
  });

  it('keeps the OPK when the surrounding transaction aborts (failed AEAD)', async () => {
    const storage = createMemoryE2eeStorage();
    await putOneTimePrekey(storage, await makeOpk('opk-1'));
    const { consumeOneTimePrekeyInTransaction } = await import('./session/prekeyStore');
    await expect(
      storage.transact(['prekeys'], 'readwrite', async (transaction) => {
        await consumeOneTimePrekeyInTransaction(transaction, 'opk-1', NOW);
        throw new Error('simulated AEAD failure');
      }),
    ).rejects.toBeTruthy();
    expect(await getOneTimePrekey(storage, 'opk-1')).not.toBeNull();
    await storage.close();
  });

  it('rejects expired OPKs and prunes them later', async () => {
    const storage = createMemoryE2eeStorage();
    await putOneTimePrekey(storage, await makeOpk('opk-expired', NOW - 40 * DAY));
    await putOneTimePrekey(storage, await makeOpk('opk-fresh', NOW));
    await expect(consumeOneTimePrekey(storage, 'opk-expired', NOW)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
    expect(await getOneTimePrekey(storage, 'opk-expired')).not.toBeNull();
    expect(await pruneExpiredOneTimePrekeys(storage, NOW)).toEqual(['opk-expired']);
    expect(await getOneTimePrekey(storage, 'opk-expired')).toBeNull();
    expect(await countAvailableOneTimePrekeys(storage, NOW)).toBe(1);
    await storage.close();
  });
});

describe('signed prekeys and retention', () => {
  it('keeps current + 2 previous private SPKs and destroys the 4th', async () => {
    const storage = createMemoryE2eeStorage();
    const records: SignedPrekeyRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      records.push(await makeSpk(`spk-${index}`, NOW + index));
    }
    const rotations = [];
    for (const record of records) {
      rotations.push(await rotateSignedPrekey(storage, record, { now: NOW + 10 }));
    }
    const retained = await listSignedPrekeys(storage);
    expect(retained.map((record) => record.keyId)).toEqual(['spk-1', 'spk-2', 'spk-3']);
    expect(rotations[3]?.destroyed).toEqual(['spk-0']);
    expect(rotations[2]?.retained.map((record) => record.keyId).sort()).toEqual([
      'spk-0',
      'spk-1',
      'spk-2',
    ]);
    expect(await getSignedPrekey(storage, 'spk-0')).toBeNull();
    const current = await getCurrentSignedPrekey(storage);
    expect(current?.keyId).toBe('spk-3');
    expect(current?.retiredAt).toBeNull();
    expect((await getSignedPrekey(storage, 'spk-1'))?.retiredAt).not.toBeNull();
    await storage.close();
  });

  it('destroys private SPKs outside the 90-day window even if fewer than three', async () => {
    const storage = createMemoryE2eeStorage();
    const old = await makeSpk('spk-old', NOW - 91 * DAY);
    const current = await makeSpk('spk-current', NOW);
    await rotateSignedPrekey(storage, old, { now: NOW - 91 * DAY });
    const rotation = await rotateSignedPrekey(storage, current, { now: NOW });
    expect(rotation.destroyed).toEqual(['spk-old']);
    expect(await listSignedPrekeys(storage)).toHaveLength(1);
    await storage.close();
  });

  it('keeps a claimed-but-undelivered SPK for the full 90-day window (CR1b P1-03)', async () => {
    // No local session references this SPK: it was handed out by a claim and the
    // prekey message has not arrived yet. "Unused for 30 days" must not destroy
    // it, otherwise the documented 90-day offline window is a lie.
    const storage = createMemoryE2eeStorage();
    const old = await makeSpk('spk-old', NOW - 31 * DAY);
    await rotateSignedPrekey(storage, old, { now: NOW - 31 * DAY });
    const rotation = await rotateSignedPrekey(storage, await makeSpk('spk-new', NOW), {
      now: NOW,
      activeSessionSpkIds: new Set<string>(),
    });
    expect(rotation.destroyed).toEqual([]);
    expect(await getSignedPrekey(storage, 'spk-old')).not.toBeNull();

    // After two more rotations the old record is the 4th newest and is gone,
    // regardless of whether any session ever referenced it.
    await rotateSignedPrekey(storage, await makeSpk('spk-3', NOW + 1), { now: NOW + 1 });
    const last = await rotateSignedPrekey(storage, await makeSpk('spk-4', NOW + 2), {
      now: NOW + 2,
      activeSessionSpkIds: new Set<string>(),
    });
    expect(last.destroyed).toEqual(['spk-old']);
    expect(await getSignedPrekey(storage, 'spk-old')).toBeNull();
    await storage.close();
  });

  it('retains a claimed-but-undelivered SPK at 31/60/89 days (CR1b P1-03)', async () => {
    for (const ageDays of [31, 60, 89]) {
      const storage = createMemoryE2eeStorage();
      const old = await makeSpk('spk-old', NOW - ageDays * DAY);
      await rotateSignedPrekey(storage, old, { now: NOW - ageDays * DAY });
      const rotation = await rotateSignedPrekey(storage, await makeSpk('spk-new', NOW), {
        now: NOW,
        // No local session references the SPK: the prekey message may still be
        // in flight, so retention must stay 90 days.
        activeSessionSpkIds: new Set<string>(),
      });
      expect(rotation.destroyed).toEqual([]);
      expect(await getSignedPrekey(storage, 'spk-old')).not.toBeNull();
      await storage.close();
    }
  });

  it('keeps the 90-day boundary and destroys a 91-day-old SPK (31/60/89/91 KAT)', async () => {
    // The normative window is SPK_RETAIN_WINDOW = 90 days with current + 2
    // private SPKs (docs/E2EE-SPEC.md §1.3 / §3.4.5.1). A 30-day "unused" TTL
    // must not shorten it; 91 days is outside the window.
    for (const { ageDays, retained } of [
      { ageDays: 31, retained: true },
      { ageDays: 60, retained: true },
      { ageDays: 89, retained: true },
      { ageDays: 90, retained: true },
      { ageDays: 91, retained: false },
    ]) {
      const storage = createMemoryE2eeStorage();
      const old = await makeSpk('spk-old', NOW - ageDays * DAY);
      await rotateSignedPrekey(storage, old, { now: NOW - ageDays * DAY });
      const rotation = await rotateSignedPrekey(storage, await makeSpk('spk-new', NOW), {
        now: NOW,
        activeSessionSpkIds: new Set<string>(),
      });
      expect(rotation.destroyed).toEqual(retained ? [] : ['spk-old']);
      expect(await getSignedPrekey(storage, 'spk-old')).toEqual(
        retained ? expect.objectContaining({ keyId: 'spk-old' }) : null,
      );
      await storage.close();
    }
  });

  it('repairs the current pointer when the current SPK is deleted', async () => {
    const storage = createMemoryE2eeStorage();
    await rotateSignedPrekey(storage, await makeSpk('spk-1', NOW), { now: NOW });
    await rotateSignedPrekey(storage, await makeSpk('spk-2', NOW + 1), { now: NOW + 1 });
    await deleteSignedPrekey(storage, 'spk-2');
    expect((await getCurrentSignedPrekey(storage))?.keyId).toBe('spk-1');
    await deleteSignedPrekey(storage, 'spk-1');
    expect(await getCurrentSignedPrekey(storage)).toBeNull();
    await storage.close();
  });

  it('destroys all prekey material on revoke/reset', async () => {
    const storage = createMemoryE2eeStorage();
    await putOneTimePrekey(storage, await makeOpk('opk-1'));
    await rotateSignedPrekey(storage, await makeSpk('spk-1'), { now: NOW });
    await destroyPrekeyMaterial(storage);
    expect(await listOneTimePrekeys(storage)).toEqual([]);
    expect(await listSignedPrekeys(storage)).toEqual([]);
    expect(await getCurrentSignedPrekey(storage)).toBeNull();
    await storage.close();
  });

  it('works across IndexedDB with non-extractable private keys', async () => {
    const storage = createIndexedDbStorage({ databaseName: 'krug-e2ee-prekeys-idb' });
    const record = await makeOpk('opk-idb');
    await putOneTimePrekey(storage, record);
    const consumed = await consumeOneTimePrekey(storage, 'opk-idb', NOW);
    expect(consumed.privateKey.extractable).toBe(false);
    await storage.close();
  });
});
