import { describe, expect, it } from 'vitest';
import {
  assertRegistrationAllOrNone,
  buildLegacyDeviceRegistration,
  completeDeviceRegistration,
  prepareDeviceRegistration,
  registerDevice,
  registerLegacyDevice,
  verifyOwnDeviceRecord,
} from './registration';
import { loadDeviceIdentity, readPendingDeviceRegistration } from './identity';
import { makeDeviceFixture, makeDeviceResponse, DEVICE_IDS } from '../test/deviceFixtures';
import { encodeBase64Url } from '../encoding/base64url';
import { createDeviceIdentity } from './identity';
import { createMemoryE2eeStorage } from '../storage/memory';
import type { DeviceRegistrationTransport, DeviceTransportErrorKind } from './types';
import type { WireDevice, WireDeviceRegistration } from '../api/deviceKeys';

function makeTransport(response: WireDevice) {
  const calls: Array<{ body: WireDeviceRegistration; idempotencyKey: string }> = [];
  const transport: DeviceRegistrationTransport = {
    async registerDevice(body, idempotencyKey) {
      calls.push({ body: structuredClone(body), idempotencyKey });
      return { device: response, replayed: false };
    },
  };
  return { transport, calls };
}

function transportError(kind: DeviceTransportErrorKind): Error {
  return Object.assign(new Error(kind), {
    kind,
    status: kind === 'device_revoked' ? 410 : 409,
    code: kind.toUpperCase(),
    retryable: kind === 'network' || kind === 'timeout' ? true : false,
  });
}

