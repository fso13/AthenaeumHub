import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * E8/R-03..R-04 + E9-F/R-05 with the MSW mock backend (password auth mode):
 * first-run setup, the platform-admin guard and the tabbed admin console
 * (overview / users / chats / storage / settings) with axe and mobile checks.
 */

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@krug.test');
  await page.getByLabel('Пароль', { exact: true }).fill('Sova-demo-2026');
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function openAdmin(page: Page, tab?: string): Promise<void> {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await page.goto(tab ? `/admin?tab=${tab}` : '/admin');
  await expect(page.getByRole('heading', { name: 'Администрирование' })).toBeVisible();
}

/** No element may stick out of the viewport (page-level horizontal scroll). */
async function expectNoClipping(page: Page): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const selectors = [
      '.admin-card',
      '.admin-row',
      '.admin-tabs',
      '.admin-tab',
      '.field__input',
      '.admin-confirm',
    ];
    return [...document.querySelectorAll(selectors.join(','))].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > width + 1 || rect.left < -1;
    }).length;
  });
  expect(overflowing).toBe(0);
  const scrollOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scrollOverflow).toBeLessThanOrEqual(0);
}

test('setup wizard: mandatory /setup → SMTP test → complete → /admin', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugSetupRequired?: boolean }).__krugSetupRequired = true;
  });
  await login(page);

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Первичная настройка Совы' })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel('SMTP-хост').fill('smtp.example.test');
  await page.getByLabel('Порт').fill('587');
  await page.getByLabel('Логин SMTP').fill('mailer');
  await page.getByLabel('Пароль SMTP').fill('smtp-e2e-secret');
  await page.getByLabel('Адрес отправителя').fill('sova@example.test');
  await page.getByLabel('Лимит чатов на пользователя').fill('12');

  await page.getByRole('button', { name: 'Сохранить SMTP и отправить тест' }).click();
  await expect(page.getByText(/Тестовое письмо отправлено/)).toBeVisible();
  await expect(page.getByLabel('Пароль SMTP')).toHaveValue('');
  await expect(page.getByText('smtp-e2e-secret')).toHaveCount(0);

  await page.getByRole('button', { name: 'Завершить настройку' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Администрирование' })).toBeVisible();
  const overview = page.getByRole('region', { name: 'Обзор установки' });
  await expect(overview.getByText('Пользователи', { exact: true })).toBeVisible();
  await expect(overview.getByText('Пространства', { exact: true })).toBeVisible();
  await expect(overview.getByText('Чаты', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('tab', { name: 'Настройки' }).click();
  await expect(page.getByText('SMTP настроен')).toBeVisible();
  await expect(page.getByLabel('Пароль SMTP')).toHaveValue('');
  await expectNoA11yViolations(page);
});

test('non-admin sees "setup incomplete" instead of /setup', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugSetupRequired?: boolean }).__krugSetupRequired = true;
    (window as Window & { __krugPlatformAdmin?: boolean }).__krugPlatformAdmin = false;
  });
  await login(page);

  await expect(page.getByRole('heading', { name: 'Установка не завершена' })).toBeVisible();
  await expect(page).not.toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Первичная настройка Совы' })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('non-admin deep link to /admin gets the 403 screen', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugPlatformAdmin?: boolean }).__krugPlatformAdmin = false;
  });
  await login(page);
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  await page.goto('/admin?tab=users');

  await expect(page.getByRole('heading', { name: 'Доступ запрещён' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Администрирование' })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('admin users: cursor pagination, debounced search and axe', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugAdminUsersSeed?: number }).__krugAdminUsersSeed = 40;
  });
  await openAdmin(page, 'users');

  await expect(page.getByRole('heading', { name: 'Пользователи установки' })).toBeVisible();
  await expect(page.getByText('Показано: 25')).toBeVisible();
  await expect(page.locator('.admin-row')).toHaveCount(25);
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(page.getByText('Показано: 40')).toBeVisible();
  await expect(page.locator('.admin-row')).toHaveCount(40);

  await page.getByLabel('Поиск по email или имени').fill('seed-31');
  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expect(page.getByText('seed-31@example.test')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Сбросить' }).click();
  await expect(page.getByText('Показано: 25')).toBeVisible();
});

