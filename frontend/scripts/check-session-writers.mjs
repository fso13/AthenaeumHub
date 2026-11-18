#!/usr/bin/env node
/**
 * E7-F5G P2-36 CI guard: low-level session writers are commit-only.
 *
 * `prepareSessionRecord`/`writeSessionRecord` bypass the ratchet engine by
 * design (the atomic outbox commit needs them), so they must never be imported
 * by application/UI code. Only the session store itself and the outbox commit
 * module may reference them; tests and the test-only writer helper are excluded
 * from the scan. The production session store must not export the arbitrary
 * `saveSession`/`createSession` convenience writers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

const ALLOWLIST = new Set(['src/e2ee/session/sessionStore.ts', 'src/e2ee/outbox/outboxStore.ts']);

const FORBIDDEN = /\b(?:prepareSessionRecord|writeSessionRecord|saveSession|createSession)\b/;

function isTestFile(path) {
  return (
    path.endsWith('.test.ts') || path.endsWith('.test.tsx') || path.startsWith('src/e2ee/test/')
  );
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
  return files;
}

const violations = [];
let scanned = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (isTestFile(rel)) continue;
  scanned += 1;
  const source = stripComments(readFileSync(file, 'utf8'));
  if (FORBIDDEN.test(source) && !ALLOWLIST.has(rel)) {
    violations.push(`${rel}: references a commit-only session writer`);
  }
}

const sessionStore = readFileSync(join(ROOT, 'src/e2ee/session/sessionStore.ts'), 'utf8');
if (/export\s+(?:async\s+)?function\s+(?:saveSession|createSession)\b/.test(sessionStore)) {
  violations.push(
    'src/e2ee/session/sessionStore.ts: production API must not export saveSession/createSession',
  );
}

if (violations.length > 0) {
  console.error('session-writers:check failed');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `session-writers:check ok (${scanned} production files; writers restricted to session store + outbox commit)`,
);
