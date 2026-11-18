import { expect, test } from '@playwright/test';

/**
 * E4 real file smoke: dev backend on 8081 with S3-compatible storage on 9002.
 * Run with the real config:
 *   PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
 *     npx playwright test --config playwright.real.config.ts files.real.spec.ts
 */
test.skip(
  process.env.E4_FILE_REAL !== '1',
  'Set E4_FILE_REAL=1 with backend 8081 + S3-compatible storage on 9002',
);

test('E4 real files: upload → ready → send → attachment card', async ({ page }) => {
  await page.goto('/');

  const input = page.locator('#file-input');
  await expect(input).toHaveCount(1, { timeout: 20_000 });

  const name = `e4-real-${Date.now()}.txt`;
  await input.setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('E4 real upload from Playwright\n'),
  });

  await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Готов к отправке')).toBeVisible({ timeout: 30_000 });

  const messageText = `E4 real file ${Date.now()}`;
  const composer = page.getByLabel('Текст сообщения');
  await composer.fill(messageText);
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();

  const message = page.locator('article').filter({ hasText: messageText });
  await expect(message).toBeVisible({ timeout: 20_000 });
  await expect(message.getByText(name, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(message.getByText('Проверен')).toBeVisible({ timeout: 20_000 });
  await expect(message.getByRole('button', { name: 'Скачать' })).toBeVisible();
});
