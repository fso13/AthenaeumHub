/**
 * Double Ratchet engine (§3.4.1–§3.4.5, §3.4.5.1).
 *
 * Pure, in-memory state transitions over `SessionState`: nothing here touches
 * storage, the network or the UI. The caller persists the returned state in the
 * same transaction as the envelope/local copy (§3.4.6) and must keep the old
 * state when a call throws — a failed AEAD never advances a chain.
 *
 * Rules enforced here:
 * - `KDF_RK`/`KDF_CK` only (§3.4.1), fresh `DHs` on every DH ratchet, only the
 *   current DH pair is kept (the previous private key is dropped from the state);
 * - `pn/n` counters, `skip_message_keys` with `MAX_SKIP`/retention limits,
 *   `MKSKIPPED` lookup for out-of-order delivery, duplicate/old rejection;
 * - `CHAIN_EXHAUSTED` at 2^31-1 (§4.5, P2-14).
 */
import { KEY_BYTES, MAX_HEADER_COUNTER, MAX_SKIP } from '../constants';
import { E2eeError } from '../errors';
import { areBytesEqual } from '../encoding/bytes';
import {
  generateX25519KeyPair,
  importX25519PublicKey,
  x25519SharedSecret,
  type X25519KeyPair,
} from '../crypto/x25519';
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto/aead';
import { deriveMessageAeadParams, kdfChainKey, kdfRootKey } from '../protocol/kdf';
import type { ParsedHeader } from '../protocol/header';
import { pruneSkippedKeys, type SessionState, type SkippedMessageKey } from './types';

export interface RatchetSendInput {
  readonly plaintext: Uint8Array;
  /** Builds the 163-byte AD for the header the send step is about to emit. */
  readonly buildAd: (header: ParsedHeader) => Promise<Uint8Array> | Uint8Array;
  readonly now?: number;
}

