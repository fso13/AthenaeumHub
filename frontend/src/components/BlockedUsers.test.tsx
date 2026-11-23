import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openDirectDanger(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Анна Петрова, Личный чат' }));
  await screen.findByRole('heading', { name: 'Анна Петрова' });
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
  await user.click(within(dialog).getByRole('tab', { name: 'Опасная зона' }));
  return dialog;
}

async function openProfile(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Профиль' }));
  return screen.findByRole('dialog', { name: 'Профиль' });
}

describe('#79 DIRECT block and the blocked list', () => {
  it('blocks the DIRECT peer after confirmation and offers unblock on the same card', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openDirectDanger(user);

    const block = await within(dialog).findByRole('button', {
      name: 'Заблокировать контакт',
    });
    await user.click(block);
    const confirm = await screen.findByRole('dialog', { name: 'Заблокировать контакт?' });
    await user.click(within(confirm).getByRole('button', { name: 'Заблокировать' }));

    expect(await within(dialog).findByText('Контакт заблокирован.')).toBeInTheDocument();
    expect(mockDb.blockRequests).toContainEqual(
      expect.objectContaining({ userId: IDS.anna, action: 'BLOCK' }),
    );
    expect(mockDb.blockedUsers.some((item) => item.user_id === IDS.anna)).toBe(true);
    expect(
      await within(dialog).findByRole('button', { name: 'Разблокировать контакт' }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Разблокировать контакт' }));
    expect(await within(dialog).findByText('Контакт разблокирован.')).toBeInTheDocument();
    expect(mockDb.blockRequests).toContainEqual(
      expect.objectContaining({ userId: IDS.anna, action: 'UNBLOCK' }),
    );
    expect(mockDb.blockedUsers).toHaveLength(0);
  });

  it('keeps the confirmation open and explains a server block failure', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openDirectDanger(user);

    mockDb.forceBlockError = {
      status: 404,
      code: 'USER_NOT_FOUND',
      message: 'User not found',
    };
    await user.click(await within(dialog).findByRole('button', { name: 'Заблокировать контакт' }));
    const confirm = await screen.findByRole('dialog', { name: 'Заблокировать контакт?' });
    await user.click(within(confirm).getByRole('button', { name: 'Заблокировать' }));

    expect(
      await within(confirm).findByText('Пользователь не найден или неактивен.'),
    ).toBeInTheDocument();
    expect(confirm).toBeInTheDocument();
    expect(mockDb.blockedUsers).toHaveLength(0);
  });

  it('lists own blocked users in the profile and unblocks from there', async () => {
    mockDb.blockedUsers = [{ user_id: IDS.anna, blocked_at: '2026-11-18T10:00:00.000Z' }];
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: /^Блокировки/ }));

    expect(await within(dialog).findByText(IDS.anna)).toBeInTheDocument();
    expect(within(dialog).getByText(/^Заблокирован /)).toBeInTheDocument();
    const blockedCard = dialog.querySelector('.blocked-card');
    expect(blockedCard?.textContent ?? '').not.toContain('@');

    await user.click(
      within(dialog).getByRole('button', {
        name: `Разблокировать пользователя ${IDS.anna}`,
      }),
    );

    expect(await within(dialog).findByText('Пользователь разблокирован.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByText(IDS.anna)).toBeNull());
    expect(mockDb.blockRequests).toContainEqual(
      expect.objectContaining({ userId: IDS.anna, action: 'UNBLOCK' }),
    );
  });

  it('shows the blocked-list error with retry and then recovers', async () => {
    mockDb.blockedUsers = [{ user_id: IDS.lena, blocked_at: '2026-11-17T10:00:00.000Z' }];
    mockDb.forceBlockedListError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Forbidden',
    };
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: /^Блокировки/ }));

    expect(
      await within(dialog).findByText('Недостаточно прав для блокировки.'),
    ).toBeInTheDocument();
    mockDb.forceBlockedListError = null;
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText(IDS.lena)).toBeInTheDocument();
  });

  it('passes an axe audit with the DIRECT danger tab open', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openDirectDanger(user);
    await within(dialog).findByRole('button', { name: 'Заблокировать контакт' });

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
  });
});
