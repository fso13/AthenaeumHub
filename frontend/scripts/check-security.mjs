#!/usr/bin/env node
/**
 * Client-side security guard (SYSTEM-ANALYSIS §11.6).
 * Fails the check on patterns that would be a P0 for this slice.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

const STORAGE_MODULE = 'src/auth/storage.ts';
/**
 * R-02 explicitly requires a per-device workspace selection that survives a
 * reload. The only localStorage writer is this module and it stores the
 * workspace id alone; auth tokens/passwords stay in sessionStorage/memory.
 */
const WORKSPACE_PREF_MODULE = 'src/workspace/deviceWorkspace.ts';

const forbidden = [
  {
    pattern: /dangerouslySetInnerHTML/g,
    message: 'dangerouslySetInnerHTML is forbidden: render user content as text nodes',
  },
  {
    pattern: /\blocalStorage\s*[.[]/g,
    message: `localStorage is allowed only in ${WORKSPACE_PREF_MODULE} (workspace id only); auth material uses sessionStorage/in-memory`,
    allow: [WORKSPACE_PREF_MODULE],
  },
  {
    pattern: /\bsessionStorage\s*[.[]/g,
    message: `sessionStorage is allowed only in ${STORAGE_MODULE} (AUTH-D-06); import storage helpers instead`,
    allow: [STORAGE_MODULE],
  },
  {
    pattern: /document\.cookie/g,
    message: 'document.cookie access is out of scope and forbidden',
  },
  {
    pattern: /\beval\s*\(/g,
    message: 'eval() is forbidden',
  },
  {
    pattern: /new\s+Function\s*\(/g,
    message: 'new Function() is forbidden',
  },
  {
    pattern: /console\.(?:log|debug|info)\([^\n)]*(?:access_token|refresh_token|id_token)/g,
    message: 'Do not log access/refresh/id tokens',
  },
  {
    pattern: /\bconsole\s*\./g,
    message: 'E2EE code must not log: no keys, plaintext, ciphertext or session material',
    only: 'src/e2ee/',
  },
  {
    pattern: /\bMath\.random\s*\(/g,
    message: 'E2EE randomness must use crypto.getRandomValues, never Math.random',
    only: 'src/e2ee/',
  },
  {
    pattern: /\bfetch\s*\(/g,
    message: 'E2EE modules must not perform network calls (send/receive is E7-F4/F5)',
    only: 'src/e2ee/',
  },
  {
    pattern: /\bXMLHttpRequest\b/g,
    message: 'E2EE modules must not perform network calls (send/receive is E7-F4/F5)',
    only: 'src/e2ee/',
  },
  {
    pattern: /\bWebSocket\b/g,
    message: 'E2EE modules must not open sockets (send/receive is E7-F4/F5)',
    only: 'src/e2ee/',
  },
  {
    pattern: /\bsendBeacon\s*\(/g,
    message: 'E2EE modules must not perform network calls',
    only: 'src/e2ee/',
  },
];

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (/\.(ts|tsx|css|html)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await collectFiles(srcDir);
const violations = [];

for (const file of files) {
  const content = await fs.readFile(file, 'utf8');
  const relative = path.relative(root, file);
  for (const rule of forbidden) {
    if (rule.allow?.includes(relative)) continue;
    if (rule.only && !relative.startsWith(rule.only)) continue;
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push(`${relative}:${line} — ${rule.message}`);
    }
  }
}

if (violations.length > 0) {
  console.error('\nSecurity check failed:\n');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `Security check passed: ${files.length} files, no XSS sinks, localStorage only for the workspace id in ${WORKSPACE_PREF_MODULE}, no token logs, no E2EE console/Math.random/network.`,
);
