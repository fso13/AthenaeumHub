import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { AdminChat, AdminUser } from '../../api/types';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, IDS } from '../../mocks/fixtures';
import { mockDb } from '../../test/server';
import { navigate } from '../../router/router';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

function makeUser(index: number, overrides: Partial<AdminUser> = {}): AdminUser {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    email: `user${suffix}@example.test`,
    display_name: `Пользователь ${suffix}`,
    is_platform_admin: false,
    status: 'ACTIVE',
    workspaces_count: 1,
    chats_count: 2,
    storage_used_bytes: 1024,
    created_at: new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString(),
    ...overrides,
  };
}

const TARGET = makeUser(2, { email: 'target@example.test', display_name: 'Цель Действия' });
const SUSPENDED = makeUser(3, {
  email: 'suspended@example.test',
  display_name: 'Заблокированный',
  status: 'SUSPENDED',
});
const OTHER_ADMIN = makeUser(4, {
  email: 'admin2@example.test',
  display_name: 'Второй админ',
  is_platform_admin: true,
});
const DELETED = makeUser(5, { email: 'deleted@example.test', status: 'DELETED' });
const CHAT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHAT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SELF = makeUser(1, { id: IDS.user, email: MOCK_DEMO_EMAIL, is_platform_admin: true });

function seedUsers(): void {
  mockDb.adminDirectory.usersOverride = [SELF, TARGET, SUSPENDED, OTHER_ADMIN, DELETED];
}