test('admin chats: workspace/type/search filters and axe', async ({ page }) => {
  await openAdmin(page, 'chats');

  await expect(page.getByRole('heading', { name: 'Чаты во всех пространствах' })).toBeVisible();
  await expect(page.getByText('Показано: 2')).toBeVisible();
  await expect(page.getByText('Команда «Восход»')).toBeVisible();
  await expect(page.getByText('Анна Петрова')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel('Тип чата').selectOption('GROUP');
  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expect(page.getByText('Анна Петрова')).toHaveCount(0);

  await page.getByLabel('Тип чата').selectOption('ALL');
  await expect(page.getByText('Показано: 2')).toBeVisible();

  await page.getByLabel('Поиск по имени чата').fill('Анна');
  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expect(page.getByText('Анна Петрова')).toBeVisible();

  await expect(page.getByRole('option', { name: 'Студия «Восход»' })).toHaveCount(1);
  await page.getByLabel('Пространство').selectOption({ label: 'Студия «Восход»' });
  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('admin storage: totals, limit bar and documented no-pagination', async ({ page }) => {
  await openAdmin(page, 'storage');

  await expect(page.getByRole('heading', { name: 'Хранилище' })).toBeVisible();
  const totals = page.getByRole('group', { name: 'Итоги хранилища' });
  await expect(totals.getByText('Использовано', { exact: true })).toBeVisible();
  await expect(totals.getByText('Зарезервировано', { exact: true })).toBeVisible();
  await expect(totals.getByText('Объекты', { exact: true })).toBeVisible();
  await expect(totals.getByText('Вложения', { exact: true })).toBeVisible();

  await expect(page.getByRole('progressbar')).toHaveCount(1);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('button', { name: 'Показать ещё' })).toHaveCount(0);
  await expect(page.getByText(/без пагинации/)).toBeVisible();
  await expectNoA11yViolations(page);
});

test('admin settings tab: SMTP/test-email form and axe', async ({ page }) => {
  await openAdmin(page, 'settings');

  await expect(page.getByRole('heading', { name: 'Параметры установки' })).toBeVisible();
  await expect(page.getByLabel('SMTP-хост')).toBeVisible();
  await expect(page.getByLabel('Email для теста')).toBeVisible();
  await expect(page.getByText(/записываются в аудит/)).toBeVisible();
  await expectNoA11yViolations(page);

  // The tab set stays keyboard-operable (roving tabindex + arrow keys).
  await page.getByRole('tab', { name: 'Настройки' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Хранилище' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).toHaveURL(/tab=storage/);
});

test('admin users: suspend and activate with a confirm dialog and axe', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugAdminUsersSeed?: number }).__krugAdminUsersSeed = 12;
  });
  await openAdmin(page, 'users');

  const row = page.locator('.admin-row').filter({ hasText: 'seed-01@example.test' });
  await expect(row.getByText('Активен')).toBeVisible();

  const trigger = row.getByRole('button', { name: 'Приостановить' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Приостановить пользователя?' })).toBeVisible();
  await expect(dialog.getByText(/seed-01@example\.test/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await expectNoA11yViolations(page);

  // Cancel path: Escape closes, focus returns to the trigger, no state change.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row.getByText('Активен')).toBeVisible();

  await trigger.click();
  await dialog.getByRole('button', { name: 'Приостановить' }).click();
  await expect(page.getByText(/приостановлен: сессии отозваны/)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText('Заблокирован')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Активировать' })).toBeVisible();

  await row.getByRole('button', { name: 'Активировать' }).click();
  await dialog.getByRole('button', { name: 'Активировать' }).click();
  await expect(page.getByText(/активирован\./)).toBeVisible();
  await expect(row.getByText('Активен')).toBeVisible();

  // The mock backend appends the audited action; the Audit tab reads it back.
  await page.getByRole('tab', { name: 'Аудит' }).click();
  await expect(page.getByRole('heading', { name: 'Аудит установки' })).toBeVisible();
  await expect(
    page.locator('.admin-rows--audit').getByText('admin.user.activated', { exact: true }),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test('admin chats: delete asks for confirmation and removes the chat', async ({ page }) => {
  await openAdmin(page, 'chats');
  await expect(page.getByText('Показано: 2')).toBeVisible();

  const row = page.locator('.admin-row').filter({ hasText: 'Команда «Восход»' });
  await row.getByRole('button', { name: 'Удалить' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Удалить чат?' })).toBeVisible();
  await expect(dialog.getByText('Команда «Восход»')).toBeVisible();
  await expect(dialog.getByText(/Подтвердите удаление чата/)).toBeVisible();
  await expect(dialog.getByText(/физически не удаляются/)).toBeVisible();
  await expectNoA11yViolations(page);

  await dialog.getByRole('button', { name: 'Удалить чат' }).click();
  await expect(page.getByText(/удалён \(soft-delete\)/)).toBeVisible();
  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expect(page.locator('.admin-rows--chats').getByText('Команда «Восход»')).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('admin audit: cursor pagination, exact action filter and no metadata', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __krugAuditSeed?: number }).__krugAuditSeed = 30;
  });
  await openAdmin(page, 'audit');

  await expect(page.getByRole('heading', { name: 'Аудит установки' })).toBeVisible();
  await expect(page.getByText('Показано: 25')).toBeVisible();
  await expect(page.locator('.admin-rows--audit .admin-row')).toHaveCount(25);
  await expect(page.locator('.admin-rows--audit')).not.toContainText('metadata');
  await expect(page.locator('.admin-rows--audit')).not.toContainText('request_id');
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(page.getByText('Показано: 30')).toBeVisible();

  await page.getByLabel('Действие', { exact: true }).selectOption('admin.user.suspended');
  await expect(page.getByText('Показано: 15')).toBeVisible();
  await expect(page.locator('.admin-rows--audit .admin-row')).toHaveCount(15);
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Сбросить' }).click();
  await expect(page.getByText('Показано: 25')).toBeVisible();
});

test('admin audit surfaces pass axe in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openAdmin(page, 'audit');

  await expect(page.getByText('Показано: 3')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('admin surfaces pass axe in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openAdmin(page, 'users');

  await expect(page.getByText('Показано: 1')).toBeVisible();
  await expectNoA11yViolations(page);
});

test.describe('admin mobile (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('cards replace columns, labels stay visible, no horizontal scroll', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __krugAdminUsersSeed?: number }).__krugAdminUsersSeed = 12;
    });
    await openAdmin(page, 'users');

    await expect(page.getByText('Показано: 12')).toBeVisible();
    await expect(page.locator('.admin-rows__head')).toBeHidden();
    await expect(page.locator('.admin-row dt').filter({ hasText: 'Email' }).first()).toBeVisible();
    await expect(
      page.locator('.admin-row dt').filter({ hasText: 'Регистрация' }).first(),
    ).toBeVisible();
    await expectNoClipping(page);

    const heights = await page
      .locator('.admin-tab')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().height));
    expect(heights.every((height) => height >= 44)).toBe(true);
    await expectNoA11yViolations(page);

    await page.getByRole('tab', { name: 'Чаты' }).click();
    await expect(page.getByRole('heading', { name: 'Чаты во всех пространствах' })).toBeVisible();
    await expect(page.getByLabel('Пространство')).toBeVisible();
    await expectNoClipping(page);
    await expectNoA11yViolations(page);

    await page.getByRole('tab', { name: 'Хранилище' }).click();
    await expect(page.getByRole('heading', { name: 'Хранилище' })).toBeVisible();
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expectNoClipping(page);
    await expectNoA11yViolations(page);

    await page.getByRole('tab', { name: 'Аудит' }).click();
    await expect(page.getByRole('heading', { name: 'Аудит установки' })).toBeVisible();
    await expect(page.getByText('Показано: 3')).toBeVisible();
    await expect(
      page.locator('.admin-rows--audit dt').filter({ hasText: 'Время' }).first(),
    ).toBeVisible();
    await expect(
      page.locator('.admin-rows--audit dt').filter({ hasText: 'Цель' }).first(),
    ).toBeVisible();
    await expectNoClipping(page);
    await expectNoA11yViolations(page);
  });

  test('users action confirm fits 390 px and keeps labels visible', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __krugAdminUsersSeed?: number }).__krugAdminUsersSeed = 12;
    });
    await openAdmin(page, 'users');

    const row = page.locator('.admin-row').filter({ hasText: 'seed-01@example.test' });
    await expect(row.getByRole('button', { name: 'Приостановить' })).toBeVisible();
    await expect(row.locator('dt').filter({ hasText: 'Действия' })).toBeVisible();
    await expectNoClipping(page);

    await row.getByRole('button', { name: 'Приостановить' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
    await expectNoClipping(page);
    await expectNoA11yViolations(page);

    await dialog.getByRole('button', { name: 'Приостановить' }).click();
    await expect(row.getByText('Заблокирован')).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe('admin tablet (768 px)', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('keeps the card layout without clipping or a11y regressions', async ({ page }) => {
    await openAdmin(page, 'users');

    await expect(page.getByText('Показано: 1')).toBeVisible();
    await expect(page.locator('.admin-rows__head')).toBeHidden();
    await expect(page.locator('.admin-row dt').filter({ hasText: 'Статус' }).first()).toBeVisible();
    await expectNoClipping(page);
    await expectNoA11yViolations(page);
  });
});
