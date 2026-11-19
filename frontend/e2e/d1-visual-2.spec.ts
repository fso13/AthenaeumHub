import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DIRECT_CHAT_NAME,
  disableAnimations,
  expectNoHorizontalScroll,
  finishUploads,
  goToView,
  openDashboard,
} from './d1-helpers';

/**
 * D1 UX fidelity 2 — human-review artefacts for pages and modals.
 *
 * No pixel snapshots: the assertions pin the sizing contract from DESIGN.md
 * (page header 64, modal widths 540/820, header 58, r18) and the screenshots
 * land in `visual-review/fidelity-2` for an eyeball diff against
 * `design/dashboard/screenshots/*`.
 */

const OUT_DIR = path.resolve('visual-review', 'fidelity-2');
mkdirSync(OUT_DIR, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: 'disabled' });
}

function widthOf(value: number | null | undefined): number {
  return Math.round(value ?? 0);
}

async function expectPageContract(page: Page): Promise<void> {
  const head = await page.locator('.page-head').boundingBox();
  expect(widthOf(head?.height)).toBe(64);
  await expectNoHorizontalScroll(page);
}

test('1600 light: overview/files/plugins/security/settings pages', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  await goToView(page, 'Обзор');
  await expectPageContract(page);
  const stats = page.locator('.stat-grid .stat');
  await expect(stats).toHaveCount(4);
  const statBoxes = await stats.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().width),
  );
  expect(statBoxes.every((width) => width > 200)).toBe(true);
  await shot(page, 'pages-overview-light');

  await goToView(page, 'Файлы');
  await expectPageContract(page);
  await expect(page.locator('.file-head')).toBeVisible();
  const head = await page.locator('.page-head').boundingBox();
  expect(widthOf(head?.width)).toBeGreaterThan(1000);
  await shot(page, 'pages-files-light');

  await goToView(page, 'Плагины');
  await expectPageContract(page);
  await expect(page.locator('.plugin-card')).toHaveCount(6);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await shot(page, 'pages-plugins-light');

  await goToView(page, 'Защита');
  await expectPageContract(page);
  await expect(page.locator('.mode-card')).toBeVisible();
  await shot(page, 'pages-security-light');

  await goToView(page, 'Настройки');
  await expectPageContract(page);
  expect(await page.locator('.settings-nav button').count()).toBeGreaterThanOrEqual(5);
  const nav = await page.locator('.settings-nav').boundingBox();
  expect(widthOf(nav?.width)).toBe(190);
  await page.getByRole('button', { name: 'Внешний вид' }).click();
  await shot(page, 'pages-settings-light');
});

test('1600 dark: overview, files and settings', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDashboard(page);
  await disableAnimations(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await goToView(page, 'Обзор');
  await expectPageContract(page);
  await shot(page, 'pages-overview-dark');

  await goToView(page, 'Файлы');
  await expectPageContract(page);
  await shot(page, 'pages-files-dark');

  await goToView(page, 'Плагины');
  await expectPageContract(page);
  await shot(page, 'pages-plugins-dark');

  await goToView(page, 'Защита');
  await expectPageContract(page);
  await shot(page, 'pages-security-dark');

  await goToView(page, 'Настройки');
  await expectPageContract(page);
  await shot(page, 'pages-settings-dark');

  // Modals in the dark palette.
  await page.getByRole('button', { name: 'К чатам' }).click();
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.locator('.modal.profile-dialog')).toBeVisible();
  await shot(page, 'modal-profile-dark');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'О чате' }).click();
  await expect(page.locator('.modal.chat-settings-dialog')).toBeVisible();
  await shot(page, 'modal-chat-settings-dark');
});

