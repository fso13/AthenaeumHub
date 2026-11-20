/**
 * Test/mock-only stored-ZIP helper for the D1.2 (#86) admin upload.
 *
 * The production client never parses a ZIP: it uploads the bytes and the
 * backend validates the archive. The mock server needs to behave like the
 * backend, so it builds/reads small *stored* (uncompressed) archives. No
 * third-party ZIP dependency is added to the app bundle.
 */

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export interface MockZipEntry {
  path: string;
  data: Uint8Array;
}

export interface MockPluginZipOptions {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  entry?: string;
  permissions?: string[];
  modes?: string[];
  files?: Record<string, string | Uint8Array>;
  /** Drop/override the manifest entirely (invalid-package tests). */
  manifest?: Record<string, unknown> | null;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Build an uncompressed ZIP. Entry order is preserved. */
export function createStoredZip(entries: MockZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.path);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

export interface MockZipReadResult {
  entries: Map<string, Uint8Array>;
  error: 'invalid-zip' | 'unsupported-compression' | null;
}

/** Read an uncompressed ZIP and return its entries in central-directory order. */
export function readStoredZip(bytes: Uint8Array): MockZipReadResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();
  if (bytes.length < 22) return { entries, error: 'invalid-zip' };

  let endOffset = -1;
  const scanStart = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= scanStart; index -= 1) {
    if (view.getUint32(index, true) === END_OF_CENTRAL_DIRECTORY) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) return { entries, error: 'invalid-zip' };

  const entryCount = view.getUint16(endOffset + 8, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const limit = centralOffset + view.getUint32(endOffset + 12, true);

  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_HEADER) {
      return { entries, error: 'invalid-zip' };
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) return { entries, error: 'invalid-zip' };
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));

    if (method !== 0) return { entries, error: 'unsupported-compression' };

    if (
      localOffset + 30 > bytes.length ||
      view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER
    ) {
      return { entries, error: 'invalid-zip' };
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) return { entries, error: 'invalid-zip' };
    if (entries.has(name)) return { entries, error: 'invalid-zip' };
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));

    cursor = nameStart + nameLength + extraLength + commentLength;
    if (cursor > limit) return { entries, error: 'invalid-zip' };
  }

  return { entries, error: null };
}

/**
 * Build a valid package for the mock server. The returned `File` is what the
 * browser would receive from a file picker.
 */
export function createMockPluginZip(options: MockPluginZipOptions = {}): File {
  const id = options.id ?? 'hello-panel';
  const entry = options.entry ?? 'index.html';
  const manifest =
    options.manifest === null
      ? null
      : {
          id,
          name: options.name ?? 'Hello panel',
          version: options.version ?? '1.0.0',
          description: options.description ?? 'Пример статической панели',
          author: options.author ?? 'Sova',
          entry,
          permissions: options.permissions ?? ['chat.messages.read'],
          modes: options.modes ?? ['MANAGED'],
          ...options.manifest,
        };

  const files: Record<string, string | Uint8Array> = {
    [entry]:
      options.files?.[entry] ??
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/app.css"></head><body><h1>Hello panel</h1><img src="assets/logo.svg" alt="Sova"><script src="assets/app.js"></script></body></html>',
    'assets/app.js': 'window.addEventListener("message", () => {});',
    'assets/app.css': 'body { font: 14px system-ui; }',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    ...options.files,
  };

  const entries: MockZipEntry[] = [
    ...(manifest ? [{ path: 'manifest.json', data: utf8(JSON.stringify(manifest, null, 2)) }] : []),
    ...Object.entries(files).map(([path, value]) => ({
      path,
      data: typeof value === 'string' ? utf8(value) : value,
    })),
  ];

  const bytes = new Uint8Array(createStoredZip(entries));
  return new File([bytes.buffer], `${id}.zip`, { type: 'application/zip' });
}

/** Minimal JSON manifest shape the mock server accepts. */
export interface MockManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  permissions: string[];
  modes: string[];
}

export function parseMockManifest(bytes: Uint8Array): MockManifest | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.version !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.author !== 'string' ||
      typeof value.entry !== 'string' ||
      !Array.isArray(value.permissions) ||
      !value.permissions.every((item) => typeof item === 'string') ||
      !Array.isArray(value.modes) ||
      !value.modes.every((item) => item === 'MANAGED' || item === 'E2EE')
    ) {
      return null;
    }
    return {
      id: value.id,
      name: value.name,
      version: value.version,
      description: value.description,
      author: value.author,
      entry: value.entry,
      permissions: value.permissions as string[],
      modes: value.modes as string[],
    };
  } catch {
    return null;
  }
}
