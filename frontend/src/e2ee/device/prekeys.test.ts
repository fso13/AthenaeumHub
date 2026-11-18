import { describe, expect, it } from 'vitest';
import {
  completePrekeyUpload,
  discardPendingPrekeyUpload,
  ensureOneTimePrekeys,
  ensureSignedPrekey,
  preparePrekeyUpload,
  readPendingPrekeyUpload,
  uploadPrekeys,
} from './prekeys';
import {
  countAvailableOneTimePrekeys,
  getSignedPrekey,
  listOneTimePrekeys,
  listSignedPrekeys,
} from '../session/prekeyStore';
import {
  DEVICE_IDS,
  makeDeviceFixture,
  makePrekeyUploadResult,
  registerFixtureDevice,
} from '../test/deviceFixtures';
import { loadDeviceIdentity } from './identity';
import { collectActiveSessionSpkIds } from './sessionSpk';
import { createSession } from '../test/sessionTestWrites';
import { loadOrCreateKStorage } from '../storage/kStorage';
import { createTestSession, testSessionId } from '../test/fixtures';
import type { PrekeyIdFactory } from './prekeys';
import type { PrekeyUploadTransport } from './types';

const DAY = 24 * 60 * 60 * 1000;

function counterFactory(prefix = 'test'): PrekeyIdFactory {
  let signed = 0;
  let oneTime = 0;
  return {
    signedPrekeyId() {
      signed += 1;
      return `spk-${prefix}-${signed}`;
    },
    oneTimePrekeyId() {
      oneTime += 1;
      return `opk-${prefix}-${oneTime}`;
    },
  };
}

async function registeredFixture(now = 1_700_000_000_000) {
  const fixture = await makeDeviceFixture({ now });
  await registerFixtureDevice(fixture, { now, opkCount: 0 });
  const identity = await loadDeviceIdentity(fixture.storage, { userId: null });
  if (!identity) throw new Error('identity missing');
  return { ...fixture, identity };
}

describe('signed prekey provisioning', () => {
  it('creates the first SPK and rotates it with current+2 retention', async () => {
    const fixture = await makeDeviceFixture();
    const initial = await ensureSignedPrekey(fixture.storage, fixture.identity, {
      force: true,
      now: fixture.spk.createdAt + 1,
      keyId: 'spk-first',
    });
    expect(initial.rotated).toBe(true);
    expect(initial.record.keyId).toBe('spk-first');

    let now = fixture.spk.createdAt + 1;
    for (let index = 0; index < 4; index += 1) {
      now += 31 * DAY;
      const rotated = await ensureSignedPrekey(fixture.storage, fixture.identity, {
        force: true,
        now,
        keyId: `spk-${index}`,
      });
      expect(rotated.rotated).toBe(true);
    }
    const retained = await listSignedPrekeys(fixture.storage);
    expect(retained).toHaveLength(3);
    expect(await getSignedPrekey(fixture.storage, 'spk-first')).toBeNull();
  });

  it('does not rotate a fresh SPK', async () => {
    const fixture = await makeDeviceFixture();
    const result = await ensureSignedPrekey(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt + 1,
    });
    expect(result.rotated).toBe(false);
    expect(result.record.keyId).toBe(fixture.spk.keyId);
  });
});

describe('one-time prekey replenishment', () => {
  it('fills to target only below the low-water mark', async () => {
    const fixture = await makeDeviceFixture();
    const factory = counterFactory();
    const first = await ensureOneTimePrekeys(fixture.storage, {
      target: 5,
      lowWater: 2,
      max: 10,
      idFactory: factory,
    });
    expect(first.created).toHaveLength(5);
    expect(first.available).toBe(5);
    const second = await ensureOneTimePrekeys(fixture.storage, {
      target: 5,
      lowWater: 2,
      max: 10,
      idFactory: factory,
    });
    expect(second.created).toHaveLength(0);
  });

  it('never exceeds the hard cap and never duplicates a key id', async () => {
    const fixture = await makeDeviceFixture();
    const fixed: PrekeyIdFactory = {
      signedPrekeyId: () => 'spk-fixed',
      oneTimePrekeyId: () => 'opk-fixed',
    };
    const result = await ensureOneTimePrekeys(fixture.storage, {
      target: 50,
      lowWater: 10,
      max: 5,
      idFactory: fixed,
    });
    expect(result.created).toHaveLength(1);
    expect(await countAvailableOneTimePrekeys(fixture.storage)).toBe(1);
  });

  it('prunes expired OPKs before counting', async () => {
    const fixture = await makeDeviceFixture();
    const now = fixture.spk.createdAt;
    await ensureOneTimePrekeys(fixture.storage, {
      now,
      target: 2,
      lowWater: 2,
      max: 5,
      idFactory: counterFactory(),
    });
    expect(await countAvailableOneTimePrekeys(fixture.storage, now + 31 * DAY)).toBe(0);
    const refill = await ensureOneTimePrekeys(fixture.storage, {
      now: now + 31 * DAY,
      target: 2,
      lowWater: 2,
      max: 5,
      idFactory: counterFactory(),
    });
    expect(refill.created).toHaveLength(2);
    expect(await listOneTimePrekeys(fixture.storage)).toHaveLength(2);
  });
});

