import { describe, expect, it } from 'vitest';
import {
  MAX_ARTWORK_BYTES,
  MAX_ID3_TAG_BYTES,
  MAX_ID3_TEXT_LENGTH,
  parseId3,
  readId3Tags,
  sanitizeId3Text,
} from './id3';

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function syncsafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function uint32(size: number): number[] {
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function textFrame(id: string, payload: number[], version: 3 | 4): number[] {
  const size = version === 4 ? syncsafe(payload.length) : uint32(payload.length);
  return [...asciiBytes(id), ...size, 0, 0, ...payload];
}

function utf8Text(id: string, value: string, version: 3 | 4): number[] {
  return textFrame(id, [3, ...utf8(value)], version);
}

function latin1Text(id: string, bytes: number[], version: 3 | 4): number[] {
  return textFrame(id, [0, ...bytes], version);
}

function apicFrame(
  mime: string,
  image: number[],
  version: 3 | 4 = 4,
  encoding = 0,
  description: number[] = [],
): number[] {
  const payload = [
    encoding,
    ...asciiBytes(mime),
    0,
    3, // front cover
    ...description,
    0,
    ...image,
  ];
  return textFrame('APIC', payload, version);
}

function buildTag(frames: number[][], version: 3 | 4, flags = 0): Uint8Array {
  const body = frames.flat();
  return new Uint8Array([
    ...asciiBytes('ID3'),
    version,
    0,
    flags,
    ...syncsafe(body.length),
    ...body,
  ]);
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];

describe('parseId3', () => {
  it('reads v2.4 UTF-8 text frames and APIC artwork', () => {
    const tag = buildTag(
      [
        utf8Text('TIT2', 'Вечер', 4),
        utf8Text('TPE1', 'Кино', 4),
        utf8Text('TALB', 'Группа крови', 4),
        utf8Text('TDRC', '1988-01-01', 4),
        utf8Text('TCON', 'Rock', 4),
        utf8Text('TLEN', '215000', 4),
        apicFrame('image/jpeg', JPEG),
      ],
      4,
    );

    const result = parseId3(tag);
    expect(result.status).toBe('ok');
    expect(result.tags).toMatchObject({
      title: 'Вечер',
      artist: 'Кино',
      album: 'Группа крови',
      year: '1988',
      genre: 'Rock',
      durationMs: 215000,
    });
    expect(result.artwork?.mime).toBe('image/jpeg');
    expect([...(result.artwork?.bytes ?? [])]).toEqual(JPEG);
  });

  it('reads v2.3 latin1 frames, TYER and a numeric genre reference', () => {
    const tag = buildTag(
      [
        latin1Text('TIT2', [0x43, 0x61, 0x66, 0xe9], 3), // Café
        utf8Text('TPE1', 'Artist', 3),
        utf8Text('TYER', '1999', 3),
        utf8Text('TCON', '(17)Rock', 3),
        utf8Text('TLEN', '90000', 3),
      ],
      3,
    );

    const result = parseId3(tag);
    expect(result.status).toBe('ok');
    expect(result.tags.title).toBe('Café');
    expect(result.tags.year).toBe('1999');
    expect(result.tags.genre).toBe('Rock');
    expect(result.tags.durationMs).toBe(90000);
    expect(result.artwork).toBeNull();
  });

  it('decodes UTF-16 with a little-endian BOM', () => {
    const text = [0xff, 0xfe];
    for (const character of 'Песня') {
      const code = character.charCodeAt(0);
      text.push(code & 0xff, (code >>> 8) & 0xff);
    }
    const tag = buildTag([textFrame('TIT2', [1, ...text], 4)], 4);
    expect(parseId3(tag).tags.title).toBe('Песня');
  });

  it('returns none for non-ID3 input, short input and unsupported versions', () => {
    expect(parseId3(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toEqual({
      status: 'none',
      tags: {},
      artwork: null,
    });
    expect(parseId3(new Uint8Array(asciiBytes('ID3'))).status).toBe('none');
    expect(parseId3(buildTag([utf8Text('TIT2', 'x', 3)], 3).slice(0, 10)).status).toBe('none');

    const v22 = buildTag([utf8Text('TIT2', 'x', 3)], 3);
    v22[3] = 2;
    expect(parseId3(v22).status).toBe('none');
  });

  it('fails closed on a truncated frame instead of throwing', () => {
    const header = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(200)]);
    const broken = new Uint8Array([...header, ...asciiBytes('TIT2'), ...uint32(500), 0, 0, 0x03]);
    expect(() => parseId3(broken)).not.toThrow();
    expect(parseId3(broken).status).toBe('malformed');
  });

  it('rejects a tag larger than the hard cap before parsing frames', () => {
    const header = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(MAX_ID3_TAG_BYTES)]);
    expect(parseId3(header).status).toBe('malformed');
  });

  it('ignores artwork above the size cap but keeps the text tags', () => {
    const oversized = new Uint8Array(MAX_ARTWORK_BYTES + 1);
    oversized.set(JPEG, 0);
    const tag = buildTag(
      [utf8Text('TIT2', 'Big cover', 4), apicFrame('image/jpeg', [...oversized])],
      4,
    );

    const result = parseId3(tag);
    expect(result.status).toBe('ok');
    expect(result.tags.title).toBe('Big cover');
    expect(result.artwork).toBeNull();
  });

  it('ignores malformed/unsafe APIC frames without failing the tag', () => {
    const tag = buildTag(
      [
        utf8Text('TIT2', 'Safe', 4),
        textFrame(
          'APIC',
          [0, ...asciiBytes('text/html'), 0, 3, 0, 0x3c, 0x68, 0x74, 0x6d, 0x6c],
          4,
        ),
        textFrame('APIC', [0, ...asciiBytes('image/png'), 0, 3], 4),
      ],
      4,
    );
    const result = parseId3(tag);
    expect(result.status).toBe('ok');
    expect(result.tags.title).toBe('Safe');
    expect(result.artwork).toBeNull();
  });

  it('sanitizes hostile tag text and bounds its length', () => {
    const hostile = `<img src=x onerror=alert(1)>\u0000\u0007\u202e${'a'.repeat(400)}`;
    const tag = buildTag([utf8Text('TIT2', hostile, 4)], 4);
    const title = parseId3(tag).tags.title ?? '';

    expect(title).not.toContain('<');
    expect(title).not.toContain('>');
    expect(title).not.toContain('\u0000');
    expect(title).not.toContain('\u202e');
    expect(title.length).toBeLessThanOrEqual(MAX_ID3_TEXT_LENGTH);
    expect(title.startsWith('img src=x onerror=alert(1)')).toBe(true);
  });

  it('returns none for an ID3 tag that only contains padding/unknown frames', () => {
    const tag = buildTag([textFrame('TXXX', [3, ...utf8('custom')], 4)], 4);
    expect(parseId3(tag).status).toBe('none');
  });

  it('survives a v2.4 frame with a plain big-endian size', () => {
    const payload = [3, ...utf8('Legacy writer')];
    const tag = buildTag([], 4);
    const body = [...asciiBytes('TIT2'), ...uint32(payload.length), 0, 0, ...payload];
    const combined = new Uint8Array([
      ...asciiBytes('ID3'),
      4,
      0,
      0,
      ...syncsafe(body.length),
      ...body,
    ]);
    // Keep the helper referenced so the intent of the fixture stays explicit.
    expect(tag.length).toBe(10);
    expect(parseId3(combined).tags.title).toBe('Legacy writer');
  });
});

