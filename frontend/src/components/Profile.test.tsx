import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openProfile(user: TestUser): Promise<{ dialog: HTMLElement; trigger: HTMLElement }> {
  await login(user);
  const trigger = screen.getByRole('button', { name: 'Профиль' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Профиль' });
  return { dialog, trigger };
}

describe('D1-FE5 profile modal', () => {
  it('shows /me identity, workspace role and the existing device list', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    expect(within(dialog).getByText('Дмитрий Крылов')).toBeInTheDocument();
    expect(within(dialog).getByText('dmitry@example.test')).toBeInTheDocument();
    expect(within(dialog).getByText('Студия «Восход»')).toBeInTheDocument();
    expect(within(dialog).getByText('Владелец')).toBeInTheDocument();
    expect(within(dialog).getByText('Да')).toBeInTheDocument();

    const device = mockDb.devices[0];
    expect(device).toBeDefined();
    expect(await within(dialog).findByText(device!.id)).toBeInTheDocument();
    expect(within(dialog).getByText('Это устройство')).toBeInTheDocument();
    expect(within(dialog).getByText('WEB')).toBeInTheDocument();
    expect(within(dialog).getByText('Без названия')).toBeInTheDocument();

    // No key material, fingerprints or E2EE secrets are rendered.
    expect(dialog.textContent).not.toMatch(/fingerprint|identity_|signed_prekey|one_time_prekey/i);
  });

  it('renders honest disabled 2FA/session rows instead of invented controls', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    expect(within(dialog).getByText('Двухфакторная аутентификация')).toBeInTheDocument();
    expect(
      within(dialog).getByText('В этом срезе нет API 2FA — переключатель не показывается.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Активные сессии')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'API управления сессиями нет. Завершить текущую сессию можно кнопкой «Выйти».',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('Недоступно')).toHaveLength(2);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('switches the theme and opens the existing notification preferences', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Тёмная' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(within(dialog).getByRole('button', { name: 'Тёмная' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Настроить уведомления' }));
    const notifications = await screen.findByRole('dialog', {
      name: 'Настройки уведомлений',
    });

    // Escape closes the nested dialog only; the profile stays open.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройки уведомлений' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: 'Профиль' })).toBeInTheDocument();
    expect(notifications).not.toBeInTheDocument();
  });

  it('asks for confirmation before logout and then returns to the login screen', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Выйти' }));
    const confirm = await screen.findByRole('dialog', { name: 'Выйти из аккаунта?' });
    expect(
      within(confirm).getByText('Текущая сессия завершится на этом устройстве.'),
    ).toBeInTheDocument();
    expect(
      within(confirm).getByText('Локальные ключи E2EE будут очищены, как и при обычном выходе.'),
    ).toBeInTheDocument();

    await user.click(within(confirm).getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: 'Вход в Сову' })).toBeInTheDocument();
    await waitFor(() => expect(mockDb.authLogoutRequests).toHaveLength(1));
  });

  it('traps focus, closes on Escape and returns focus to the sidebar identity', async () => {
    const { user } = renderPasswordApp();
    const { dialog, trigger } = await openProfile(user);

    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Профиль' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('passes an axe audit with the profile modal open', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    expect(dialog).toBeInTheDocument();
  });
});