describe('prekey upload planning', () => {
  it('uploads only newly generated OPKs and persists an exact pending body', async () => {
    const fixture = await registeredFixture();
    const plan = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkTarget: 3,
      opkLowWater: 3,
      opkMax: 10,
      idFactory: counterFactory(),
      idempotencyKey: DEVICE_IDS.idempotency,
    });
    if (plan.kind !== 'upload') throw new Error('expected upload');
    expect(plan.pending.idempotencyKey).toBe(DEVICE_IDS.idempotency);
    expect(plan.pending.spkKeyId).toBeNull();
    expect(plan.pending.opkIds).toHaveLength(3);
    expect(plan.pending.body.signed_prekey).toBeUndefined();
    expect(plan.pending.body.one_time_prekeys).toHaveLength(3);
    expect(JSON.stringify(plan.pending.body)).not.toContain('privateKey');

    const stored = await readPendingPrekeyUpload(fixture.storage);
    expect(stored).toEqual(plan.pending);
  });

  it('reuses a usable pending body byte for byte', async () => {
    const fixture = await registeredFixture();
    const first = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory(),
    });
    const second = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt + 1,
      opkTarget: 99,
      idFactory: counterFactory(),
    });
    if (first.kind !== 'upload' || second.kind !== 'upload') throw new Error('expected upload');
    expect(second.pending).toEqual(first.pending);
  });

  it('rotates an SPK when it is older than 30 days and uploads it', async () => {
    const fixture = await registeredFixture();
    const plan = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt + 31 * DAY,
      opkLowWater: 0,
      opkTarget: 0,
      idFactory: counterFactory(),
    });
    if (plan.kind !== 'upload') throw new Error('expected upload');
    expect(plan.pending.spkKeyId).not.toBeNull();
    expect(plan.pending.body.signed_prekey?.key_id).toBe(plan.pending.spkKeyId);
    expect(plan.pending.body.one_time_prekeys).toBeUndefined();
  });

  it('discards a pending body whose OPK private key disappeared', async () => {
    const fixture = await registeredFixture();
    const first = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory(),
    });
    if (first.kind !== 'upload') throw new Error('expected upload');
    const missing = first.pending.opkIds[0] as string;
    await fixture.storage.delete('prekeys', `opk:${missing}`);
    const second = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt + 1,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory('second'),
    });
    if (second.kind !== 'upload') throw new Error('expected upload');
    expect(second.pending.idempotencyKey).not.toBe(first.pending.idempotencyKey);
    expect(second.pending.opkIds).not.toContain(missing);
  });

  it('returns sufficient when nothing is due', async () => {
    const fixture = await registeredFixture();
    const plan = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkLowWater: 0,
      opkTarget: 0,
    });
    expect(plan.kind).toBe('sufficient');
    expect(await readPendingPrekeyUpload(fixture.storage)).toBeNull();
  });

  it('does not reuse OPK ids across two concurrent replenishments', async () => {
    const fixture = await registeredFixture();
    const [left, right] = await Promise.all([
      preparePrekeyUpload(fixture.storage, fixture.identity, {
        now: fixture.spk.createdAt,
        opkTarget: 10,
        opkLowWater: 10,
        opkMax: 10,
      }),
      preparePrekeyUpload(fixture.storage, fixture.identity, {
        now: fixture.spk.createdAt,
        opkTarget: 10,
        opkLowWater: 10,
        opkMax: 10,
      }),
    ]);
    const uploads = [left, right].filter((plan) => plan.kind === 'upload');
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    const ids = uploads.flatMap((plan) => (plan.kind === 'upload' ? plan.pending.opkIds : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(await countAvailableOneTimePrekeys(fixture.storage)).toBeLessThanOrEqual(10);
  });
});

