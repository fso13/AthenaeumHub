/**
 * Shared trust checks for send and receive (E7-F4).
 *
 * These are the *local* decisions that must not be delegated to the server:
 * re-verify a device's `IK_sig → IK_dh` binding, compare its keys/generation to
 * the persisted TOFU pin, and compare a session's peer keys to the device keys
 * on every use (CR1 P2-04: a tampered session record must not silently select
 * the wrong peer).
 */
import { E2eeError } from '../errors';
import { areBytesEqual } from '../encoding/bytes';
import { encodeBase64Url } from '../encoding/base64url';
import { verifyIdentityKeyMaterial } from '../device/binding';
import type { TofuPinRecord, VerifiedDeviceIdentity } from '../device/types';
import type { SessionState } from './types';

/** Re-verifies binding + fingerprint of a device identity handed in by F3. */
export async function assertVerifiedIdentity(identity: VerifiedDeviceIdentity): Promise<void> {
  const verified = await verifyIdentityKeyMaterial(
    identity.identitySigningKey,
    identity.identityDhKey,
    identity.identityBindingSignature,
    'device',
  );
  if (verified.fingerprintBase64Url !== identity.fingerprintBase64Url) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'device fingerprint does not match its keys');
  }
}

/** Any difference from the pin is a key change; the pin is never overwritten here. */
export function pinMatchesIdentity(pin: TofuPinRecord, identity: VerifiedDeviceIdentity): boolean {
  return (
    pin.userId === identity.userId &&
    pin.deviceId === identity.deviceId &&
    pin.identitySigningKey === encodeBase64Url(identity.identitySigningKey) &&
    pin.identityDhKey === encodeBase64Url(identity.identityDhKey) &&
    pin.identityBindingSignature === encodeBase64Url(identity.identityBindingSignature) &&
    pin.fingerprint === identity.fingerprintBase64Url &&
    pin.keyGeneration === identity.keyGeneration
  );
}

/** A stored session must still describe the same chat and the same peer keys. */
export function assertSessionMatchesIdentity(
  session: SessionState,
  identity: VerifiedDeviceIdentity,
  chatId: string,
): void {
  if (session.chatId !== chatId) {
    throw new E2eeError('SESSION_STATE_STALE', 'session belongs to another chat');
  }
  if (session.peerUserId !== identity.userId || session.peerDeviceId !== identity.deviceId) {
    throw new E2eeError('SESSION_STATE_STALE', 'session belongs to another peer device');
  }
  if (
    !areBytesEqual(session.peerIkSig, identity.identitySigningKey) ||
    !areBytesEqual(session.peerIkDh, identity.identityDhKey)
  ) {
    throw new E2eeError(
      'KEY_CHANGE_DETECTED',
      'session peer identity keys no longer match the device keys',
    );
  }
}
