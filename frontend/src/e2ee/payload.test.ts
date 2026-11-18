/**
 * Inner payload framing and TEXT_JSON validation (§3.5.1, P2-7).
 * D1 positive bytes live in the KAT; here are the boundaries and rejections.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_TYPE_SESSION_RESET,
  CONTENT_TYPE_TEXT_JSON,
  buildInnerPayload,
  parseInnerPayload,
  parseTextBody,
  serializeTextBody,
  validateText,
} from './protocol/payload';
import { getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes, zeros } from './encoding/bytes';

const file = loadVectorFile();
const d1 = getVector<{
  inputs: { body_utf8: string; body_hex: string };
  expected: { padded_hex: string };
}>(file, 'D1-inner-payload-framing');

describe('inner payload framing', () => {
  it('serialises TEXT_JSON with the exact D1 body bytes', () => {
    const body = serializeTextBody({ text: 'Привет, Боб!', replyToId: null });
    expect(bytesToHex(body)).toBe(d1.inputs.body_hex);
    expect(new TextDecoder().decode(body)).toBe(d1.inputs.body_utf8);
  });

  it('pads to 256 bytes and round-trips through the parser', () => {
    const padded = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, hexToBytes(d1.inputs.body_hex));
    expect(bytesToHex(padded)).toBe(d1.expected.padded_hex);
    const parsed = parseInnerPayload(padded);
    expect(parsed.contentType).toBe(CONTENT_TYPE_TEXT_JSON);
    expect(bytesToHex(parsed.body)).toBe(d1.inputs.body_hex);
  });

  it('keeps the control payload type opaque but framed', () => {
    const padded = buildInnerPayload(CONTENT_TYPE_SESSION_RESET, hexToBytes('7b7d'));
    expect(padded).toHaveLength(256);
    expect(parseInnerPayload(padded).contentType).toBe(CONTENT_TYPE_SESSION_RESET);
  });

  it('rejects undersized, unpadded and misaligned frames', () => {
    expect(() => parseInnerPayload(new Uint8Array(128))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
    expect(() => parseInnerPayload(new Uint8Array(300))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });

  it('rejects a bad domain, version, content type or body length', () => {
    const valid = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, hexToBytes('00'));

    const domain = Uint8Array.from(valid);
    domain[0] = 0x00;
    expect(() => parseInnerPayload(domain)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );

    const version = Uint8Array.from(valid);
    version[20] = 2;
    expect(() => parseInnerPayload(version)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );

    const contentType = Uint8Array.from(valid);
    contentType[21] = 9;
    expect(() => parseInnerPayload(contentType)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_CONTENT_TYPE' }),
    );

    const length = Uint8Array.from(valid);
    length.set([0x00, 0x00, 0x80, 0x01], 22);
    expect(() => parseInnerPayload(length)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });

  it('rejects non-zero padding and extra padding blocks', () => {
    const valid = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, hexToBytes('00'));
    const dirty = Uint8Array.from(valid);
    dirty[dirty.length - 1] = 0x01;
    expect(() => parseInnerPayload(dirty)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );

    const extraBlock = new Uint8Array(512);
    extraBlock.set(valid, 0);
    expect(() => parseInnerPayload(extraBlock)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });

  it('refuses a body larger than 32 KiB', () => {
    expect(() => buildInnerPayload(CONTENT_TYPE_TEXT_JSON, zeros(32769))).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_TOO_LONG' }),
    );
  });
});

describe('TEXT_JSON body validation', () => {
  it('accepts 1..8000 code points, including astral characters', () => {
    expect(validateText('a')).toBe('a');
    expect(validateText('привет\n\tмир')).toBe('привет\n\tмир');
    expect(validateText('😀'.repeat(8000))).toHaveLength(8000 * 2);
  });

  it('rejects empty, too long, control and bidi text', () => {
    const invalid = [
      '',
      'a'.repeat(8001),
      'a\u0000b',
      'a\rb',
      'a\u007fb',
      'a\u0085b',
      'a\u202Eb',
      'a\u2066b',
      '\ud800',
    ];
    for (const text of invalid) {
      expect(() => validateText(text)).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
      );
    }
  });

  it('parses a canonical body and normalises optional fields', () => {
    expect(parseTextBody(hexToBytes(d1.inputs.body_hex))).toEqual({
      text: 'Привет, Боб!',
      replyToId: null,
    });
    expect(parseTextBody(new TextEncoder().encode('{"text":"hi"}'))).toEqual({
      text: 'hi',
      replyToId: null,
    });
    expect(
      parseTextBody(
        new TextEncoder().encode(
          '{"text":"hi","reply_to_id":"00000000-0000-4000-8000-000000000001"}',
        ),
      ),
    ).toEqual({ text: 'hi', replyToId: '00000000-0000-4000-8000-000000000001' });
    expect(parseTextBody(new TextEncoder().encode('{"text":"hi","foo":1}'))).toEqual({
      text: 'hi',
      replyToId: null,
    });
  });

  it('rejects malformed bodies and forbidden E2EE v1 fields', () => {
    const invalid = [
      'not json',
      '[]',
      '"text"',
      '{}',
      '{"text":42}',
      '{"text":"hi","reply_to_id":"nope"}',
      '{"text":"hi","mentions":["00000000-0000-4000-8000-000000000001"]}',
      '{"text":"hi","mentions":[42]}',
      '{"text":"hi","mentions":"x"}',
      '{"text":"hi","attachment_refs":[]}',
    ];
    for (const body of invalid) {
      expect(() => parseTextBody(new TextEncoder().encode(body))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
      );
    }
  });

  it('rejects invalid UTF-8 body bytes', () => {
    expect(() => parseTextBody(Uint8Array.of(0xff, 0xfe))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });

  it('rejects a non-UUID reply target on serialisation', () => {
    expect(() => serializeTextBody({ text: 'hi', replyToId: 'not-a-uuid' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });
});
