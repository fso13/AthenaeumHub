import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type NotificationControls = {
  notifications: {
    failNextRead(count?: number): void;
  };
};

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test('bell: panel, E2EE-safe rows, read all and preferences', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();

  const bell = page.getByRole('button', { name: 'Уведомления: 2 непрочитанных' });
  await expect(bell).toBeVisible();
  await bell.click();

  const panel = page.getByRole('region', { name: 'Уведомления' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Новое сообщение')).toHaveCount(2);
  await expect(panel.getByText('Новое упоминание')).toBeVisible();
  // body=null rows never show message content, only the explicit explanation.
  await expect(panel.getByText(/Текст скрыт/)).toHaveCount(3);
  await expect(panel.getByText('Макеты готовы — посмотрите, пожалуйста.')).toBeVisible();
  await expect(panel.getByText('Не прочитано')).toHaveCount(2);
  await expectNoA11yViolations(page);

  await panel.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(page.getByRole('button', { name: 'Уведомления', exact: true })).toBeVisible();
  await expect(panel.getByText('Прочитано')).toHaveCount(4);
  await expect(panel.getByText('Не прочитано')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Настройки уведомлений' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки уведомлений' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Сохранённые настройки')).toBeVisible();
  await expectNoA11yViolations(page);

  await dialog.getByLabel('Режим').selectOption('MUTE');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog.getByText('Настройка сохранена')).toBeVisible();
  await expect(dialog.getByText('Отключено')).toHaveCount(2);

  await dialog.getByRole('button', { name: 'Закрыть настройки' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Уведомления', exact: true })).toBeFocused();
});

test('read-all failure rolls the badge back and can be retried', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await page.getByRole('button', { name: 'Уведомления: 2 непрочитанных' }).click();

  const panel = page.getByRole('region', { name: 'Уведомления' });
  await expect(panel).toBeVisible();
  await page.evaluate(() => {
    const controls = (window as Window & { __krugMocks?: NotificationControls }).__krugMocks;
    controls?.notifications.failNextRead(1);
  });

  await panel.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(panel.getByRole('alert')).toContainText('Изменение отменено');
  await expect(page.getByRole('button', { name: 'Уведомления: 2 непрочитанных' })).toBeVisible();

  await panel.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(page.getByRole('button', { name: 'Уведомления', exact: true })).toBeVisible();
  await expect(panel.getByText('Прочитано')).toHaveCount(4);
});

test('dark theme panel passes the same WCAG AA audit', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await page.getByRole('button', { name: 'Уведомления: 2 непрочитанных' }).click();
  await expect(page.getByRole('region', { name: 'Уведомления' })).toBeVisible();
  await expectNoA11yViolations(page);
});
