import { describe, expect, it } from 'vitest';
import {
  verifyClaimedBundle,
  verifyDeviceKeyInfo,
  verifyPrekeySenderIdentity,
  validateChatKeysResponse,
  validateClaimResponse,
} from './binding';
import { decodePrekeyBundle } from '../api/deviceKeys';
import { parseEnvelope } from '../protocol/envelope';
import { buildWireEnvelope } from '../test/fixtures';
import {
  DEVICE_IDS,
  b64,
  makeChatKeysResponse,
  makeClaimResponse,
  makeDeviceFixture,
  makeDeviceKeyInfo,
  makeWireBundle,
} from '../test/deviceFixtures';
import { createMemoryE2eeStorage } from '../storage/memory';
import { encodeBase64Url } from '../encoding/base64url';
import type { WirePrekeyBlock } from '../protocol/envelope';
import type { WireKeyClaimRequest, WirePrekeyBundle } from '../api/deviceKeys';
import type { TofuPinRecord } from './types';

const REQUEST: WireKeyClaimRequest = {
  chat_id: DEVICE_IDS.chat,
  devices: [{ device_id: DEVICE_IDS.peerDevice, user_id: DEVICE_IDS.peerUser }],
};

function wirePrekey(bundle: WirePrekeyBundle): WirePrekeyBlock {
  return {
    sender_identity_signing_key: bundle.identity_signing_key,
    sender_identity_dh_key: bundle.identity_dh_key,
    sender_ephemeral_key: b64(new Uint8Array(32).fill(3)),
    recipient_identity_dh_key: b64(new Uint8Array(32).fill(4)),
    spk_id: bundle.signed_prekey.key_id,
    spk_public: bundle.signed_prekey.public_key,
    opk_id: bundle.one_time_prekey?.key_id ?? null,
    opk_public: bundle.one_time_prekey?.public_key ?? null,
    signature: b64(new Uint8Array(64).fill(5)),
  };
}

describe('bundle verification', () => {
  it('accepts a correctly signed bundle and recomputes the fingerprint', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    const verified = await verifyClaimedBundle(decodePrekeyBundle(wire));

    expect(verified.userId).toBe(DEVICE_IDS.peerUser);
    expect(verified.deviceId).toBe(DEVICE_IDS.peerDevice);
    expect(verified.identity.fingerprintBase64Url).toBe(fixture.identity.record.fingerprint);
    expect(verified.signedPrekey.key_id).toBe(fixture.spk.keyId);
    expect(verified.oneTimePrekeyId).toBe('opk-test-1');
    expect(verified.otpExhausted).toBe(false);
  });

  it('rejects a bad SPK signature', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    wire.signed_prekey.signature = b64(new Uint8Array(64).fill(7));
    await expect(verifyClaimedBundle(decodePrekeyBundle(wire))).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
  });

  it('rejects a bad identity binding signature', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    wire.identity_binding_signature = b64(new Uint8Array(64).fill(7));
    await expect(verifyClaimedBundle(decodePrekeyBundle(wire))).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
  });

  it('rejects an expired SPK and an invalid key id', async () => {
    const fixture = await makeDeviceFixture();
    const expired = makeWireBundle(fixture.identity, fixture.spk);
    expired.signed_prekey.expires_at = '2020-01-01T00:00:00.000Z';
    await expect(
      verifyClaimedBundle(decodePrekeyBundle(expired), { now: Date.now() }),
    ).rejects.toMatchObject({ code: 'KEY_HANDSHAKE_INVALID' });

    const invalidId = makeWireBundle(fixture.identity, fixture.spk);
    invalidId.signed_prekey.key_id = 'not a key id';
    await expect(verifyClaimedBundle(decodePrekeyBundle(invalidId))).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
  });

  it('rejects an inconsistent otp_exhausted flag', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk, {
      one_time_prekey: null,
      otp_exhausted: false,
    });
    await expect(verifyClaimedBundle(decodePrekeyBundle(wire))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const exhausted = makeWireBundle(fixture.identity, fixture.spk, {
      one_time_prekey: null,
      otp_exhausted: true,
    });
    const verified = await verifyClaimedBundle(decodePrekeyBundle(exhausted));
    expect(verified.oneTimePrekeyId).toBeNull();
    expect(verified.otpExhausted).toBe(true);
  });
});

