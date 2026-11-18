/**
 * Safety-number properties beyond the G2–G5 KATs: symmetry, independence from
 * the caller's order, per-pair keys, QR stability and input validation.
 */
import { describe, expect, it } from 'vitest';
import {
  SAFETY_NUMBER_DIGITS,
  buildSafetyNumberQrPayload,
  computeSafetyNumber,
  formatSafetyNumberDigits,
  safetyNumberPairKey,
} from './verification/safetyNumber';
import { computeVerificationHash } from './verification/verificationHash';
import { deviceFingerprint } from './verification/fingerprint';
import { hexToBytes } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import { getVector, loadVectorFile } from './test/vectors';

interface SafetyEntryJson {
  user_id: string;
  device_id: string;
  fingerprint: string;
}

const g2 = getVector<{ inputs: { entries: [SafetyEntryJson, SafetyEntryJson] } }>(
  loadVectorFile(),
  'G2-safety-number',
);
const [aliceJson, bobJson] = g2.inputs.entries;
const alice = {
  userId: aliceJson.user_id,
  deviceId: aliceJson.device_id,
  fingerprint: hexToBytes(aliceJson.fingerprint),
};
const bob = {
  userId: bobJson.user_id,
  deviceId: bobJson.device_id,
  fingerprint: hexToBytes(bobJson.fingerprint),
};

describe('safety number properties', () => {
  it('is symmetric and independent of argument order', async () => {
    const forward = await computeSafetyNumber(alice, bob);
    const backward = await computeSafetyNumber(bob, alice);
    expect(forward.digits).toBe(backward.digits);
    expect(Array.from(forward.digest)).toEqual(Array.from(backward.digest));
    expect(forward.display).toBe(backward.display);
    expect(forward.digits).toHaveLength(SAFETY_NUMBER_DIGITS);
  });

  it('changes when either device key changes', async () => {
    const original = await computeSafetyNumber(alice, bob);
    const changedBob = {
      ...bob,
      fingerprint: await deviceFingerprint(new Uint8Array(32), new Uint8Array(32).fill(1)),
    };
    const changed = await computeSafetyNumber(alice, changedBob);
    expect(changed.digits).not.toBe(original.digits);
    expect(changed.display).not.toBe(original.display);
  });

  it('binds the verifier device into the verification hash', async () => {
    const digits = (await computeSafetyNumber(alice, bob)).digits;
    const base = {
      chatId: '00000000-0000-4000-8000-000000000100',
      verifierUserId: alice.userId,
      targetDeviceId: bob.deviceId,
      targetKeyGeneration: 1,
      safetyNumberDigits: digits,
    };
    const onTel = await computeVerificationHash({
      ...base,
      verifierDeviceId: alice.deviceId,
    });
    const onLaptop = await computeVerificationHash({
      ...base,
      verifierDeviceId: '00000000-0000-4000-8000-000000000012',
    });
    expect(onTel).toHaveLength(32);
    expect(Array.from(onTel)).not.toEqual(Array.from(onLaptop));
  });

  it('rejects malformed digits and out-of-range generations', async () => {
    const base = {
      chatId: '00000000-0000-4000-8000-000000000100',
      verifierUserId: alice.userId,
      verifierDeviceId: alice.deviceId,
      targetDeviceId: bob.deviceId,
      targetKeyGeneration: 1,
      safetyNumberDigits: '1'.repeat(59),
    };
    await expect(computeVerificationHash(base)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      computeVerificationHash({
        ...base,
        safetyNumberDigits: '1'.repeat(60),
        targetKeyGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('formats exactly 12 groups of 5 digits', () => {
    const formatted = formatSafetyNumberDigits('0'.repeat(60));
    expect(formatted.split(' ')).toHaveLength(12);
    expect(formatted).toHaveLength(60 + 11);
    expect(
      formatSafetyNumberDigits('123456789012345678901234567890123456789012345678901234567890'),
    ).toBe('12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890');
    expect(() => formatSafetyNumberDigits('123')).toThrow();
    expect(() => formatSafetyNumberDigits('a'.repeat(60))).toThrow();
  });

  it('rejects fingerprints that are not 32 bytes', async () => {
    await expect(
      computeSafetyNumber(alice, { ...bob, fingerprint: new Uint8Array(31) }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });
});

describe('QR payload', () => {
  it('orders devices deterministically and is stable for either argument order', () => {
    const forward = buildSafetyNumberQrPayload(
      { deviceId: alice.deviceId, fingerprint: alice.fingerprint },
      { deviceId: bob.deviceId, fingerprint: bob.fingerprint },
    );
    const backward = buildSafetyNumberQrPayload(
      { deviceId: bob.deviceId, fingerprint: bob.fingerprint },
      { deviceId: alice.deviceId, fingerprint: alice.fingerprint },
    );
    expect(forward).toBe(backward);
    expect(forward.startsWith('krug://verify/v1?')).toBe(true);
    const params = new URLSearchParams(forward.slice('krug://verify/v1?'.length));
    expect(params.get('dev1')).toBe(alice.deviceId);
    expect(params.get('dev2')).toBe(bob.deviceId);
    expect(params.get('fp1')).toBe(encodeBase64Url(alice.fingerprint));
    expect(params.get('fp2')).toBe(encodeBase64Url(bob.fingerprint));
  });

  it('rejects a short fingerprint', () => {
    expect(() =>
      buildSafetyNumberQrPayload(
        { deviceId: alice.deviceId, fingerprint: new Uint8Array(31) },
        { deviceId: bob.deviceId, fingerprint: bob.fingerprint },
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_KEY' }));
  });
});

describe('per-device-pair key', () => {
  it('is order-independent and device-specific', () => {
    expect(safetyNumberPairKey(alice.deviceId, bob.deviceId)).toBe(
      safetyNumberPairKey(bob.deviceId, alice.deviceId),
    );
    expect(safetyNumberPairKey(alice.deviceId, bob.deviceId)).not.toBe(
      safetyNumberPairKey(alice.deviceId, '00000000-0000-4000-8000-000000000012'),
    );
  });
});
