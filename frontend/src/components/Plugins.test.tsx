import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb, server } from '../test/server';
import { renderApp, renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderApp>['user'];

const GROUP = IDS.groupChat;
const SECOND_GROUP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setWorkspaceRole(role: WorkspaceRole): void {
  mockDb.me = {
    ...mockDb.me,
    workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role })),
  };
}

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await waitForChat();
}

async function openPlugins(user: TestUser): Promise<void> {
  await waitForChat();
  await user.click(screen.getByRole('button', { name: 'Плагины' }));
  await screen.findByRole('heading', { level: 1, name: 'Плагины' });
  await screen.findByRole('heading', { name: 'Опросы' });
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(5));
}

async function waitForReady(): Promise<HTMLElement> {
  const polls = screen.getByRole('switch', { name: 'Включить плагин «Опросы»' });
  await waitFor(() => expect(polls).toBeEnabled());
  return polls;
}

function addSecondGroupChat(): void {
  const group = mockDb.chats[GROUP];
  if (!group) throw new Error('Mock group chat is missing');
  mockDb.chats[SECOND_GROUP] = {
    summary: {
      ...group.summary,
      id: SECOND_GROUP,
      name: 'Второй чат',
      unread_count: 0,
      last_seq: 0,
      security_mode: 'MANAGED',
    },
    workspaceId: group.workspaceId,
    messages: [],
    clientMessageIds: new Map(),
    hiddenMessageIds: new Set(),
  };
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

describe('D1.1 plugin catalog and per-chat state', () => {
  it('renders the five server plugins with descriptions, permissions and modes', async () => {
    const { user } = renderApp();
    await openPlugins(user);

    const names = ['Опросы', 'Задачи', 'Перевод', 'Мост в Telegram', 'DLP-подсказки'];
    for (const name of names) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('switch')).toHaveLength(5);

    const polls = card('Опросы');
    expect(
      within(polls).getByText('Голосования и быстрые решения прямо в переписке.'),
    ).toBeVisible();
    expect(within(polls).getByText('Сообщения')).toBeVisible();
    expect(within(polls).getByText('Участники')).toBeVisible();
    expect(within(polls).getByText('Управляемый')).toBeVisible();

    const telegram = card('Мост в Telegram');
    expect(within(telegram).getByText('Вебхуки')).toBeVisible();

    const dlp = card('DLP-подсказки');
    expect(within(dlp).getByText('Файлы')).toBeVisible();

    // No marketplace/install affordance and no invented plugins.
    expect(screen.queryByRole('button', { name: /Установить/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Стикеры' })).not.toBeInTheDocument();
  });

  it('loads state per chat, switches the selected chat and never applies optimistic state', async () => {
    addSecondGroupChat();
    mockDb.chatPlugins.set(SECOND_GROUP, new Map([['tasks', true]]));
    mockDb.chatPluginPatchDelayMs = 80;

    const { user } = renderApp();
    await openPlugins(user);

    // The active chat is the first GROUP; all switches are server-default off.
    expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    const select = screen.getByRole('combobox', { name: 'Чат' });
    await user.selectOptions(select, SECOND_GROUP);
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Выключить плагин «Задачи»' })).toBeEnabled();
    });
    expect(screen.getByRole('switch', { name: 'Выключить плагин «Задачи»' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Включено 1 из 5')).toBeInTheDocument();

    const polls = screen.getByRole('switch', { name: 'Включить плагин «Опросы»' });
    await user.click(polls);

    // While the PATCH is in flight the old server value is still shown.
    await waitFor(() => expect(mockDb.chatPluginRequests).toHaveLength(1));
    expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toBeDisabled();

    expect(
      await screen.findByText('Плагин «Опросы» включён. Изменение записано в журнал аудита.'),
    ).toBeInTheDocument();
    // The response is the only source of the new value.
    expect(screen.getByRole('switch', { name: 'Выключить плагин «Опросы»' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(mockDb.chatPluginRequests[0]).toMatchObject({
      chatId: SECOND_GROUP,
      pluginId: 'polls',
      body: { enabled: true },
    });
    expect(mockDb.chatPluginRequests[0]?.deviceId).toBeTruthy();
    expect(mockDb.chatPluginAudit).toEqual([{ pluginId: 'polls', enabled: true }]);
  });

  it('keeps the last server value and reports a rejected toggle honestly', async () => {
    const { user } = renderApp();
    await openPlugins(user);
    await waitForReady();
    mockDb.forceChatPluginPatchError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a chat owner/admin',
    };

    await user.click(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Не удалось изменить плагин' }),
    ).toBeVisible();
    expect(
      within(alert).getByText('Недостаточно прав: нужен владелец или администратор чата.'),
    ).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(mockDb.chatPluginAudit).toHaveLength(0);
    expect(mockDb.chatPlugins.get(GROUP)?.get('polls') ?? false).toBe(false);
  });

  it('shows no-op feedback when the server already had the requested value', async () => {
    const { user } = renderApp();
    await openPlugins(user);
    await waitForReady();
    server.use(
      http.patch('*/api/v1/chats/:chatId/plugins/:pluginId', () =>
        HttpResponse.json({ plugin_id: 'polls', enabled: false, available: true }),
      ),
    );

    await user.click(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' }));

    expect(
      await screen.findByText(
        'Сервер уже имел это значение: плагин не изменён и событие аудита не записано.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('disables switches for non-managers with an explicit reason and sends no PATCH', async () => {
    setWorkspaceRole('MEMBER');
    const { user } = renderPasswordApp();
    await login(user);
    await openPlugins(user);

    const polls = screen.getByRole('switch', { name: 'Включить плагин «Опросы»' });
    expect(polls).toBeDisabled();
    expect(
      within(card('Опросы')).getByText('Только владелец или администратор чата'),
    ).toBeVisible();
    expect(mockDb.chatPluginRequests).toHaveLength(0);
  });

  it('keeps E2EE honest: banner, unavailable reason and disabled switches', async () => {
    const group = mockDb.chats[GROUP];
    if (!group) throw new Error('Mock group chat is missing');
    group.summary.security_mode = 'E2EE';

    const { user } = renderApp();
    await openPlugins(user);

    expect(
      screen.getByRole('heading', { name: 'Серверные плагины недоступны в E2EE' }),
    ).toBeVisible();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(5);
    for (const element of switches) expect(element).toBeDisabled();
    expect(within(card('Опросы')).getByText('Недоступен в E2EE')).toBeVisible();
    expect(card('Опросы')).toHaveAttribute('aria-labelledby', 'plugin-title-polls');
    expect(mockDb.chatPluginRequests).toHaveLength(0);
  });

  it('retries a failed catalog read', async () => {
    server.use(
      http.get('*/api/v1/plugins', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'catalog failed' }, { status: 500 }),
      ),
    );
    const { user } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Плагины' }));
    await screen.findByRole('heading', { level: 1, name: 'Плагины' });

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Не удалось загрузить каталог' }),
    ).toBeVisible();

    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Опросы' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('retries a failed chat state read without inventing availability', async () => {
    server.use(
      http.get('*/api/v1/chats/:chatId/plugins', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'state failed' }, { status: 500 }),
      ),
    );
    const { user } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Плагины' }));
    await screen.findByRole('heading', { level: 1, name: 'Плагины' });
    await screen.findByRole('heading', { name: 'Опросы' });

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Не удалось загрузить состояние плагинов' }),
    ).toBeVisible();
    for (const element of screen.getAllByRole('switch')) expect(element).toBeDisabled();

    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Включить плагин «Опросы»' })).toBeEnabled();
    });
  });

  it('passes an axe audit on the plugins page', async () => {
    const { user } = renderApp();
    await openPlugins(user);

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

describe('D1.1 details row', () => {
  it('shows the server enabled count and opens the page on the same chat', async () => {
    mockDb.chatPlugins.set(
      GROUP,
      new Map([
        ['polls', true],
        ['tasks', true],
      ]),
    );
    const { user } = renderApp();
    await waitForChat();

    const row = await screen.findByRole('button', { name: /Плагины чата/ });
    await waitFor(() => expect(row).toHaveTextContent('2'));

    await user.click(row);
    expect(await screen.findByText('2 из 5 включено')).toBeVisible();
    expect(screen.getByText(/Переключать плагины может владелец/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Открыть плагины' }));
    await screen.findByRole('heading', { level: 1, name: 'Плагины' });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Выключить плагин «Опросы»' })).toBeEnabled();
    });
    expect(screen.getByRole('switch', { name: 'Выключить плагин «Задачи»' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
