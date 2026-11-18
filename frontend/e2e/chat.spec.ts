import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type MockControls = { failNextSend(count?: number): void };

async function expectNoA11yViolations(page: Page): Promise<void> {
  // Let the 180ms message-in animation settle: opacity changes effective contrast.
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test('managed chat: load → send → 500 retry', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page.getByRole('article').first()).toBeVisible();
  await expectNoA11yViolations(page);

  const textarea = page.getByLabel('Текст сообщения');
  const first = `E2E сообщение ${Date.now()}`;

  await textarea.fill(first);
  await textarea.press('Enter');
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  await expect(page.getByText('Отправляется…')).toHaveCount(0);

  await page.evaluate(() => {
    const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
    controls?.failNextSend(1);
  });

  const second = `${first} — с ошибкой`;
  await textarea.fill(second);
  await textarea.press('Enter');

  await expect(page.getByText('Не отправлено')).toBeVisible();
  await expect(page.getByText(second, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Повторить' }).click();

  await expect(page.getByText('Не отправлено')).toHaveCount(0);
  await expect(page.getByText(second, { exact: true })).toHaveCount(1);
});

test('dark theme passes the same WCAG AA audit', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page.getByRole('article').first()).toBeVisible();
  await expectNoA11yViolations(page);
});