describe('claim response validation', () => {
  it('accepts a bundle for exactly the requested device', async () => {
    const fixture = await makeDeviceFixture();
    const response = makeClaimResponse(makeWireBundle(fixture.identity, fixture.spk));
    const decoded = await validateClaimResponse(response, REQUEST);
    expect(decoded.bundles).toHaveLength(1);
    expect(decoded.unavailable).toEqual([]);
  });

  it('rejects unknown, duplicate, omitted and mismatched bundles', async () => {
    const fixture = await makeDeviceFixture();
    const bundle = makeWireBundle(fixture.identity, fixture.spk);

    await expect(
      validateClaimResponse(
        makeClaimResponse({
          ...bundle,
          device_id: DEVICE_IDS.peerDevice2,
        }),
        REQUEST,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    await expect(
      validateClaimResponse(makeClaimResponse(bundle, []), {
        ...REQUEST,
        devices: [
          { device_id: DEVICE_IDS.peerDevice, user_id: DEVICE_IDS.peerUser },
          { device_id: DEVICE_IDS.peerDevice2, user_id: DEVICE_IDS.peerUser },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    await expect(
      validateClaimResponse({ bundles: [bundle, bundle], unavailable: [] }, REQUEST),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    await expect(
      validateClaimResponse(makeClaimResponse({ ...bundle, user_id: DEVICE_IDS.user }), REQUEST),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts unavailable devices but not duplicates or invalid reasons', async () => {
    const fixture = await makeDeviceFixture();
    const bundle = makeWireBundle(fixture.identity, fixture.spk);
    const response = await validateClaimResponse(
      { bundles: [], unavailable: [{ device_id: DEVICE_IDS.peerDevice, reason: 'NO_KEYS' }] },
      REQUEST,
    );
    expect(response.bundles).toEqual([]);
    expect(response.unavailable).toEqual([DEVICE_IDS.peerDevice]);

    await expect(
      validateClaimResponse(
        {
          bundles: [bundle],
          unavailable: [{ device_id: DEVICE_IDS.peerDevice, reason: 'NO_KEYS' }],
        },
        REQUEST,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('chat keys validation', () => {
  it('verifies every device and the self entry', async () => {
    const self = await makeDeviceFixture();
    const peer = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const response = makeChatKeysResponse(self.identity, peer.identity);
    const verified = await validateChatKeysResponse(response, {
      chatId: DEVICE_IDS.chat,
      myDeviceId: DEVICE_IDS.device,
      localIdentity: self.identity,
    });
    expect(verified).toHaveLength(2);
    expect(verified.find((device) => device.isSelf)?.deviceId).toBe(DEVICE_IDS.device);
  });

  it('rejects wrong chat/verifier ids and non-ACTIVE or duplicate devices', async () => {
    const self = await makeDeviceFixture();
    const peer = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const response = makeChatKeysResponse(self.identity, peer.identity);
    const options = { chatId: DEVICE_IDS.chat, myDeviceId: DEVICE_IDS.device };

    await expect(
      validateChatKeysResponse({ ...response, chat_id: DEVICE_IDS.peerDevice }, options),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      validateChatKeysResponse({ ...response, verifier_device_id: DEVICE_IDS.peerDevice }, options),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      validateChatKeysResponse(
        {
          ...response,
          devices: response.devices.map((device) => ({ ...device, status: 'REVOKED' as const })),
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      validateChatKeysResponse(
        { ...response, devices: [response.devices[0]!, response.devices[0]!] },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      validateChatKeysResponse({ ...response, devices: [response.devices[1]!] }, options),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a server fingerprint that does not match the keys', async () => {
    const self = await makeDeviceFixture();
    const peer = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const response = makeChatKeysResponse(self.identity, peer.identity);
    const info = makeDeviceKeyInfo(peer.identity, {
      fingerprint: encodeBase64Url(new Uint8Array(32).fill(1)),
    });
    await expect(verifyDeviceKeyInfo(info)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
    expect(response.devices).toHaveLength(2);
  });

  it('rejects self keys that differ from local identity', async () => {
    const self = await makeDeviceFixture();
    const other = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.user,
    });
    const response = makeChatKeysResponse(other.identity, self.identity);
    await expect(
      validateChatKeysResponse(response, {
        chatId: DEVICE_IDS.chat,
        myDeviceId: DEVICE_IDS.device,
        localIdentity: self.identity,
      }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
  });
});

describe('prekey sender identity (P0-2b)', () => {
  it('matches the prekey block against bundle and pin', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    const bundle = await verifyClaimedBundle(decodePrekeyBundle(wire));
    const envelope = parseEnvelope(
      buildWireEnvelope({
        sender_device_id: wire.device_id,
        sender_key_generation: wire.key_generation,
        prekey: wirePrekey(wire),
      }),
    );
    expect(() => verifyPrekeySenderIdentity(envelope, bundle)).not.toThrow();

    const pin: TofuPinRecord = {
      v: 1,
      userId: DEVICE_IDS.peerUser,
      deviceId: DEVICE_IDS.peerDevice,
      identitySigningKey: wire.identity_signing_key,
      identityDhKey: wire.identity_dh_key,
      identityBindingSignature: wire.identity_binding_signature,
      fingerprint: fixture.identity.record.fingerprint,
      keyGeneration: wire.key_generation,
      firstSeen: 1,
      acceptedAt: null,
      verified: false,
      verifiedAt: null,
      pinSource: 'claim',
    };
    expect(() => verifyPrekeySenderIdentity(envelope, bundle, pin)).not.toThrow();
  });

  it('rejects a bundle/prekey mismatch and a pin mismatch', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    const bundle = await verifyClaimedBundle(decodePrekeyBundle(wire));
    const envelope = parseEnvelope(
      buildWireEnvelope({
        sender_device_id: wire.device_id,
        sender_key_generation: wire.key_generation,
        prekey: { ...wirePrekey(wire), sender_identity_dh_key: b64(new Uint8Array(32).fill(8)) },
      }),
    );
    expect(() => verifyPrekeySenderIdentity(envelope, bundle)).toThrowError(
      expect.objectContaining({ code: 'KEY_HANDSHAKE_INVALID' }),
    );

    const validEnvelope = parseEnvelope(
      buildWireEnvelope({
        sender_device_id: wire.device_id,
        sender_key_generation: wire.key_generation,
        prekey: wirePrekey(wire),
      }),
    );
    const pin: TofuPinRecord = {
      v: 1,
      userId: DEVICE_IDS.peerUser,
      deviceId: DEVICE_IDS.peerDevice,
      identitySigningKey: b64(new Uint8Array(32).fill(2)),
      identityDhKey: b64(new Uint8Array(32).fill(3)),
      identityBindingSignature: b64(new Uint8Array(64).fill(4)),
      fingerprint: b64(new Uint8Array(32).fill(5)),
      keyGeneration: 1,
      firstSeen: 1,
      acceptedAt: null,
      verified: false,
      verifiedAt: null,
      pinSource: 'claim',
    };
    expect(() => verifyPrekeySenderIdentity(validEnvelope, bundle, pin)).toThrowError(
      expect.objectContaining({ code: 'KEY_CHANGE_DETECTED' }),
    );
  });

  it('rejects a prekey block with another sender device or generation', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    const bundle = await verifyClaimedBundle(decodePrekeyBundle(wire));

    const otherDevice = parseEnvelope(
      buildWireEnvelope({
        sender_device_id: DEVICE_IDS.peerDevice2,
        sender_key_generation: wire.key_generation,
        prekey: wirePrekey(wire),
      }),
    );
    expect(() => verifyPrekeySenderIdentity(otherDevice, bundle)).toThrowError(
      expect.objectContaining({ code: 'KEY_HANDSHAKE_INVALID' }),
    );

    const otherGeneration = parseEnvelope(
      buildWireEnvelope({
        sender_device_id: wire.device_id,
        sender_key_generation: 2,
        prekey: wirePrekey(wire),
      }),
    );
    expect(() => verifyPrekeySenderIdentity(otherGeneration, bundle)).toThrowError(
      expect.objectContaining({ code: 'KEY_HANDSHAKE_INVALID' }),
    );
  });

  it('rejects an envelope without a prekey block', async () => {
    const fixture = await makeDeviceFixture();
    const wire = makeWireBundle(fixture.identity, fixture.spk);
    const bundle = await verifyClaimedBundle(decodePrekeyBundle(wire));
    const envelope = parseEnvelope(buildWireEnvelope());
    expect(() => verifyPrekeySenderIdentity(envelope, bundle)).toThrowError(
      expect.objectContaining({ code: 'KEY_HANDSHAKE_INVALID' }),
    );
  });
});
