import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type MockControls = {
  chats: {
    forceCreateError(
      error: {
        status: number;
        code: string;
        message: string;
        details?: Record<string, unknown>;
      } | null,
    ): void;
  };
};

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test('chat creation: + → GROUP name → open the new chat', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  await page.getByRole('button', { name: 'Создать чат' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Новый групповой чат' })).toBeVisible();
  await expect(dialog.getByText('Чатов: 2 из 100')).toBeVisible();
  await expectNoA11yViolations(page);

  const name = `E2E чат ${Date.now()}`;
  await dialog.getByLabel('Название чата').fill(name);
  await dialog.getByRole('button', { name: 'Создать чат' }).click();

  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(name).first()).toBeVisible();
  await expectNoA11yViolations(page);
});

test('chat creation: server 409 CHAT_LIMIT_REACHED shows scope/limit/used', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  await page.getByRole('button', { name: 'Создать чат' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Новый групповой чат' })).toBeVisible();

  // Force the authoritative 409 while the client still thinks there is room;
  // the UI must show the server details and not insert an optimistic chat.
  await page.evaluate(() => {
    const controls = (window as Window & { __krugMocks?: MockControls }).__krugMocks;
    controls?.chats.forceCreateError({
      status: 409,
      code: 'CHAT_LIMIT_REACHED',
      message: 'Chat limit reached',
      details: { scope: 'USER', limit: 2, used: 2 },
    });
  });

  await dialog.getByLabel('Название чата').fill('Сверх лимита');
  await dialog.getByRole('button', { name: 'Создать чат' }).click();

  await expect(dialog.getByRole('alert')).toContainText(
    'Достигнут лимит чатов пользователя: 2 из 2.',
  );
  await expect(page.getByRole('heading', { name: 'Сверх лимита' })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('chat creation: DIRECT via member picker at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  // D1-FE1: at 390 px the sidebar lives in the drawer.
  await page.getByRole('button', { name: 'Открыть навигацию' }).click();
  await page.getByRole('button', { name: 'Создать чат' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Новый групповой чат' })).toBeVisible();

  await dialog.getByRole('radio', { name: /Личный чат/ }).check();
  await expect(dialog.getByRole('heading', { name: 'Новый личный чат' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Анна Петрова/ })).toBeVisible();
  await expect(dialog.getByText('Дмитрий Крылов')).toHaveCount(0);
  await expectNoA11yViolations(page);

  await dialog.getByLabel('Найти участника').fill('Марк');
  const mark = dialog.getByRole('radio', { name: /Марк Соколов/ });
  await expect(mark).toBeVisible();
  await mark.check();
  await expectNoA11yViolations(page);

  await dialog.getByRole('button', { name: 'Создать чат' }).click();
  await expect(page.getByRole('heading', { name: 'Марк Соколов' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const noHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(noHorizontalScroll).toBe(true);
  await expectNoA11yViolations(page);
});
