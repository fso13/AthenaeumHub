#!/usr/bin/env node
/**
 * E5-F asset guard.
 *
 * Built-in sticker artwork ships as PNG only (SYSTEM-ANALYSIS §12.7: SVG is
 * forbidden) at 512×512 and ≤512 KiB, matching the seeded catalog paths in
 * `src/mocks/fixtures.ts` and backend seed data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stickersDir = path.join(root, 'public', 'stickers');
const PACKS = ['krug', 'cats'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 512 * 1024;

const failures = [];

for (const pack of PACKS) {
  const expected = [
    ...Array.from({ length: 8 }, (_, index) => `${String(index + 1).padStart(2, '0')}.png`),
    'cover.png',
  ];
  for (const file of expected) {
    const filePath = path.join(stickersDir, pack, file);
    let bytes;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      failures.push(`Missing sticker asset: public/stickers/${pack}/${file}`);
      continue;
    }
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) {
      failures.push(`Not a PNG (magic bytes): public/stickers/${pack}/${file}`);
      continue;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== 512 || height !== 512) {
      failures.push(
        `Sticker asset must be 512×512: public/stickers/${pack}/${file} is ${width}×${height}`,
      );
    }
    if (bytes.length > MAX_BYTES) {
      failures.push(
        `Sticker asset exceeds 512 KiB: public/stickers/${pack}/${file} is ${bytes.length} bytes`,
      );
    }
  }
}

async function collect(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

const files = await collect(stickersDir);
for (const file of files) {
  if (!/\.png$/i.test(file)) {
    failures.push(`Built-in sticker directory may contain only PNG: ${path.relative(root, file)}`);
  }
}

if (failures.length > 0) {
  console.error('\nSticker asset check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Sticker asset check passed: ${PACKS.length} packs × (8 stickers + cover), PNG 512×512, no SVG.`,
);