function makeChat(id: string, name: string, overrides: Partial<AdminChat> = {}): AdminChat {
  return {
    id,
    name,
    type: 'GROUP',
    security_mode: 'MANAGED',
    workspace_id: '11111111-1111-4111-8111-111111111111',
    workspace_name: 'Студия «Восход»',
    members_count: 4,
    messages_count: 12,
    created_at: '2026-01-02T10:00:00Z',
    last_activity_at: null,
    ...overrides,
  };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

async function openAdmin(user: TestUser, tab: 'users' | 'chats' | 'audit'): Promise<void> {
  await login(user);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  navigate(`/admin?tab=${tab}`);
  await screen.findByRole('heading', { name: 'Администрирование' });
}

async function rowFor(emailOrName: string): Promise<HTMLElement> {
  const rows = await screen.findAllByRole('listitem');
  const row = rows.find((item) => item.textContent?.includes(emailOrName));
  if (!row) throw new Error(`No admin row contains ${emailOrName}`);
  return row;
}

describe('E11-F admin user actions', () => {
  it('suspends a user after a confirm that names the email and refreshes the chip', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    expect(within(row).getByText('Активен')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      within(dialog).getByRole('heading', { name: 'Приостановить пользователя?' }),
    ).toBeVisible();
    expect(within(dialog).getByText(/target@example\.test/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Приостановить' }));

    expect(
      await screen.findByText('Пользователь target@example.test приостановлен: сессии отозваны.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(row).getByText('Заблокирован')).toBeInTheDocument();
    });
    expect(within(row).getByRole('button', { name: 'Активировать' })).toBeInTheDocument();
    expect(mockDb.adminDirectory.userActionRequests).toHaveLength(1);
    expect(mockDb.adminDirectory.userActionRequests[0]).toMatchObject({
      action: 'suspend',
      userId: TARGET.id,
    });
    // The row status the server now returns is authoritative.
    expect(mockDb.adminDirectory.usersRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('activates a suspended user and flips the action back', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('suspended@example.test');
    await user.click(within(row).getByRole('button', { name: 'Активировать' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Активировать пользователя?' }),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Активировать' }));

    expect(
      await screen.findByText('Пользователь suspended@example.test активирован.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(within(row).getByText('Активен')).toBeInTheDocument();
    });
    expect(within(row).getByRole('button', { name: 'Приостановить' })).toBeInTheDocument();
  });

  it('disables self, platform-admin and deleted rows without sending a request', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const selfRow = await rowFor(MOCK_DEMO_EMAIL);
    const selfButton = within(selfRow).getByRole('button', { name: 'Приостановить' });
    expect(selfButton).toBeDisabled();
    expect(within(selfRow).getByText('Нельзя менять свой статус')).toBeInTheDocument();

    const adminRow = await rowFor('admin2@example.test');
    expect(within(adminRow).getByRole('button', { name: 'Приостановить' })).toBeDisabled();
    expect(within(adminRow).getByText('Платформенный админ защищён')).toBeInTheDocument();

    const deletedRow = await rowFor('deleted@example.test');
    expect(within(deletedRow).getByRole('button', { name: 'Нет действий' })).toBeDisabled();

    expect(mockDb.adminDirectory.userActionRequests).toHaveLength(0);
  });

  it('closes on Escape, traps focus and returns it to the trigger', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    const trigger = within(row).getByRole('button', { name: 'Приостановить' });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(mockDb.adminDirectory.userActionRequests).toHaveLength(0);
  });

  it('treats a repeat suspend as reconciled state and does not keep a stale chip', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    // The list was read before the change; the server is already SUSPENDED.
    mockDb.adminDirectory.userStatuses.set(TARGET.id, 'SUSPENDED');
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Приостановить' }));

    expect(
      await screen.findByText('Пользователь уже приостановлен — список обновлён.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(row).getByText('Заблокирован')).toBeInTheDocument();
    });
  });

  it('keeps the dialog open with 403 and never removes the row', async () => {
    seedUsers();
    mockDb.adminDirectory.forceUserActionError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Platform admin access is required',
    };
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Приостановить' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Недостаточно прав: действие доступно только платформенному администратору.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('target@example.test')).toBeInTheDocument();
    expect(within(row).getByText('Активен')).toBeInTheDocument();
  });

  it('offers a retry on 503 and applies the action when the IdP recovers', async () => {
    seedUsers();
    mockDb.adminDirectory.forceUserActionError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak is unavailable',
    };
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Приостановить' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Сервис аутентификации недоступен, изменения не применены. Повторите позже.',
    );
    expect(within(row).getByText('Активен')).toBeInTheDocument();

    mockDb.adminDirectory.forceUserActionError = null;
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));

    expect(
      await screen.findByText('Пользователь target@example.test приостановлен: сессии отозваны.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(within(row).getByText('Заблокирован')).toBeInTheDocument();
    });
  });

  it('closes on 404 with a warning and keeps the row until the refresh answers', async () => {
    seedUsers();
    mockDb.adminDirectory.forceUserActionError = {
      status: 404,
      code: 'NOT_FOUND',
      message: 'User not found',
    };
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Приостановить' }));

    expect(
      await screen.findByText('Пользователь не найден: возможно, он удалён. Список обновлён.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('target@example.test')).toBeInTheDocument();
    expect(mockDb.adminDirectory.usersRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('passes an axe audit with the confirm dialog open', async () => {
    seedUsers();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = await rowFor('target@example.test');
    await user.click(within(row).getByRole('button', { name: 'Приостановить' }));
    await screen.findByRole('dialog');

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

describe('E11-F admin chat delete', () => {
  it('soft-deletes a chat after a confirm and removes the row', async () => {
    mockDb.adminDirectory.chatsOverride = [
      makeChat(CHAT_A, 'Альфа'),
      makeChat(CHAT_B, 'Бета', { type: 'DIRECT', security_mode: 'E2EE' }),
    ];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'chats');

    expect(await screen.findByText('Показано: 2')).toBeInTheDocument();
    const row = await rowFor('Альфа');
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Удалить чат?' })).toBeVisible();
    expect(within(dialog).getByText('Альфа')).toBeVisible();
    expect(within(dialog).getByText(/Подтвердите удаление чата/)).toBeVisible();
    expect(within(dialog).getByText(/физически не удаляются/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить чат' }));

    expect(
      await screen.findByText('Чат Альфа удалён (soft-delete): сообщения сохранены.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Альфа')).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.chatDeleteRequests).toHaveLength(1);
    expect(mockDb.adminDirectory.chatDeleteRequests[0]?.chatId).toBe(CHAT_A);
  });

  it('reconciles an already deleted chat (409) and drops the row', async () => {
    mockDb.adminDirectory.chatsOverride = [makeChat(CHAT_A, 'Альфа'), makeChat(CHAT_B, 'Бета')];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'chats');
    expect(await screen.findByText('Показано: 2')).toBeInTheDocument();

    // Deleted elsewhere between the read and the action.
    mockDb.adminDirectory.deletedChatIds.add(CHAT_A);
    const row = await rowFor('Альфа');
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Удалить чат' }));

    expect(await screen.findByText('Чат уже удалён — список обновлён.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Альфа')).not.toBeInTheDocument();
  });

  it('keeps the chat row and the dialog open on 503', async () => {
    mockDb.adminDirectory.chatsOverride = [makeChat(CHAT_A, 'Альфа')];
    mockDb.adminDirectory.forceChatDeleteError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'IdP is unavailable',
    };
    const { user } = renderPasswordApp();
    await openAdmin(user, 'chats');

    const row = await rowFor('Альфа');
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Удалить чат' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Сервис аутентификации недоступен, изменения не применены. Повторите позже.',
    );
    expect(row).toBeInTheDocument();
    expect(screen.getByText('Показано: 1')).toBeInTheDocument();
  });
});
