/**
 * Read-only loader for the normative vector file.
 *
 * `docs/E2EE-TEST-VECTORS.json` is the single source of truth and is never
 * copied into the frontend: every KAT test reads the committed file. Tests fail
 * loudly (not silently skip) if the file is missing or the version changes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RawVector {
  id: string;
  kind: string;
  note?: string;
  source?: string;
  inputs?: unknown;
  expected?: unknown;
  initial_state?: unknown;
  expected_steps?: unknown;
}

export interface RawSection {
  id: string;
  title: string;
  normative: boolean;
  vectors: RawVector[];
}

export interface VectorMeta {
  title: string;
  vector_set_version: number;
  status: string;
  spec: string;
}

export interface VectorFile {
  meta: VectorMeta;
  sections: RawSection[];
}

/** The eight normative crypto sections E7-F1 must verify (A–G, E2). */
export const CRYPTO_SECTIONS = [
  'A-primitives',
  'B-x3dh',
  'C-kdf',
  'D-aead',
  'E-double-ratchet',
  'E2-skipped-keys',
  'F-envelope',
  'G-verification',
] as const;

/**
 * Vitest runs with the frontend package as cwd, but the vector file lives in
 * the repository-level `docs/`. Try the plausible ancestors instead of
 * hard-coding a relative depth (also works when the suite is run from the root).
 */
function resolveVectorsPath(): string {
  const candidates = [
    resolve(process.cwd(), 'docs/E2EE-TEST-VECTORS.json'),
    resolve(process.cwd(), '../docs/E2EE-TEST-VECTORS.json'),
    resolve(process.cwd(), '../../docs/E2EE-TEST-VECTORS.json'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(['Normative E2EE vectors are missing; tried:', ...candidates].join('\n'));
  }
  return found;
}

let cached: VectorFile | null = null;

export function loadVectorFile(): VectorFile {
  if (cached) return cached;
  const path = resolveVectorsPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Normative E2EE vectors are unreadable: ${path}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Normative E2EE vectors are not a JSON object');
  }
  cached = parsed as VectorFile;
  return cached;
}

export function getSection(file: VectorFile, sectionId: string): RawSection {
  const section = file.sections.find((candidate) => candidate.id === sectionId);
  if (!section) throw new Error(`Vector section not found: ${sectionId}`);
  return section;
}

export function getVector<T extends object = Record<string, unknown>>(
  file: VectorFile,
  vectorId: string,
): RawVector & T {
  for (const section of file.sections) {
    const vector = section.vectors.find((candidate) => candidate.id === vectorId);
    if (vector) return vector as RawVector & T;
  }
  throw new Error(`Vector not found: ${vectorId}`);
}

export function allVectors(file: VectorFile): RawVector[] {
  return file.sections.flatMap((section) => section.vectors);
}