export interface RatchetSendResult {
  readonly state: SessionState;
  readonly header: ParsedHeader;
  readonly messageKey: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface RatchetReceiveInput {
  readonly header: ParsedHeader;
  readonly ciphertext: Uint8Array;
  /** Builds the 163-byte AD from received (already validated) envelope fields. */
  readonly buildAd: (header: ParsedHeader) => Promise<Uint8Array> | Uint8Array;
  readonly now?: number;
  /**
   * Deterministic ratchet keypair for KAT walks only; product code must omit it
   * so every DH ratchet uses a fresh CSPRNG pair (§3.3.2 step 7 / P1-9).
   */
  readonly nextRatchetKeyPair?: X25519KeyPair;
}

export interface RatchetReceiveResult {
  readonly state: SessionState;
  readonly messageKey: Uint8Array;
  readonly plaintext: Uint8Array;
  /** Number of skipped keys added by this message (0 for a skipped-key hit). */
  readonly skippedStored: number;
  /** True when the message triggered a DH ratchet. */
  readonly dhRatchet: boolean;
  /** Skipped keys evicted by the retention limits during this step. */
  readonly skippedEvicted: number;
}

type MutableSessionState = { -readonly [K in keyof SessionState]: SessionState[K] };

function cloneState(state: SessionState): MutableSessionState {
  return {
    ...state,
    rootKey: state.rootKey.slice(),
    dhPublicKey: state.dhPublicKey.slice(),
    dhRemote: state.dhRemote === null ? null : state.dhRemote.slice(),
    chainSend: state.chainSend === null ? null : state.chainSend.slice(),
    chainRecv: state.chainRecv === null ? null : state.chainRecv.slice(),
    skipped: state.skipped.map((key) => ({
      ...key,
      dh: key.dh.slice(),
      messageKey: key.messageKey.slice(),
    })),
  };
}

async function dh(privateKey: CryptoKey, publicBytes: Uint8Array): Promise<Uint8Array> {
  return x25519SharedSecret(privateKey, await importX25519PublicKey(publicBytes));
}

function takeSkipped(
  skipped: readonly SkippedMessageKey[],
  dhPublic: Uint8Array,
  n: number,
): { key: SkippedMessageKey; rest: SkippedMessageKey[] } | null {
  const index = skipped.findIndex((entry) => entry.n === n && areBytesEqual(entry.dh, dhPublic));
  if (index < 0) return null;
  const rest = skipped.slice();
  const [key] = rest.splice(index, 1);
  return { key: key as SkippedMessageKey, rest };
}

function chainHasSkippedKeys(skipped: readonly SkippedMessageKey[], dhPublic: Uint8Array): boolean {
  return skipped.some((entry) => areBytesEqual(entry.dh, dhPublic));
}

interface SkipResult {
  readonly skipped: SkippedMessageKey[];
  readonly chainKey: Uint8Array;
  readonly nextNr: number;
}

/**
 * `skip_message_keys(until)` (§3.4.4): reject gaps above `MAX_SKIP`, store each
 * derived message key, and never advance past the requested counter.
 */
async function skipChainKeys(
  chainKey: Uint8Array,
  dhPublic: Uint8Array,
  fromNr: number,
  until: number,
  now: number,
): Promise<SkipResult> {
  if (until < fromNr) {
    throw new E2eeError('DUPLICATE_OR_OLD_MESSAGE', 'message number went backwards');
  }
  if (until - fromNr > MAX_SKIP) {
    throw new E2eeError('SESSION_TOO_FAR_BEHIND', 'too many skipped messages');
  }
  const skipped: SkippedMessageKey[] = [];
  let current: Uint8Array = chainKey.slice();
  let nr = fromNr;
  while (nr < until) {
    const step = await kdfChainKey(current);
    skipped.push({ dh: dhPublic.slice(), n: nr, messageKey: step.messageKey, createdAt: now });
    current = step.nextChainKey;
    nr += 1;
  }
  return { skipped, chainKey: current, nextNr: nr };
}

/**
 * Sending step (§3.4.3): requires `CKs`, derives `MK`/`CKs'`, emits the header
 * for `(DHs, pn, Ns)` and encrypts `padded_plaintext` with `AD`.
 */
export async function ratchetSend(
  state: SessionState,
  input: RatchetSendInput,
): Promise<RatchetSendResult> {
  if (state.chainSend === null) {
    throw new E2eeError('NO_SESSION', 'sending chain is not established');
  }
  if (state.ns >= MAX_HEADER_COUNTER) {
    throw new E2eeError('CHAIN_EXHAUSTED', 'sending chain reached the 2^31-1 message limit');
  }
  const now = input.now ?? Date.now();
  const step = await kdfChainKey(state.chainSend);
  const header: ParsedHeader = {
    v: 1,
    dh: state.dhPublicKey.slice(),
    pn: state.pn,
    n: state.ns,
  };
  const ad = await input.buildAd(header);
  const params = await deriveMessageAeadParams(step.messageKey);
  const ciphertext = await aesGcmEncrypt(params.key, params.nonce, input.plaintext, ad);
  return {
    state: {
      ...state,
      chainSend: step.nextChainKey,
      ns: state.ns + 1,
      lastUsedAt: now,
    },
    header,
    messageKey: step.messageKey,
    ciphertext,
  };
}

/**
 * Receiving step (§3.4.4). The returned state is a candidate: a throw means the
 * persisted state must stay untouched (failed AEAD, duplicate, too-far gap).
 */
export async function ratchetReceive(
  state: SessionState,
  input: RatchetReceiveInput,
): Promise<RatchetReceiveResult> {
  const now = input.now ?? Date.now();
  const header = input.header;
  const working = cloneState(state);
  let skipped: SkippedMessageKey[] = working.skipped.slice();
  let skippedStored = 0;
  let dhRatchet = false;

  const sameRemote = working.dhRemote !== null && areBytesEqual(working.dhRemote, header.dh);
  if (!sameRemote) {
    // A message from a chain we already abandoned: its key can only come from
    // MKSKIPPED. Ratcheting to it would corrupt the root key.
    const early = takeSkipped(skipped, header.dh, header.n);
    if (early) {
      const ad = await input.buildAd(header);
      const params = await deriveMessageAeadParams(early.key.messageKey);
      const plaintext = await aesGcmDecrypt(params.key, params.nonce, input.ciphertext, ad);
      return {
        state: {
          ...working,
          skipped: early.rest,
          lastReceivedAt: now,
          lastUsedAt: now,
        },
        messageKey: early.key.messageKey,
        plaintext,
        skippedStored: 0,
        dhRatchet: false,
        skippedEvicted: 0,
      };
    }
    if (working.dhRemote !== null && chainHasSkippedKeys(skipped, header.dh)) {
      throw new E2eeError(
        'DUPLICATE_OR_OLD_MESSAGE',
        'message belongs to an already replaced ratchet chain',
      );
    }
    if (working.chainRecv !== null && working.dhRemote !== null) {
      const previous = await skipChainKeys(
        working.chainRecv,
        working.dhRemote,
        working.nr,
        header.pn,
        now,
      );
      skipped.push(...previous.skipped);
      skippedStored += previous.skipped.length;
      working.chainRecv = previous.chainKey;
      working.nr = previous.nextNr;
    }

    // DH ratchet (§3.4.4 step 2): pn = Ns, reset counters, receive chain,
    // fresh DHs, then the new sending chain — the old private key is dropped.
    working.pn = working.ns;
    working.ns = 0;
    working.nr = 0;
    working.dhRemote = header.dh.slice();
    const receiving = await kdfRootKey(working.rootKey, await dh(working.dhPrivateKey, header.dh));
    working.rootKey = receiving.rootKey;
    working.chainRecv = receiving.chainKey;
    const nextPair = input.nextRatchetKeyPair ?? (await generateX25519KeyPair());
    working.dhPrivateKey = nextPair.privateKey;
    working.dhPublicKey = nextPair.publicKeyBytes.slice();
    const sending = await kdfRootKey(working.rootKey, await dh(working.dhPrivateKey, header.dh));
    working.rootKey = sending.rootKey;
    working.chainSend = sending.chainKey;
    dhRatchet = true;
  }

  const stored = takeSkipped(skipped, header.dh, header.n);
  let messageKey: Uint8Array;
  if (stored) {
    skipped = stored.rest;
    messageKey = stored.key.messageKey;
  } else {
    if (header.n < working.nr) {
      throw new E2eeError(
        'DUPLICATE_OR_OLD_MESSAGE',
        'message was already decrypted or is older than the current chain',
      );
    }
    if (working.chainRecv === null) {
      throw new E2eeError('NO_SESSION', 'receiving chain is not established');
    }
    const gap = await skipChainKeys(working.chainRecv, header.dh, working.nr, header.n, now);
    skipped.push(...gap.skipped);
    skippedStored += gap.skipped.length;
    const step = await kdfChainKey(gap.chainKey);
    messageKey = step.messageKey;
    working.chainRecv = step.nextChainKey;
    working.nr = gap.nextNr + 1;
  }

  const ad = await input.buildAd(header);
  const params = await deriveMessageAeadParams(messageKey);
  const plaintext = await aesGcmDecrypt(params.key, params.nonce, input.ciphertext, ad);

  const retention = pruneSkippedKeys(skipped, { now });
  return {
    state: {
      ...working,
      skipped: retention.kept,
      lastReceivedAt: now,
      lastUsedAt: now,
    },
    messageKey,
    plaintext,
    skippedStored,
    dhRatchet,
    skippedEvicted: retention.evicted,
  };
}

/** Asserts a fresh initiator ratchet key is not any X3DH input (P1-9). */
export function assertFreshRatchetKey(
  ratchetPublicKey: Uint8Array,
  forbidden: readonly (Uint8Array | null | undefined)[],
): void {
  if (ratchetPublicKey.length !== KEY_BYTES) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'ratchet public key must be 32 bytes');
  }
  for (const candidate of forbidden) {
    if (candidate && areBytesEqual(ratchetPublicKey, candidate)) {
      throw new E2eeError(
        'KEY_HANDSHAKE_INVALID',
        'initiator ratchet key must be fresh, not an X3DH input key',
      );
    }
  }
}
