/**
 * SHA-256 helpers for the managed upload pipeline.
 *
 * The contract requires `Content-SHA256` for every part and a final file hash
 * on complete. Web Crypto has no streaming digest, so small buffers use
 * `crypto.subtle` and large files use a small incremental implementation
 * (never loading a 2 GiB file into memory twice).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function compressBlock(state: Uint32Array, block: Uint8Array, offset: number): void {
  const words = new Uint32Array(64);
  for (let index = 0; index < 16; index += 1) {
    const start = offset + index * 4;
    words[index] =
      (((block[start] ?? 0) << 24) |
        ((block[start + 1] ?? 0) << 16) |
        ((block[start + 2] ?? 0) << 8) |
        (block[start + 3] ?? 0)) >>>
      0;
  }
  for (let index = 16; index < 64; index += 1) {
    const w15 = words[index - 15] ?? 0;
    const w2 = words[index - 2] ?? 0;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
  }

  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;

  for (let index = 0; index < 64; index += 1) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (h + s1 + ch + (K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (s0 + maj) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = ((state[0] ?? 0) + a) >>> 0;
  state[1] = ((state[1] ?? 0) + b) >>> 0;
  state[2] = ((state[2] ?? 0) + c) >>> 0;
  state[3] = ((state[3] ?? 0) + d) >>> 0;
  state[4] = ((state[4] ?? 0) + e) >>> 0;
  state[5] = ((state[5] ?? 0) + f) >>> 0;
  state[6] = ((state[6] ?? 0) + g) >>> 0;
  state[7] = ((state[7] ?? 0) + h) >>> 0;
}

export class Sha256 {
  private readonly state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalBytes = 0;

  update(data: Uint8Array): this {
    this.totalBytes += data.length;
    let offset = 0;

    if (this.bufferLength > 0) {
      const take = Math.min(64 - this.bufferLength, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        compressBlock(this.state, this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= data.length) {
      compressBlock(this.state, data, offset);
      offset += 64;
    }

    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.length - offset;
    }

    return this;
  }

  digest(): Uint8Array {
    const state = this.state.slice();
    const tail = this.buffer.slice();
    let tailLength = this.bufferLength;
    tail[tailLength] = 0x80;
    tailLength += 1;

    if (tailLength > 56) {
      tail.fill(0, tailLength);
      compressBlock(state, tail, 0);
      tailLength = 0;
    }
    tail.fill(0, tailLength, 56);

    const bits = this.totalBytes * 8;
    const high = Math.floor(bits / 0x1_0000_0000);
    const low = bits >>> 0;
    tail[56] = (high >>> 24) & 0xff;
    tail[57] = (high >>> 16) & 0xff;
    tail[58] = (high >>> 8) & 0xff;
    tail[59] = high & 0xff;
    tail[60] = (low >>> 24) & 0xff;
    tail[61] = (low >>> 16) & 0xff;
    tail[62] = (low >>> 8) & 0xff;
    tail[63] = low & 0xff;
    compressBlock(state, tail, 0);

    const output = new Uint8Array(32);
    for (let index = 0; index < 8; index += 1) {
      const word = state[index] ?? 0;
      output[index * 4] = (word >>> 24) & 0xff;
      output[index * 4 + 1] = (word >>> 16) & 0xff;
      output[index * 4 + 2] = (word >>> 8) & 0xff;
      output[index * 4 + 3] = word & 0xff;
    }
    return output;
  }
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return toHex(new Sha256().update(bytes).digest());
}

/** Hash an ArrayBuffer, preferring the platform digest. */
export async function sha256Buffer(buffer: ArrayBuffer): Promise<string> {
  const crypto = subtle();
  if (crypto) {
    try {
      const digest = await crypto.digest('SHA-256', buffer);
      return toHex(new Uint8Array(digest));
    } catch {
      // Fall through.
    }
  }
  return sha256Bytes(new Uint8Array(buffer));
}

const SUBTLE_LIMIT_BYTES = 64 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

function subtle(): SubtleCrypto | null {
  const value = globalThis.crypto?.subtle;
  return value ?? null;
}

/** jsdom's Blob predates `Blob.arrayBuffer`; FileReader is available there. */
export function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'));
      reader.readAsArrayBuffer(blob);
    });
  }
  return new Response(blob).arrayBuffer();
}

/** Hash a Blob/File part; uses Web Crypto when the environment supports it. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const crypto = subtle();
  if (crypto) {
    try {
      const digest = await crypto.digest('SHA-256', await readBlobArrayBuffer(blob));
      return toHex(new Uint8Array(digest));
    } catch {
      // Fall through to the portable implementation (e.g. insecure context).
    }
  }
  return sha256Stream(blob);
}

/**
 * Hash a whole file. Files up to 64 MiB use one Web Crypto call; larger files
 * are streamed in 4 MiB slices so the browser never holds 2 GiB at once.
 */
export async function sha256File(
  blob: Blob,
  onProgress?: (hashedBytes: number, totalBytes: number) => void,
): Promise<string> {
  const crypto = subtle();
  if (crypto && blob.size <= SUBTLE_LIMIT_BYTES) {
    try {
      const digest = await crypto.digest('SHA-256', await readBlobArrayBuffer(blob));
      onProgress?.(blob.size, blob.size);
      return toHex(new Uint8Array(digest));
    } catch {
      // Fall through.
    }
  }
  return sha256Stream(blob, onProgress);
}

async function sha256Stream(
  blob: Blob,
  onProgress?: (hashedBytes: number, totalBytes: number) => void,
): Promise<string> {
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += STREAM_CHUNK_BYTES) {
    const end = Math.min(offset + STREAM_CHUNK_BYTES, blob.size);
    const bytes = new Uint8Array(await readBlobArrayBuffer(blob.slice(offset, end)));
    hash.update(bytes);
    onProgress?.(end, blob.size);
  }
  onProgress?.(blob.size, blob.size);
  return toHex(hash.digest());
}
