/**
 * Versioned, transactional session store (§3.4.5, §3.4.6, §3.4.5.1).
 *
 * One record per `session_id`; multiple sessions per `(chat, peer_device)` are
 * allowed (§5.7) and tracked by a small secondary index in the same store. The
 * ratchet's secret bytes (`RK/CKs/CKr/MKSKIPPED`) are sealed with `K_storage`,
 * while the current `DHs` private key is a non-extractable `CryptoKey`. Only
 * the current pair is ever written: saving a new ratchet state drops the old
 * private key, so a storage scan cannot find a superseded `DHs_priv`.
 *
 * Every write is an optimistic compare-and-swap on `revision`. A tab that
 * loaded an older state gets `SESSION_STATE_STALE` instead of silently
 * clobbering another tab's chain advance; under `krug-session:<id>` locks this
 * should be a defensive backstop, not the normal path.
 */
import {
  KEY_ID_PATTERN,
  MAX_HEADER_COUNTER,
  MAX_KEY_ID_CHARS,
  MAX_SKIP,
  SESSION_ID_BYTES,
  SESSION_IDLE_TTL_MS,
} from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import { areBytesEqual, assertBytesLength, isUuid, utf8, zeroBytes } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { assertPrivateKey } from '../crypto/keyGuards';
import { sha256 } from '../crypto/digest';
import { importX25519PublicKey, x25519SharedSecret } from '../crypto/x25519';
import { kdfChainKey, kdfRootKey } from '../protocol/kdf';
import { type E2eeStorage, type E2eeTransaction } from '../storage/types';
import { type EncryptedRecord, type KStorage } from '../storage/kStorage';
import {
  type SessionInitiator,
  type SessionState,
  type SkippedMessageKey,
  type StoredSessionRecord,
  type StoredSessionSecrets,
  pruneSkippedKeys,
} from './types';

export const SESSION_KEY_PREFIX = 'session:';
const PEER_INDEX_PREFIX = 'peer:';
const STORED_VERSION = 1;

interface PeerSessionIndex {
  readonly v: 1;
  readonly sessionIds: readonly string[];
}

export interface PreparedSessionRecord {
  readonly record: StoredSessionRecord;
  /** State after retention pruning; carries the revision read from storage. */
  readonly state: SessionState;
}

export type SessionWriteMode = { readonly create: true } | { readonly ifRevision: number };

export function sessionStorageKey(sessionId: string): string {
  requireSessionId(sessionId);
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export function peerSessionIndexKey(
  deviceId: string,
  chatId: string,
  peerDeviceId: string,
): string {
  requireUuid(deviceId, 'device_id');
  requireUuid(chatId, 'chat_id');
  requireUuid(peerDeviceId, 'peer_device_id');
  return `${PEER_INDEX_PREFIX}${deviceId}:${chatId}:${peerDeviceId}`;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireSessionId(value: string): string {
  try {
    decodeBase64Url(value, SESSION_ID_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session_id must be canonical b64u16');
  }
  return value;
}

function requireOptionalSessionId(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  try {
    decodeBase64Url(value, SESSION_ID_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u16`);
  }
  return value;
}

function requireKeyBytes(value: Uint8Array, label: string): Uint8Array {
  try {
    return assertBytesLength(value, 32, label);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be 32 bytes`);
  }
}

function requireOptionalKeyBytes(value: Uint8Array | null, label: string): Uint8Array | null {
  return value === null ? null : requireKeyBytes(value, label);
}

function requireCounter(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_HEADER_COUNTER) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is out of range`);
  }
  return value;
}

function requireInitiatedBy(value: SessionInitiator | null | undefined): SessionInitiator | null {
  if (value === undefined || value === null) return null;
  if (value !== 'local' && value !== 'peer') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session initiator is invalid');
  }
  return value;
}

function requireOptionalTimestamp(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  return requireTimestamp(value, label);
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid timestamp`);
  }
  return value;
}

function requireRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session revision is invalid');
  }
  return value;
}

function requireUuidOrNull(value: string | null, label: string): string | null {
  return value === null ? null : requireUuid(value, label);
}