test('1600: profile 540 and chat settings 820 with 58 px headers', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  await page.getByRole('button', { name: 'Профиль' }).click();
  const profile = page.locator('.modal.profile-dialog');
  await expect(profile).toBeVisible();
  const profileBox = await profile.boundingBox();
  expect(widthOf(profileBox?.width)).toBe(540);
  const profileHead = await profile.locator('.modal-head').boundingBox();
  expect(widthOf(profileHead?.height)).toBe(58);
  const radius = await profile.evaluate((element) => getComputedStyle(element).borderRadius);
  expect(radius).toBe('18px');
  await shot(page, 'modal-profile-light');
  await page.keyboard.press('Escape');
  await expect(profile).toBeHidden();

  await page.getByRole('button', { name: 'О чате' }).click();
  const settings = page.locator('.modal.chat-settings-dialog');
  await expect(settings).toBeVisible();
  const settingsBox = await settings.boundingBox();
  expect(widthOf(settingsBox?.width)).toBe(820);
  const settingsHead = await settings.locator('.modal-head').boundingBox();
  expect(widthOf(settingsHead?.height)).toBe(58);
  await expect(settings.getByRole('tab')).toHaveCount(4);
  await shot(page, 'modal-chat-settings-light');
  await settings.getByRole('tab', { name: 'Участники' }).click();
  await shot(page, 'modal-chat-settings-members-light');
});

test('390: pages and modals become full-height sheets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);

  await goToView(page, 'Обзор');
  await expectPageContract(page);
  await expect(page.locator('.stat-grid .stat')).toHaveCount(4);
  await shot(page, 'mobile-overview');

  await goToView(page, 'Файлы');
  await expectPageContract(page);
  await expect(page.locator('.file-head')).toBeHidden();
  await shot(page, 'mobile-files');

  await goToView(page, 'Настройки');
  await expectPageContract(page);
  await expect(page.locator('.settings-nav')).toBeVisible();
  await shot(page, 'mobile-settings');

  // Profile sheet from the drawer footer.
  await page.getByRole('button', { name: 'К чатам' }).click();
  await page.getByRole('button', { name: 'Открыть навигацию' }).click();
  await page.getByRole('button', { name: 'Профиль' }).click();
  const profile = page.locator('.modal.profile-dialog');
  await expect(profile).toBeVisible();
  const profileBox = await profile.boundingBox();
  expect(widthOf(profileBox?.width)).toBeLessThanOrEqual(390);
  expect(widthOf(profileBox?.height)).toBe(844);
  await shot(page, 'mobile-profile');
  await page.keyboard.press('Escape');
  await expect(profile).toBeHidden();

  // Chat settings sheet from the header (we are back on the chat surface).
  await page.getByRole('button', { name: 'О чате' }).click();
  const settings = page.locator('.modal.chat-settings-dialog');
  await expect(settings).toBeVisible();
  const settingsBox = await settings.boundingBox();
  expect(widthOf(settingsBox?.width)).toBeLessThanOrEqual(390);
  await expect(settings.getByRole('tab')).toHaveCount(4);
  await shot(page, 'mobile-chat-settings');
});

test('details attachment grid comes from real loaded attachments', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1150 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openDashboard(page);
  await disableAnimations(page);
  await finishUploads(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'review-grid.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.getByText('Готов к отправке', { exact: true })).toBeVisible();
  const composer = page.getByLabel('Текст сообщения');
  await composer.fill('Вложение для панели');
  await composer.press('Enter');

  await expect(page.locator('.details--open')).toBeVisible();
  await expect(page.locator('.media-grid .media-tile')).toHaveCount(1);
  await expect(page.locator('.media-tile__label')).toHaveText('PNG');
  await shot(page, 'details-attachments-light');

  // DIRECT keeps the human profile and the «Личный чат» chip.
  await page.getByRole('button', { name: `${DIRECT_CHAT_NAME}, Личный чат` }).click();
  await expect(page.getByRole('heading', { level: 1, name: DIRECT_CHAT_NAME })).toBeVisible();
  await expect(
    page.locator('.details--open .chip').filter({ hasText: 'Личный чат' }),
  ).toBeVisible();
  await expect(page.locator('.details--open .profile-cover__img')).toHaveAttribute(
    'src',
    '/covers/cover-dm.svg',
  );
  await shot(page, 'details-direct-light');
});
