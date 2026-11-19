/**
 * E7-F7B — real two-device E2EE against the boxed stack.
 *
 * Gated by `E2EE_REAL=1` (see `playwright.e2ee-real.config.ts` and
 * `npm run test:e2e:e2ee:real`). It does **not** run in `npm run test:e2e` or in
 * the default Vite/mock suite: it needs the test-only compose overlay
 * (`deploy/docker-compose.e2ee-test.yml`), i.e. backend `KRUG_E2EE_ENABLED=true`
 * and a SPA built with `VITE_E2EE_ENABLED=true`.
 *
 * The flow is intentionally two real browser contexts (separate IndexedDB,
 * separate E2EE device identities):
 *   1. login via the BFF password form; the client registers a keyed device and
 *      uploads prekeys; `GET /devices` is asserted `e2ee_capable`;
 *   2. the fixture (documented below) creates a fresh E2EE workspace and adds
 *      the second real user through the E12 members API;
 *   3. both contexts open that workspace, A creates/opens a DIRECT E2EE chat,
 *      A sends, B decrypts, B replies, A decrypts;
 *   4. both reload and the plaintext is restored locally;
 *   5. a lost receiver session drives SESSION_RESET + re-encryption (R-15);
 *   6. server PostgreSQL is checked for envelopes-only rows and absence of the
 *      plaintext markers; WebSocket frames and backend logs are scanned in
 *      memory for the same markers.
 *
 * Clean-stack fixture (see `e2ee-real-fixture.ts`):
 *   - both fixture users are provisioned through the **real** BFF:
 *     `POST /auth/register` → TOTP from the Mailpit API → `POST /auth/verify-email`;
 *     an already verified user is reused. No pre-seeded `test@krug.local` /
 *     leftover `pickle-ui-…` account is required;
 *   - override identities with `E2EE_REAL_USER_A_EMAIL`/`_PASSWORD`/`_NAME` and
 *     the matching `..._B_...` variables; `E2EE_REAL_MAILPIT_URL` points at the
 *     Mailpit API (default `http://localhost:8025`);
 *   - a new `E2EE` workspace `E2EE F7B <timestamp>-<random>` per run, created with
 *     `POST /workspaces {security_mode:"E2EE"}`, and the second user added with
 *     `POST /workspaces/{id}/members {email, role:"MEMBER"}`. The unique name
 *     avoids slug collisions and the fresh workspace keeps DIRECT history empty
 *     so old messages cannot race R-15;
 *   - **destructive SQL is opt-in**: `E2EE_REAL_RESET=1` (alias
 *     `E2EE_REAL_ALLOW_DESTRUCTIVE=1`) enables the pre-login device reset,
 *     stale `E2EE F7B …` workspace cleanup and post-run workspace delete.
 *     Without the gate the spec executes no `UPDATE`/`DELETE`; a clean stack
 *     works because everything is created uniquely. The post-login
 *     `DELETE /devices/{deviceId}` API safety net only touches the fixture
 *     user's own devices and keeps exactly one;
 *   - DB/log assertions use `docker exec`/`docker logs`; set
 *     `E2EE_REAL_DB_CHECK=0` when the stack is remote (it skips DB/log checks and
 *     therefore the destructive SQL too; the post-login API cleanup still runs).
 *
 * No plaintext is written to traces/screenshots/video (disabled in the config),
 * to the report, or to stdout. Assertions about message text use element counts
 * rather than `toHaveText(marker)` so a failure does not echo the plaintext.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page, type Response } from '@playwright/test';

import {
  API,
  DB_CHECK,
  DESTRUCTIVE,
  KEYCHANGE,
  KEYCHANGE_ENABLED,
  RESET,
  USER_A,
  USER_B,
  WORKSPACE_PREFIX,
  backendLogs,
  cleanupStaleWorkspaces,
  countActiveVerifications,
  countAvailableOneTimePrekeys,
  countOf,
  deleteWorkspace,
  ensureFixtureUsers,
  requireUuid,
  resetFixtureDevices,
  restoreDeviceIdentity,
  rotateDeviceIdentity,
  snapshotDeviceIdentity,
  type DeviceKeySnapshot,
} from './e2ee-real-fixture';

const ENABLED = process.env.E2EE_REAL === '1';

interface ApiUser {
  readonly token: string;
  readonly userId: string;
}

interface BrowserUser extends ApiUser {
  readonly page: Page;
  readonly deviceId: string;
}

interface ApiDevice {
  id: string;
  status: string;
  e2ee_capable: boolean;
  one_time_prekeys_available: number;
  signed_prekey: unknown;
}

interface ApiWorkspace {
  id: string;
  name: string;
  security_mode: string;
  role: string;
}

interface ApiChat {
  id: string;
  type: string;
  security_mode: string;
  peer_id: string | null;
  peer_has_e2ee_capable_devices: boolean;
}

interface ApiMessage {
  id: string;
  seq: number;
  text: string | null;
  client_message_id: string | null;
  crypto: unknown;
  envelope_coverage?: {
    peer_devices: number;
    peer_covered: number;
    warning: string | null;
  } | null;
}

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

async function api(
  path: string,
  options: {
    readonly token: string;
    readonly deviceId: string;
    readonly method?: 'GET' | 'POST' | 'DELETE';
    readonly body?: unknown;
  },
): Promise<ApiResponse> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    'x-device-id': options.deviceId,
    'content-type': 'application/json',
  };
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function assertStatus(response: ApiResponse, allowed: readonly number[], what: string): void {
  if (!allowed.includes(response.status)) {
    throw new Error(`${what}: unexpected HTTP ${response.status}`);
  }
}

async function readAuth(page: Page): Promise<(ApiUser & { deviceId: string }) | null> {
  return page.evaluate(() => {
    try {
      const raw = sessionStorage.getItem('krug.auth.session');
      const deviceId = sessionStorage.getItem('krug.device.id');
      if (!raw || !deviceId) return null;
      const parsed = JSON.parse(raw) as {
        accessToken?: string;
        user?: { id?: string };
      };
      if (!parsed.accessToken || !parsed.user?.id) return null;
      return { token: parsed.accessToken, userId: parsed.user.id, deviceId };
    } catch {
      return null;
    }
  });
}

async function loginViaUi(page: Page, email: string, password: string): Promise<BrowserUser> {
  await page.goto('/');
  // A clean-stack user has no workspace yet, so the post-login state is the
  // onboarding screen, not the chat shell. Both prove that the keyed device was
  // registered in `runPasswordBootstrap`; `readAuth` below waits for its id.
  const chatButton = page.getByRole('button', { name: 'Создать чат' });
  const onboarding = page.getByRole('heading', { name: 'Создайте пространство' });
  const loggedIn = chatButton.or(onboarding);
  const rateLimited = page.getByText(/Слишком много попыток/);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    try {
      await expect(loggedIn).toBeVisible({ timeout: 30_000 });
      break;
    } catch (error) {
      if (attempt === 2 || !(await rateLimited.isVisible().catch(() => false))) throw error;
      // Auth BFF rate limit after repeated runs; back off and retry the same
      // credentials. This is test-harness resilience, not an auth bypass.
      await page.waitForTimeout(5_000);
    }
  }
  await expect(loggedIn).toBeVisible({ timeout: 60_000 });

  const resolved: { auth: (ApiUser & { deviceId: string }) | null } = { auth: null };
  await expect
    .poll(
      async () => {
        resolved.auth = await readAuth(page);
        return resolved.auth !== null;
      },
      { timeout: 60_000, intervals: [200, 500, 1000, 2000] },
    )
    .toBe(true);
  if (resolved.auth === null) {
    throw new Error('E2EE device id/token did not appear in sessionStorage');
  }
  return { ...resolved.auth, page };
}

/** Asserts that the bridge registered a keyed device and uploaded prekeys. */
async function expectKeyedDevice(user: BrowserUser): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const response = await api('/devices', {
            token: user.token,
            deviceId: user.deviceId,
          });
          if (response.status !== 200) return `http:${response.status}`;
          const device = ((response.json as { items?: ApiDevice[] }).items ?? []).find(
            (item) => item.id === user.deviceId,
          );
          if (!device) return 'missing';
          return `${device.e2ee_capable}:${device.one_time_prekeys_available}:${
            device.signed_prekey ? 'spk' : 'none'
          }`;
        },
        { timeout: 90_000, intervals: [200, 500, 1000, 2000] },
      )
      .toMatch(/^true:[1-9]\d*:spk$/);
  } catch {
    throw new Error(
      'E2EE device is not keyed/prekey-ready: the SPA must be built with ' +
        'VITE_E2EE_ENABLED=true and the backend with KRUG_E2EE_ENABLED=true ' +
        '(deploy/docker-compose.e2ee-test.yml overlay). If the fixture user already ' +
        'has MAX_ACTIVE_DEVICES from earlier crashed runs, re-run once with ' +
        'E2EE_REAL_RESET=1 on the disposable stack (opt-in destructive SQL).',
    );
  }

  const devices = await api('/devices', { token: user.token, deviceId: user.deviceId });
  assertStatus(devices, [200], 'GET /devices');
  const current = ((devices.json as { items?: ApiDevice[] }).items ?? []).find(
    (item) => item.id === user.deviceId,
  );
  expect(current?.e2ee_capable).toBe(true);
}

