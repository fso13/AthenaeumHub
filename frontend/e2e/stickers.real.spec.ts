import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E5-F real smoke against backend E5-B on 8081 (dev profile, seeded packs).
 * Run with:
 *   PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
 *     npx playwright test --config playwright.real.config.ts stickers.real.spec.ts
 */

const API = 'http://localhost:8081/api/v1';
const KRUG_FIRST_ALT = 'Круг — стикер 1';

interface Session {
  access_token: string;
  device: { id: string };
  chat: { id: string };
}

async function devSession(request: APIRequestContext): Promise<Session> {
  const response = await request.post(`${API}/dev/session`, { data: {} });
  expect(response.status()).toBe(200);
  return (await response.json()) as Session;
}

function authHeaders(session: Session): Record<string, string> {
  return {
    Authorization: `Bearer ${session.access_token}`,
    'X-Device-Id': session.device.id,
  };
}

/** Favorites are server-side; clear leftovers so the smoke is repeatable. */
async function clearFavorites(request: APIRequestContext, session: Session): Promise<void> {
  const response = await request.get(`${API}/sticker-packs?chat_id=${session.chat.id}`, {
    headers: authHeaders(session),
  });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    items: Array<{ stickers: Array<{ id: string; favorite: boolean }> }>;
  };
  for (const pack of payload.items) {
    for (const sticker of pack.stickers) {
      if (!sticker.favorite) continue;
      const removed = await request.delete(`${API}/stickers/${sticker.id}/favorite`, {
        headers: authHeaders(session),
      });
      expect(removed.status()).toBe(204);
    }
  }
}

async function openPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Стикеры' }).click();
  await expect(page.getByRole('dialog', { name: 'Стикеры' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Круг' })).toBeVisible();
}

test('E5 real: picker → favorite → send STICKER → history after reload → assets', async ({
  page,
  request,
}) => {
  const session = await devSession(request);
  await clearFavorites(request, session);

  await page.goto('/');
  await expect(page.getByLabel('Текст сообщения')).toBeVisible({ timeout: 20_000 });

  // Frontend really serves the seeded PNG paths.
  for (const path of [
    '/stickers/krug/01.png',
    '/stickers/cats/01.png',
    '/stickers/krug/cover.png',
  ]) {
    const asset = await request.get(`http://127.0.0.1:5180${path}`);
    expect(asset.status(), path).toBe(200);
    expect(asset.headers()['content-type']).toContain('image/png');
    const bytes = await asset.body();
    expect(bytes.readUInt32BE(16), `${path} width`).toBe(512);
    expect(bytes.readUInt32BE(20), `${path} height`).toBe(512);
  }

  await openPicker(page);
  await page.getByRole('tab', { name: 'Круг' }).click();
  const favorite = page.getByRole('button', {
    name: `Добавить в избранное: ${KRUG_FIRST_ALT}`,
  });
  await expect(favorite).toBeVisible();
  await favorite.click();
  await expect(
    page.getByRole('button', { name: `Убрать из избранного: ${KRUG_FIRST_ALT}` }),
  ).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Избранное' }).click();
  const sendButton = page.getByRole('button', {
    name: `Отправить стикер: ${KRUG_FIRST_ALT}`,
  });
  await expect(sendButton).toBeVisible();

  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== 'POST') return false;
    if (!new URL(request.url()).pathname.endsWith('/messages')) return false;
    try {
      return request.postDataJSON()?.type === 'STICKER';
    } catch {
      return false;
    }
  });
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST') return false;
    if (!new URL(response.url()).pathname.endsWith('/messages')) return false;
    try {
      return response.request().postDataJSON()?.type === 'STICKER';
    } catch {
      return false;
    }
  });

  await sendButton.click();
  const sendRequest = await requestPromise;
  const body = sendRequest.postDataJSON() as {
    client_message_id: string;
    type: string;
    sticker_id: string;
    text?: string | null;
    attachment_ids?: string[];
  };
  expect(body.type).toBe('STICKER');
  expect(body.sticker_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.text ?? null).toBeNull();
  expect(body.attachment_ids ?? []).toEqual([]);

  const sendResponse = await responsePromise;
  expect(sendResponse.status()).toBe(201);
  const sent = (await sendResponse.json()) as {
    type: string;
    text: string | null;
    sticker_id: string;
    sticker: { alt: string; url: string };
  };
  expect(sent.type).toBe('STICKER');
  expect(sent.text).toBeNull();
  expect(sent.sticker_id).toBe(body.sticker_id);
  expect(sent.sticker.alt).toBe(KRUG_FIRST_ALT);
  expect(sent.sticker.url).toBe('/stickers/krug/01.png');

  const rendered = page.getByRole('img', { name: KRUG_FIRST_ALT }).last();
  await expect(rendered).toBeVisible({ timeout: 10_000 });
  expect(await rendered.evaluate((element) => Boolean(element.closest('.bubble')))).toBe(false);

  await page.reload();
  await expect(page.getByLabel('Текст сообщения')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('img', { name: KRUG_FIRST_ALT }).first()).toBeVisible({
    timeout: 20_000,
  });

  // Unfavorite through the UI (also exercises DELETE against the real backend).
  await openPicker(page);
  await page.getByRole('tab', { name: 'Круг' }).click();
  await page.getByRole('button', { name: `Убрать из избранного: ${KRUG_FIRST_ALT}` }).click();
  await expect(
    page.getByRole('button', { name: `Добавить в избранное: ${KRUG_FIRST_ALT}` }),
  ).toHaveAttribute('aria-pressed', 'false');
});

function setPackStatus(packId: string, status: 'ACTIVE' | 'DISABLED'): void {
  execFileSync(
    'docker',
    [
      'exec',
      'krug-postgres',
      'psql',
      '-U',
      'krug_migrator',
      '-d',
      'krug',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `UPDATE sticker.sticker_packs SET status='${status}' WHERE id='${packId}';`,
    ],
    { stdio: 'ignore' },
  );
}

/**
 * Requires E5_DISABLED_PACK=1 and docker access to the dev PostgreSQL.
 * Mutates only the seeded pack status and restores it in `finally`.
 */
test('E5 real: disabled pack 409 hides the pack but keeps old stickers', async ({ page }) => {
  test.skip(
    process.env.E5_DISABLED_PACK !== '1',
    'Set E5_DISABLED_PACK=1 with docker access to the dev PostgreSQL',
  );
  const krugPackId = '3a7f2fdc-306b-53c8-926d-77d90bcea67e';

  await page.goto('/');
  await expect(page.getByLabel('Текст сообщения')).toBeVisible({ timeout: 20_000 });
  await openPicker(page);
  await page.getByRole('tab', { name: 'Круг' }).click();

  try {
    setPackStatus(krugPackId, 'DISABLED');
    await page.getByRole('button', { name: `Отправить стикер: ${KRUG_FIRST_ALT}` }).click();
    await expect(page.getByText('Набор стикеров отключён', { exact: true })).toBeVisible();
    await expect(
      page.locator('article[data-sticker-outgoing="true"][data-outgoing-status="failed"]'),
    ).toHaveCount(1);
    // Previously sent stickers keep rendering from history even though the
    // pack is disabled; only new sends are rejected.
    await expect(page.getByRole('img', { name: KRUG_FIRST_ALT }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Стикеры' }).click();
    await expect(page.getByRole('dialog', { name: 'Стикеры' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Круг' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Коты' })).toBeVisible();
    await expect(page.getByText(/Набор «Круг» отключён/)).toBeVisible();
  } finally {
    setPackStatus(krugPackId, 'ACTIVE');
  }
});
