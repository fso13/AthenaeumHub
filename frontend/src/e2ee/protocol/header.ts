/** Ratchet header codec: `{v:1, dh:b64u32, pn:u32, n:u32}` → 42 bytes (§3.5.3). */
import {
  HEADER_BYTES,
  HEADER_FLAGS,
  HEADER_VERSION,
  KEY_BYTES,
  MAX_HEADER_COUNTER,
} from '../constants';
import { invalid } from '../errors';
import { concatBytes, readU32be, u32be, u8 } from '../encoding/bytes';

export interface ParsedHeader {
  readonly v: 1;
  readonly dh: Uint8Array;
  readonly pn: number;
  readonly n: number;
}

function assertCounter(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_HEADER_COUNTER) {
    throw invalid('INVALID_HEADER', `${label} must be an integer in 0..${MAX_HEADER_COUNTER}`);
  }
  return value;
}

export function encodeHeader(header: ParsedHeader): Uint8Array {
  if (header.v !== HEADER_VERSION) {
    throw invalid('INVALID_HEADER', `header.v must be ${HEADER_VERSION}`);
  }
  if (header.dh.length !== KEY_BYTES) {
    throw invalid('INVALID_HEADER', `header.dh must be ${KEY_BYTES} bytes`);
  }
  return concatBytes(
    u8(HEADER_VERSION),
    u8(HEADER_FLAGS),
    u32be(assertCounter(header.pn, 'header.pn')),
    u32be(assertCounter(header.n, 'header.n')),
    header.dh,
  );
}

export function decodeHeader(bytes: Uint8Array): ParsedHeader {
  if (bytes.length !== HEADER_BYTES) {
    throw invalid('INVALID_HEADER', `header must be exactly ${HEADER_BYTES} bytes`);
  }
  if (bytes[0] !== HEADER_VERSION) {
    throw invalid('INVALID_HEADER', `unsupported header version ${bytes[0] ?? -1}`);
  }
  if (bytes[1] !== HEADER_FLAGS) {
    throw invalid('INVALID_HEADER', 'header flags must be zero');
  }
  return {
    v: 1,
    dh: bytes.slice(10, 42),
    pn: readU32be(bytes, 2),
    n: readU32be(bytes, 6),
  };
}
