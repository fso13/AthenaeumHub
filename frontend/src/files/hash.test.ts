import { describe, expect, it } from 'vitest';
import { Sha256, sha256Blob, sha256Bytes, sha256File, toHex } from './hash';

const encoder = new TextEncoder();

const VECTORS = [
  {
    input: '',
    expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    input: 'abc',
    expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    input: 'The quick brown fox jumps over the lazy dog',
    expected: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  },
] as const;

describe('sha256', () => {
  it.each(VECTORS)('hashes "$input" to the standard vector', ({ input, expected }) => {
    expect(sha256Bytes(encoder.encode(input))).toBe(expected);
  });

  it('is incremental: split input produces the same digest', () => {
    const hash = new Sha256();
    hash.update(encoder.encode('The quick '));
    hash.update(encoder.encode('brown fox jumps '));
    hash.update(encoder.encode('over the lazy dog'));
    expect(toHex(hash.digest())).toBe(VECTORS[2].expected);
  });

  it('hashes Blob and File-like inputs without Web Crypto assumptions', async () => {
    const blob = new Blob([encoder.encode('abc')]);
    expect(await sha256Blob(blob)).toBe(VECTORS[1].expected);
    expect(await sha256File(blob)).toBe(VECTORS[1].expected);
  });

  it('reports progress for a multi-chunk file', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const blob = new Blob([bytes]);
    const seen: number[] = [];
    const digest = await sha256File(blob, (hashed) => seen.push(hashed));

    expect(digest).toBe(sha256Bytes(bytes));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(blob.size);
  });
});
