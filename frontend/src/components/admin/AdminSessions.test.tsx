import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { navigate } from '../../router/router';
import { mockDb } from '../../test/server';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openSessions(user: TestUser): Promise<HTMLElement> {
  await login(user);
  navigate('/admin?tab=users');
  await screen.findByRole('heading', { name: 'Администрирование' });
  await user.click(await screen.findByRole('button', { name: 'Сессии' }));
  return screen.findByRole('dialog', { name: 'Сессии пользователя' });
}

describe('#84 admin sessions management', () => {
  it('lists only device/timestamps and marks the current session', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);

    expect(await within(dialog).findByText('krug-web · Chrome')).toBeInTheDocument();
    expect(within(dialog).getByText('krug-mobile · iOS')).toBeInTheDocument();
    expect(within(dialog).getByText('Текущая')).toBeInTheDocument();
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/Создана:/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Активность:/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/127\.0\.0\.1/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Bearer/)).not.toBeInTheDocument();
    expect(mockDb.adminSessions.listRequests[0]).toMatchObject({
      userId: '11111111-1111-4111-8111-111111111111',
      cursor: null,
      limit: 25,
    });
  });

  it('revokes a single session and removes the row', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);
    await within(dialog).findByText('krug-mobile · iOS');

    await user.click(
      within(dialog).getByRole('button', { name: 'Отозвать сессию «krug-mobile · iOS»' }),
    );

    await waitFor(() =>
      expect(within(dialog).queryByText('krug-mobile · iOS')).not.toBeInTheDocument(),
    );
    expect(mockDb.adminSessions.revokeRequests).toEqual(['f0000000-0000-4000-8000-000000000102']);
    expect(within(dialog).getByText('krug-web · Chrome')).toBeInTheDocument();
  });

  it('requires confirmation and shows server counters for revoke-all', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);
    await within(dialog).findByText('krug-mobile · iOS');

    await user.click(within(dialog).getByRole('button', { name: 'Отозвать все сессии' }));
    expect(
      within(dialog).getByText(/Все сессии выбранного пользователя будут завершены/),
    ).toBeInTheDocument();
    expect(mockDb.adminSessions.revokeAllRequests).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: 'Отозвать все' }));

    expect(
      await within(dialog).findByText('Отозвано сессий: 2. Затронуто пользователей: 1.'),
    ).toBeInTheDocument();
    expect(mockDb.adminSessions.revokeAllRequests).toBe(1);
    expect(await within(dialog).findByText('Активных сессий нет')).toBeInTheDocument();
  });

  it('surfaces AUTH_UNAVAILABLE honestly and retries', async () => {
    mockDb.adminSessions.forceListError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak is unavailable',
      retryAfterSeconds: 30,
    };
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);

    const alert = await within(dialog).findByRole('alert');
    expect(
      within(alert).getByText(
        'Служба сессий Keycloak недоступна (AUTH_UNAVAILABLE). Повторите попытку позже.',
      ),
    ).toBeInTheDocument();
    expect(within(alert).getAllByText(/AUTH_UNAVAILABLE/).length).toBeGreaterThan(0);

    mockDb.adminSessions.forceListError = null;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));

    expect(await within(dialog).findByText('krug-web · Chrome')).toBeInTheDocument();
  });

  it('shows a 404 no-identity state without inventing sessions', async () => {
    mockDb.adminSessions.forceListError = {
      status: 404,
      code: 'USER_NOT_FOUND',
      message: 'User has no identity',
    };
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);

    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText(/нет Keycloak identity/)).toBeInTheDocument();
    expect(within(dialog).queryByText('krug-web · Chrome')).not.toBeInTheDocument();
  });

  it('passes axe without serious/critical violations', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSessions(user);
    await within(dialog).findByText('krug-mobile · iOS');

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false } } });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
