/**
 * Normative K_storage AAD KATs (E7-F2G, CR1b P1-07/P2-18).
 *
 * Every expected value comes from `docs/E2EE-TEST-VECTORS.json` section
 * `O-kstorage-aad` — no AAD/ciphertext constant is duplicated in this file.
 * O1 pins the exact 50-byte layout and AES-256-GCM bytes, O2 pins nil/zero
 * injectivity, O3 pins the pin/key-change/mode-pin scope slots.
 */
import { describe, expect, it } from 'vitest';
import { getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes, utf8 } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import { aesGcmDecrypt, aesGcmEncrypt } from './crypto/aead';
import {
  K_STORAGE_AAD_OFFSETS,
  buildKStorageAad,
  type KStorageAadFields,
} from './storage/kStorage';
import { modeAad, pinAad } from './device/pinStore';

interface O1Inputs {
  key_hex: string;
  owner_device_id: string;
  session_id_b64u: string;
  client_message_id: string;
  record_type: 'session';
  record_type_code: number;
  local_record_version: number;
  nonce_hex: string;
  plaintext_utf8: string;
}
interface O1Expected {
  aad_len: number;
  aad_offsets: typeof K_STORAGE_AAD_OFFSETS;
  aad_hex: string;
  ciphertext_hex_with_tag: string;
  plaintext_utf8: string;
}
interface O2Inputs {
  owner_device_id: string;
  record_type: 'localCopy';
  record_type_code: number;
  local_record_version: number;
}
interface O2Expected {
  absent_ids_aad_hex: string;
  zero_sentinel_hex: string;
  nil_uuid_rejected: boolean;
  zero_session_id_rejected: boolean;
  nil_client_message_id_rejected: boolean;
  nil_owner_device_id_rejected: boolean;
  null_and_nil_share_aad: boolean;
}
interface O3Inputs {
  owner_device_id: string;
  target_user_id: string;
  target_device_id: string;
  chat_id: string;
  pin_record_type_code: number;
  key_change_record_type_code: number;
  mode_pin_record_type_code: number;
  local_record_version: number;
}
interface O3Expected {
  pin_aad_hex: string;
  key_change_aad_hex: string;
  mode_pin_aad_hex: string;
}

const file = loadVectorFile();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const ACCOUNT_B_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZERO_ID = encodeBase64Url(new Uint8Array(16));

