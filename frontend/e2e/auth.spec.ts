import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Auth BFF password flow with the MSW mock backend (`VITE_USE_MOCKS=true`).
 * There is no Keycloak redirect: the browser only calls `/api/v1/auth/*`.
 */

async function expectNoA11yViolations(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.test`;
}

async function registerThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('button', { name: 'Регистрация' }).click();
  await expect(page.getByRole('heading', { name: 'Регистрация в Pickle' })).toBeVisible();
  await page.getByLabel('Имя').fill('E2E Пользователь');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByLabel('Повторите пароль').fill(password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('heading', { name: 'Подтвердите email' })).toBeVisible();
}

test('password auth: guard → register → verify → chat → logout', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'Krug-e2e-password-2026';

  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Вход в Pickle' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Регистрация' }).click();
  await expect(page.getByRole('heading', { name: 'Регистрация в Pickle' })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel('Имя').fill('E2E Пользователь');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByLabel('Повторите пароль').fill(password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();

  await expect(page.getByRole('heading', { name: 'Подтвердите email' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole('button', { name: /Повторить можно через/ })).toBeDisabled();
  await expectNoA11yViolations(page);

  await page.getByLabel('Код из письма').fill('123456');
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Выйти' }).click();

  await expect(page.getByRole('heading', { name: 'Вход в Pickle' })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Вы вышли из аккаунта.')).toBeVisible();
});

test('password auth: invalid credentials show a generic error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@krug.test');
  await page.getByLabel('Пароль', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page.getByRole('alert')).toHaveText('Неверный email или пароль.');
  await expect(page).toHaveURL(/\/login$/);
});

test('password auth: unverified login returns to verify, wrong code shows attempts', async ({
  page,
}) => {
  const email = uniqueEmail();
  const password = 'Krug-e2e-password-2026';

  await page.goto('/login');
  await registerThroughUi(page, email, password);

  await page.getByRole('button', { name: 'Вернуться ко входу' }).click();
  await expect(page.getByRole('heading', { name: 'Вход в Pickle' })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page.getByRole('heading', { name: 'Подтвердите email' })).toBeVisible();
  await page.getByLabel('Код из письма').fill('000000');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByRole('alert')).toContainText('Неверный код. Осталось попыток: 4.');

  await page.getByLabel('Код из письма').fill('123456');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByRole('heading', { name: 'Команда «Восход»' })).toBeVisible();
});

test('password auth: first login without workspaces opens onboarding', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'Krug-e2e-password-2026';

  await page.addInitScript(() => {
    (window as Window & { __krugEmptyWorkspaces?: boolean }).__krugEmptyWorkspaces = true;
  });

  await page.goto('/login');
  await registerThroughUi(page, email, password);
  await page.getByLabel('Код из письма').fill('123456');
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByRole('heading', { name: 'Создайте пространство' })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel('Название пространства').fill('Тестовое пространство');
  await page.getByRole('button', { name: 'Создать пространство' }).click();

  await expect(page.getByRole('heading', { name: 'Общий чат' })).toBeVisible();
  await expect(
    page
      .getByRole('complementary', { name: 'Пространство и чаты' })
      .getByText('Тестовое пространство'),
  ).toBeVisible();
  await expect(page.getByLabel('Текст сообщения')).toBeVisible();
});