describe('device registration', () => {
  it('builds an all-or-none keyed registration body with SPK and OPKs', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 2,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');

    expect(prepared.body.identity_signing_key).toBe(fixture.identity.record.identitySigningKey);
    expect(prepared.body.identity_dh_key).toBe(fixture.identity.record.identityDhKey);
    expect(prepared.body.identity_binding_signature).toBe(
      fixture.identity.record.identityBindingSignature,
    );
    expect(prepared.body.identity_key_alg).toBe('Ed25519+X25519');
    expect(prepared.body.signed_prekey?.key_id).toBe(fixture.spk.keyId);
    expect(prepared.body.one_time_prekeys).toHaveLength(2);
    expect(prepared.oneTimePrekeyCount).toBe(2);
    expect(assertRegistrationAllOrNone(prepared.body)).toBe('e2ee');

    const serialised = JSON.stringify(prepared.body);
    expect(serialised).not.toContain('privateKey');
    expect(serialised).not.toContain('CryptoKey');
  });

  it('reuses the exact body, idempotency key and prekeys on retry', async () => {
    const fixture = await makeDeviceFixture();
    const first = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 2,
      idempotencyKey: DEVICE_IDS.idempotency,
    });
    const second = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Other name',
      appVersion: '9.9.9',
      opkCount: 99,
    });
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready');

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.body).toEqual(first.body);
    expect(second.body.name).toBe('Test device');
    expect(second.identity.record).toEqual(first.identity.record);
  });

  it('rejects partial key sets and keyless bodies with prekeys', () => {
    const base: WireDeviceRegistration = {
      name: 'x',
      platform: 'WEB',
      app_version: '1',
    };
    expect(assertRegistrationAllOrNone(base)).toBe('legacy');
    expect(() =>
      assertRegistrationAllOrNone({
        ...base,
        one_time_prekeys: [{ key_id: 'opk-1', public_key: 'a' }] as never,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_KEY' }));
    expect(() =>
      assertRegistrationAllOrNone({
        ...base,
        identity_key_alg: 'Ed25519+X25519',
        identity_signing_key: encodeBase64Url(new Uint8Array(32)),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_KEY' }));
    expect(buildLegacyDeviceRegistration({ name: 'x', appVersion: '1' })).toEqual(base);
  });

  it('commits the server device id and key generation after verifying the echo', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');
    const device = makeDeviceResponse(prepared.identity, fixture.spk, { key_generation: 2 });
    const record = await completeDeviceRegistration(fixture.storage, prepared, device);

    expect(record.deviceId).toBe(DEVICE_IDS.device);
    expect(record.state).toBe('registered');
    expect(record.keyGeneration).toBe(2);
    expect(record.registeredAt).not.toBeNull();
    expect(await readPendingDeviceRegistration(fixture.storage)).toBeNull();
  });

  it('rejects a legacy response for a keyed request and marks the identity', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');
    const device = makeDeviceResponse(prepared.identity, fixture.spk, {
      e2ee_capable: false,
      identity_key_alg: 'LEGACY',
      identity_signing_key: null,
      identity_dh_key: null,
      identity_binding_signature: null,
      fingerprint: null,
      signed_prekey: null,
    });
    await expect(
      completeDeviceRegistration(fixture.storage, prepared, device),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const identity = await loadDeviceIdentity(fixture.storage, { userId: null });
    expect(identity?.record.state).toBe('legacy');
  });

  it('rejects a response with different identity keys or fingerprint', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');
    const other = await createDeviceIdentity(await createMemoryE2eeStorage());

    await expect(
      completeDeviceRegistration(
        fixture.storage,
        prepared,
        makeDeviceResponse(prepared.identity, fixture.spk, {
          identity_dh_key: other.record.identityDhKey,
        }),
      ),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });

    await expect(
      completeDeviceRegistration(
        fixture.storage,
        prepared,
        makeDeviceResponse(prepared.identity, fixture.spk, {
          fingerprint: encodeBase64Url(new Uint8Array(32).fill(4)),
        }),
      ),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
  });

  it('retries a transient failure with byte-identical body and key, then succeeds', async () => {
    const fixture = await makeDeviceFixture();
    const device = makeDeviceResponse(fixture.identity, fixture.spk);
    const calls: Array<{ body: WireDeviceRegistration; idempotencyKey: string }> = [];
    let attempts = 0;
    const transport: DeviceRegistrationTransport = {
      async registerDevice(body, idempotencyKey) {
        attempts += 1;
        calls.push({ body: structuredClone(body), idempotencyKey });
        if (attempts === 1) throw transportError('network');
        return { device, replayed: false };
      },
    };
    const result = await registerDevice(fixture.storage, transport, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
      maxAttempts: 2,
      sleep: async () => undefined,
    });

    expect(attempts).toBe(2);
    expect(JSON.stringify(calls[0]?.body)).toBe(JSON.stringify(calls[1]?.body));
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
    expect(result.status).toBe('registered');
    expect(result.deviceId).toBe(DEVICE_IDS.device);
  });

  it('does not retry or regenerate after a 409 identity conflict', async () => {
    const fixture = await makeDeviceFixture();
    let attempts = 0;
    const transport: DeviceRegistrationTransport = {
      async registerDevice() {
        attempts += 1;
        throw transportError('identity_key_conflict');
      },
    };
    await expect(
      registerDevice(fixture.storage, transport, {
        userId: DEVICE_IDS.user,
        name: 'Test device',
        appVersion: '0.7.0',
        opkCount: 1,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'identity_key_conflict' });

    expect(attempts).toBe(1);
    const identity = await loadDeviceIdentity(fixture.storage, { userId: null });
    expect(identity?.record.state).toBe('conflict');
    expect(identity?.record.identitySigningKey).toBe(fixture.identity.record.identitySigningKey);
  });

  it('marks the identity revoked on 410 and invalid on a binding failure', async () => {
    const revokedFixture = await makeDeviceFixture();
    await expect(
      registerDevice(
        revokedFixture.storage,
        {
          async registerDevice() {
            throw transportError('device_revoked');
          },
        },
        {
          userId: DEVICE_IDS.user,
          name: 'Test device',
          appVersion: '0.7.0',
          opkCount: 1,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toBeDefined();
    expect((await loadDeviceIdentity(revokedFixture.storage, { userId: null }))?.record.state).toBe(
      'revoked',
    );

    const invalidFixture = await makeDeviceFixture();
    await expect(
      registerDevice(
        invalidFixture.storage,
        {
          async registerDevice() {
            throw transportError('invalid_identity_binding');
          },
        },
        {
          userId: DEVICE_IDS.user,
          name: 'Test device',
          appVersion: '0.7.0',
          opkCount: 1,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toBeDefined();
    expect((await loadDeviceIdentity(invalidFixture.storage, { userId: null }))?.record.state).toBe(
      'invalid',
    );
  });

  it('short-circuits when the device is already registered', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');
    await completeDeviceRegistration(
      fixture.storage,
      prepared,
      makeDeviceResponse(prepared.identity, fixture.spk),
    );
    let attempts = 0;
    const result = await registerDevice(
      fixture.storage,
      {
        async registerDevice() {
          attempts += 1;
          throw new Error('must not be called');
        },
      },
      {
        userId: DEVICE_IDS.user,
        name: 'Test device',
        appVersion: '0.7.0',
      },
    );
    expect(attempts).toBe(0);
    expect(result.status).toBe('already_registered');
  });

  it('registers legacy devices only with a legacy response', async () => {
    const legacy: WireDevice = {
      id: DEVICE_IDS.device,
      name: 'Legacy',
      platform: 'WEB',
      status: 'ACTIVE',
      e2ee_capable: false,
      identity_key_alg: 'LEGACY',
      created_at: '2026-11-16T10:00:00.000Z',
    };
    const { transport, calls } = makeTransport(legacy);
    const device = await registerLegacyDevice(transport, {
      name: 'Legacy',
      appVersion: '0.7.0',
      idempotencyKey: DEVICE_IDS.idempotency,
    });
    expect(device.e2ee_capable).toBe(false);
    expect(calls[0]?.body).toEqual({
      name: 'Legacy',
      platform: 'WEB',
      app_version: '0.7.0',
    });
    expect(calls[0]?.idempotencyKey).toBe(DEVICE_IDS.idempotency);

    await expect(
      registerLegacyDevice(
        {
          async registerDevice() {
            return {
              device: {
                id: DEVICE_IDS.device,
                platform: 'WEB',
                status: 'ACTIVE',
                e2ee_capable: true,
                created_at: '2026-11-16T10:00:00.000Z',
              },
              replayed: false,
            };
          },
        },
        { name: 'Legacy', appVersion: '0.7.0' },
      ),
    ).rejects.toBeDefined();
  });

  it('verifies own GET /devices record against local identity', async () => {
    const fixture = await makeDeviceFixture();
    const prepared = await prepareDeviceRegistration(fixture.storage, {
      userId: DEVICE_IDS.user,
      name: 'Test device',
      appVersion: '0.7.0',
      opkCount: 1,
    });
    if (prepared.kind !== 'ready') throw new Error('expected ready');
    await completeDeviceRegistration(
      fixture.storage,
      prepared,
      makeDeviceResponse(prepared.identity, fixture.spk),
    );
    const device = makeDeviceResponse(prepared.identity, fixture.spk);
    await expect(
      verifyOwnDeviceRecord(fixture.storage, device, { userId: DEVICE_IDS.user }),
    ).resolves.toEqual({
      deviceId: DEVICE_IDS.device,
      keyGeneration: 1,
    });
    await expect(
      verifyOwnDeviceRecord(
        fixture.storage,
        { ...device, key_generation: 2 },
        {
          userId: DEVICE_IDS.user,
        },
      ),
    ).rejects.toMatchObject({ code: 'KEY_GENERATION_STALE' });
    await expect(
      verifyOwnDeviceRecord(
        fixture.storage,
        {
          ...device,
          id: DEVICE_IDS.peerDevice,
        },
        { userId: DEVICE_IDS.user },
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
  });
});