/** Revokes every ACTIVE device except the one this browser just registered. */
async function pruneOtherDevices(user: BrowserUser): Promise<void> {
  const list = await api('/devices', { token: user.token, deviceId: user.deviceId });
  assertStatus(list, [200], 'GET /devices');
  for (const device of (list.json as { items?: ApiDevice[] }).items ?? []) {
    if (device.status !== 'ACTIVE' || device.id === user.deviceId) continue;
    const deleted = await api(`/devices/${encodeURIComponent(device.id)}`, {
      method: 'DELETE',
      token: user.token,
      deviceId: user.deviceId,
    });
    if (![204, 404, 409].includes(deleted.status)) {
      throw new Error(`E2EE device cleanup failed: HTTP ${deleted.status}`);
    }
  }
  const after = await api('/devices', { token: user.token, deviceId: user.deviceId });
  assertStatus(after, [200], 'GET /devices after cleanup');
  const active = ((after.json as { items?: ApiDevice[] }).items ?? [])
    .filter((device) => device.status === 'ACTIVE')
    .map((device) => device.id);
  expect(active).toEqual([user.deviceId]);
}

/**
 * Creates a **fresh** E2EE workspace for this run. The name contains a timestamp
 * and a random suffix, so reruns never collide on the workspace slug and no
 * destructive cleanup is needed for the default (clean-stack) path. A fresh
 * workspace also keeps DIRECT history empty so old messages cannot race R-15.
 * With `E2EE_REAL_RESET=1` the caller deletes it in `finally`; without the gate
 * the workspace stays in the disposable test DB.
 */
async function createFixtureWorkspace(owner: BrowserUser, name: string): Promise<string> {
  const created = await api('/workspaces', {
    method: 'POST',
    token: owner.token,
    deviceId: owner.deviceId,
    body: { name, security_mode: 'E2EE' },
  });
  if (created.status === 409 && (created.json as { code?: string }).code === 'E2EE_DISABLED') {
    throw new Error(
      'Backend E2EE is disabled: start the stack with ' +
        'deploy/docker-compose.e2ee-test.yml (KRUG_E2EE_ENABLED=true)',
    );
  }
  assertStatus(created, [201], 'POST /workspaces (E2EE)');
  const workspace = created.json as ApiWorkspace;
  if (workspace.security_mode !== 'E2EE') {
    throw new Error(`fixture workspace "${name}" is not E2EE`);
  }
  return workspace.id;
}

async function addWorkspaceMember(
  owner: BrowserUser,
  workspaceId: string,
  memberEmail: string,
): Promise<void> {
  const added = await api(`/workspaces/${workspaceId}/members`, {
    method: 'POST',
    token: owner.token,
    deviceId: owner.deviceId,
    body: { email: memberEmail, role: 'MEMBER' },
  });
  // 409: already a member (a concurrent/manual fixture won the race).
  assertStatus(added, [201, 409], 'POST workspace member');
}

