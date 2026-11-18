import { expect, test } from '@playwright/test';
import {
  DIRECT_CHAT_ID,
  GROUP_CHAT_NAME,
  WORKSPACE_NAME,
  disableAnimations,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  expectPageHeading,
  goToView,
  openDashboard,
  setUnreadCounts,
} from './d1-helpers';

/**
 * D1-QA1: dashboard shell, space rail/99+, section routing and the
 * responsive/a11y matrix. The suite runs on the MSW mock backend in the
 * password auth mode (`npm run test:e2e:d1`); no real backend is involved.
 */

test.describe('D1 dashboard shell', () => {
  test('login → rail with exact unread aria → Overview/Files/Settings → back to chat', async ({
    page,
  }) => {
    // Unread sits on the inactive direct chat so the active-chat markRead
    // cannot race the rail assertion.
    await setUnreadCounts(page, { [DIRECT_CHAT_ID]: 3 });
    await openDashboard(page);

    const rail = page.getByRole('navigation', { name: 'Пространства' });
    const space = rail.getByRole('button', {
      name: `Пространство: ${WORKSPACE_NAME}, непрочитанных: 3`,
    });
    await expect(space).toBeVisible();
    await expect(space).toHaveAttribute('aria-current', 'page');
    // The visual badge is decorative; the exact number lives in the button
    // accessible name, so screen readers announce it once.
    const badge = space.locator('.unread-badge');
    await expect(badge).toHaveText('3');
    await expect(badge).toHaveAttribute('aria-hidden', 'true');

    await expect(page.getByRole('link', { name: 'Перейти к чату' })).toBeAttached();
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();

    // Overview: URL state + main focus + back-to-chat control.
    await goToView(page, 'Обзор');
    await expect(page).toHaveURL(/\?view=overview$/);
    await expectPageHeading(page, 'Обзор');
    await expect(
      page
        .getByRole('navigation', { name: 'Разделы пространства' })
        .getByRole('button', { name: 'Обзор', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'К чатам' }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();

    // Browser back returns to the section as well.
    await goToView(page, 'Файлы');
    await expect(page).toHaveURL(/\?view=files$/);
    await expectPageHeading(page, 'Файлы');
    await page.goBack();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();

    await goToView(page, 'Настройки');
    await expect(page).toHaveURL(/\?view=settings$/);
    await expectPageHeading(page, 'Настройки');
    await page.getByRole('button', { name: 'К чатам' }).click();
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();
  });

  test('unread boundary: 99 → 99, 100 → 99+ with the exact aria number', async ({ page }) => {
    await setUnreadCounts(page, { [DIRECT_CHAT_ID]: 100 });
    await openDashboard(page);

    const rail = page.getByRole('navigation', { name: 'Пространства' });
    const space = rail.getByRole('button', {
      name: `Пространство: ${WORKSPACE_NAME}, непрочитанных: 99+ (100)`,
    });
    await expect(space).toBeVisible();
    await expect(space.locator('.unread-badge')).toHaveText('99+');
    await expect(space.locator('.unread-badge')).toHaveAttribute('aria-hidden', 'true');

    // 99 is still shown as the exact number.
    const page99 = await page.context().newPage();
    try {
      await setUnreadCounts(page99, { [DIRECT_CHAT_ID]: 99 });
      await openDashboard(page99);
      const ninetyNine = page99.getByRole('button', {
        name: `Пространство: ${WORKSPACE_NAME}, непрочитанных: 99`,
      });
      await expect(ninetyNine).toBeVisible();
      await expect(ninetyNine.locator('.unread-badge')).toHaveText('99');
    } finally {
      await page99.close();
    }
  });

  test('mobile drawer opens, traps the shell state and closes with Esc/backdrop', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);

    const menu = page.getByRole('button', { name: 'Открыть навигацию' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(
      page.getByRole('button', { name: 'Закрыть навигацию', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('navigation', { name: 'Разделы пространства' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Открыть навигацию' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await page.getByRole('button', { name: 'Открыть навигацию' }).click();
    await page.getByRole('button', { name: 'Закрыть навигацию (фон)' }).click();
    await expect(page.getByRole('button', { name: 'Открыть навигацию' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expectNoHorizontalScroll(page);
  });
});

for (const width of [390, 768, 1440]) {
  test(`a11y/responsive ${width}px: light + dark, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await openDashboard(page);
    await disableAnimations(page);

    // Chat surface: both themes, WCAG 2.1 A/AA.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    // Overview in light.
    await page.emulateMedia({ colorScheme: 'light' });
    await goToView(page, 'Обзор');
    await expectPageHeading(page, 'Обзор');
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    // Files in light.
    await goToView(page, 'Файлы');
    await expectPageHeading(page, 'Файлы');
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    // Settings in dark, then back to the chat.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await goToView(page, 'Настройки');
    await expectPageHeading(page, 'Настройки');
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'К чатам' }).click();
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}