function decodeB64uOrNull(
  value: string | null,
  expectedBytes: number,
  label: string,
): Uint8Array | null {
  if (value === null) return null;
  try {
    return decodeBase64Url(value, expectedBytes);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not canonical b64u`);
  }
}

export function validateSessionState(state: SessionState): SessionState {
  requireSessionId(state.sessionId);
  requireUuid(state.deviceId, 'device_id');
  requireUuid(state.chatId, 'chat_id');
  requireUuid(state.peerUserId, 'peer_user_id');
  requireUuid(state.peerDeviceId, 'peer_device_id');
  requireKeyBytes(state.peerIkSig, 'peer_ik_sig');
  requireKeyBytes(state.peerIkDh, 'peer_ik_dh');
  requireKeyBytes(state.rootKey, 'root_key');
  assertPrivateKey(state.dhPrivateKey, 'session DHs private key');
  requireKeyBytes(state.dhPublicKey, 'dh_public_key');
  requireOptionalKeyBytes(state.dhRemote, 'dh_remote');
  requireOptionalKeyBytes(state.chainSend, 'chain_send');
  requireOptionalKeyBytes(state.chainRecv, 'chain_recv');
  requireCounter(state.ns, 'ns');
  requireCounter(state.nr, 'nr');
  requireCounter(state.pn, 'pn');
  if (state.spkId !== undefined && state.spkId !== null) {
    if (!KEY_ID_PATTERN.test(state.spkId) || state.spkId.length > MAX_KEY_ID_CHARS) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'spk_id is not a valid key id');
    }
  }
  requireInitiatedBy(state.initiatedBy);
  requireOptionalTimestamp(state.lastReceivedAt, 'last_received_at');
  const supersededBy = requireOptionalSessionId(state.supersededBy, 'superseded_by');
  const supersededAt = requireOptionalTimestamp(state.supersededAt, 'superseded_at');
  if ((supersededBy === null) !== (supersededAt === null)) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'superseded_by and superseded_at must be set together',
    );
  }
  if (supersededBy !== null && supersededBy === state.sessionId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'a session cannot supersede itself');
  }
  requireOptionalTimestamp(state.winnerConfirmedAt, 'winner_confirmed_at');
  requireTimestamp(state.createdAt, 'created_at');
  requireTimestamp(state.lastUsedAt, 'last_used_at');
  requireUuidOrNull(state.localCopyRef, 'local_copy_ref');
  if (state.revision !== 0) requireRevision(state.revision);
  for (const skipped of state.skipped) {
    requireKeyBytes(skipped.dh, 'skipped.dh');
    requireKeyBytes(skipped.messageKey, 'skipped.message_key');
    requireCounter(skipped.n, 'skipped.n');
    requireTimestamp(skipped.createdAt, 'skipped.created_at');
  }
  return state;
}

function serializeSecrets(state: SessionState): Uint8Array {
  const secrets: StoredSessionSecrets = {
    v: STORED_VERSION,
    sessionId: state.sessionId,
    deviceId: state.deviceId,
    ns: state.ns,
    nr: state.nr,
    pn: state.pn,
    spkId: state.spkId ?? null,
    initiatedBy: requireInitiatedBy(state.initiatedBy),
    lastReceivedAt: requireOptionalTimestamp(state.lastReceivedAt, 'last_received_at'),
    supersededBy: requireOptionalSessionId(state.supersededBy, 'superseded_by'),
    supersededAt: requireOptionalTimestamp(state.supersededAt, 'superseded_at'),
    winnerConfirmedAt: requireOptionalTimestamp(state.winnerConfirmedAt, 'winner_confirmed_at'),
    dhPublicKey: encodeBase64Url(state.dhPublicKey),
    rootKey: encodeBase64Url(state.rootKey),
    chainSend: state.chainSend ? encodeBase64Url(state.chainSend) : null,
    chainRecv: state.chainRecv ? encodeBase64Url(state.chainRecv) : null,
    skipped: state.skipped.map((key) => ({
      dh: encodeBase64Url(key.dh),
      n: key.n,
      messageKey: encodeBase64Url(key.messageKey),
      createdAt: key.createdAt,
    })),
  };
  return utf8(JSON.stringify(secrets));
}

function parseSecrets(bytes: Uint8Array): StoredSessionSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session secrets are not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session secrets are malformed');
  }
  const candidate = parsed as Partial<StoredSessionSecrets>;
  if (
    candidate.v !== STORED_VERSION ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.deviceId !== 'string'
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session secrets version is unsupported');
  }
  requireUuid(candidate.deviceId, 'secrets.device_id');
  if (
    typeof candidate.rootKey !== 'string' ||
    (candidate.chainSend !== null && typeof candidate.chainSend !== 'string') ||
    (candidate.chainRecv !== null && typeof candidate.chainRecv !== 'string') ||
    typeof candidate.dhPublicKey !== 'string' ||
    !Array.isArray(candidate.skipped)
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session secrets are malformed');
  }
  const ns = requireCounter(candidate.ns as number, 'secrets.ns');
  const nr = requireCounter(candidate.nr as number, 'secrets.nr');
  const pn = requireCounter(candidate.pn as number, 'secrets.pn');
  const sealedSpkId = candidate.spkId ?? null;
  const initiatedBy = requireInitiatedBy(candidate.initiatedBy);
  const lastReceivedAt = requireOptionalTimestamp(
    candidate.lastReceivedAt,
    'secrets.last_received_at',
  );
  const supersededBy = requireOptionalSessionId(candidate.supersededBy, 'secrets.superseded_by');
  const supersededAt = requireOptionalTimestamp(candidate.supersededAt, 'secrets.superseded_at');
  if ((supersededBy === null) !== (supersededAt === null)) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'secrets.superseded_by and superseded_at must be set together',
    );
  }
  const winnerConfirmedAt = requireOptionalTimestamp(
    candidate.winnerConfirmedAt,
    'secrets.winner_confirmed_at',
  );
  if (sealedSpkId !== null) {
    if (typeof sealedSpkId !== 'string' || !KEY_ID_PATTERN.test(sealedSpkId)) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'secrets.spk_id is not a valid key id');
    }
  }
  const skipped = candidate.skipped.map((entry): StoredSessionSecrets['skipped'][number] => {
    if (typeof entry !== 'object' || entry === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'skipped key record is malformed');
    }
    const key = entry as { dh?: unknown; n?: unknown; messageKey?: unknown; createdAt?: unknown };
    if (
      typeof key.dh !== 'string' ||
      typeof key.messageKey !== 'string' ||
      typeof key.n !== 'number' ||
      typeof key.createdAt !== 'number'
    ) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'skipped key record is malformed');
    }
    return {
      dh: key.dh,
      n: requireCounter(key.n, 'skipped.n'),
      messageKey: key.messageKey,
      createdAt: requireTimestamp(key.createdAt, 'skipped.created_at'),
    };
  });
  return {
    v: 1,
    sessionId: candidate.sessionId,
    deviceId: candidate.deviceId,
    ns,
    nr,
    pn,
    spkId: sealedSpkId,
    initiatedBy,
    lastReceivedAt,
    supersededBy,
    supersededAt,
    winnerConfirmedAt,
    dhPublicKey: candidate.dhPublicKey,
    rootKey: candidate.rootKey,
    chainSend: candidate.chainSend,
    chainRecv: candidate.chainRecv,
    skipped,
  };
}

function decodeSkipped(secrets: StoredSessionSecrets): SkippedMessageKey[] {
  return secrets.skipped.map((key) => ({
    dh: decodeB64uOrNull(key.dh, 32, 'skipped.dh') as Uint8Array,
    n: requireCounter(key.n, 'skipped.n'),
    messageKey: decodeB64uOrNull(key.messageKey, 32, 'skipped.message_key') as Uint8Array,
    createdAt: requireTimestamp(key.createdAt, 'skipped.created_at'),
  }));
}

async function chainSendCommitment(chainSend: Uint8Array | null): Promise<string | null> {
  return chainSend === null ? null : encodeBase64Url(await sha256(chainSend));
}

async function hashChainCommitment(chain: Uint8Array | null): Promise<string | null> {
  return chain === null ? null : encodeBase64Url(await sha256(chain));
}

function bytesEqualOrBothNull(
  left: Uint8Array | null | undefined,
  right: Uint8Array | null | undefined,
): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return areBytesEqual(left, right);
}

interface FingerprintFields {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly revision: number;
  readonly ns: number;
  readonly nr: number;
  readonly pn: number;
  readonly chainSendCommitment: string | null;
  readonly chainRecvCommitment: string | null;
  /**
   * E7-F6 §5.7 winner/superseded metadata is part of the persisted transition
   * fingerprint: a prepared send/receive derived from a session before it was
   * marked must not clobber the decision back to `null`.
   */
  readonly supersededBy: string | null;
  readonly supersededAt: number | null;
  readonly winnerConfirmedAt: number | null;
}

function composeStateFingerprint(fields: FingerprintFields): string {
  return JSON.stringify([
    fields.sessionId,
    fields.deviceId,
    fields.revision,
    fields.ns,
    fields.nr,
    fields.pn,
    fields.chainSendCommitment,
    fields.chainRecvCommitment,
    fields.supersededBy,
    fields.supersededAt,
    fields.winnerConfirmedAt,
  ]);
}

async function fingerprintOfState(state: SessionState): Promise<string> {
  return composeStateFingerprint({
    sessionId: state.sessionId,
    deviceId: state.deviceId,
    revision: state.revision,
    ns: state.ns,
    nr: state.nr,
    pn: state.pn,
    chainSendCommitment: await hashChainCommitment(state.chainSend),
    chainRecvCommitment: await hashChainCommitment(state.chainRecv),
    supersededBy: state.supersededBy ?? null,
    supersededAt: state.supersededAt ?? null,
    winnerConfirmedAt: state.winnerConfirmedAt ?? null,
  });
}

function fingerprintOfRecord(record: StoredSessionRecord): string {
  return composeStateFingerprint({
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    revision: record.revision,
    ns: record.ns,
    nr: record.nr,
    pn: record.pn,
    chainSendCommitment: record.chainSendCommitment ?? null,
    chainRecvCommitment: record.chainRecvCommitment ?? null,
    supersededBy: record.supersededBy ?? null,
    supersededAt: record.supersededAt ?? null,
    winnerConfirmedAt: record.winnerConfirmedAt ?? null,
  });
}

function stale(message: string): E2eeError {
  return new E2eeError('SESSION_STATE_STALE', message);
}

async function dhWith(privateKey: CryptoKey, publicKeyBytes: Uint8Array): Promise<Uint8Array> {
  return x25519SharedSecret(privateKey, await importX25519PublicKey(publicKeyBytes));
}

/**
 * Forward-KDF proof for every stored transition (E7-F5G, P1-01R-R/P2-36).
 *
 * The store no longer trusts a caller-provided counter jump. A send must be
 * exactly `KDF_CK(CKs).next`, a same-chain receive must consume the persisted
 * receiving chain (`K` steps for `nr + K`), a DH ratchet must be recomputable
 * from the previous root key + both DH pairs, and a skipped-key hit may only
 * touch `MKSKIPPED` (no chain/counter change). Anything else is rejected before
 * a record is built, so a forged `{ns: 0, new DHs, old CK0}` cannot re-use a
 * message key/nonce.
 */
async function assertForwardTransition(previous: SessionState, next: SessionState): Promise<void> {
  if (
    previous.sessionId !== next.sessionId ||
    previous.deviceId !== next.deviceId ||
    previous.chatId !== next.chatId ||
    previous.peerUserId !== next.peerUserId ||
    previous.peerDeviceId !== next.peerDeviceId
  ) {
    throw stale('session scope cannot change between writes');
  }

  // §5.7 winner/superseded metadata is monotonic: a session may be marked as
  // superseded (or promoted back on recovery when its winner vanished), and a
  // winner confirmation may be added but never moved backwards.
  const beforeSupersededBy = previous.supersededBy ?? null;
  const afterSupersededBy = next.supersededBy ?? null;
  if (
    beforeSupersededBy !== null &&
    afterSupersededBy !== null &&
    beforeSupersededBy !== afterSupersededBy
  ) {
    throw stale('a superseded session cannot switch to another winner');
  }
  const beforeSupersededAt = previous.supersededAt ?? null;
  const afterSupersededAt = next.supersededAt ?? null;
  if ((afterSupersededBy === null) !== (afterSupersededAt === null)) {
    throw stale('supersededBy and supersededAt must be set together');
  }
  if (
    afterSupersededAt !== null &&
    beforeSupersededAt !== null &&
    afterSupersededAt < beforeSupersededAt
  ) {
    throw stale('superseded_at must not move backwards');
  }
  const beforeConfirmed = previous.winnerConfirmedAt ?? null;
  const afterConfirmed = next.winnerConfirmedAt ?? null;
  if (beforeConfirmed !== null && (afterConfirmed === null || afterConfirmed < beforeConfirmed)) {
    throw stale('winner confirmation must not be removed or moved backwards');
  }
  if (afterSupersededBy !== null && afterSupersededBy === next.sessionId) {
    throw stale('a session cannot supersede itself');
  }

  const dhRemoteChanged = !bytesEqualOrBothNull(previous.dhRemote, next.dhRemote);
  const dhChanged = !areBytesEqual(previous.dhPublicKey, next.dhPublicKey);

  if (!dhRemoteChanged) {
    const metadataOnly =
      next.ns === previous.ns &&
      next.nr === previous.nr &&
      next.pn === previous.pn &&
      !dhChanged &&
      bytesEqualOrBothNull(previous.rootKey, next.rootKey) &&
      bytesEqualOrBothNull(previous.chainSend, next.chainSend) &&
      bytesEqualOrBothNull(previous.chainRecv, next.chainRecv);
    if (metadataOnly) return; // skipped-key hit / lastUsedAt only

    if (dhChanged || next.pn !== previous.pn) {
      throw stale('session DH/pn cannot change without a new remote DH');
    }
    if (!bytesEqualOrBothNull(previous.rootKey, next.rootKey)) {
      throw stale('session root key cannot change without a new remote DH');
    }
    if (next.ns === previous.ns + 1 && next.nr === previous.nr) {
      if (previous.chainSend === null || next.chainSend === null) {
        throw stale('send without a persisted sending chain');
      }
      if (!bytesEqualOrBothNull(previous.chainRecv, next.chainRecv)) {
        throw stale('send must not change the receiving chain');
      }
      const expected = await kdfChainKey(previous.chainSend);
      if (!areBytesEqual(expected.nextChainKey, next.chainSend)) {
        throw stale('send chain is not KDF_CK(previous sending chain)');
      }
      return;
    }
    if (next.ns === previous.ns && next.nr > previous.nr) {
      if (next.nr - previous.nr > MAX_SKIP) {
        throw stale('receiving chain advance exceeds MAX_SKIP');
      }
      if (previous.chainRecv === null || next.chainRecv === null) {
        throw stale('receive without a persisted receiving chain');
      }
      if (!bytesEqualOrBothNull(previous.chainSend, next.chainSend)) {
        throw stale('receive must not change the sending chain');
      }
      let expected: Uint8Array = previous.chainRecv;
      for (let step = previous.nr; step < next.nr; step += 1) {
        expected = new Uint8Array((await kdfChainKey(expected)).nextChainKey);
      }
      if (!areBytesEqual(expected, next.chainRecv)) {
        throw stale('receiving chain is not the persisted chain advanced by nr');
      }
      return;
    }
    throw stale('counter move is not a send or receive of the persisted chain');
  }

  // DH ratchet: new remote key. The new root/receiving/sending chains must be
  // exactly the Double Ratchet derivation from the persisted previous state.
  if (next.dhRemote === null) throw stale('DH ratchet without a remote DH key');
  if (next.ns !== 0 || next.pn !== previous.ns || next.nr < 1) {
    throw stale('DH ratchet must reset ns to 0, fold pn = previous ns and receive one message');
  }
  if (next.nr > MAX_SKIP + 1) {
    throw stale('DH ratchet skipped more messages than MAX_SKIP');
  }
  if (!dhChanged) throw stale('DH ratchet requires a fresh local DH key pair');
  const remote = next.dhRemote;
  const receiving = await kdfRootKey(previous.rootKey, await dhWith(previous.dhPrivateKey, remote));
  let expectedRecv: Uint8Array = receiving.chainKey;
  for (let step = 0; step < next.nr; step += 1) {
    expectedRecv = new Uint8Array((await kdfChainKey(expectedRecv)).nextChainKey);
  }
  if (next.chainRecv === null || !areBytesEqual(expectedRecv, next.chainRecv)) {
    throw stale('receiving chain does not match the DH ratchet derivation');
  }
  const sending = await kdfRootKey(receiving.rootKey, await dhWith(next.dhPrivateKey, remote));
  if (!areBytesEqual(sending.rootKey, next.rootKey)) {
    throw stale('root key does not match the DH ratchet derivation');
  }
  if (next.chainSend === null || !areBytesEqual(sending.chainKey, next.chainSend)) {
    throw stale('sending chain does not match the DH ratchet derivation');
  }
}

/**
 * Builds the persisted record (encrypting secrets) before a transaction opens.
 * WebCrypto never runs inside an IndexedDB transaction.
 */
export async function prepareSessionRecord(
  kStorage: KStorage,
  state: SessionState,
  options: {
    readonly now?: number;
    /**
     * Exact persisted state this write is derived from (E7-F5G, P2-36). It is
     * required for every update; `null`/omitted is only a create. The store
     * verifies the forward KDF step here and binds the result to the stored
     * record through `previousStateFingerprint`.
     */
    readonly previous?: SessionState | null;
  } = {},
): Promise<PreparedSessionRecord> {
  validateSessionState(state);
  if (state.deviceId !== kStorage.ownerDeviceId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session belongs to another local device');
  }
  const previous = options.previous ?? null;
  let previousStateFingerprint: string | null = null;
  if (state.revision > 0) {
    if (previous === null) {
      throw stale('an existing session update requires the previous persisted state');
    }
    await assertForwardTransition(previous, state);
    previousStateFingerprint = await fingerprintOfState(previous);
  } else if (previous !== null) {
    throw stale('a new session must not carry a previous state');
  }
  const now = options.now ?? Date.now();
  const retention = pruneSkippedKeys(state.skipped, { now });
  const prunedState: SessionState = { ...state, skipped: retention.kept };

  const chainCommitment = await chainSendCommitment(prunedState.chainSend);
  const chainRecvCommitment = await hashChainCommitment(prunedState.chainRecv);
  const plaintext = serializeSecrets(prunedState);
  let secrets: EncryptedRecord;
  try {
    secrets = await kStorage.encrypt(plaintext, {
      sessionId: state.sessionId,
      clientMessageId: null,
      recordType: 'session',
    });
  } finally {
    zeroBytes(plaintext);
  }

  return {
    record: {
      v: 1,
      sessionId: state.sessionId,
      deviceId: state.deviceId,
      chatId: state.chatId,
      peerUserId: state.peerUserId,
      peerDeviceId: state.peerDeviceId,
      peerIkSig: encodeBase64Url(state.peerIkSig),
      peerIkDh: encodeBase64Url(state.peerIkDh),
      dhPublicKey: encodeBase64Url(state.dhPublicKey),
      dhRemote: state.dhRemote ? encodeBase64Url(state.dhRemote) : null,
      chainSendCommitment: chainCommitment,
      chainRecvCommitment,
      previousStateFingerprint,
      ns: state.ns,
      nr: state.nr,
      pn: state.pn,
      spkId: state.spkId ?? null,
      initiatedBy: requireInitiatedBy(state.initiatedBy),
      lastReceivedAt: requireOptionalTimestamp(state.lastReceivedAt, 'last_received_at'),
      supersededBy: requireOptionalSessionId(state.supersededBy, 'superseded_by'),
      supersededAt: requireOptionalTimestamp(state.supersededAt, 'superseded_at'),
      winnerConfirmedAt: requireOptionalTimestamp(state.winnerConfirmedAt, 'winner_confirmed_at'),
      dhPrivateKey: state.dhPrivateKey,
      secrets,
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
      localCopyRef: state.localCopyRef,
      revision: state.revision,
    },
    state: prunedState,
  };
}

export async function loadSessionRecord(
  kStorage: KStorage,
  record: StoredSessionRecord,
): Promise<SessionState> {
  if (record.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session record version is unsupported');
  }
  requireSessionId(record.sessionId);
  requireUuid(record.deviceId, 'device_id');
  if (record.deviceId !== kStorage.ownerDeviceId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session belongs to another local device');
  }
  requireUuid(record.chatId, 'chat_id');
  requireUuid(record.peerUserId, 'peer_user_id');
  requireUuid(record.peerDeviceId, 'peer_device_id');
  requireKeyBytes(
    decodeB64uOrNull(record.peerIkSig, 32, 'peer_ik_sig') as Uint8Array,
    'peer_ik_sig',
  );
  requireKeyBytes(decodeB64uOrNull(record.peerIkDh, 32, 'peer_ik_dh') as Uint8Array, 'peer_ik_dh');
  const dhPublicKey = decodeB64uOrNull(record.dhPublicKey, 32, 'dh_public_key') as Uint8Array;
  requireKeyBytes(dhPublicKey, 'dh_public_key');
  const dhRemote = decodeB64uOrNull(record.dhRemote, 32, 'dh_remote');
  requireCounter(record.ns, 'ns');
  requireCounter(record.nr, 'nr');
  requireCounter(record.pn, 'pn');
  if (record.spkId !== undefined && record.spkId !== null) {
    if (typeof record.spkId !== 'string' || !KEY_ID_PATTERN.test(record.spkId)) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored spk_id is not a valid key id');
    }
  }
  const recordInitiatedBy = requireInitiatedBy(record.initiatedBy);
  const recordLastReceivedAt = requireOptionalTimestamp(record.lastReceivedAt, 'last_received_at');
  const recordSupersededBy = requireOptionalSessionId(record.supersededBy, 'superseded_by');
  const recordSupersededAt = requireOptionalTimestamp(record.supersededAt, 'superseded_at');
  const recordWinnerConfirmedAt = requireOptionalTimestamp(
    record.winnerConfirmedAt,
    'winner_confirmed_at',
  );
  if ((recordSupersededBy === null) !== (recordSupersededAt === null)) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'stored superseded_by and superseded_at must be set together',
    );
  }
  requireTimestamp(record.createdAt, 'created_at');
  requireTimestamp(record.lastUsedAt, 'last_used_at');
  requireUuidOrNull(record.localCopyRef, 'local_copy_ref');
  const revision = requireRevision(record.revision);
  assertPrivateKey(record.dhPrivateKey, 'session DHs private key');

  let plaintext: Uint8Array;
  try {
    plaintext = await kStorage.decrypt(record.secrets, {
      sessionId: record.sessionId,
      clientMessageId: null,
      recordType: 'session',
    });
  } catch (error) {
    if (isE2eeError(error) && error.code === 'DECRYPT_FAILED') {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session secrets cannot be decrypted');
    }
    throw error;
  }

  let secrets: StoredSessionSecrets;
  try {
    secrets = parseSecrets(plaintext);
  } finally {
    zeroBytes(plaintext);
  }

  if (secrets.sessionId !== record.sessionId || secrets.deviceId !== record.deviceId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session record does not match its secrets');
  }
  if (
    secrets.ns !== record.ns ||
    secrets.nr !== record.nr ||
    secrets.pn !== record.pn ||
    secrets.dhPublicKey !== record.dhPublicKey ||
    (secrets.spkId ?? null) !== (record.spkId ?? null) ||
    (secrets.initiatedBy ?? null) !== recordInitiatedBy ||
    (secrets.lastReceivedAt ?? null) !== recordLastReceivedAt ||
    (secrets.supersededBy ?? null) !== recordSupersededBy ||
    (secrets.supersededAt ?? null) !== recordSupersededAt ||
    (secrets.winnerConfirmedAt ?? null) !== recordWinnerConfirmedAt
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session record metadata was tampered with');
  }

  const chainSend = decodeB64uOrNull(secrets.chainSend, 32, 'chain_send');
  const chainRecv = decodeB64uOrNull(secrets.chainRecv, 32, 'chain_recv');
  const storedCommitment =
    (record as { readonly chainSendCommitment?: string | null }).chainSendCommitment ?? null;
  if (storedCommitment !== null) {
    if (storedCommitment !== (await chainSendCommitment(chainSend))) {
      throw new E2eeError(
        'KEY_STORAGE_UNAVAILABLE',
        'session chain commitment does not match the sealed sending chain',
      );
    }
  } else if (chainSend !== null) {
    // Records written before E7-F5F have no commitment; they remain readable
    // but cannot prove a chain transition until the next write adds it.
  }
  const storedRecvCommitment =
    (record as { readonly chainRecvCommitment?: string | null }).chainRecvCommitment ?? null;
  if (storedRecvCommitment !== null) {
    if (storedRecvCommitment !== (await hashChainCommitment(chainRecv))) {
      throw new E2eeError(
        'KEY_STORAGE_UNAVAILABLE',
        'session chain commitment does not match the sealed receiving chain',
      );
    }
  }

  return {
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    chatId: record.chatId,
    peerUserId: record.peerUserId,
    peerDeviceId: record.peerDeviceId,
    peerIkSig: decodeB64uOrNull(record.peerIkSig, 32, 'peer_ik_sig') as Uint8Array,
    peerIkDh: decodeB64uOrNull(record.peerIkDh, 32, 'peer_ik_dh') as Uint8Array,
    rootKey: decodeB64uOrNull(secrets.rootKey, 32, 'root_key') as Uint8Array,
    dhPrivateKey: record.dhPrivateKey,
    dhPublicKey,
    dhRemote,
    chainSend,
    chainRecv,
    ns: secrets.ns,
    nr: secrets.nr,
    pn: secrets.pn,
    spkId: record.spkId ?? null,
    initiatedBy: recordInitiatedBy,
    lastReceivedAt: recordLastReceivedAt,
    supersededBy: recordSupersededBy,
    supersededAt: recordSupersededAt,
    winnerConfirmedAt: recordWinnerConfirmedAt,
    skipped: decodeSkipped(secrets),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    localCopyRef: record.localCopyRef,
    revision,
  };
}

export async function loadSession(
  storage: E2eeStorage,
  kStorage: KStorage,
  sessionId: string,
): Promise<SessionState | null> {
  const key = sessionStorageKey(sessionId);
  const record = await storage.get<StoredSessionRecord>('sessions', key);
  if (record === null) return null;
  // CR1c P2-04: a record stored under another key must never be returned.
  if (record.sessionId !== sessionId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session record id does not match its key');
  }
  return loadSessionRecord(kStorage, record);
}

async function readPeerIndex(
  transaction: E2eeTransaction,
  deviceId: string,
  chatId: string,
  peerDeviceId: string,
): Promise<PeerSessionIndex> {
  const key = peerSessionIndexKey(deviceId, chatId, peerDeviceId);
  const index = await transaction.get<PeerSessionIndex>('sessions', key);
  if (index === null) return { v: 1, sessionIds: [] };
  if (index.v !== 1 || !Array.isArray(index.sessionIds)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'peer session index is malformed');
  }
  return index;
}

async function writePeerIndex(
  transaction: E2eeTransaction,
  deviceId: string,
  chatId: string,
  peerDeviceId: string,
  sessionIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(sessionIds)].sort();
  await transaction.put<PeerSessionIndex>(
    'sessions',
    peerSessionIndexKey(deviceId, chatId, peerDeviceId),
    { v: 1, sessionIds: unique },
  );
}

async function addToPeerIndex(
  transaction: E2eeTransaction,
  record: StoredSessionRecord,
): Promise<void> {
  const index = await readPeerIndex(
    transaction,
    record.deviceId,
    record.chatId,
    record.peerDeviceId,
  );
  if (index.sessionIds.includes(record.sessionId)) return;
  await writePeerIndex(transaction, record.deviceId, record.chatId, record.peerDeviceId, [
    ...index.sessionIds,
    record.sessionId,
  ]);
}

async function removeFromPeerIndex(
  transaction: E2eeTransaction,
  deviceId: string,
  chatId: string,
  peerDeviceId: string,
  sessionId: string,
): Promise<void> {
  const index = await readPeerIndex(transaction, deviceId, chatId, peerDeviceId);
  if (!index.sessionIds.includes(sessionId)) return;
  await writePeerIndex(
    transaction,
    deviceId,
    chatId,
    peerDeviceId,
    index.sessionIds.filter((value) => value !== sessionId),
  );
}

function assertSessionScopeUnchanged(
  existing: StoredSessionRecord,
  record: StoredSessionRecord,
): void {
  if (
    existing.chatId !== record.chatId ||
    existing.peerUserId !== record.peerUserId ||
    existing.peerDeviceId !== record.peerDeviceId ||
    existing.peerIkSig !== record.peerIkSig ||
    existing.peerIkDh !== record.peerIkDh ||
    (existing.spkId ?? null) !== (record.spkId ?? null)
  ) {
    throw new E2eeError(
      'SESSION_STATE_STALE',
      'a session cannot be moved to another chat, peer or identity after creation',
    );
  }
}

/**
 * Structural half of the store-level transition check (E7-F5G P2-36). The
 * cryptographic half is `assertForwardTransition` during preparation and is
 * bound to this exact previous record by `previousStateFingerprint`. These
 * checks keep a directly forged `StoredSessionRecord` (one built without
 * `prepareSessionRecord`) from looking like a valid send/ratchet either.
 */
function assertTransitionShape(existing: StoredSessionRecord, record: StoredSessionRecord): void {
  const remoteChanged = record.dhRemote !== existing.dhRemote;
  if (!remoteChanged) {
    if (record.dhPublicKey !== existing.dhPublicKey) {
      throw stale('session DH key cannot change without a new remote DH');
    }
    if (record.pn !== existing.pn) {
      throw stale('session pn cannot change without a new remote DH');
    }
    if (record.ns === existing.ns) {
      if (record.nr < existing.nr) {
        throw stale('session nr must not decrease inside the same chain');
      }
      if (record.chainSendCommitment !== existing.chainSendCommitment) {
        throw stale('session sending chain changed without a send or DH ratchet');
      }
      if (
        record.nr === existing.nr &&
        record.chainRecvCommitment !== existing.chainRecvCommitment
      ) {
        throw stale('session receiving chain changed without a receive');
      }
    } else if (record.ns === existing.ns + 1) {
      if (record.nr !== existing.nr) {
        throw stale('a send must not advance the receiving counter');
      }
      if (
        record.chainSendCommitment === null ||
        record.chainSendCommitment === existing.chainSendCommitment
      ) {
        throw stale('a send requires a newly derived sending chain');
      }
      if (record.chainRecvCommitment !== existing.chainRecvCommitment) {
        throw stale('a send must not change the receiving chain');
      }
    } else {
      throw stale('session ns may only advance by exactly one send step');
    }
    return;
  }

  // A new remote DH is only valid as a completed DH ratchet: ns=0, pn=f(reset),
  // fresh local DH and fresh sending/receiving chains.
  if (record.ns !== 0) throw stale('a DH ratchet must reset ns to 0');
  if (record.pn !== existing.ns) throw stale('a DH ratchet must fold the old ns into pn');
  if (record.dhPublicKey === existing.dhPublicKey) {
    throw stale('a DH ratchet requires a fresh local DH key pair');
  }
  if (record.nr < 1) throw stale('a DH ratchet is committed only after receiving a message');
  if (
    record.chainSendCommitment === null ||
    record.chainSendCommitment === existing.chainSendCommitment
  ) {
    throw stale('a DH ratchet requires a newly derived sending chain');
  }
  if (
    record.chainRecvCommitment === null ||
    record.chainRecvCommitment === existing.chainRecvCommitment
  ) {
    throw stale('a DH ratchet requires a newly derived receiving chain');
  }
}

/**
 * Writes a prepared record inside an existing transaction, enforcing the
 * optimistic-concurrency rule and keeping the peer index consistent.
 */
export async function writeSessionRecord(
  transaction: E2eeTransaction,
  record: StoredSessionRecord,
  mode: SessionWriteMode,
): Promise<StoredSessionRecord> {
  requireSessionId(record.sessionId);
  const key = sessionStorageKey(record.sessionId);
  const existing = await transaction.get<StoredSessionRecord>('sessions', key);

  if ('create' in mode) {
    if (existing !== null) {
      throw new E2eeError('SESSION_STATE_STALE', 'session already exists');
    }
    if (record.previousStateFingerprint !== null) {
      throw stale('a new session must not carry a previous-state fingerprint');
    }
    if (record.revision !== 0) {
      throw stale('a new session must start at revision 0');
    }
  } else {
    if (existing === null) {
      throw new E2eeError('NO_SESSION', 'session does not exist');
    }
    if (existing.deviceId !== record.deviceId) {
      throw new E2eeError('SESSION_STATE_STALE', 'session device id cannot change');
    }
    const existingRevision = requireRevision(existing.revision);
    if (existingRevision !== mode.ifRevision) {
      throw new E2eeError('SESSION_STATE_STALE', 'session state was updated by another writer');
    }
    // P1-01R: the prepared record itself must be the exact revision the caller
    // believes it is shifting; a forged/stale `PreparedSessionRecord` (e.g. an
    // old tab's in-memory state with a fresh mode) is rejected.
    if (requireRevision(record.revision) !== mode.ifRevision) {
      throw new E2eeError(
        'SESSION_STATE_STALE',
        'prepared session revision does not match the compare-and-swap token',
      );
    }
    // E7-F5G P2-36: the transition was verified against *a* previous state
    // during preparation; this binds it to the state actually stored now.
    if (
      record.previousStateFingerprint === null ||
      record.previousStateFingerprint !== fingerprintOfRecord(existing)
    ) {
      throw stale('prepared session was not derived from the stored session state');
    }
    assertSessionScopeUnchanged(existing, record);
    assertTransitionShape(existing, record);
  }

  const revision = existing === null ? 1 : requireRevision(existing.revision) + 1;
  const stored: StoredSessionRecord = { ...record, revision };
  await transaction.put('sessions', key, stored);

  await addToPeerIndex(transaction, stored);
  return stored;
}

/** Metadata-only update used by the §5.7 parallel-session state machine (E7-F6). */
export interface SessionMetadataPatch {
  readonly supersededBy?: string | null;
  readonly supersededAt?: number | null;
  readonly winnerConfirmedAt?: number | null;
}

/**
 * Applies a metadata-only transition (no chain/counter movement) through the
 * same forward-KDF/fingerprint-bound writer as sends and receives. Returns
 * `null` when the session is already gone, so callers can treat recovery as
 * idempotent. This is the only production path that marks a loser/writes the
 * winner confirmation outside a ratchet commit.
 */
export async function updateSessionMetadata(
  storage: E2eeStorage,
  kStorage: KStorage,
  sessionId: string,
  patch: SessionMetadataPatch,
  options: { readonly now?: number } = {},
): Promise<SessionState | null> {
  const existing = await loadSession(storage, kStorage, sessionId);
  if (existing === null) return null;
  const next: SessionState = { ...existing, ...patch };
  const now = options.now ?? Date.now();
  const prepared = await prepareSessionRecord(kStorage, next, { previous: existing, now });
  await storage.transact(['sessions'], 'readwrite', async (transaction) => {
    await writeSessionRecord(transaction, prepared.record, { ifRevision: existing.revision });
  });
  return prepared.state;
}

/** Marks a simultaneous-handshake loser after the deterministic tie-break. */
export async function markSessionSuperseded(
  storage: E2eeStorage,
  kStorage: KStorage,
  sessionId: string,
  winnerSessionId: string,
  options: { readonly now?: number } = {},
): Promise<SessionState | null> {
  requireSessionId(winnerSessionId);
  return updateSessionMetadata(
    storage,
    kStorage,
    sessionId,
    {
      supersededBy: winnerSessionId,
      supersededAt: options.now ?? Date.now(),
    },
    options,
  );
}

/** Promotes a surviving session when its recorded winner disappeared. */
export async function clearSessionSuperseded(
  storage: E2eeStorage,
  kStorage: KStorage,
  sessionId: string,
  options: { readonly now?: number } = {},
): Promise<SessionState | null> {
  return updateSessionMetadata(
    storage,
    kStorage,
    sessionId,
    { supersededBy: null, supersededAt: null },
    options,
  );
}

export async function deleteSession(storage: E2eeStorage, sessionId: string): Promise<void> {
  const key = sessionStorageKey(sessionId);
  await storage.transact(['sessions'], 'readwrite', async (transaction) => {
    const existing = await transaction.get<StoredSessionRecord>('sessions', key);
    if (existing === null) return;
    await transaction.delete('sessions', key);
    await removeFromPeerIndex(
      transaction,
      existing.deviceId,
      existing.chatId,
      existing.peerDeviceId,
      sessionId,
    );
  });
}

export async function listSessionIds(storage: E2eeStorage): Promise<string[]> {
  const keys = await storage.keys('sessions');
  return keys
    .filter((key) => key.startsWith(SESSION_KEY_PREFIX))
    .map((key) => key.slice(SESSION_KEY_PREFIX.length))
    .sort();
}

export async function listSessions(
  storage: E2eeStorage,
  kStorage: KStorage,
): Promise<SessionState[]> {
  const ids = await listSessionIds(storage);
  const sessions: SessionState[] = [];
  for (const id of ids) {
    const session = await loadSession(storage, kStorage, id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export async function listSessionsByPeer(
  storage: E2eeStorage,
  kStorage: KStorage,
  chatId: string,
  peerDeviceId: string,
): Promise<SessionState[]> {
  const key = peerSessionIndexKey(kStorage.ownerDeviceId, chatId, peerDeviceId);
  const index = await storage.get<PeerSessionIndex>('sessions', key);
  if (index === null) return [];
  if (index.v !== 1 || !Array.isArray(index.sessionIds)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'peer session index is malformed');
  }
  const sessions: SessionState[] = [];
  for (const sessionId of index.sessionIds) {
    const session = await loadSession(storage, kStorage, sessionId);
    if (session) sessions.push(session);
  }
  return sessions;
}

/** GC of inactive sessions (`SESSION_IDLE_TTL`); not an FS boundary (§3.4.5.1). */
export async function pruneIdleSessions(
  storage: E2eeStorage,
  kStorage: KStorage,
  now: number,
  idleTtlMs?: number,
): Promise<string[]> {
  const removed: string[] = [];
  for (const session of await listSessions(storage, kStorage)) {
    const ttl = idleTtlMs ?? SESSION_IDLE_TTL_MS;
    if (now - session.lastUsedAt >= ttl) {
      await deleteSession(storage, session.sessionId);
      removed.push(session.sessionId);
    }
  }
  return removed;
}

export async function clearSessions(storage: E2eeStorage): Promise<void> {
  await storage.clear('sessions');
}