async function openWorkspace(
  page: Page,
  workspaceId: string,
  workspaceName: string,
): Promise<void> {
  await page.evaluate((id) => {
    try {
      localStorage.setItem('krug.workspace.id', id);
    } catch {
      // Storage is disabled only in exotic profiles; the reload then falls
      // back to the default workspace and the assertion below fails loudly.
    }
  }, workspaceId);
  await page.reload();
  await expect(page.locator('.brand__workspace')).toHaveText(workspaceName, {
    timeout: 60_000,
  });
  await expect(page.getByText(/Чатов: \d+ из \d+/)).toBeVisible({ timeout: 60_000 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createDirectChat(page: Page, peerName: string): Promise<ApiChat> {
  await page.getByRole('button', { name: 'Создать чат' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Личный чат' }).check();
  const peer = dialog.getByRole('radio', { name: new RegExp(escapeRegExp(peerName)) });
  await expect(peer).toBeVisible({ timeout: 30_000 });
  await peer.check();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/workspaces\/[^/]+\/chats$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole('button', { name: 'Создать чат' }).click();
  const response = await responsePromise;
  expect([200, 201]).toContain(response.status());
  const chat = (await response.json()) as ApiChat;
  expect(chat.type).toBe('DIRECT');
  expect(chat.security_mode).toBe('E2EE');
  expect(chat.peer_has_e2ee_capable_devices).toBe(true);
  return chat;
}

async function expectComposerReady(page: Page): Promise<void> {
  const composer = page.getByLabel('Текст сообщения');
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await expect(composer).toBeEnabled({ timeout: 60_000 });
}

/**
 * A send performed before the receiver's WebSocket subscription completes is
 * not lost forever (history has it), but it is not a live receive either. Wait
 * for the real "Онлайн" status so the next step proves WS fan-out + decrypt.
 */
async function expectRealtimeOnline(page: Page): Promise<void> {
  await expect(page.locator('.realtime-status')).toHaveText('Онлайн', { timeout: 60_000 });
}

async function sendE2eeText(
  page: Page,
  text: string,
): Promise<{ id: string; clientMessageId: string }> {
  const isSend = (url: string): boolean => /\/chats\/[^/]+\/messages$/.test(new URL(url).pathname);
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && isSend(request.url()),
  );
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && isSend(response.url()),
  );
  await page.getByLabel('Текст сообщения').fill(text);
  await page.getByLabel('Текст сообщения').press('Enter');
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  expect(response.status()).toBe(201);

  const payload = request.postDataJSON() as {
    text?: unknown;
    type?: unknown;
    envelopes?: unknown[];
    client_message_id?: unknown;
  };
  expect(payload.text).toBeUndefined();
  expect(payload.type).toBe('TEXT');
  expect(Array.isArray(payload.envelopes)).toBe(true);
  expect(payload.envelopes?.length ?? 0).toBeGreaterThanOrEqual(1);
  expect(payload.client_message_id).toBeTruthy();

  const message = (await response.json()) as ApiMessage;
  expect(message.text).toBeNull();
  expect(message.crypto).toBeNull();
  expect(message.client_message_id).toBeTruthy();
  expect(message.envelope_coverage?.peer_covered ?? 0).toBeGreaterThanOrEqual(1);
  return { id: message.id, clientMessageId: message.client_message_id as string };
}

/** Count-based visibility check; deliberately does not echo the plaintext. */
async function expectMessageVisible(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => page.getByText(text, { exact: true }).count(), {
      timeout: 45_000,
      intervals: [200, 500, 1000, 2000],
    })
    .toBeGreaterThan(0);
}

/** Attests the safety number from this verifier device via the real UI. */
async function verifyPeerFromSafetyDialog(page: Page): Promise<{
  status: number;
  verified: boolean;
  body: {
    device_id?: string;
    method?: string;
    vh_version?: number;
    safety_number_hash?: string;
    expected_key_generation?: number;
  };
}> {
  await page.getByRole('button', { name: 'Безопасность' }).click();
  const dialog = page.getByRole('dialog', { name: 'Код безопасности' });
  await expect(dialog).toBeVisible();
  const isVerification = (url: string): boolean =>
    /\/chats\/[^/]+\/keys\/verification$/.test(new URL(url).pathname);
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'PUT' && isVerification(request.url()),
  );
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && isVerification(response.url()),
  );
  await dialog.getByRole('button', { name: 'Сверить' }).click();
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  const body = request.postDataJSON() as {
    device_id?: string;
    method?: string;
    vh_version?: number;
    safety_number_hash?: string;
    expected_key_generation?: number;
  };
  const payload = (await response.json()) as { verified?: boolean };
  await expect(dialog.getByText('Сверено', { exact: true })).toBeVisible();
  await dialog
    .locator('.notification-prefs__actions')
    .getByRole('button', { name: 'Закрыть' })
    .click();
  await expect(dialog).toBeHidden();
  return { status: response.status(), verified: payload.verified === true, body };
}

async function expectSafetyStatus(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Безопасность' }).click();
  const dialog = page.getByRole('dialog', { name: 'Код безопасности' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  await dialog
    .locator('.notification-prefs__actions')
    .getByRole('button', { name: 'Закрыть' })
    .click();
  await expect(dialog).toBeHidden();
}

async function openSafetyNumber(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Безопасность' }).click();
  const dialog = page.getByRole('dialog', { name: 'Код безопасности' });
  await expect(dialog).toBeVisible();
  const code = dialog.locator('code').first();
  await expect(code).toHaveText(/^\d{5}(?: \d{5}){11}$/, { timeout: 30_000 });
  const value = (await code.textContent()) ?? '';
  await dialog
    .locator('.notification-prefs__actions')
    .getByRole('button', { name: 'Закрыть' })
    .click();
  await expect(dialog).toBeHidden();
  return value;
}

/**
 * Test-only fault injection for R-15: clears this device's Double Ratchet
 * sessions in IndexedDB. Identity keys, prekeys, pins and local copies stay
 * intact, so the client behaves exactly like a device that lost its session
 * state; the crypto/KAT paths are not weakened.
 */
async function clearE2eeSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('krug-e2ee');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

async function countE2eeSessions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('krug-e2ee');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction('sessions', 'readonly');
      const request = transaction.objectStore('sessions').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return count;
  });
}

/**
 * Session ids only (keys starting with `session:`). Records are sealed, so this
 * deliberately does not try to read peer keys: a stable id set is enough to
 * prove a blocked key change neither deletes nor overwrites the old session.
 */
async function readE2eeSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('krug-e2ee');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const transaction = database.transaction('sessions', 'readonly');
      const request = transaction.objectStore('sessions').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return keys
      .map((key) => String(key))
      .filter((key) => key.startsWith('session:'))
      .sort();
  });
}

