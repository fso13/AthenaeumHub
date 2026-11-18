/**
 * Verification hash v2 (the client value sent as `safety_number_hash`) §7.4.
 *
 * `SHA-256(D_VER || u8(2) || chat_id || verifier_user_id || verifier_device_id
 *  || target_device_id || u32(target_key_generation) || ascii(digits_60))`
 *
 * The verifier's DEVICE is part of the hash (P0-1): another device of the same
 * user gets different digits and therefore a different hash.
 */
import { D_VER, MAX_KEY_GENERATION, VERIFICATION_HASH_VERSION } from '../constants';
import { invalid } from '../errors';
import { sha256 } from '../crypto/digest';
import { concatBytes, u32be, u8, utf8, uuidToBytes } from '../encoding/bytes';

export interface VerificationHashInput {
  readonly chatId: string;
  readonly verifierUserId: string;
  readonly verifierDeviceId: string;
  readonly targetDeviceId: string;
  readonly targetKeyGeneration: number;
  /** 60 decimal characters — the per-device-pair digits. */
  readonly safetyNumberDigits: string;
}

export async function computeVerificationHash(input: VerificationHashInput): Promise<Uint8Array> {
  if (!/^\d{60}$/.test(input.safetyNumberDigits)) {
    throw invalid('INVALID_PAYLOAD', 'safety number digits must be exactly 60 decimal characters');
  }
  if (
    !Number.isInteger(input.targetKeyGeneration) ||
    input.targetKeyGeneration < 1 ||
    input.targetKeyGeneration > MAX_KEY_GENERATION
  ) {
    throw invalid('INVALID_KEY', 'target_key_generation is out of range');
  }
  return sha256(
    concatBytes(
      D_VER,
      u8(VERIFICATION_HASH_VERSION),
      uuidToBytes(input.chatId),
      uuidToBytes(input.verifierUserId),
      uuidToBytes(input.verifierDeviceId),
      uuidToBytes(input.targetDeviceId),
      u32be(input.targetKeyGeneration),
      utf8(input.safetyNumberDigits),
    ),
  );
}
