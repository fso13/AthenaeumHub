import { expect, test } from '@playwright/test';

type SwitcherWindow = Window & {
  __krugMocks?: {
    setWorkspaces(
      workspaces: Array<{
        id: string;
        name: string;
        slug: string;
        role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
        security_mode: 'MANAGED' | 'E2EE';
      }>,
    ): void;
  };
};

/**
 * D1-FE1 / v1.2: the workspace switcher is a designed popover, not a native
 * select. This covers the real login → menu → switch → reopen path against
 * the MSW mock backend.
 */
test('v1.2 workspace switcher opens, shows chips and switches space', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as SwitcherWindow).__krugMocks));

  await page.evaluate(() => {
    (window as SwitcherWindow).__krugMocks!.setWorkspaces([
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Студия «Восход»',
        slug: 'studiya-voshod',
        role: 'OWNER',
        security_mode: 'MANAGED',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Семья',
        slug: 'family',
        role: 'MEMBER',
        security_mode: 'E2EE',
      },
    ]);
  });

  await page.getByLabel('Email').fill('demo@krug.test');
  await page.getByLabel('Пароль', { exact: true }).fill('Sova-demo-2026');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  const trigger = page.locator('.ws-switch .ws-btn');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();

  const menu = page.getByRole('menu', { name: 'Пространства' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /Студия «Восход»/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitemradio', { name: /Семья/ })).toContainText('E2EE');
  await expect(menu.getByRole('menuitem', { name: /Создать пространство/ })).toBeDisabled();

  await menu.getByRole('menuitemradio', { name: /Семья/ }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-label', /Семья/);

  await trigger.click();
  await expect(page.getByRole('menuitemradio', { name: /Семья/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
