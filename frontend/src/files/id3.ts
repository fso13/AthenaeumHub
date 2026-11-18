/**
 * Minimal, dependency-free ID3v2 reader (D1-FE2).
 *
 * Scope: ID3v2.3/2.4 text frames (`TIT2`, `TPE1`, `TALB`, `TYER`/`TDRC`,
 * `TCON`, `TLEN`) and `APIC` artwork. The parser is defensive by design:
 *
 *  - only the first tag is read, and only up to `MAX_ID3_TAG_BYTES`;
 *  - every frame size is verified against the remaining buffer;
 *  - compression/encryption frames are skipped, never decompressed;
 *  - malformed input returns `status: 'malformed'` instead of throwing;
 *  - text is sanitized (no HTML angle brackets, no control/bidi characters)
 *    and truncated, because the server rejects such strings and the UI must
 *    never treat tag values as markup;
 *  - artwork bytes are capped and restricted to safe raster MIME types.
 *
 * `readId3Tags` reads at most the tag + 10-byte header from a `Blob`, so a
 * multi-gigabyte audio file never gets loaded into memory.
 */
import { readBlobArrayBuffer } from './hash';

export const ID3_HEADER_SIZE = 10;
/** Hard cap on the whole tag (header included); larger tags are rejected. */
export const MAX_ID3_TAG_BYTES = 8 * 1024 * 1024;
/** Hard cap on embedded cover art; larger APIC frames are ignored. */
export const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;
/** Text frames above this size are not user metadata; skip them. */
export const MAX_ID3_TEXT_FRAME_BYTES = 64 * 1024;
export const MAX_ID3_TEXT_LENGTH = 255;
export const MAX_ID3_GENRE_LENGTH = 64;
const MAX_ARTWORK_DESCRIPTION_BYTES = 4096;

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  /** Four ASCII digits, as required by `AttachmentRef.media.year`. */
  year?: string;
  genre?: string;
  /** `TLEN` in milliseconds when present and within the contract bounds. */
  durationMs?: number;
}

export interface Id3Artwork {
  /** One of the safe raster MIME types below. */
  mime: string;
  bytes: Uint8Array;
}

export type Id3Status = 'ok' | 'none' | 'malformed';

export interface Id3Result {
  status: Id3Status;
  tags: Id3Tags;
  artwork: Id3Artwork | null;
}

const EMPTY_TAGS: Id3Tags = {};

const TEXT_FRAME_IDS = new Set(['TIT2', 'TPE1', 'TALB', 'TYER', 'TDRC', 'TCON', 'TLEN']);
const SAFE_ARTWORK_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

function none(): Id3Result {
  return { status: 'none', tags: { ...EMPTY_TAGS }, artwork: null };
}

function malformed(): Id3Result {
  return { status: 'malformed', tags: { ...EMPTY_TAGS }, artwork: null };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return value;
}

function syncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[offset + 1] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[offset + 2] ?? 0) & 0x7f) * 0x80 +
    ((bytes[offset + 3] ?? 0) & 0x7f)
  );
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** ID3v2 unsynchronisation: every `FF 00` pair becomes `FF`. */
function deunsynchronize(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    const value = bytes[read] ?? 0;
    output[write] = value;
    write += 1;
    if (value === 0xff && bytes[read + 1] === 0x00) read += 1;
  }
  return output.subarray(0, write);
}

/**
 * Tag text is display-only. Remove characters that are forbidden by the
 * server (`<`, `>`, C0/C1 controls, bidi overrides), collapse whitespace and
 * truncate to the contract bound. React escapes the result when rendering.
 */
export function sanitizeId3Text(value: string, maxLength = MAX_ID3_TEXT_LENGTH): string {
  if (typeof value !== 'string') return '';
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const forbidden =
      character === '<' ||
      character === '>' ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0xfeff;
    if (forbidden) {
      cleaned += ' ';
      continue;
    }
    cleaned += character;
  }
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxLength));
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('iso-8859-1').decode(bytes);
}

