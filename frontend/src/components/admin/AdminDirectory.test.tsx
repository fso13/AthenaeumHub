import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { AdminChat, AdminStorage, AdminUser } from '../../api/types';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { setMockPlatformAdmin } from '../../mocks/db';
import { navigate } from '../../router/router';
import { mockDb, server } from '../../test/server';
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

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

function makeChat(id: string, workspaceId: string, overrides: Partial<AdminChat> = {}): AdminChat {
  return {
    id,
    name: id,
    type: 'GROUP',
    security_mode: 'MANAGED',
    workspace_id: workspaceId,
    workspace_name: workspaceId === WORKSPACE_B ? 'Лаборатория «Полюс»' : 'Студия «Восход»',
    members_count: 4,
    messages_count: 12,
    created_at: '2026-01-02T10:00:00Z',
    last_activity_at: '2026-01-03T11:30:00Z',
    ...overrides,
  };
}

function makeStorage(overrides: Partial<AdminStorage> = {}): AdminStorage {
  return {
    totals: { used_bytes: 3072, reserved_bytes: 512, objects: 2, attachments: 3 },
    workspaces: [
      {
        workspace_id: WORKSPACE_A,
        workspace_name: 'Студия «Восход»',
        security_mode: 'MANAGED',
        used_bytes: 2048,
        reserved_bytes: 0,
        storage_limit_bytes: 8192,
        objects: 1,
        attachments: 2,
      },
      {
        workspace_id: WORKSPACE_B,
        workspace_name: 'Лаборатория «Полюс»',
        security_mode: 'E2EE',
        used_bytes: 1024,
        reserved_bytes: 512,
        storage_limit_bytes: 0,
        objects: 1,
        attachments: 1,
      },
    ],
    ...overrides,
  };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

async function openAdmin(user: TestUser, tab?: 'users' | 'chats' | 'storage' | 'settings') {
  await login(user);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  navigate(tab ? `/admin?tab=${tab}` : '/admin');
  await screen.findByRole('heading', { name: 'Администрирование' });
}

describe('E9-F admin directory UI', () => {
  it('lists users and appends the next cursor page', async () => {
    mockDb.adminDirectory.usersOverride = Array.from({ length: 30 }, (_, index) =>
      makeUser(index + 1),
    );
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    expect(await screen.findByText('Показано: 25')).toBeInTheDocument();
    expect(screen.getByText('user30@example.test')).toBeInTheDocument();
    expect(screen.queryByText('user05@example.test')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));

    expect(await screen.findByText('Показано: 30')).toBeInTheDocument();
    expect(screen.getByText('user01@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();

    const requests = mockDb.adminDirectory.usersRequests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ cursor: null, limit: 25 });
    expect(requests[1]?.cursor).toBeTruthy();
    expect(requests[1]?.query).toBeNull();
  });

  it('filters users by a debounced search and resets it', async () => {
    mockDb.adminDirectory.usersOverride = [
      makeUser(1, { email: 'anna@example.test', display_name: 'Анна Петрова' }),
      makeUser(2, { email: 'boris@example.test', display_name: 'Борис Ким' }),
      makeUser(3, { email: 'vera@example.test', display_name: 'Вера Лит' }),
    ];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Поиск по email или имени'), 'anna');

    await waitFor(() => {
      expect(screen.queryByText('boris@example.test')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    expect(screen.getByText('anna@example.test')).toBeInTheDocument();
    expect(mockDb.adminDirectory.usersRequests.at(-1)?.query).toBe('anna');

    await user.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();
    expect(mockDb.adminDirectory.usersRequests.at(-1)?.query).toBeNull();
  });

  it('shows the users skeleton while loading', async () => {
    mockDb.adminDirectory.usersOverride = [makeUser(1)];
    mockDb.adminDirectory.usersDelayMs = 250;
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    expect(await screen.findByText('Загружаем пользователей…')).toBeInTheDocument();
    expect(await screen.findByText('user01@example.test')).toBeInTheDocument();
  });

  it('surfaces a users error and retries with the same filters', async () => {
    mockDb.adminDirectory.usersOverride = [makeUser(1)];
    mockDb.adminDirectory.forceUsersError = {
      status: 500,
      code: 'INTERNAL',
      message: 'boom',
    };
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить пользователей.',
    );

    mockDb.adminDirectory.forceUsersError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('user01@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps loaded users visible when a refresh fails', async () => {
    mockDb.adminDirectory.usersOverride = [makeUser(1)];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');
    expect(await screen.findByText('user01@example.test')).toBeInTheDocument();

    mockDb.adminDirectory.forceUsersError = { status: 500, code: 'INTERNAL', message: 'boom' };
    await user.click(screen.getByRole('button', { name: 'Обновить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить пользователей.',
    );
    expect(screen.getByText('user01@example.test')).toBeInTheDocument();
  });

  it('filters chats by workspace, type and name', async () => {
    mockDb.adminDirectory.storageOverride = makeStorage();
    mockDb.adminDirectory.chatsOverride = [
      makeChat('chat-a', WORKSPACE_A, { name: 'Команда «Восход»' }),
      makeChat('chat-b', WORKSPACE_A, { name: null, type: 'DIRECT', members_count: 2 }),
      makeChat('chat-c', WORKSPACE_B, { name: 'Проект «Полюс»', security_mode: 'E2EE' }),
    ];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'chats');

    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();
    expect(screen.getByText('Без названия')).toBeInTheDocument();
    expect(screen.getByText('Проект «Полюс»')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Пространство'), WORKSPACE_B);
    expect(await screen.findByText('Показано: 1')).toBeInTheDocument();
    expect(screen.queryByText('Команда «Восход»')).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.chatsRequests.at(-1)).toMatchObject({
      workspaceId: WORKSPACE_B,
      type: null,
      query: null,
    });

    await user.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Тип чата'), 'GROUP');
    expect(await screen.findByText('Показано: 2')).toBeInTheDocument();
    expect(screen.queryByText('Без названия')).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.chatsRequests.at(-1)?.type).toBe('GROUP');

    await user.type(screen.getByLabelText('Поиск по имени чата'), 'Полюс');
    await waitFor(() => {
      expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Команда «Восход»')).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.chatsRequests.at(-1)?.query).toBe('Полюс');
  });

  it('renders storage totals, per-workspace rows and limit bars without pagination', async () => {
    mockDb.adminDirectory.storageOverride = makeStorage();
    const { user } = renderPasswordApp();
    await openAdmin(user, 'storage');

    const totals = await screen.findByRole('group', { name: 'Итоги хранилища' });
    expect(within(totals).getByText('3 КБ')).toBeInTheDocument();
    expect(within(totals).getByText('512 Б')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: /Студия «Восход».*25%/ });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('Без лимита')).toBeInTheDocument();
    expect(screen.getByText('Лаборатория «Полюс»')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('switches sections with the keyboard and keeps the URL deep-linkable', async () => {
    const { user } = renderPasswordApp();
    await openAdmin(user);

    const overviewTab = screen.getByRole('tab', { name: 'Обзор' });
    overviewTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Пользователи' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(window.location.search).toContain('tab=users');

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Настройки' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Параметры установки' })).toBeInTheDocument();
  });

  it('renders every required user column as a labelled card cell', async () => {
    mockDb.adminDirectory.usersOverride = [makeUser(1)];
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    const row = (await screen.findAllByRole('listitem')).find((item) =>
      item.textContent?.includes('user01@example.test'),
    );
    expect(row).toBeDefined();
    const labels = [...row!.querySelectorAll('dt')].map((term) => term.textContent);
    expect(labels).toEqual([
      'Email',
      'Имя',
      'Статус',
      'Админ',
      'Пространства',
      'Чаты',
      'Место',
      'Регистрация',
      'Действия',
    ]);
    expect(row!.querySelectorAll('dd')).toHaveLength(9);
    // The directory is list/card based: no table that could overflow on 390 px.
    expect(document.querySelector('.admin-panel table')).toBeNull();
    expect(within(row as HTMLElement).getByText('Активен')).toBeInTheDocument();
  });

  it('shows the 403 screen when the server rejects a directory read', async () => {
    // `/me` still claims admin (stale token), but the server is the source of
    // truth: any directory 403 must replace the whole admin surface.
    server.use(
      http.get('*/api/v1/admin/users', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Platform admin access is required', request_id: 'req_1' },
          { status: 403 },
        ),
      ),
    );
    const { user } = renderPasswordApp();
    await openAdmin(user, 'users');

    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Администрирование' })).not.toBeInTheDocument();
  });

  it('never calls the admin directory for a non-admin deep link', async () => {
    setMockPlatformAdmin(mockDb, false);
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    navigate('/admin?tab=users');

    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Администрирование' })).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.usersRequests).toHaveLength(0);
  });
});