describe('O — normative K_storage AAD (P1-07)', () => {
  it('O1 matches the 50-byte layout and the fixed AES-256-GCM bytes', async () => {
    const vector = getVector<{ inputs: O1Inputs; expected: O1Expected }>(
      file,
      'O1-kstorage-aad-kat',
    );
    const { inputs, expected } = vector;
    const fields: KStorageAadFields = {
      ownerDeviceId: inputs.owner_device_id,
      sessionId: inputs.session_id_b64u,
      clientMessageId: inputs.client_message_id,
      recordType: inputs.record_type,
    };
    const aad = buildKStorageAad(fields);
    expect(aad).toHaveLength(expected.aad_len);
    expect(aad).toHaveLength(50);
    expect(expected.aad_offsets).toEqual(K_STORAGE_AAD_OFFSETS);
    expect(bytesToHex(aad)).toBe(expected.aad_hex);
    expect(inputs.record_type_code).toBe(1);
    expect(inputs.local_record_version).toBe(1);
    expect(K_STORAGE_AAD_OFFSETS).toEqual({
      deviceId: 0,
      sessionId: 16,
      clientMessageId: 32,
      recordType: 48,
      version: 49,
    });

    const key = hexToBytes(inputs.key_hex);
    const nonce = hexToBytes(inputs.nonce_hex);
    const plaintext = utf8(inputs.plaintext_utf8);
    const ciphertext = await aesGcmEncrypt(key, nonce, plaintext, aad);
    expect(bytesToHex(ciphertext)).toBe(expected.ciphertext_hex_with_tag);

    const decrypted = await aesGcmDecrypt(
      key,
      nonce,
      hexToBytes(expected.ciphertext_hex_with_tag),
      aad,
    );
    expect(new TextDecoder().decode(decrypted)).toBe(expected.plaintext_utf8);

    // The ciphertext must not authenticate under any other record type/scope.
    const wrongType = buildKStorageAad({ ...fields, recordType: 'outbox' });
    await expect(
      aesGcmDecrypt(key, nonce, hexToBytes(expected.ciphertext_hex_with_tag), wrongType),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('O2 encodes absent ids as the zero sentinel and rejects nil values', () => {
    const vector = getVector<{ inputs: O2Inputs; expected: O2Expected }>(
      file,
      'O2-kstorage-aad-injectivity',
    );
    const { inputs, expected } = vector;
    const absent = buildKStorageAad({
      ownerDeviceId: inputs.owner_device_id,
      sessionId: null,
      clientMessageId: null,
      recordType: inputs.record_type,
    });
    expect(bytesToHex(absent)).toBe(expected.absent_ids_aad_hex);
    expect(bytesToHex(absent.subarray(16, 48))).toBe(
      expected.zero_sentinel_hex + expected.zero_sentinel_hex,
    );
    expect(inputs.record_type_code).toBe(3);
    expect(inputs.local_record_version).toBe(1);

    const rejects = [
      () => buildKStorageAad({ ownerDeviceId: NIL_UUID, recordType: 'localCopy' }),
      () =>
        buildKStorageAad({
          ownerDeviceId: inputs.owner_device_id,
          sessionId: ZERO_ID,
          recordType: 'localCopy',
        }),
      () =>
        buildKStorageAad({
          ownerDeviceId: inputs.owner_device_id,
          sessionId: NIL_UUID,
          recordType: 'localCopy',
        }),
      () =>
        buildKStorageAad({
          ownerDeviceId: inputs.owner_device_id,
          clientMessageId: NIL_UUID,
          recordType: 'localCopy',
        }),
    ];
    for (const call of rejects) {
      expect(call).toThrowError(expect.objectContaining({ code: 'KEY_STORAGE_UNAVAILABLE' }));
    }
    expect(expected.nil_uuid_rejected).toBe(true);
    expect(expected.zero_session_id_rejected).toBe(true);
    expect(expected.nil_client_message_id_rejected).toBe(true);
    expect(expected.nil_owner_device_id_rejected).toBe(true);
    expect(expected.null_and_nil_share_aad).toBe(false);
  });
});

describe('O — normative pin AAD slots (P2-18)', () => {
  it('O3 binds pin/key-change to (owner device, user, target device) and mode to chat', () => {
    const vector = getVector<{ inputs: O3Inputs; expected: O3Expected }>(file, 'O3-pin-aad-scope');
    const { inputs, expected } = vector;
    const owner = inputs.owner_device_id;
    const pinFields = pinAad(inputs.target_user_id, inputs.target_device_id, 'pin');
    const keyChangeFields = pinAad(inputs.target_user_id, inputs.target_device_id, 'keyChange');
    const modeFields = modeAad(inputs.chat_id);

    expect(pinFields.recordType).toBe('pin');
    expect(keyChangeFields.recordType).toBe('keyChange');
    expect(modeFields.recordType).toBe('modePin');
    expect(bytesToHex(buildKStorageAad({ ownerDeviceId: owner, ...pinFields }))).toBe(
      expected.pin_aad_hex,
    );
    expect(bytesToHex(buildKStorageAad({ ownerDeviceId: owner, ...keyChangeFields }))).toBe(
      expected.key_change_aad_hex,
    );
    expect(bytesToHex(buildKStorageAad({ ownerDeviceId: owner, ...modeFields }))).toBe(
      expected.mode_pin_aad_hex,
    );
    expect(inputs.pin_record_type_code).toBe(4);
    expect(inputs.key_change_record_type_code).toBe(5);
    expect(inputs.mode_pin_record_type_code).toBe(6);
    expect(inputs.local_record_version).toBe(1);

    // Every scope component is authenticated: another owner, user, target
    // device or record type produces a different 50-byte AAD.
    const pinAadHex = bytesToHex(buildKStorageAad({ ownerDeviceId: owner, ...pinFields }));
    expect(
      bytesToHex(buildKStorageAad({ ownerDeviceId: inputs.target_device_id, ...pinFields })),
    ).not.toBe(pinAadHex);
    expect(
      bytesToHex(
        buildKStorageAad({
          ownerDeviceId: owner,
          ...pinAad(ACCOUNT_B_USER, inputs.target_device_id, 'pin'),
        }),
      ),
    ).not.toBe(pinAadHex);
    expect(
      bytesToHex(
        buildKStorageAad({
          ownerDeviceId: owner,
          ...pinAad(inputs.target_user_id, inputs.chat_id, 'pin'),
        }),
      ),
    ).not.toBe(pinAadHex);
    expect(
      bytesToHex(
        buildKStorageAad({
          ownerDeviceId: owner,
          ...pinAad(inputs.target_user_id, inputs.target_device_id, 'keyChange'),
        }),
      ),
    ).not.toBe(pinAadHex);
  });
});