function decodeUtf16(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    if (first === 0xfe && second === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    if (first === 0xff && second === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
  }
  // Most untagged UTF-16 ID3 frames are little-endian in the wild.
  return new TextDecoder('utf-16le').decode(bytes);
}

function decodeUtf16Be(bytes: Uint8Array): string {
  return new TextDecoder('utf-16be').decode(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeTextPayload(payload: Uint8Array): string {
  if (payload.length === 0) return '';
  const encoding = payload[0] ?? 0;
  const body = payload.subarray(1);
  switch (encoding) {
    case 0:
      return decodeLatin1(body);
    case 1:
      return decodeUtf16(body);
    case 2:
      return decodeUtf16Be(body);
    case 3:
      return decodeUtf8(body);
    default:
      return '';
  }
}

/** Multi-value text frames separate values with NUL; join them for display. */
function decodeTextFrame(payload: Uint8Array): string {
  if (payload.length < 1) return '';
  const decoded = decodeTextPayload(payload);
  const parts = decoded
    .split('\u0000')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.join(', ');
}

function cleanYear(value: string): string | undefined {
  const match = /(?:^|\D)(\d{4})(?:\D|$)/.exec(value);
  return match?.[1];
}

function cleanGenre(value: string): string | undefined {
  // ID3v2.3 may encode a genre as "(17)Rock" or a bare numeric reference.
  const cleaned = value.replace(/^\(\d+\)/, '').trim();
  const result = sanitizeId3Text(cleaned, MAX_ID3_GENRE_LENGTH);
  return result.length > 0 ? result : undefined;
}

function cleanDuration(value: string): number | undefined {
  const digits = value.trim();
  if (!/^\d{1,12}$/.test(digits)) return undefined;
  const duration = Number.parseInt(digits, 10);
  if (!Number.isFinite(duration) || duration < 1 || duration > 604_800_000) return undefined;
  return duration;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    (bytes[0] ?? 0) === 0xff &&
    (bytes[1] ?? 0) === 0xd8 &&
    (bytes[2] ?? 0) === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 4 &&
    (bytes[0] ?? 0) === 0x89 &&
    (bytes[1] ?? 0) === 0x50 &&
    (bytes[2] ?? 0) === 0x4e &&
    (bytes[3] ?? 0) === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    ascii(bytes, 0, 4) === 'GIF8' &&
    ((bytes[4] ?? 0) === 0x37 || (bytes[4] ?? 0) === 0x39)
  ) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function normalizeArtworkMime(value: string): string | null {
  const mime = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg';
  if (mime === 'image/x-ms-bmp') return 'image/bmp';
  return SAFE_ARTWORK_MIME.has(mime) ? mime : null;
}

/** Find the end of a NUL-terminated string; `step` is 1 for 8-bit, 2 for UTF-16. */
function findTerminator(bytes: Uint8Array, start: number, step: number, limit: number): number {
  const end = Math.min(bytes.length, limit);
  for (let index = start; index + step <= end; index += step) {
    let zero = true;
    for (let offset = 0; offset < step; offset += 1) {
      if ((bytes[index + offset] ?? 0) !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) return index;
  }
  return -1;
}

function parseApic(payload: Uint8Array): Id3Artwork | null {
  if (payload.length < 4) return null;
  const encoding = payload[0] ?? 0;
  const mimeEnd = findTerminator(payload, 1, 1, 256);
  if (mimeEnd < 0) return null;
  const declaredMime = decodeLatin1(payload.subarray(1, mimeEnd));
  const afterMime = mimeEnd + 1;
  if (afterMime >= payload.length) return null;
  // Picture type byte.
  const descriptionStart = afterMime + 1;
  const step = encoding === 1 || encoding === 2 ? 2 : 1;
  const descriptionEnd = findTerminator(
    payload,
    descriptionStart,
    step,
    descriptionStart + MAX_ARTWORK_DESCRIPTION_BYTES,
  );
  if (descriptionEnd < 0) return null;
  const imageStart = descriptionEnd + step;
  if (imageStart >= payload.length) return null;
  const image = payload.subarray(imageStart);
  if (image.length === 0 || image.length > MAX_ARTWORK_BYTES) return null;
  const mime = normalizeArtworkMime(declaredMime) ?? sniffImageMime(image);
  if (mime === null) return null;
  return { mime, bytes: image.slice() };
}

function hasTags(tags: Id3Tags): boolean {
  return (
    tags.title !== undefined ||
    tags.artist !== undefined ||
    tags.album !== undefined ||
    tags.year !== undefined ||
    tags.genre !== undefined ||
    tags.durationMs !== undefined
  );
}

export function parseId3(input: ArrayBuffer | Uint8Array): Id3Result {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < ID3_HEADER_SIZE) return none();
    if (ascii(bytes, 0, 3) !== 'ID3') return none();
    const major = bytes[3] ?? 0;
    const flags = bytes[5] ?? 0;
    if (major !== 3 && major !== 4) return none();
    const tagSize = syncsafe(bytes, 6);
    if (tagSize < 0 || tagSize + ID3_HEADER_SIZE > MAX_ID3_TAG_BYTES) return malformed();
    const tagEnd = Math.min(bytes.length, ID3_HEADER_SIZE + tagSize);
    let body = bytes.subarray(ID3_HEADER_SIZE, tagEnd);
    if ((flags & 0x80) !== 0) body = deunsynchronize(body);

    const tags: Id3Tags = {};
    let artwork: Id3Artwork | null = null;
    let offset = 0;

    // Extended header: v2.3's size field excludes itself, v2.4's includes it.
    if ((flags & 0x40) !== 0) {
      if (body.length < 4) return malformed();
      const extendedSize = major === 4 ? syncsafe(body, 0) : uint32(body, 0);
      if (extendedSize < 4) return malformed();
      offset = major === 4 ? extendedSize : extendedSize + 4;
      if (offset > body.length) return malformed();
    }

    while (offset + 10 <= body.length) {
      const frameId = ascii(body, offset, 4);
      if (frameId === '\u0000\u0000\u0000\u0000') break; // padding starts
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const rawSize = uint32(body, offset + 4);
      let frameSize = major === 4 ? syncsafe(body, offset + 4) : rawSize;
      if (frameSize < 0 || frameSize > body.length - offset - 10) {
        // Some v2.4 writers emit a plain big-endian frame size. Accept it
        // only when it actually fits; otherwise the frame is broken.
        frameSize = rawSize;
        if (frameSize < 0 || frameSize > body.length - offset - 10) {
          return malformed();
        }
      }
      const flag1 = body[offset + 8] ?? 0;
      const frameStart = offset + 10;
      const frameEnd = frameStart + frameSize;
      if (frameEnd > body.length) return malformed();

      let payload = body.subarray(frameStart, frameEnd);
      offset = frameEnd;

      if (major === 3) {
        // Compression 0x80, encryption 0x40: never supported. Grouping 0x20.
        if ((flag1 & 0xc0) !== 0) continue;
        if ((flag1 & 0x20) !== 0 && payload.length > 0) payload = payload.subarray(1);
      } else {
        // Compression 0x08, encryption 0x04: skip. Grouping 0x40, DLI 0x01,
        // unsync 0x02 (the global flag was already handled).
        if ((flag1 & 0x0c) !== 0) continue;
        if ((flag1 & 0x40) !== 0 && payload.length > 0) payload = payload.subarray(1);
        if ((flag1 & 0x01) !== 0 && payload.length >= 4) payload = payload.subarray(4);
        if ((flag1 & 0x02) !== 0) payload = deunsynchronize(payload);
      }
      // Tag-alter/file-alter/read-only flags (flag2) do not change the bytes.

      if (frameId === 'APIC') {
        if (artwork === null) artwork = parseApic(payload);
        continue;
      }
      if (!TEXT_FRAME_IDS.has(frameId)) continue;
      if (payload.length > MAX_ID3_TEXT_FRAME_BYTES) continue;

      const text = decodeTextFrame(payload);
      if (frameId === 'TIT2') {
        const value = sanitizeId3Text(text);
        if (value) tags.title = value;
      } else if (frameId === 'TPE1') {
        const value = sanitizeId3Text(text);
        if (value) tags.artist = value;
      } else if (frameId === 'TALB') {
        const value = sanitizeId3Text(text);
        if (value) tags.album = value;
      } else if (frameId === 'TYER' || frameId === 'TDRC') {
        const value = tags.year ?? cleanYear(text);
        if (value) tags.year = value;
      } else if (frameId === 'TCON') {
        const value = tags.genre ?? cleanGenre(text);
        if (value) tags.genre = value;
      } else if (frameId === 'TLEN') {
        tags.durationMs ??= cleanDuration(text);
      }
    }

    if (!hasTags(tags) && artwork === null) {
      // A structurally valid but empty tag (padding only) is not a song tag.
      return { status: 'none', tags: {}, artwork: null };
    }
    return { status: 'ok', tags, artwork };
  } catch {
    // Any unexpected shape (bad decoder input, out-of-range slice) degrades
    // to the filename/default-cover fallback instead of crashing the feed.
    return malformed();
  }
}

export interface ReadId3Options {
  /** Override for tests; production keeps the hard cap. */
  maxTagBytes?: number;
}

/**
 * Read only the ID3 tag from a file. A file without an `ID3` header is not
 * fetched at all beyond the first 10 bytes; a tag larger than the cap is
 * rejected before allocating its buffer.
 */
export async function readId3Tags(file: Blob, options: ReadId3Options = {}): Promise<Id3Result> {
  try {
    if (file.size < ID3_HEADER_SIZE) return none();
    const header = new Uint8Array(await readBlobArrayBuffer(file.slice(0, ID3_HEADER_SIZE)));
    if (header.length < ID3_HEADER_SIZE || ascii(header, 0, 3) !== 'ID3') return none();
    const tagSize = syncsafe(header, 6);
    const maxTagBytes = options.maxTagBytes ?? MAX_ID3_TAG_BYTES;
    if (tagSize < 0 || tagSize + ID3_HEADER_SIZE > maxTagBytes) return malformed();
    const end = Math.min(file.size, ID3_HEADER_SIZE + tagSize);
    const bytes = new Uint8Array(await readBlobArrayBuffer(file.slice(0, end)));
    return parseId3(bytes);
  } catch {
    return malformed();
  }
}