it('exposes session SPK ids to rotation and falls back on legacy sessions', async () => {
  const fixture = await registeredFixture();
  const deviceId = fixture.identity.record.deviceId as string;
  const kStorage = await loadOrCreateKStorage(fixture.storage, deviceId, { userId: null });
  await createSession(
    fixture.storage,
    kStorage,
    await createTestSession({
      sessionId: testSessionId(1),
      deviceId,
      spkId: fixture.spk.keyId,
    }),
  );
  const ids = await collectActiveSessionSpkIds(fixture.storage);
  expect(ids?.has(fixture.spk.keyId)).toBe(true);

  await createSession(
    fixture.storage,
    kStorage,
    await createTestSession({
      sessionId: testSessionId(2),
      deviceId,
      spkId: null,
    }),
  );
  // A session created before spk_id existed cannot identify its SPK; rotation
  // must keep the full current+2/90-day retention instead of an empty set.
  expect(await collectActiveSessionSpkIds(fixture.storage)).toBeUndefined();
});

describe('prekey upload completion', () => {
  it('validates and clears the pending body', async () => {
    const fixture = await registeredFixture();
    const plan = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory(),
    });
    if (plan.kind !== 'upload') throw new Error('expected upload');
    const result = await completePrekeyUpload(
      fixture.storage,
      fixture.identity,
      plan.pending,
      makePrekeyUploadResult(plan.pending),
    );
    expect(result.status).toBe('uploaded');
    expect(result.storedOpks).toBe(2);
    expect(await readPendingPrekeyUpload(fixture.storage)).toBeNull();
  });

  it('rejects stale generation, another device and over-reported counts', async () => {
    const fixture = await registeredFixture();
    const plan = await preparePrekeyUpload(fixture.storage, fixture.identity, {
      now: fixture.spk.createdAt,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory(),
    });
    if (plan.kind !== 'upload') throw new Error('expected upload');
    await expect(
      completePrekeyUpload(
        fixture.storage,
        fixture.identity,
        plan.pending,
        makePrekeyUploadResult(plan.pending, { key_generation: 2 }),
      ),
    ).rejects.toMatchObject({ code: 'KEY_GENERATION_STALE' });
    await expect(
      completePrekeyUpload(
        fixture.storage,
        fixture.identity,
        plan.pending,
        makePrekeyUploadResult(plan.pending, { device_id: DEVICE_IDS.peerDevice }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      completePrekeyUpload(
        fixture.storage,
        fixture.identity,
        plan.pending,
        makePrekeyUploadResult(plan.pending, { one_time_prekeys_stored: 3 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('retries with identical body and key, then completes', async () => {
    const fixture = await registeredFixture();
    const calls: Array<{ body: unknown; key: string }> = [];
    let attempts = 0;
    const transport: PrekeyUploadTransport = {
      async uploadPrekeys(_deviceId, body, idempotencyKey) {
        attempts += 1;
        calls.push({ body: structuredClone(body), key: idempotencyKey });
        if (attempts === 1) {
          throw Object.assign(new Error('network'), {
            kind: 'network',
            status: 0,
            code: 'NETWORK',
            retryable: true,
          });
        }
        const pending = await readPendingPrekeyUpload(fixture.storage);
        if (!pending) throw new Error('pending missing');
        return makePrekeyUploadResult(pending);
      },
    };
    const result = await uploadPrekeys(fixture.storage, fixture.identity, transport, {
      now: fixture.spk.createdAt,
      opkTarget: 2,
      opkLowWater: 2,
      idFactory: counterFactory(),
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    expect(attempts).toBe(2);
    expect(JSON.stringify(calls[0]?.body)).toBe(JSON.stringify(calls[1]?.body));
    expect(calls[0]?.key).toBe(calls[1]?.key);
    expect(result.status).toBe('uploaded');
  });

  it('marks the identity legacy on 422 E2EE_LEGACY_DEVICE', async () => {
    const fixture = await registeredFixture();
    const transport: PrekeyUploadTransport = {
      async uploadPrekeys() {
        throw Object.assign(new Error('legacy'), {
          kind: 'legacy_device',
          status: 422,
          code: 'E2EE_LEGACY_DEVICE',
          retryable: false,
        });
      },
    };
    await expect(
      uploadPrekeys(fixture.storage, fixture.identity, transport, {
        now: fixture.spk.createdAt,
        opkTarget: 2,
        opkLowWater: 2,
        idFactory: counterFactory(),
      }),
    ).rejects.toBeDefined();
    expect((await loadDeviceIdentity(fixture.storage, { userId: null }))?.record.state).toBe(
      'legacy',
    );
    await discardPendingPrekeyUpload(fixture.storage);
  });
});
