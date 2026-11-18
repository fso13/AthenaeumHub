/**
 * Inner payload framing (§3.5.1).
 *
 * `raw = D_PAY || u8(1) || u8(content_type) || u32be(body_len) || body`, then
 * zero-padded to a multiple of 256. The receiver validates the frame itself
 * (P2-7) instead of trusting the sender.
 */
import { D_PAY, MAX_INNER_BODY_BYTES, MAX_TEXT_CHARS, PAD_BLOCK } from '../constants';
import { E2eeError, invalid } from '../errors';
import {
  areBytesEqual,
  concatBytes,
  fromUtf8,
  isUuid,
  readU32be,
  u32be,
  u8,
  utf8,
  zeros,
} from '../encoding/bytes';

export const CONTENT_TYPE_TEXT_JSON = 1;
export const CONTENT_TYPE_SESSION_RESET = 2;

export type ContentType = typeof CONTENT_TYPE_TEXT_JSON | typeof CONTENT_TYPE_SESSION_RESET;

const INNER_HEADER_BYTES = D_PAY.length + 1 + 1 + 4;

export interface InnerPayload {
  readonly contentType: ContentType;
  readonly body: Uint8Array;
}

function isContentType(value: number): value is ContentType {
  return value === CONTENT_TYPE_TEXT_JSON || value === CONTENT_TYPE_SESSION_RESET;
}

export function buildInnerPayload(contentType: ContentType, body: Uint8Array): Uint8Array {
  if (!isContentType(contentType)) {
    throw invalid('INVALID_PAYLOAD', 'unknown content type');
  }
  if (!(body instanceof Uint8Array)) {
    throw invalid('INVALID_PAYLOAD', 'inner body must be bytes');
  }
  if (body.length > MAX_INNER_BODY_BYTES) {
    throw new E2eeError('MESSAGE_TOO_LONG', `inner body exceeds ${MAX_INNER_BODY_BYTES} bytes`);
  }
  const raw = concatBytes(D_PAY, u8(1), u8(contentType), u32be(body.length), body);
  const padding = (PAD_BLOCK - (raw.length % PAD_BLOCK)) % PAD_BLOCK;
  return concatBytes(raw, zeros(padding));
}

export function parseInnerPayload(padded: Uint8Array): InnerPayload {
  if (!(padded instanceof Uint8Array) || padded.length < PAD_BLOCK) {
    throw invalid('INVALID_PAYLOAD', 'padded payload must be at least one 256-byte block');
  }
  if (padded.length % PAD_BLOCK !== 0) {
    throw invalid('INVALID_PAYLOAD', 'padded payload length must be a multiple of 256');
  }
  if (!areBytesEqual(padded.subarray(0, D_PAY.length), D_PAY)) {
    throw invalid('INVALID_PAYLOAD', 'inner payload domain prefix mismatch');
  }
  if (padded[D_PAY.length] !== 1) {
    throw invalid('INVALID_PAYLOAD', 'unsupported inner payload version');
  }
  const contentType = padded[D_PAY.length + 1] ?? 0;
  if (!isContentType(contentType)) {
    throw invalid('UNSUPPORTED_CONTENT_TYPE', `unknown content type ${contentType}`);
  }
  const bodyLength = readU32be(padded, D_PAY.length + 2);
  if (bodyLength > MAX_INNER_BODY_BYTES) {
    throw invalid('INVALID_PAYLOAD', `inner body exceeds ${MAX_INNER_BODY_BYTES} bytes`);
  }
  const rawLength = INNER_HEADER_BYTES + bodyLength;
  if (rawLength > padded.length) {
    throw invalid('INVALID_PAYLOAD', 'inner body length exceeds the frame');
  }
  if (padded.length - rawLength >= PAD_BLOCK) {
    throw invalid('INVALID_PAYLOAD', 'inner payload has more than 255 padding bytes');
  }
  for (let index = rawLength; index < padded.length; index += 1) {
    if (padded[index] !== 0) {
      throw invalid('INVALID_PAYLOAD', 'padding bytes must be zero');
    }
  }
  return { contentType, body: padded.slice(INNER_HEADER_BYTES, rawLength) };
}

/** TEXT_JSON body (§3.5.1): `{"text":"...","reply_to_id":null}`. */
export interface TextPayload {
  readonly text: string;
  readonly replyToId: string | null;
}

const FORBIDDEN_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x7f, 0x9f], // C1 controls
  [0x202a, 0x202e], // bidi embedding/override
  [0x2066, 0x2069], // bidi isolates
];

/** 1..8000 Unicode code points, no C0/C1 (except \n, \t), no bidi overrides. */
export function validateText(text: string): string {
  if (typeof text !== 'string') {
    throw invalid('INVALID_PAYLOAD', 'text must be a string');
  }
  let length = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw invalid('INVALID_PAYLOAD', 'text contains an unpaired surrogate');
    }
    if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) {
      throw invalid('INVALID_PAYLOAD', 'text contains a forbidden C0 control character');
    }
    for (const [start, end] of FORBIDDEN_CODEPOINT_RANGES) {
      if (codePoint >= start && codePoint <= end) {
        throw invalid('INVALID_PAYLOAD', 'text contains a forbidden control/bidi character');
      }
    }
    length += 1;
  }
  if (length < 1 || length > MAX_TEXT_CHARS) {
    throw invalid('INVALID_PAYLOAD', `text must be 1..${MAX_TEXT_CHARS} characters`);
  }
  return text;
}

export function serializeTextBody(payload: TextPayload): Uint8Array {
  validateText(payload.text);
  if (payload.replyToId !== null && !isUuid(payload.replyToId)) {
    throw invalid('INVALID_PAYLOAD', 'reply_to_id must be null or a canonical UUID');
  }
  // v1 schema: exactly these two keys; `mentions` is reserved and omitted when empty.
  const body = utf8(JSON.stringify({ text: payload.text, reply_to_id: payload.replyToId }));
  if (body.length > MAX_INNER_BODY_BYTES) {
    throw new E2eeError('MESSAGE_TOO_LONG', `text body exceeds ${MAX_INNER_BODY_BYTES} bytes`);
  }
  return body;
}

export function parseTextBody(body: Uint8Array): TextPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(body));
  } catch {
    throw invalid('INVALID_PAYLOAD', 'text body is not valid UTF-8 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('INVALID_PAYLOAD', 'text body must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const text = validateText(record.text as string);

  const replyValue = record.reply_to_id;
  let replyToId: string | null = null;
  if (replyValue !== undefined && replyValue !== null) {
    if (!isUuid(replyValue)) {
      throw invalid('INVALID_PAYLOAD', 'reply_to_id must be null or a canonical UUID');
    }
    replyToId = replyValue;
  }

  const mentions = record.mentions;
  if (mentions !== undefined) {
    if (!Array.isArray(mentions) || !mentions.every((entry) => isUuid(entry))) {
      throw invalid('INVALID_PAYLOAD', 'mentions must be an array of UUIDs');
    }
    // Reserved in v1: a peer must not smuggle mentions into an E2EE message.
    if (mentions.length > 0) {
      throw invalid('INVALID_PAYLOAD', 'mentions must be empty in protocol v1');
    }
  }

  if ('attachment_refs' in record) {
    throw invalid('INVALID_PAYLOAD', 'attachment_refs are forbidden in E2EE v1');
  }

  return { text, replyToId };
}
