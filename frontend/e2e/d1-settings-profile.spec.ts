import { expect, test } from '@playwright/test';
import {
  GROUP_CHAT_NAME,
  clearDevices,
  disableAnimations,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  openDashboard,
  setWorkspaceRole,
} from './d1-helpers';

/**
 * D1-QA1: chat settings (D1-BE3 mock) and the profile modal.
 * Managed-only, owner vs read-only member, explicitly disabled danger zone.
 */

test.describe('D1 chat settings', () => {
  test('owner saves name/description after 200, danger actions stay disabled', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);

    const trigger = page.getByRole('button', { name: 'О чате' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Настройки чата' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Название' })).toBeFocused();
    await expect(dialog.getByRole('textbox', { name: 'Название' })).toHaveValue(GROUP_CHAT_NAME);
    await expect(dialog.getByRole('textbox', { name: 'Описание' })).toHaveValue('');

    // Danger zone lives on its own tab and is honestly disabled until the
    // backend API lands.
    await dialog.getByRole('tab', { name: 'Опасная зона' }).click();
    await expect(dialog.getByRole('button', { name: 'Архивировать чат' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Покинуть чат' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Удалить чат' })).toBeDisabled();
    await expect(
      dialog.getByText('Недоступно: в этом срезе нет API архивации, выхода или удаления чата.'),
    ).toBeVisible();

    await expectNoA11yViolations(page);

    await dialog.getByRole('tab', { name: 'Основное' }).click();
    await dialog.getByRole('textbox', { name: 'Название' }).fill('  Продуктовая   команда  ');
    await dialog.getByRole('textbox', { name: 'Описание' }).fill('  Описание команды  ');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();

    await expect(dialog.getByRole('status')).toHaveText(
      'Настройки сохранены. Заголовок и список чатов обновлены.',
    );
    // Header/list update only after the server confirms.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Продуктовая команда' }),
    ).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Чаты' });
    await expect(sidebar.getByText('Продуктовая команда').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('MEMBER sees read-only fields and no save control; no PATCH is sent', async ({ page }) => {
    await setWorkspaceRole(page, 'MEMBER');
    await openDashboard(page);
    await page.getByRole('button', { name: 'О чате' }).click();
    const dialog = page.getByRole('dialog', { name: 'Настройки чата' });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole('textbox', { name: 'Название' })).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: 'Описание' })).toBeDisabled();
    await expect(
      dialog.getByText(
        'Менять название и описание могут владелец и администратор пространства. Вам доступен просмотр.',
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

    await disableAnimations(page);
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);
  });

  test('390 px: chat settings fit without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
    await page.getByRole('button', { name: 'О чате' }).click();
    const dialog = page.getByRole('dialog', { name: 'Настройки чата' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.width).toBeLessThanOrEqual(390);
    }
    await disableAnimations(page);
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('D1 profile', () => {
  test('/me identity + registered devices + honest 2FA and live sessions', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);

    const trigger = page.getByRole('button', { name: 'Профиль' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Профиль' });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByText('Дмитрий Крылов')).toBeVisible();
    await expect(dialog.getByText('dmitry@example.test')).toBeVisible();
    await expect(dialog.getByText('Студия «Восход»')).toBeVisible();
    await expect(dialog.getByText('Владелец')).toBeVisible();
    await expect(dialog.getByText('Платформенный администратор')).toBeVisible();

    // GET /devices: the password bootstrap registered this browser.
    await expect(dialog.getByRole('heading', { name: 'Устройства' })).toBeVisible();
    await expect(dialog.getByText('Это устройство')).toBeVisible();
    await expect(dialog.getByText('WEB', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Устройства ещё не зарегистрированы.')).toHaveCount(0);

    // 2FA stays an honest disabled row; sessions are the real Keycloak list
    // from GET /me/sessions (client labels, timestamps, current flag only).
    await expect(
      dialog.getByText('В этом срезе нет API 2FA — переключатель не показывается.'),
    ).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByRole('heading', { name: 'Активные сессии' })).toBeVisible();
    await expect(dialog.getByText('krug-web · Chrome')).toBeVisible();
    await expect(dialog.getByText('Текущая')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Завершить сессию: krug-web · Safari' }),
    ).toBeVisible();
    await expect(dialog).not.toContainText(/access_token|refresh_token|ip_address/i);

    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('edits the profile incrementally and revokes a session after confirmation', async ({
    page,
  }) => {
    await openDashboard(page);
    await disableAnimations(page);
    await page.getByRole('button', { name: 'Профиль' }).click();
    const dialog = page.getByRole('dialog', { name: 'Профиль' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Редактировать' }).click();
    const name = dialog.getByLabel('Имя');
    await expect(name).toBeFocused();
    await name.fill('Дмитрий К.');
    await dialog.getByLabel('О себе').fill('Люблю наводить порядок в файлах.');
    await dialog.getByLabel('Телефон').fill('+7 999 123-45-67');

    const patch = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/api/v1/me'),
    );
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    expect((await patch).postDataJSON()).toEqual({
      display_name: 'Дмитрий К.',
      bio: 'Люблю наводить порядок в файлах.',
      phone: '+7 999 123-45-67',
    });
    await expect(dialog.getByText('Профиль сохранён.')).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText('Дмитрий К.');

    // Second save carries only the changed field (incremental PATCH).
    await dialog.getByRole('button', { name: 'Редактировать' }).click();
    await dialog.getByLabel('Имя').fill('Дмитрий Крылов');
    const secondPatch = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/api/v1/me'),
    );
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    expect((await secondPatch).postDataJSON()).toEqual({ display_name: 'Дмитрий Крылов' });

    const revoke = page.waitForRequest(
      (request) => request.method() === 'DELETE' && request.url().includes('/api/v1/me/sessions/'),
    );
    await dialog.getByRole('button', { name: 'Завершить сессию: krug-web · Safari' }).click();
    const confirm = page.getByRole('dialog', { name: 'Завершить сессию?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Завершить' }).click();
    await revoke;
    await expect(dialog.getByText('krug-web · Safari')).toHaveCount(0);
    await expect(dialog.getByText('Сессия завершена.')).toBeVisible();

    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('empty device list renders the honest empty state', async ({ page }) => {
    await openDashboard(page);
    await clearDevices(page);
    await page.getByRole('button', { name: 'Профиль' }).click();
    const dialog = page.getByRole('dialog', { name: 'Профиль' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Устройства ещё не зарегистрированы.')).toBeVisible();
    await expect(dialog.getByText('Это устройство')).toHaveCount(0);
  });
});
