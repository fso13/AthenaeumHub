import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type MockControls = {
  files: {
    setLimits(patch: Record<string, unknown>): void;
    setScanPolls(count: number): void;
    reset(): void;
  };
};

async function setScanPolls(page: Page, count: number): Promise<void> {
  await page.evaluate((value) => {
    const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
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

test('E4 mock files: picker → upload → send → card → download, axe', async ({ page }) => {
  page.on('popup', (popup) => void popup.close().catch(() => undefined));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Хранилище' })).toBeVisible();

  // Complete immediately after scan instead of waiting for the SCANNING poll.
  await setScanPolls(page, 0);

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: 'brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('E4 managed file'),
  });

  await expect(page.getByText('brief.txt')).toBeVisible();
  await expect(page.getByText('Готов к отправке', { exact: true })).toBeVisible();

  const textarea = page.getByLabel('Текст сообщения');
  await textarea.fill('Файл во вложении');
  await textarea.press('Enter');

  await expect(page.locator('.attachment-card')).toHaveCount(1);
  await expect(page.getByText('Проверен')).toBeVisible();
  await expect(page.getByText('Ссылка действует 5 минут')).toBeVisible();
  await expect(page.getByText('Файл во вложении')).toBeVisible();

  const downloadRequest = page.waitForRequest((request) => request.url().includes('/download-url'));
  await page.getByRole('button', { name: 'Скачать' }).click();
  const request = await downloadRequest;
  expect(request.url()).toContain('/attachments/');

  await expectNoA11yViolations(page);
});

test('E4 mock files: preflight 413 is shown before any upload', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugMockLimits?: Record<string, unknown> }).__krugMockLimits = {
      max_file_bytes: 16,
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'too-big.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024),
  });

  await expect(page.getByText('Файл больше лимита')).toBeVisible();
  await expect(page.getByText(/Максимум 16 Б/)).toBeVisible();
  await expect(page.getByText(/Не будет отправлен/)).toBeVisible();
  await expect(page.getByText('Готов к отправке')).toHaveCount(0);
});
