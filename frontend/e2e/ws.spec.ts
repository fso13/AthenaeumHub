import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type MockControls = {
  insertMessage(chatId: string, text: string): void;
  dropRealtime(code?: number): void;
  emitTyping(chatId: string, userId: string, ttlMs?: number): void;
};

const GROUP_CHAT = '44444444-4444-4444-8444-444444444444';

async function insertMessage(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ chatId, messageText }) => {
      const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
      controls?.insertMessage(chatId, messageText);
    },
    { chatId: GROUP_CHAT, messageText: text },
  );
}

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test('E3 mock WS: live message, reconnect without duplicates, axe', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page.getByTitle('Онлайн')).toBeVisible();

  const live = `E3 live ${Date.now()}`;
  await insertMessage(page, live);
  await expect(page.getByText(live, { exact: true })).toBeVisible();
  await expect(page.getByText(live, { exact: true })).toHaveCount(1);

  // Backpressure close 1013 is the documented reconnect path.
  await page.evaluate(() => {
    const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
    controls?.dropRealtime(1013);
  });
  await expect(page.getByText(/Нет live-обновлений/)).toBeVisible();
  await expect(page.getByLabel('Текст сообщения')).toBeVisible();

  const missed = `E3 after reconnect ${Date.now()}`;
  await insertMessage(page, missed);
  await expect(page.getByTitle('Онлайн')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(missed, { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(missed, { exact: true })).toHaveCount(1);
  await expect(page.getByText(live, { exact: true })).toHaveCount(1);

  await expectNoA11yViolations(page);
});

test('E3 mock WS: typing indicator is ephemeral and announced politely', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTitle('Онлайн')).toBeVisible();

  await page.evaluate(
    ({ chatId }) => {
      const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
      // TTL 350 ms keeps the assertion fast while using the real frame path.
      controls?.emitTyping(chatId, '77777777-7777-4777-8777-777777777777', 350);
    },
    { chatId: GROUP_CHAT },
  );

  const typing = page.getByText(/печатает…/);
  await expect(typing).toBeVisible();
  await expect(typing).toHaveCount(0, { timeout: 3_000 });
});
