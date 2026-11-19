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

  it('keeps 2FA honest while showing the real Keycloak sessions from /me/sessions', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    expect(within(dialog).getByText('Двухфакторная аутентификация')).toBeInTheDocument();
    expect(
      within(dialog).getByText('В этом срезе нет API 2FA — переключатель не показывается.'),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('Активные сессии').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('Недоступно')).toHaveLength(1);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();

    // Contract fields only: client label, timestamps, current flag. No IP,
    // username or session tokens are rendered.
    expect(await within(dialog).findByText('krug-web · Chrome')).toBeInTheDocument();
    expect(within(dialog).getByText('krug-web · Safari')).toBeInTheDocument();
    expect(within(dialog).getByText('Текущая')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /^Завершить сессию:/ })).toHaveLength(2);
    expect(dialog.textContent).not.toMatch(/ipAddress|ip_address|access_token|refresh_token/i);
    expect(dialog.textContent).not.toContain(
      mockDb.profileSessions[0]?.id.slice(0, 8) ?? 'no-session-id',
    );
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

describe('D1-FE5/#72 profile edit and sessions', () => {
  it('saves display_name/bio/phone as an incremental PATCH and updates /me', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Редактировать' }));
    const name = within(dialog).getByLabelText('Имя');
    expect(name).toHaveFocus();

    await user.clear(name);
    await user.type(name, 'Дмитрий К.');
    await user.type(within(dialog).getByLabelText('О себе'), 'Люблю наводить порядок в файлах.');
    await user.type(within(dialog).getByLabelText('Телефон'), '+7 999 123-45-67');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.profileUpdateRequests).toHaveLength(1));
    expect(mockDb.profileUpdateRequests[0]?.body).toEqual({
      display_name: 'Дмитрий К.',
      bio: 'Люблю наводить порядок в файлах.',
      phone: '+7 999 123-45-67',
    });
    expect(mockDb.me.user.display_name).toBe('Дмитрий К.');
    expect(await within(dialog).findByText('Профиль сохранён.')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { level: 3 })).toHaveTextContent('Дмитрий К.');

    // Second save sends only the changed field; unchanged bio/phone are absent.
    await user.click(within(dialog).getByRole('button', { name: 'Редактировать' }));
    await user.clear(within(dialog).getByLabelText('Имя'));
    await user.type(within(dialog).getByLabelText('Имя'), 'Дмитрий Крылов');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.profileUpdateRequests).toHaveLength(2));
    expect(mockDb.profileUpdateRequests[1]?.body).toEqual({ display_name: 'Дмитрий Крылов' });
  });

  it('validates the 80/280/32 bounds locally and never sends an invalid patch', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Редактировать' }));
    const name = within(dialog).getByLabelText('Имя');
    await user.clear(name);
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(within(dialog).getByText('Укажите имя.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(mockDb.profileUpdateRequests).toHaveLength(0);

    await user.type(name, 'a'.repeat(81));
    await user.type(within(dialog).getByLabelText('О себе'), 'b'.repeat(281));
    await user.type(within(dialog).getByLabelText('Телефон'), '9'.repeat(33));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(within(dialog).getByText('Имя — не больше 80 символов.')).toBeInTheDocument();
    expect(within(dialog).getByText('О себе — не больше 280 символов.')).toBeInTheDocument();
    expect(within(dialog).getByText('Телефон — не больше 32 символов.')).toBeInTheDocument();
    expect(mockDb.profileUpdateRequests).toHaveLength(0);
  });

  it('keeps the form open and shows a server error without an optimistic update', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Редактировать' }));
    await user.clear(within(dialog).getByLabelText('Имя'));
    await user.type(within(dialog).getByLabelText('Имя'), 'Новое имя');
    mockDb.forceProfileUpdateError = {
      status: 500,
      code: 'INTERNAL',
      message: 'profile failed',
    };
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось сохранить профиль.');
    expect(mockDb.me.user.display_name).toBe('Дмитрий Крылов');
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();
  });

  it('revokes a session only after confirmation and re-reads the server list', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);
    await within(dialog).findByText('krug-web · Safari');

    const target = mockDb.profileSessions.find((session) => !session.current);
    expect(target).toBeDefined();
    await user.click(
      within(dialog).getByRole('button', { name: `Завершить сессию: ${target!.name}` }),
    );

    const confirm = await screen.findByRole('dialog', { name: 'Завершить сессию?' });
    expect(within(confirm).getByText(`Сессия «${target!.name}» будет отозвана.`)).toBeVisible();
    expect(within(confirm).getByText(/Устройство потеряет доступ/)).toBeVisible();

    // Nothing is removed until the server confirms.
    expect(mockDb.profileSessionRevokeRequests).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Завершить' }));

    await waitFor(() => expect(mockDb.profileSessionRevokeRequests).toEqual([target!.id]));
    await waitFor(() => expect(within(dialog).queryByText(target!.name)).not.toBeInTheDocument());
    expect(await within(dialog).findByText('Сессия завершена.')).toBeInTheDocument();
  });

  it('shows a 503 sessions error, retries, and surfaces a revoke failure honestly', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);
    await within(dialog).findByText('krug-web · Chrome');

    mockDb.forceProfileSessionsError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak unavailable',
      retryAfterSeconds: 5,
    };
    await user.click(within(dialog).getByRole('button', { name: 'Обновить' }));
    const sessionAlert = await within(dialog).findByRole('alert');
    expect(sessionAlert).toHaveTextContent('Сервис сессий недоступен. Повторите позже.');

    mockDb.forceProfileSessionsError = null;
    await user.click(within(sessionAlert).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('krug-web · Chrome')).toBeInTheDocument();

    const target = mockDb.profileSessions.find((session) => !session.current);
    mockDb.forceSessionRevokeError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak unavailable',
      retryAfterSeconds: 5,
    };
    await user.click(
      within(dialog).getByRole('button', { name: `Завершить сессию: ${target!.name}` }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Завершить сессию?' });
    await user.click(within(confirm).getByRole('button', { name: 'Завершить' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Сервис сессий недоступен. Повторите позже.',
    );
    // The row is still there: revoke is never optimistic.
    expect(within(dialog).getByText(target!.name)).toBeInTheDocument();

    mockDb.forceSessionRevokeError = null;
    await user.click(within(confirm).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(within(dialog).queryByText(target!.name)).not.toBeInTheDocument());
  });

  it('passes an axe audit in edit mode with sessions visible', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: 'Редактировать' }));
    await within(dialog).findByText('krug-web · Chrome');

    const results = await axe.run(dialog, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
