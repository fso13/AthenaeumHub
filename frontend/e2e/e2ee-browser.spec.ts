/**
 * E7-F7A — real-browser WebCrypto matrix for the E2EE core.
 *
 * Closed by default: `E2EE_BROWSER_MATRIX=1` (the `test:e2e:e2ee` script sets
 * it). The suite needs only the Vite dev server: no backend, Keycloak, MSW
 * contract or E2EE feature flag. It loads the app shell and dynamically
 * imports the production E2EE modules that the browser would actually run.
 *
 * The normative vectors are NOT copied into this file: Playwright serves
 * `docs/E2EE-TEST-VECTORS.json` to the page (route fulfilment) and the page
 * fetches it. The SHA-256 of the fetched bytes is compared with the SHA-256 of
 * the committed file, so a stale copy cannot silently pass.
 *
 * Matrix policy (E7-F8 P1-04): Chromium/Firefox must pass every primitive and
 * the byte-exact RFC 8032 Ed25519 KAT (blocking). WebKit is an explicit
 * expected-unsupported row: the runtime floor must return `available=false`
 * with `ed25519` in `missing`, and the app must block E2EE. It is never a
 * silent pass and never a job that is simply ignored. There is deliberately
 * no JS/WASM fallback (E2EE-ADR-02).
 */
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MATRIX_ENABLED = process.env.E2EE_BROWSER_MATRIX === '1';
const VECTORS_ROUTE = '**/__e2ee__/vectors.json';
const VECTORS_URL = '/__e2ee__/vectors.json';
const SUPPORT_MODULE = '/src/e2ee/crypto/support.ts';
const KAT_MODULE = '/src/e2ee/test/browserKat.ts';
const ED25519_MODULE = '/src/e2ee/crypto/ed25519.ts';

const REQUIRED_PRIMITIVES = [
  'random',
  'sha256',
  'sha512',
  'hmacSha256',
  'hkdfSha256',
  'aesGcm256',
  'x25519',
  'ed25519',
] as const;

interface E2eeSupport {
  available: boolean;
  primitives: Record<string, boolean>;
  missing: string[];
}

interface KatCaseResult {
  id: string;
  section: string;
  checks: number;
  ok: boolean;
  error?: string;
}

interface KatRunResult {
  cases: KatCaseResult[];
  checks: number;
  failures: number;
}

interface KatEvidence {
  sha256: string;
  bytes: number;
  vectorSetVersion: number;
  sectionCounts: Record<string, number>;
  result: KatRunResult;
}

