import { expect, test } from '@playwright/test';
import {
  GROUP_CHAT_ID,
  GROUP_CHAT_NAME,
  disableAnimations,
  expectNoA11yViolations,
  expectPageHeading,
  goToView,
  openDashboard,
  setChatModes,
  setWorkspaceRole,
} from './d1-helpers';

/**
 * D1.1 (#69): the closed plugin catalog and chat-scoped switches against the
 * MSW mock backend. No install/marketplace action exists; every switch is
 * server-backed and non-managers see disabled controls with a reason.
 */

test('catalog → toggle → details count, with axe', async ({ page }) => {
  await openDashboard(page);
  await disableAnimations(page);
  await goToView(page, 'Плагины');
  await expectPageHeading(page, 'Плагины');

  await expect(page.locator('.plugin-card')).toHaveCount(5);
  await expect(page.locator('.plugin-card h3')).toHaveText([
    'Опросы',
    'Задачи',
    'Перевод',
    'Мост в Telegram',
    'DLP-подсказки',
  ]);
  await expect(page.getByRole('switch')).toHaveCount(5);
  await expect(page.getByRole('button', { name: /Установить/ })).toHaveCount(0);

  const polls = page.getByRole('switch', { name: 'Включить плагин «Опросы»' });
  await expect(polls).toBeEnabled();
  await polls.click();

  await expect(
    page.getByText('Плагин «Опросы» включён. Изменение записано в журнал аудита.'),
  ).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Выключить плагин «Опросы»' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('Включено 1 из 5')).toBeVisible();

  // The chat details row reads the same server state and opens the page.
  await page.getByRole('button', { name: 'К чатам' }).click();
  await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();
  const row = page.getByRole('button', { name: /Плагины чата/ });
  await expect(row).toContainText('1');
  await row.click();
  await expect(page.getByText('1 из 5 включено')).toBeVisible();

  await expectNoA11yViolations(page);
});

test('non-manager sees disabled switches and an explicit reason', async ({ page }) => {
  await setWorkspaceRole(page, 'MEMBER');
  await openDashboard(page);
  await disableAnimations(page);
  await goToView(page, 'Плагины');
  await expectPageHeading(page, 'Плагины');

  await expect(page.locator('.plugin-card')).toHaveCount(5);
  for (const item of await page.getByRole('switch').all()) {
    await expect(item).toBeDisabled();
  }
  await expect(page.getByText('Только владелец или администратор чата').first()).toBeVisible();
  await expectNoA11yViolations(page);
});

test('E2EE keeps server plugins unavailable and the UI honest', async ({ page }) => {
  await setChatModes(page, { [GROUP_CHAT_ID]: 'E2EE' });
  await openDashboard(page);
  await disableAnimations(page);
  await goToView(page, 'Плагины');
  await expectPageHeading(page, 'Плагины');

  await expect(
    page.getByRole('heading', { name: 'Серверные плагины недоступны в E2EE' }),
  ).toBeVisible();
  await expect(page.locator('.plugin-card')).toHaveCount(5);
  for (const item of await page.getByRole('switch').all()) {
    await expect(item).toBeDisabled();
  }
  await expect(page.getByText('Недоступен в E2EE').first()).toBeVisible();
  await expectNoA11yViolations(page);
});
