import { expect, test } from '@playwright/test';

/**
 * E6 real notifications smoke: requires backend 8081 with a seeded notification
 * for the default dev user. Run with:
 *   E6_NOTIFY_REAL=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
 *     npx playwright test --config playwright.real.config.ts notifications.real.spec.ts
 */
test.skip(process.env.E6_NOTIFY_REAL !== '1', 'Set E6_NOTIFY_REAL=1 with seeded backend');

test('E6 real: bell → panel → read all → unread cleared', async ({ page }) => {
  await page.goto('/');

  const bell = page.getByRole('button', { name: /^Уведомления/ });
  await expect(bell).toBeVisible({ timeout: 20_000 });
  await bell.click();

  const panel = page.getByRole('region', { name: 'Уведомления' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Новое сообщение').first()).toBeVisible();

  await page.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(panel.getByText('Прочитано').first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Закрыть уведомления' }).click();
  await expect(bell).toHaveAttribute('aria-label', /^Уведомления$/);
});