describe('sanitizeId3Text', () => {
  it('trims, collapses whitespace and truncates', () => {
    expect(sanitizeId3Text('  a   b  ')).toBe('a b');
    expect(sanitizeId3Text('x'.repeat(300)).length).toBe(MAX_ID3_TEXT_LENGTH);
    expect(sanitizeId3Text('a<b>c')).toBe('a b c');
  });
});

describe('readId3Tags', () => {
  it('reads only the tag prefix from a File', async () => {
    const tag = buildTag([utf8Text('TIT2', 'File song', 4), utf8Text('TPE1', 'File artist', 4)], 4);
    const file = new File(
      [tag.buffer as ArrayBuffer, new Uint8Array(4096).buffer as ArrayBuffer],
      'song.mp3',
      { type: 'audio/mpeg' },
    );
    const result = await readId3Tags(file);
    expect(result.status).toBe('ok');
    expect(result.tags.title).toBe('File song');
    expect(result.tags.artist).toBe('File artist');
  });

  it('does not treat an MP3 frame (no ID3 header) as a tag', async () => {
    const file = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00])], 'plain.mp3', {
      type: 'audio/mpeg',
    });
    expect(await readId3Tags(file)).toEqual({ status: 'none', tags: {}, artwork: null });
  });

  it('fails closed for oversized headers and read errors', async () => {
    const header = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(MAX_ID3_TAG_BYTES)]);
    const file = new File([header], 'huge.mp3', { type: 'audio/mpeg' });
    expect((await readId3Tags(file)).status).toBe('malformed');

    const unreadable = new File([new Uint8Array(10)], 'broken.mp3');
    Object.defineProperty(unreadable, 'slice', {
      value: () => {
        throw new Error('read failed');
      },
    });
    expect((await readId3Tags(unreadable)).status).toBe('malformed');
  });
});
