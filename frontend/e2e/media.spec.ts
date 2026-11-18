import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * 1×1 transparent PNG uploaded through the normal picker. The mock presigned
 * media handler (`src/mocks/handlers.ts`) serves the uploaded bytes back.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function setScanPolls(page: Page, count: number): Promise<void> {
  await page.evaluate((value) => {
    const controls = (
      window as Window & { __krugMocks?: { files: { setScanPolls(count: number): void } } }
    ).__krugMocks;
    controls?.files.setScanPolls(value);
  }, count);
}

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test('media preview: image lightbox, focus return, Esc and axe', async ({ page }) => {
  page.on('popup', (popup) => void popup.close().catch(() => undefined));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await setScanPolls(page, 0);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByText('Готов к отправке', { exact: true })).toBeVisible();

  await page.getByLabel('Текст сообщения').fill('Фото');
  await page.getByLabel('Текст сообщения').press('Enter');

  const image = page.getByAltText('Превью файла photo.png');
  await expect(image).toBeVisible();

  await image.click();
  const dialog = page.getByRole('dialog', { name: 'Просмотр: photo.png' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: 'Закрыть просмотр' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Открыть превью: photo.png' })).toBeFocused();

  await image.click();
  await expect(dialog).toBeVisible();
  await expectNoA11yViolations(page);

  // Dark theme keeps the dialog readable too.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // Backdrop click also closes the dialog.
  await page.locator('.media-lightbox').click({ position: { x: 8, y: 8 } });
  await expect(dialog).toBeHidden();
});
