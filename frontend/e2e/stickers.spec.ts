import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const KRUG_PACK_ID = 'a1111111-1111-4111-8111-111111111111';

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function openPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Стикеры' }).click();
  await expect(page.getByRole('dialog', { name: 'Стикеры' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Сова' })).toBeVisible();
}

test('sticker picker: history, search, favorite, send and reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  // E5-AC-03: a sticker from history renders after reload as an image, no bubble.
  const historySticker = page.getByRole('img', { name: 'Сова: готово' });
  await expect(historySticker).toBeVisible();
  expect(await historySticker.evaluate((element) => Boolean(element.closest('.bubble')))).toBe(
    false,
  );

  await openPicker(page);
  await page.getByRole('tab', { name: 'Сова' }).click();
  await expectNoA11yViolations(page);

  const search = page.getByLabel('Поиск по стикерам');
  await search.fill('спасибо');
  await expect(page.getByRole('button', { name: 'Отправить стикер: Сова: спасибо' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отправить стикер: Сова: привет' })).toHaveCount(0);
  await search.fill('');

  await page.getByRole('button', { name: 'Добавить в избранное: Сова: привет' }).click();
  await expect(
    page.getByRole('button', { name: 'Убрать из избранного: Сова: привет' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Избранное' }).click();
  await expect(page.getByRole('button', { name: 'Отправить стикер: Сова: привет' })).toBeVisible();

  await page.getByRole('button', { name: 'Отправить стикер: Сова: привет' }).click();
  const sent = page.getByRole('img', { name: 'Сова: привет' });
  await expect(sent).toBeVisible();
  await expect(page.getByText('Отправляется…')).toHaveCount(0);
  expect(await sent.evaluate((element) => Boolean(element.closest('.bubble')))).toBe(false);
  await expectNoA11yViolations(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Сова: готово' })).toBeVisible();

  // Recent is local (IndexedDB), so it survives the reload; server-side mock
  // state does not, which is exactly the E5-D-03 split.
  await openPicker(page);
  await page.getByRole('tab', { name: 'Недавние' }).click();
  await expect(page.getByRole('button', { name: 'Отправить стикер: Сова: привет' })).toBeVisible();
});

test('disabled pack blocks sticker sending and is hidden from the picker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await openPicker(page);
  await page.getByRole('tab', { name: 'Сова' }).click();

  await page.evaluate((packId) => {
    window.__krugMocks?.forceSendError({
      status: 409,
      code: 'STICKER_PACK_DISABLED',
      message: 'Sticker pack is disabled',
      details: { pack_id: packId, status: 'DISABLED' },
    });
  }, KRUG_PACK_ID);

  await page.getByRole('button', { name: 'Отправить стикер: Сова: привет' }).click();
  await expect(page.getByText('Набор стикеров отключён', { exact: true })).toBeVisible();
  await expect(
    page.locator('article[data-sticker-outgoing="true"][data-outgoing-status="failed"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('article:not([data-outgoing-status]) img[alt="Сова: привет"]'),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Стикеры' }).click();
  await expect(page.getByRole('dialog', { name: 'Стикеры' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Сова' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Коты' })).toBeVisible();
  await expect(page.getByText(/Набор «Сова» отключён/)).toBeVisible();
  await expectNoA11yViolations(page);
});
