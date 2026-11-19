import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  disableAnimations,
  expectNoHorizontalScroll,
  finishUploads,
  openDashboard,
} from './d1-helpers';

/**
 * D1 UX fidelity v1.0.0: eyeball artefacts (no fragile pixel snapshots).
 *
 * The screenshots land in `test-results/d1-visual/` so the differences against
 * `design/dashboard/screenshots/*` can be reviewed by a human. The assertions
 * only pin the layout contract from DESIGN.md §5 (window 1548×1000, rail 72,
 * sidebar 272, details 304, header 64, flat feed without bubbles), which keeps
 * the test stable across font rendering and OS differences.
 */

const SHOT_DIR = 'd1-visual';

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${SHOT_DIR}-${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  expect(size.width).toBeGreaterThan(0);
  return path;
}

function boxWidth(value: number | null | undefined): number {
  return Math.round(value ?? 0);
}

test('desktop 1600×1150 light: window, rail, sidebar, details and flat feed', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNoHorizontalScroll(page);

  const app = await page.locator('.app').boundingBox();
  expect(app).not.toBeNull();
  expect(boxWidth(app?.width)).toBe(1548);
  expect(boxWidth(app?.height)).toBe(1000);

  const rail = await page.locator('.space-rail').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  const details = await page.locator('.details').boundingBox();
  const header = await page.locator('.chat-head').boundingBox();
  expect(boxWidth(rail?.width)).toBe(72);
  expect(boxWidth(sidebar?.width)).toBe(272);
  expect(boxWidth(details?.width)).toBe(304);
  expect(boxWidth(header?.height)).toBe(64);

  // Flat feed: no legacy bubbles left on desktop, author/text are in one column.
  await expect(page.locator('.messages .msg-text').first()).toBeVisible();
  await expect(page.locator('.bubble')).toHaveCount(0);
  await expect(page.locator('.messages .msg-row').first()).toBeVisible();

  const first = page.locator('.messages .msg-row').first();
  const avatar = await first.locator('.avatar').boundingBox();
  expect(boxWidth(avatar?.width)).toBe(38);

  await shot(page, testInfo, 'desktop-light');
});

test('desktop 1600×1150 dark: independent palette', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDashboard(page);
  await disableAnimations(page);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const app = await page.locator('.app').boundingBox();
  expect(boxWidth(app?.width)).toBe(1548);
  const surface = await page
    .locator('.app')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(surface).toBe('rgb(23, 25, 30)');

  await shot(page, testInfo, 'desktop-dark');
});

test('390×844 mobile: full-bleed shell, drawer and details sheet', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  const app = await page.locator('.app').boundingBox();
  expect(boxWidth(app?.width)).toBe(390);
  expect(boxWidth(app?.height)).toBe(844);
  await expect(page.locator('.space-rail')).toBeHidden();
  await expect(page.locator('.app__menu')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await shot(page, testInfo, 'mobile-chat');

  // Details is a bottom/right sheet on mobile and closes with Escape.
  await page.getByRole('button', { name: 'Показать сведения' }).click();
  const details = page.locator('.details--open');
  await expect(details).toBeVisible();
  const box = await details.boundingBox();
  expect(boxWidth(box?.width)).toBeLessThanOrEqual(340);
  await shot(page, testInfo, 'mobile-details');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();

  // Drawer keeps the same sidebar contract.
  await page.getByRole('button', { name: 'Открыть навигацию' }).click();
  await expect(page.getByRole('navigation', { name: 'Разделы пространства' })).toBeVisible();
  await shot(page, testInfo, 'mobile-drawer');
});

test('desktop direct chat: human profile in the details column', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  await page.getByRole('button', { name: 'Анна Петрова, Личный чат' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Анна Петрова' })).toBeVisible();
  await expect(page.locator('.messages .msg-row').first()).toBeVisible();
  const details = page.locator('.details--open');
  await expect(details).toBeVisible();
  await expect(details.locator('.chip').filter({ hasText: 'Личный чат' })).toBeVisible();
  await shot(page, testInfo, 'desktop-dm');
});

/* Minimal ID3v2.4 song so the flat feed can be checked with a real song card. */
function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function syncSafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function id3Frame(id: string, payload: number[]): number[] {
  return [...ascii(id), ...syncSafe(payload.length), 0, 0, ...payload];
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function id3Song(): Buffer {
  const body = [
    ...id3Frame('APIC', [0, ...ascii('image/png'), 0, 3, 0, ...COVER_PNG]),
    ...id3Frame('TIT2', [3, ...utf8('Тихие огни')]),
    ...id3Frame('TPE1', [3, ...utf8('Аквариум')]),
    ...id3Frame('TALB', [3, ...utf8('Радио Африка')]),
    ...id3Frame('TYER', [3, ...utf8('1983')]),
    ...id3Frame('TCON', [3, ...utf8('Rock')]),
  ];
  return Buffer.concat([
    Buffer.from([...ascii('ID3'), 4, 0, 0, ...syncSafe(body.length), ...body]),
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
  ]);
}

test('desktop media: flat feed keeps the song card and voice entry points', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);
  await finishUploads(page);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: id3Song() });
  await expect(page.getByText('Готов к отправке', { exact: true })).toBeVisible();
  const composer = page.getByLabel('Текст сообщения');
  await composer.fill('Песня');
  await composer.press('Enter');

  const card = page.locator('.song-card').last();
  await expect(card).toBeVisible();
  await expect(card.locator('.song-card__title')).toHaveText('Тихие огни');
  await expect(card.locator('.song-card__artist')).toHaveText(
    'Аквиум'.replace('Аквиум', 'Аквариум'),
  );
  await shot(page, testInfo, 'desktop-media');
});

test('desktop thread: right panel replaces the details column', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  const row = page.locator('#message-00000000-0000-4000-8000-000000000044');
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole('button', { name: /Начать тред/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Тред' });
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'desktop-thread');
});