test.describe('E7-F7B real two-device E2EE (Chromium/Firefox)', () => {
  test.skip(
    !ENABLED,
    'Real two-device E2EE needs E2EE_REAL=1 and the docker E2EE overlay (see deploy/README.md)',
  );
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test('two devices: keyed registration, DIRECT E2EE chat, send/receive, reload, DB/log/WS no-plaintext', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const pageErrors: Error[] = [];
    const wsFrames: string[] = [];
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    for (const page of [pageA, pageB]) {
      page.on('pageerror', (error) => pageErrors.push(error));
      page.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          // Memory only: never printed, never attached to the report.
          if (wsFrames.length < 2_000) wsFrames.push(String(frame.payload));
        });
      });
    }

    // Opt-in diagnostics: status codes only, never message bodies/plaintext.
    if (process.env.E2EE_REAL_DEBUG === '1') {
      for (const [label, page] of [
        ['A', pageA],
        ['B', pageB],
      ] as const) {
        page.on('response', (response) => {
          const path = new URL(response.url()).pathname;
          if (path.includes('realtime')) {
            console.warn(`${label} realtime ticket: HTTP ${response.status()}`);
          }
        });
        page.on('websocket', (socket) => {
          console.warn(`${label} ws opened`);
          socket.on('close', () => console.warn(`${label} ws closed`));
          socket.on('socketerror', () => console.warn(`${label} ws socket error`));
        });
        page.on('console', (message) => {
          if (message.type() === 'error') console.warn(`${label} console error: ${message.text()}`);
        });
      }
    }

    const logStart = Date.now();
    // Unique name: no slug collisions on reruns, no cleanup needed by default.
    const workspaceName = `${WORKSPACE_PREFIX} ${Date.now()}-${randomUUID().slice(0, 8)}`;
    const markerA = `f7b_a_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerB = `f7b_b_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerR15 = `f7b_r15_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerLost = `f7b_lost_${Date.now()}_${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    let chatId: string | null = null;
    let sentA: { id: string; clientMessageId: string } | null = null;
    let sentB: { id: string; clientMessageId: string } | null = null;
    let sentR15: Array<{ id: string }> = [];

    try {
      await test.step('fixture: BFF users via Mailpit, keyed devices, E2EE workspace + member', async () => {
        // Clean-stack provisioning: register/verify A and B through the real
        // BFF + Mailpit when absent, reuse them when a previous run created
        // them. No pre-seeded fixture account and no SQL user shortcut.
        const fixtureStates = await ensureFixtureUsers([USER_A, USER_B]);
        test.info().annotations.push({
          type: 'E2EE_FIXTURE_USERS',
          description:
            `registered/reused via BFF+Mailpit: ` +
            `A=${fixtureStates[0]?.source ?? 'missing'}, B=${fixtureStates[1]?.source ?? 'missing'}`,
        });

        if (DESTRUCTIVE) {
          // Opt-in only (E2EE_REAL_RESET=1): disposable stack, no live users.
          const revoked = resetFixtureDevices([USER_A.email, USER_B.email]);
          const cleaned = cleanupStaleWorkspaces();
          test.info().annotations.push({
            type: 'E2EE_REAL_RESET',
            description:
              `on: revoked ${revoked} active fixture device(s), deleted ${cleaned} ` +
              `stale ${WORKSPACE_PREFIX} row(s)`,
          });
        } else if (RESET) {
          test.info().annotations.push({
            type: 'E2EE_REAL_RESET',
            description: 'requested but E2EE_REAL_DB_CHECK=0; destructive SQL skipped',
          });
        } else {
          test.info().annotations.push({
            type: 'E2EE_REAL_RESET',
            description: 'off: no destructive SQL executed (no device reset, no workspace cleanup)',
          });
        }

        // Both real browser contexts register their own keyed device before
        // the chat can be created (the server requires a capable device on
        // both sides).
        const [browserA, browserB] = await Promise.all([
          loginViaUi(pageA, USER_A.email, USER_A.password),
          loginViaUi(pageB, USER_B.email, USER_B.password),
        ]);
        await expectKeyedDevice(browserA);
        await expectKeyedDevice(browserB);
        await pruneOtherDevices(browserA);
        await pruneOtherDevices(browserB);

        workspaceId = await createFixtureWorkspace(browserA, workspaceName);
        await addWorkspaceMember(browserA, workspaceId, USER_B.email);
        await openWorkspace(pageA, workspaceId, workspaceName);
        await openWorkspace(pageB, workspaceId, workspaceName);
      });

      await test.step('A creates/opens a DIRECT E2EE chat; B opens it', async () => {
        const chat = await createDirectChat(pageA, USER_B.name);
        chatId = chat.id;
        await expectComposerReady(pageA);
        await expectRealtimeOnline(pageA);

        // B had no chat at bootstrap time, so its realtime client was not
        // started. Reload is the documented "open on a second device" path: it
        // refreshes the chat list and loads the E2EE device keys.
        await pageB.reload();
        await expect(pageB.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        await expect(pageB.getByText(/Чатов: [1-9]\d* из \d+/)).toBeVisible({ timeout: 60_000 });
        await expectComposerReady(pageB);
        await expectRealtimeOnline(pageB);
      });

      await test.step('A sends; B decrypts; B replies; A decrypts', async () => {
        sentA = await sendE2eeText(pageA, markerA);
        await expectMessageVisible(pageA, markerA);
        await expectMessageVisible(pageB, markerA);

        sentB = await sendE2eeText(pageB, markerB);
        await expectMessageVisible(pageB, markerB);
        await expectMessageVisible(pageA, markerB);
      });

      await test.step('TOFU pin + safety number is a 60-digit per-device code', async () => {
        const safetyBefore = await openSafetyNumber(pageA);
        const safetyAfter = await openSafetyNumber(pageB);
        // Both sides compute the same pair code from the pinned fingerprints.
        expect(safetyBefore).toBe(safetyAfter);

        // P1-02: the ceremony is real, not a fake local flag. A attests via
        // PUT /chats/{id}/keys/verification; `verified` is scoped to A's
        // verifier device, so B's dialog still says "Не сверено".
        const attested = await verifyPeerFromSafetyDialog(pageA);
        expect(attested.status).toBe(201);
        expect(attested.verified).toBe(true);
        expect(attested.body).toMatchObject({
          method: 'MANUAL',
          vh_version: 2,
        });
        expect(attested.body.safety_number_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(attested.body.device_id).toBeTruthy();
        expect(attested.body.expected_key_generation).toBeGreaterThanOrEqual(1);
        await expectSafetyStatus(pageA, 'Сверено');
        await expectSafetyStatus(pageB, 'Не сверено');

        // Persistence: the attestation is server-side and scoped to A's
        // verifier device, so it survives a full reload of A.
        await pageA.reload();
        await expect(pageA.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        await expectComposerReady(pageA);
        await expectRealtimeOnline(pageA);
        await expectSafetyStatus(pageA, 'Сверено');
      });

      await test.step('reload restores both messages from local sealed copies', async () => {
        await pageA.reload();
        await expect(pageA.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        await expectComposerReady(pageA);
        await expectRealtimeOnline(pageA);
        await expectMessageVisible(pageA, markerA);
        await expectMessageVisible(pageA, markerB);

        await pageB.reload();
        await expect(pageB.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        await expectComposerReady(pageB);
        await expectRealtimeOnline(pageB);
        await expectMessageVisible(pageB, markerA);
        await expectMessageVisible(pageB, markerB);
      });

      let usedResetCatchUp = false;
      await test.step('R-15: a lost receiver session triggers SESSION_RESET and re-encryption', async () => {
        // Simulate a real lost-session failure without touching keys or crypto:
        // drop only this device's ratchet sessions, then reload so the app
        // processes history with no matching receiver state. History decryption
        // fails with NO_SESSION, B sends an encrypted SESSION_RESET, and A
        // re-encrypts the failed window in a fresh prekey session.
        const resetMessageIds: string[] = [];
        const onResponse = async (response: Response): Promise<void> => {
          if (
            response.request().method() === 'POST' &&
            /\/chats\/[^/]+\/messages$/.test(new URL(response.url()).pathname) &&
            response.status() === 201
          ) {
            const body = (await response.json()) as { id?: string };
            if (body.id) resetMessageIds.push(body.id);
          }
        };
        pageA.on('response', onResponse);
        let bPostsDuringR15 = 0;
        const onBPost = (response: Response): void => {
          if (
            response.request().method() === 'POST' &&
            /\/chats\/[^/]+\/messages$/.test(new URL(response.url()).pathname)
          ) {
            bPostsDuringR15 += 1;
          }
        };
        pageB.on('response', onBPost);
        try {
          // Let the previous decrypt loop finish, then clear twice: a receive
          // that committed between the two clears would otherwise restore a
          // session and make the history replay decrypt normally.
          await pageB.waitForTimeout(1_000);
          await clearE2eeSessions(pageB);
          await pageB.waitForTimeout(500);
          await clearE2eeSessions(pageB);
          await pageB.reload();
          await expect(pageB.locator('.brand__workspace')).toHaveText(workspaceName, {
            timeout: 60_000,
          });
          await expectComposerReady(pageB);
          await expectRealtimeOnline(pageB);

          // P1-01: history is restored from sealed incoming copies, not shown
          // as decrypt errors, and no SESSION_RESET is sent for rows that were
          // already delivered before the session was lost.
          await expectMessageVisible(pageB, markerA);
          await expectMessageVisible(pageB, markerB);
          await expect(pageB.getByText('Не удалось расшифровать сообщение')).toHaveCount(0);
          expect(bPostsDuringR15).toBe(0);
          expect(await countE2eeSessions(pageB)).toBe(0);

          // P1-01/P1-03: a *new* message has no sealed copy, so B must fail
          // with NO_SESSION and send an encrypted reset. The live frame may be
          // missed; A's sync/reload catch-up now processes it (P1-03).
          await sendE2eeText(pageA, markerLost);
          const resetCompleted = pageA.getByText('Сообщения переотправлены в новую сессию.');
          try {
            await expect(resetCompleted).toBeVisible({ timeout: 15_000 });
          } catch {
            usedResetCatchUp = true;
            if (process.env.E2EE_REAL_DEBUG === '1') {
              const debug = {
                bSessions: await countE2eeSessions(pageB),
                bPostsDuringR15,
                bDecryptErrors: await pageB.getByText('Не удалось расшифровать сообщение').count(),
                bBanners: (await pageB.locator('.banner').allInnerTexts())
                  .join(' | ')
                  .slice(0, 400),
                aBanners: (await pageA.locator('.banner').allInnerTexts())
                  .join(' | ')
                  .slice(0, 400),
                bRealtime: await pageB
                  .locator('.realtime-status')
                  .innerText()
                  .catch(() => '?'),
              };
              console.warn('R15_BANNER_DEBUG', JSON.stringify(debug));
            }
            // Product catch-up: runSync/resume.gap now decapsulates the missed
            // control without relying on a reload; a reload remains the last
            // resort if the live frame and sync both raced the reset.
            await pageA.reload();
            await expect(pageA.locator('.brand__workspace')).toHaveText(workspaceName, {
              timeout: 60_000,
            });
            await expectComposerReady(pageA);
            await expectRealtimeOnline(pageA);
            await expect(resetCompleted).toBeVisible({ timeout: 60_000 });
          }
          await expectMessageVisible(pageB, markerLost);
          // The already received marker stays visible from its copy.
          await expectMessageVisible(pageB, markerA);
          expect(await countE2eeSessions(pageB)).toBeGreaterThan(0);

          // The replacement session is live: a new message flows normally.
          await sendE2eeText(pageA, markerR15);
          await expectMessageVisible(pageB, markerR15);

          // G4b P1-01: reload the *sender* after R-15. The sealed local copy of
          // the re-encrypted original must be `superseded`, so A renders one
          // copy, not the original next to its replacement.
          await pageA.reload();
          await expect(pageA.locator('.brand__workspace')).toHaveText(workspaceName, {
            timeout: 60_000,
          });
          await expectComposerReady(pageA);
          await expectRealtimeOnline(pageA);
          for (const marker of [markerA, markerLost, markerR15]) {
            await expect
              .poll(async () => pageA.getByText(marker, { exact: true }).count(), {
                timeout: 60_000,
                intervals: [200, 500, 1000, 2000],
              })
              .toBe(1);
          }
          await expect
            .poll(async () => pageA.getByText(markerR15, { exact: true }).count(), {
              timeout: 60_000,
              intervals: [200, 500, 1000, 2000],
            })
            .toBe(1);
        } finally {
          pageA.off('response', onResponse);
          pageB.off('response', onBPost);
        }
        if (usedResetCatchUp) {
          test.info().annotations.push({
            type: 'R15_CATCH_UP_RELOAD',
            description:
              'A live SESSION_RESET was not observed within 15s; A reloaded and processed the reset from history',
          });
        }
        // One re-encrypted replacement (from the reset) plus the new message.
        expect(resetMessageIds.length).toBeGreaterThanOrEqual(2);
        sentR15 = resetMessageIds.map((id) => ({ id }));
      });

      await test.step('no plaintext in WS frames or backend logs', async () => {
        expect(wsFrames.length).toBeGreaterThan(0);
        for (const frame of wsFrames) {
          expect(
            frame.includes(markerA) ||
              frame.includes(markerB) ||
              frame.includes(markerR15) ||
              frame.includes(markerLost),
          ).toBe(false);
        }
        if (DB_CHECK) {
          const logs = backendLogs(logStart);
          expect(
            logs.includes(markerA) ||
              logs.includes(markerB) ||
              logs.includes(markerR15) ||
              logs.includes(markerLost),
          ).toBe(false);
        }
      });

      await test.step('server DB stores envelopes only, never the plaintext', async () => {
        if (!DB_CHECK) {
          test.info().annotations.push({
            type: 'E2EE_REAL_DB_CHECK',
            description: 'disabled: server DB/log assertions were not run',
          });
          return;
        }
        if (chatId === null || sentA === null || sentB === null) {
          throw new Error('chat/message ids are missing before the DB check');
        }
        const chat = requireUuid(chatId, 'chat id');
        const ids = [
          requireUuid(sentA.id, 'message A id'),
          requireUuid(sentB.id, 'message B id'),
          ...sentR15.map((message) => requireUuid(message.id, 'R-15 replacement id')),
        ];
        const idList = ids.map((id) => `'${id}'`).join(', ');

        // The stored rows are E2EE with no managed body/meta/sticker/reply.
        const rows = countOf(
          `SELECT count(*) FROM message.messages
             WHERE chat_id='${chat}' AND id IN (${idList})
               AND crypto_scheme='E2EE_PAIRWISE' AND type='TEXT'
               AND body_ciphertext IS NULL AND content_meta='{}'::jsonb
               AND sticker_id IS NULL AND reply_to_id IS NULL
               AND sender_device_id IS NOT NULL;`,
        );
        expect(rows).toBe(ids.length);

        // Whole-chat invariant: every stored message is E2EE with an envelope.
        const nonE2eeMessages = countOf(
          `SELECT count(*) FROM message.messages
             WHERE chat_id='${chat}'
               AND (crypto_scheme <> 'E2EE_PAIRWISE' OR type <> 'TEXT'
                    OR body_ciphertext IS NOT NULL OR content_meta <> '{}'::jsonb
                    OR sticker_id IS NOT NULL OR reply_to_id IS NOT NULL);`,
        );
        expect(nonE2eeMessages).toBe(0);
        const messagesWithoutEnvelope = countOf(
          `SELECT count(*) FROM message.messages m
             WHERE m.chat_id='${chat}'
               AND NOT EXISTS (
                 SELECT 1 FROM message.message_envelopes e WHERE e.message_id = m.id
               );`,
        );
        expect(messagesWithoutEnvelope).toBe(0);

        // No column of either message row contains the plaintext marker.
        const plaintextRows = countOf(
          `SELECT count(*) FROM message.messages m
             WHERE m.chat_id='${chat}'
               AND (strpos(row_to_json(m)::text, '${markerA}') > 0
                    OR strpos(row_to_json(m)::text, '${markerB}') > 0
                    OR strpos(row_to_json(m)::text, '${markerR15}') > 0);`,
        );
        expect(plaintextRows).toBe(0);

        // Envelopes are present and structurally valid (opaque ciphertext).
        const envelopes = countOf(
          `SELECT count(*) FROM message.message_envelopes
             WHERE message_id IN (${idList});`,
        );
        expect(envelopes).toBeGreaterThanOrEqual(2);
        const validEnvelopes = countOf(
          `SELECT count(*) FROM message.message_envelopes
             WHERE message_id IN (${idList})
               AND scheme='PAIRWISE_X3DH_DR'
               AND octet_length(session_id)=16
               AND octet_length(ciphertext) BETWEEN 272 AND 33040
               AND sender_device_id IS NOT NULL
               AND recipient_device_id IS NOT NULL;`,
        );
        expect(validEnvelopes).toBe(envelopes);

        // The first message of each direction is a prekey envelope.
        const prekeys = countOf(
          `SELECT count(*) FROM message.message_envelopes
             WHERE message_id IN (${idList}) AND prekey IS NOT NULL;`,
        );
        expect(prekeys).toBeGreaterThanOrEqual(1);

        // Envelope rows (header/prekey JSON included) never carry plaintext.
        const plaintextEnvelopes = countOf(
          `SELECT count(*) FROM message.message_envelopes e
             WHERE e.message_id IN (${idList})
               AND (strpos(row_to_json(e)::text, '${markerA}') > 0
                    OR strpos(row_to_json(e)::text, '${markerB}') > 0
                    OR strpos(row_to_json(e)::text, '${markerR15}') > 0);`,
        );
        expect(plaintextEnvelopes).toBe(0);
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await contextA.close();
      await contextB.close();
      if (DESTRUCTIVE && workspaceId !== null) {
        try {
          deleteWorkspace(workspaceId);
        } catch (error) {
          // A cleanup failure must not mask the scenario result; surface it in
          // the Playwright report and let the next reset run retry.
          test.info().annotations.push({
            type: 'E2EE_REAL_CLEANUP_FAILED',
            description: error instanceof Error ? error.message : 'workspace cleanup failed',
          });
        }
      }
    }
  });

  test('negative key change/TOFU: same device_id, new identity keys, send blocked until accept + re-verify', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      !KEYCHANGE,
      'Negative key-change/TOFU needs E2EE_REAL_KEYCHANGE=1 (test-only SQL mutation on a disposable stack)',
    );
    test.skip(
      !KEYCHANGE_ENABLED,
      'E2EE_REAL_KEYCHANGE=1 also needs E2EE_REAL_RESET=1 (destructive opt-in) and E2EE_REAL_DB_CHECK!=0',
    );
    test.setTimeout(300_000);

    const pageErrors: Error[] = [];
    const wsFrames: string[] = [];
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();
    for (const page of [pageA, pageB]) {
      page.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          // Memory only: never printed, never attached to the report.
          if (wsFrames.length < 2_000) wsFrames.push(String(frame.payload));
        });
      });
    }
    pageA.on('pageerror', (error) => pageErrors.push(error));

    const logStart = Date.now();
    const workspaceName = `${WORKSPACE_PREFIX} KEYCHANGE ${Date.now()}-${randomUUID().slice(0, 8)}`;
    const markerA = `f7b_kc_a_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerB = `f7b_kc_b_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerBlocked = `f7b_kc_blocked_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const markerAfter = `f7b_kc_after_${Date.now()}_${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    let chatId: string | null = null;
    let userA: BrowserUser | null = null;
    let userB: BrowserUser | null = null;
    let snapshot: DeviceKeySnapshot | null = null;
    let keyGenerationAfter = 0;
    let safetyBefore = '';
    let sessionsBefore: string[] = [];
    let sentAfter: { id: string; clientMessageId: string } | null = null;

    try {
      await test.step('fixture: BFF users, keyed devices, E2EE workspace + member', async () => {
        const fixtureStates = await ensureFixtureUsers([USER_A, USER_B]);
        test.info().annotations.push({
          type: 'E2EE_FIXTURE_USERS',
          description:
            `registered/reused via BFF+Mailpit: ` +
            `A=${fixtureStates[0]?.source ?? 'missing'}, B=${fixtureStates[1]?.source ?? 'missing'}`,
        });
        // The key-change mutation is destructive test-only SQL; the key-change
        // gate already requires this opt-in. Start from exactly one active
        // device per fixture user so the temporary source device is predictable.
        const revoked = resetFixtureDevices([USER_A.email, USER_B.email]);
        const cleaned = cleanupStaleWorkspaces();
        test.info().annotations.push({
          type: 'E2EE_KEYCHANGE_RESET',
          description:
            `on: revoked ${revoked} active fixture device(s), deleted ${cleaned} ` +
            `stale ${WORKSPACE_PREFIX} row(s) (disposable stack only)`,
        });

        const [authA, authB] = await Promise.all([
          loginViaUi(pageA, USER_A.email, USER_A.password),
          loginViaUi(pageB, USER_B.email, USER_B.password),
        ]);
        userA = authA;
        userB = authB;
        await expectKeyedDevice(authA);
        await expectKeyedDevice(authB);
        await pruneOtherDevices(authA);
        await pruneOtherDevices(authB);

        workspaceId = await createFixtureWorkspace(authA, workspaceName);
        await addWorkspaceMember(authA, workspaceId, USER_B.email);
        await openWorkspace(pageA, workspaceId, workspaceName);
        await openWorkspace(pageB, workspaceId, workspaceName);
      });

      await test.step('DIRECT E2EE chat, both directions, pre-change safety attestation', async () => {
        if (userA === null || userB === null) throw new Error('fixture users are missing');
        const chat = await createDirectChat(pageA, USER_B.name);
        chatId = chat.id;
        await expectComposerReady(pageA);
        await expectRealtimeOnline(pageA);

        await pageB.reload();
        await expect(pageB.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        await expect(pageB.getByText(/Чатов: [1-9]\d* из \d+/)).toBeVisible({ timeout: 60_000 });
        await expectComposerReady(pageB);
        await expectRealtimeOnline(pageB);

        await sendE2eeText(pageA, markerA);
        await expectMessageVisible(pageA, markerA);
        await expectMessageVisible(pageB, markerA);
        await sendE2eeText(pageB, markerB);
        await expectMessageVisible(pageB, markerB);
        await expectMessageVisible(pageA, markerB);

        // A attests B before the rotation: a server-side `verified` row exists
        // and must be revoked (not inherited) when key_generation changes.
        const attested = await verifyPeerFromSafetyDialog(pageA);
        expect(attested.status).toBe(201);
        expect(attested.verified).toBe(true);
        await expectSafetyStatus(pageA, 'Сверено');
        safetyBefore = await openSafetyNumber(pageA);
        sessionsBefore = await readE2eeSessionIds(pageA);
        expect(sessionsBefore.length).toBeGreaterThan(0);
        expect(countActiveVerifications(userA.deviceId, userB.deviceId)).toBe(1);
      });

      await test.step('test-only identity rotation on the same device_id', async () => {
        if (userA === null || userB === null) throw new Error('fixture users are missing');
        // Source device: a real keyed registration by B in a temporary
        // context. Its identity keys/binding signature and SPK are produced by
        // the production client, so the peer's binding/SPK verification sees
        // legitimate material; only the device_id reassignment is test SQL.
        const source = await loginViaUi(pageC, USER_B.email, USER_B.password);
        await expectKeyedDevice(source);
        snapshot = snapshotDeviceIdentity(userB.deviceId);
        const rotated = rotateDeviceIdentity(userB.deviceId, source.deviceId);
        expect(rotated.keyGeneration).toBe(snapshot.keyGeneration + 1);
        expect(rotated.source.fingerprint).not.toBe(snapshot.fingerprint);
        keyGenerationAfter = rotated.keyGeneration;
        test.info().annotations.push({
          type: 'E2EE_KEYCHANGE_MUTATION',
          description:
            `test-only SQL on disposable stack: device ${userB.deviceId.slice(0, 8)}… ` +
            `kept its id, adopted source device ${source.deviceId.slice(0, 8)}… identity keys/SPK, ` +
            `key_generation ${snapshot.keyGeneration}->${keyGenerationAfter}; ` +
            `old keys/SPK are restored in finally`,
        });
        // The rotation must reset server-side verification for the target.
        expect(countActiveVerifications(userA.deviceId, userB.deviceId)).toBe(0);
        expect(countAvailableOneTimePrekeys(userB.deviceId)).toBeGreaterThan(0);
      });

      await test.step('peer sees KEY_CHANGE_DETECTED, sending stays blocked, old messages remain', async () => {
        if (userA === null || userB === null) throw new Error('fixture users are missing');
        await pageA.reload();
        await expect(pageA.locator('.brand__workspace')).toHaveText(workspaceName, {
          timeout: 60_000,
        });
        const warning = pageA.getByText('Ключ безопасности изменился');
        await expect(warning).toBeVisible({ timeout: 60_000 });
        await expect(pageA.getByRole('button', { name: 'Принять новый ключ' })).toBeVisible();
        if (process.env.E2EE_REAL_DEBUG === '1') {
          console.warn(
            'KEYCHANGE_DEBUG',
            JSON.stringify({
              bubbles: await pageA.locator('.bubble').count(),
              rows: await pageA.locator('.msg-row').count(),
              countA: await pageA.getByText(markerA, { exact: true }).count(),
              countB: await pageA.getByText(markerB, { exact: true }).count(),
              textLengths: await pageA
                .locator('.bubble-text')
                .evaluateAll((nodes) => nodes.map((node) => node.textContent?.length ?? 0)),
              decryptErrors: await pageA.getByText('Не удалось расшифровать сообщение').count(),
              unavailable: await pageA.getByText('Недоступно на этом устройстве').count(),
              empty: await pageA.getByText('Пока нет сообщений').count(),
              banners: (await pageA.locator('.banner').allInnerTexts()).join(' | ').slice(0, 300),
            }),
          );
        }

        // Already decrypted history is not deleted by the warning.
        await expectMessageVisible(pageA, markerA);
        await expectMessageVisible(pageA, markerB);

        // Per-device safety number changes because the pinned fingerprint
        // changed; re-verification is required.
        const safetyAfter = await openSafetyNumber(pageA);
        expect(safetyAfter).not.toBe(safetyBefore);
        await expectSafetyStatus(pageA, 'Нужна повторная сверка');

        // Sending is blocked in the UI and no message request leaves the page.
        const sendButton = pageA.getByRole('button', { name: 'Отправить сообщение' });
        await expect(sendButton).toBeDisabled();
        await expect(pageA.locator('#composer-note')).toContainText(
          'Отправка в этом чате заблокирована.',
        );
        expect(await readE2eeSessionIds(pageA)).toEqual(sessionsBefore);

        const opkBeforeBlockedSend = countAvailableOneTimePrekeys(userB.deviceId);
        let postsDuringBlock = 0;
        const onPost = (response: Response): void => {
          if (
            response.request().method() === 'POST' &&
            /\/chats\/[^/]+\/messages$/.test(new URL(response.url()).pathname)
          ) {
            postsDuringBlock += 1;
          }
        };
        pageA.on('response', onPost);
        try {
          await pageA.getByLabel('Текст сообщения').fill(markerBlocked);
          await pageA.getByLabel('Текст сообщения').press('Enter');
          await pageA.waitForTimeout(1_500);
        } finally {
          pageA.off('response', onPost);
        }
        expect(postsDuringBlock).toBe(0);
        // Scope to rendered bubbles: the draft stays in the composer, but it
        // must never become a message row.
        expect(
          await pageA.locator('.bubble-text').getByText(markerBlocked, { exact: true }).count(),
        ).toBe(0);
        // A blocked send must not claim/consume the peer's one-time prekey.
        expect(countAvailableOneTimePrekeys(userB.deviceId)).toBe(opkBeforeBlockedSend);
        // The old session is neither deleted nor overwritten while blocked.
        expect(await readE2eeSessionIds(pageA)).toEqual(sessionsBefore);
      });

      await test.step('explicit accept + re-verify with the new key generation', async () => {
        if (userA === null || userB === null) throw new Error('fixture users are missing');
        await pageA.getByRole('button', { name: 'Принять новый ключ' }).click();
        await expect(pageA.getByText('Ключ безопасности изменился')).toBeHidden({
          timeout: 60_000,
        });
        // Acceptance resets local verification; only the real ceremony attests.
        await expectSafetyStatus(pageA, 'Не сверено');
        const attested = await verifyPeerFromSafetyDialog(pageA);
        expect(attested.status).toBe(201);
        expect(attested.verified).toBe(true);
        expect(attested.body.device_id).toBe(userB.deviceId);
        expect(attested.body.expected_key_generation).toBe(keyGenerationAfter);
        expect(attested.body.vh_version).toBe(2);
        await expectSafetyStatus(pageA, 'Сверено');
        expect(countActiveVerifications(userA.deviceId, userB.deviceId)).toBe(1);
      });

      await test.step('after accept a fresh prekey session carries the new send', async () => {
        if (userA === null || userB === null) throw new Error('fixture users are missing');
        const opkBeforeSend = countAvailableOneTimePrekeys(userB.deviceId);
        sentAfter = await sendE2eeText(pageA, markerAfter);
        await expectMessageVisible(pageA, markerAfter);

        // The pre-change session stays on disk, but it is not reused: a new
        // session id exists and the new envelope has a prekey block.
        const sessionsAfter = await readE2eeSessionIds(pageA);
        expect(sessionsAfter).toContain(sessionsBefore[0]);
        expect(sessionsAfter.length).toBeGreaterThan(sessionsBefore.length);
        expect(countAvailableOneTimePrekeys(userB.deviceId)).toBe(opkBeforeSend - 1);
        const sentId = requireUuid(sentAfter.id, 'post-accept message id');
        expect(
          countOf(
            `SELECT count(*) FROM message.message_envelopes
              WHERE message_id='${sentId}' AND prekey IS NOT NULL;`,
          ),
        ).toBe(1);
      });

      await test.step('no plaintext in WS frames / backend logs; DB envelopes-only', async () => {
        for (const frame of wsFrames) {
          expect(
            frame.includes(markerA) ||
              frame.includes(markerB) ||
              frame.includes(markerBlocked) ||
              frame.includes(markerAfter),
          ).toBe(false);
        }
        if (DB_CHECK) {
          const logs = backendLogs(logStart);
          expect(
            logs.includes(markerA) ||
              logs.includes(markerB) ||
              logs.includes(markerBlocked) ||
              logs.includes(markerAfter),
          ).toBe(false);
        }

        if (!DB_CHECK) {
          test.info().annotations.push({
            type: 'E2EE_REAL_DB_CHECK',
            description: 'disabled: server DB/log assertions were not run',
          });
          return;
        }
        if (chatId === null || userA === null || userB === null || sentAfter === null) {
          throw new Error('chat/user/message ids are missing before the DB check');
        }
        const chat = requireUuid(chatId, 'chat id');
        const verifier = requireUuid(userA.deviceId, 'verifier device id');
        const target = requireUuid(userB.deviceId, 'target device id');
        const sentId = requireUuid(sentAfter.id, 'post-accept message id');

        const nonE2ee = countOf(
          `SELECT count(*) FROM message.messages
            WHERE chat_id='${chat}'
              AND (crypto_scheme <> 'E2EE_PAIRWISE' OR type <> 'TEXT'
                   OR body_ciphertext IS NOT NULL OR content_meta <> '{}'::jsonb);`,
        );
        expect(nonE2ee).toBe(0);
        const withoutEnvelope = countOf(
          `SELECT count(*) FROM message.messages m
            WHERE m.chat_id='${chat}'
              AND NOT EXISTS (SELECT 1 FROM message.message_envelopes e WHERE e.message_id=m.id);`,
        );
        expect(withoutEnvelope).toBe(0);
        const plaintext = countOf(
          `SELECT count(*) FROM message.messages m
            WHERE m.chat_id='${chat}'
              AND (strpos(row_to_json(m)::text, '${markerA}') > 0
                   OR strpos(row_to_json(m)::text, '${markerB}') > 0
                   OR strpos(row_to_json(m)::text, '${markerBlocked}') > 0
                   OR strpos(row_to_json(m)::text, '${markerAfter}') > 0);`,
        );
        expect(plaintext).toBe(0);
        const plaintextEnvelopes = countOf(
          `SELECT count(*) FROM message.message_envelopes e
            WHERE e.message_id='${sentId}'
              AND (strpos(row_to_json(e)::text, '${markerAfter}') > 0
                   OR strpos(row_to_json(e)::text, '${markerBlocked}') > 0);`,
        );
        expect(plaintextEnvelopes).toBe(0);
        expect(
          countOf(
            `SELECT count(*) FROM auth.devices
              WHERE id='${target}' AND key_generation=${keyGenerationAfter};`,
          ),
        ).toBe(1);
        expect(countActiveVerifications(verifier, target)).toBe(1);
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await contextC.close();
      await contextA.close();
      await contextB.close();
      if (snapshot !== null) {
        try {
          restoreDeviceIdentity(snapshot);
        } catch (error) {
          test.info().annotations.push({
            type: 'E2EE_KEYCHANGE_RESTORE_FAILED',
            description: error instanceof Error ? error.message : 'device identity restore failed',
          });
        }
      }
      if (DESTRUCTIVE && workspaceId !== null) {
        try {
          deleteWorkspace(workspaceId);
        } catch (error) {
          test.info().annotations.push({
            type: 'E2EE_REAL_CLEANUP_FAILED',
            description: error instanceof Error ? error.message : 'workspace cleanup failed',
          });
        }
      }
    }
  });
});