function resolveVectorsPath(): string {
  const candidates = [
    resolve(process.cwd(), '../docs/E2EE-TEST-VECTORS.json'),
    resolve(process.cwd(), 'docs/E2EE-TEST-VECTORS.json'),
    resolve(process.cwd(), '../../docs/E2EE-TEST-VECTORS.json'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Normative E2EE vectors are missing; tried:\n${candidates.join('\n')}`);
  }
  return found;
}

const VECTORS_PATH = resolveVectorsPath();

async function routeVectors(page: Page): Promise<void> {
  await page.route(VECTORS_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', path: VECTORS_PATH }),
  );
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

async function readSupport(
  page: Page,
  project: string,
  browserVersion: string,
): Promise<E2eeSupport> {
  let support: E2eeSupport;
  try {
    support = await page.evaluate(async (modulePath) => {
      const supportModule = (await import(modulePath)) as {
        detectE2eeSupport(): Promise<E2eeSupport>;
      };
      return supportModule.detectE2eeSupport();
    }, SUPPORT_MODULE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `E2EE_UNSUPPORTED_BROWSER: could not load the E2EE support detector in ${project} ${browserVersion}: ${message}`,
    );
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const evidence = { project, browserVersion, userAgent, support };
  await test.info().attach('webcrypto-support.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });

  if (!support.available) {
    const missing = support.missing.join(', ');
    test.info().annotations.push({
      type: 'E2EE_UNSUPPORTED_BROWSER',
      description: `${project} ${browserVersion} is missing/blocked: ${missing}`,
    });
  }
  return support;
}

/**
 * ADR-26 matrix policy (E7-F8 P1-04): Chromium/Firefox are blocking; WebKit is
 * an explicit expected-unsupported row, not a red job that gets ignored and not
 * a silent pass. The WebKit row must fail the RFC 8032 runtime probe.
 */
async function assertBrowserFloor(
  support: E2eeSupport,
  project: string,
  browserVersion: string,
): Promise<void> {
  if (project === 'webkit') {
    expect(
      support.available,
      `E2EE_UNSUPPORTED_BROWSER: WebKit ${browserVersion} must be blocked by the RFC 8032 runtime floor`,
    ).toBe(false);
    expect(support.primitives.ed25519).toBe(false);
    expect(support.missing).toContain('ed25519');
    test.info().annotations.push({
      type: 'E2EE_UNSUPPORTED_BROWSER',
      description: `WebKit ${browserVersion} is expected unsupported (ADR-26); E2EE stays blocked in the app.`,
    });
    return;
  }
  expect(support.available, `${project} ${browserVersion} must support E2EE`).toBe(true);
  for (const primitive of REQUIRED_PRIMITIVES) {
    expect(
      support.primitives[primitive],
      `E2EE_UNSUPPORTED_BROWSER: ${primitive} is unavailable in ${project} ${browserVersion}`,
    ).toBe(true);
  }
  expect(
    support.missing,
    `E2EE_UNSUPPORTED_BROWSER: ${project} is missing ${support.missing}`,
  ).toEqual([]);
}

async function fetchAndRunKat(page: Page): Promise<KatEvidence> {
  return page.evaluate(
    async ({ url, katModulePath }) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`vector fetch failed: HTTP ${response.status}`);
      }
      const text = await response.text();
      const encoded = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const vectors = JSON.parse(text) as {
        meta: { vector_set_version: number };
        sections: Array<{ id: string; vectors: unknown[] }>;
      };
      const katModule = (await import(katModulePath)) as {
        runBrowserKat(file: unknown): Promise<KatRunResult>;
      };
      const result = await katModule.runBrowserKat(vectors);
      const sectionCounts: Record<string, number> = {};
      for (const section of vectors.sections) sectionCounts[section.id] = section.vectors.length;
      return {
        sha256,
        bytes: encoded.length,
        vectorSetVersion: vectors.meta.vector_set_version,
        sectionCounts,
        result,
      };
    },
    { url: VECTORS_URL, katModulePath: KAT_MODULE },
  );
}

async function fetchAndRunTamper(page: Page): Promise<KatEvidence> {
  return page.evaluate(
    async ({ url, katModulePath }) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`vector fetch failed: HTTP ${response.status}`);
      }
      const text = await response.text();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const vectors = JSON.parse(text) as {
        meta: { vector_set_version: number };
        sections: Array<{ id: string; vectors: unknown[] }>;
      };
      const katModule = (await import(katModulePath)) as {
        runEnvelopeTamperKat(file: unknown): Promise<KatRunResult>;
      };
      const result = await katModule.runEnvelopeTamperKat(vectors);
      const sectionCounts: Record<string, number> = {};
      for (const section of vectors.sections) sectionCounts[section.id] = section.vectors.length;
      return {
        sha256,
        bytes: new TextEncoder().encode(text).length,
        vectorSetVersion: vectors.meta.vector_set_version,
        sectionCounts,
        result,
      };
    },
    { url: VECTORS_URL, katModulePath: KAT_MODULE },
  );
}

function expectNoFailures(result: KatRunResult): void {
  expect(
    result.cases.filter((entry) => !entry.ok),
    'every KAT case must pass; see the attached evidence',
  ).toEqual([]);
  expect(result.failures).toBe(0);
}

test.describe('E2EE browser WebCrypto matrix (F7A)', () => {
  test.skip(
    !MATRIX_ENABLED,
    'real-browser E2EE matrix is opt-in: set E2EE_BROWSER_MATRIX=1 or run npm run test:e2e:e2ee',
  );

  test('enforces the runtime WebCrypto floor (WebKit expected unsupported)', async ({
    page,
    browser,
  }) => {
    const project = test.info().project.name;
    const browserVersion = browser.version();
    await openApp(page);
    const support = await readSupport(page, project, browserVersion);
    await assertBrowserFloor(support, project, browserVersion);

    // `requireE2eeSupport` is exactly what the bridge calls during E2EE init.
    const required = await page.evaluate(async (modulePath) => {
      const supportModule = (await import(modulePath)) as {
        requireE2eeSupport(): Promise<unknown>;
      };
      try {
        await supportModule.requireE2eeSupport();
        return 'ok';
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : 'unknown';
      }
    }, SUPPORT_MODULE);
    if (project === 'webkit') {
      expect(required).toBe('E2EE_UNSUPPORTED_BROWSER');
      return;
    }
    expect(required).toBe('ok');
    expect(support.primitives.x25519).toBe(true);
    expect(support.primitives.ed25519).toBe(true);
    expect(support.primitives.hkdfSha256).toBe(true);
    expect(support.primitives.aesGcm256).toBe(true);
  });

  test('matches the normative A/B/C/D/F/G KAT fetched from docs JSON', async ({
    page,
    browser,
  }) => {
    const project = test.info().project.name;
    const browserVersion = browser.version();
    await routeVectors(page);
    await openApp(page);
    const support = await readSupport(page, project, browserVersion);
    await assertBrowserFloor(support, project, browserVersion);

    const committed = readFileSync(VECTORS_PATH);
    const expectedSha256 = createHash('sha256').update(committed).digest('hex');
    const evidence = await fetchAndRunKat(page);

    await test.info().attach('kat-a-b-c-d-f-g.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });

    const failedIds = evidence.result.cases.filter((entry) => !entry.ok).map((entry) => entry.id);
    if (failedIds.some((id) => id.startsWith('A2-') || id.startsWith('B3-'))) {
      test.info().annotations.push({
        type: 'E2EE_ED25519_NON_NORMATIVE',
        description: `Engine is blocked for byte-exact Ed25519 KAT: ${failedIds.join(', ')}`,
      });
    }

    expect(evidence.sha256, 'the browser must fetch byte-identical docs vectors').toBe(
      expectedSha256,
    );
    expect(evidence.bytes).toBe(committed.byteLength);
    expect(evidence.vectorSetVersion).toBe(5);
    expect(evidence.sectionCounts).toMatchObject({
      'A-primitives': 4,
      'B-x3dh': 5,
      'C-kdf': 3,
      'D-aead': 3,
      'F-envelope': 2,
      'G-verification': 5,
    });
    expect(evidence.result.cases).toHaveLength(22);
    if (project === 'webkit') {
      // Expected-unsupported row: record the exact KAT failures that block the
      // engine, but do not turn the matrix into a silent green pass.
      const failed = evidence.result.cases.filter((entry) => !entry.ok).map((entry) => entry.id);
      test.info().annotations.push({
        type: 'E2EE_ED25519_NON_NORMATIVE',
        description: `WebKit is blocked by the byte-exact Ed25519 KAT: ${failed.join(', ')}`,
      });
      expect(failed.length).toBeGreaterThan(0);
      return;
    }
    expectNoFailures(evidence.result);
    expect(evidence.result.checks).toBeGreaterThanOrEqual(80);
  });

  test('rejects tampered envelope, AD, preamble and AEAD inputs', async ({ page, browser }) => {
    const project = test.info().project.name;
    const browserVersion = browser.version();
    await routeVectors(page);
    await openApp(page);
    await assertBrowserFloor(
      await readSupport(page, project, browserVersion),
      project,
      browserVersion,
    );

    const committed = readFileSync(VECTORS_PATH);
    const expectedSha256 = createHash('sha256').update(committed).digest('hex');
    const evidence = await fetchAndRunTamper(page);

    await test.info().attach('envelope-tamper.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });

    expect(evidence.sha256).toBe(expectedSha256);
    expect(evidence.result.cases).toHaveLength(10);
    expectNoFailures(evidence.result);
  });

  /**
   * Diagnostic, not a gate: the byte-exact KAT above is the gate. Some WebKit
   * builds implement Ed25519 with hedged (randomized) nonces, so a freshly
   * generated signature is valid but not byte-identical to RFC 8032, and their
   * empty-message path is broken. This test records which case applies; it
   * never accepts a signature that does not verify.
   */
  test('classifies generated Ed25519 signatures without weakening the KAT gate', async ({
    page,
    browser,
  }) => {
    const project = test.info().project.name;
    const browserVersion = browser.version();
    await routeVectors(page);
    await openApp(page);
    await assertBrowserFloor(
      await readSupport(page, project, browserVersion),
      project,
      browserVersion,
    );

    const evidence = await page.evaluate(
      async ({ url, edModulePath }) => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`vector fetch failed: HTTP ${response.status}`);
        const vectors = JSON.parse(await response.text()) as {
          sections: Array<{
            vectors: Array<{
              id: string;
              inputs?: Record<string, unknown>;
              expected?: Record<string, unknown>;
            }>;
          }>;
        };
        const find = (id: string) => {
          for (const section of vectors.sections) {
            for (const vector of section.vectors) {
              if (vector.id === id) return vector;
            }
          }
          throw new Error(`vector ${id} is missing`);
        };
        const toHex = (bytes: Uint8Array) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        const fromHex = (text: string) =>
          Uint8Array.from(text.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
        const ed = (await import(edModulePath)) as {
          ed25519KeyPairFromSeed(seed: Uint8Array): Promise<{
            privateKey: CryptoKey;
            publicKeyBytes: Uint8Array;
            publicKey: CryptoKey;
          }>;
          ed25519Sign(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array>;
          ed25519Verify(
            publicKey: CryptoKey | Uint8Array,
            message: Uint8Array,
            signature: Uint8Array,
          ): Promise<boolean>;
        };

        const a2 = find('A2-Ed25519-RFC8032');
        const b3 = find('B3-SPK-signature');
        if (!a2?.inputs || !a2.expected || !b3?.inputs || !b3.expected) {
          throw new Error('A2/B3 vector shape is unexpected');
        }

        const a2Pair = await ed.ed25519KeyPairFromSeed(fromHex(String(a2.inputs.private_seed)));
        const empty = new Uint8Array(0);
        const a2Signature = await ed.ed25519Sign(a2Pair.privateKey, empty);
        const a2Expected = fromHex(String(a2.expected.signature));

        const b3Pair = await ed.ed25519KeyPairFromSeed(fromHex(String(b3.inputs.signing_seed)));
        const b3Message = fromHex(String(b3.inputs.signed_message));
        const b3Expected = fromHex(String(b3.expected.signature_hex));
        const b3First = await ed.ed25519Sign(b3Pair.privateKey, b3Message);
        const b3Second = await ed.ed25519Sign(b3Pair.privateKey, b3Message);

        return {
          a2: {
            generatedSignatureVerifies: await ed.ed25519Verify(
              a2Pair.publicKey,
              empty,
              a2Signature,
            ),
            normativeSignatureVerifies: await ed.ed25519Verify(a2Pair.publicKey, empty, a2Expected),
            generatedEqualsNormative: toHex(a2Signature) === toHex(a2Expected),
          },
          b3: {
            generatedFirstVerifies: await ed.ed25519Verify(b3Pair.publicKey, b3Message, b3First),
            generatedSecondVerifies: await ed.ed25519Verify(b3Pair.publicKey, b3Message, b3Second),
            normativeSignatureVerifies: await ed.ed25519Verify(
              b3Pair.publicKey,
              b3Message,
              b3Expected,
            ),
            signaturesDeterministic: toHex(b3First) === toHex(b3Second),
            generatedEqualsNormative: toHex(b3First) === toHex(b3Expected),
            messageBytes: b3Message.length,
          },
        };
      },
      { url: VECTORS_URL, edModulePath: ED25519_MODULE },
    );

    // A hedged signature is still cryptographically valid; a non-verifying one
    // is a browser bug and blocks the row. The strict KAT remains the gate.
    expect(evidence.b3.generatedFirstVerifies).toBe(true);
    expect(evidence.b3.generatedSecondVerifies).toBe(true);
    expect(evidence.b3.normativeSignatureVerifies).toBe(true);
    expect(evidence.b3.messageBytes).toBeGreaterThan(0);

    const nonNormative =
      !evidence.b3.signaturesDeterministic ||
      !evidence.b3.generatedEqualsNormative ||
      !evidence.a2.generatedEqualsNormative ||
      !evidence.a2.generatedSignatureVerifies ||
      !evidence.a2.normativeSignatureVerifies;
    if (nonNormative) {
      test.info().annotations.push({
        type: 'E2EE_ED25519_NON_NORMATIVE',
        description:
          'Ed25519 signatures are valid but not RFC 8032 byte-exact; the byte-exact KAT row is blocked for this engine.',
      });
    }

    await test.info().attach('ed25519-behaviour.json', {
      body: JSON.stringify({ project, browserVersion, evidence }, null, 2),
      contentType: 'application/json',
    });
  });
});
