import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { insertMockMessage, setMockWorkspaces } from '../mocks/db';
import { publishMockMessageCreated } from '../mocks/realtime';
import { mockDb, server } from '../test/server';
import { renderApp, renderPasswordApp } from '../test/renderApp';
import { formatUnreadBadge, sumUnread } from '../domain/unread';
import { parseView, withView } from '../router/views';
import { workspaceUnreadTotals } from './AppShell';
import { SpaceRail } from './SpaceRail';

const GROUP = IDS.groupChat;
const DIRECT = IDS.directChat;
const SECOND_WORKSPACE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Второе пространство',
  slug: 'second',
  role: 'MEMBER' as const,
  security_mode: 'MANAGED' as const,
};
const SECOND_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function login(user: ReturnType<typeof renderPasswordApp>['user']): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await waitForChat();
}

function addSecondWorkspaceWithUnread(unread: number): void {
  setMockWorkspaces(mockDb, [
    {
      id: IDS.workspace,
      name: 'Студия «Восход»',
      slug: 'studiya-voshod',
      role: 'OWNER',
      security_mode: 'MANAGED',
    },
    SECOND_WORKSPACE,
  ]);
  mockDb.chats[SECOND_CHAT] = {
    summary: {
      id: SECOND_CHAT,
      name: 'Второй чат',
      type: 'GROUP',
      security_mode: 'MANAGED',
      last_message_at: null,
      unread_count: unread,
      last_seq: 0,
    },
    workspaceId: SECOND_WORKSPACE.id,
    messages: [],
    clientMessageIds: new Map(),
  };
}

function addAttachmentFixture(): void {
  const messages = mockDb.chats[GROUP]?.messages ?? [];
  const message = messages[messages.length - 1];
  if (!message) throw new Error('mock message missing');
  message.attachments = [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      filename: 'atlas-cover.png',
      size_bytes: 1024,
      mime_type: 'image/png',
      scan_status: 'CLEAN',
    },
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      filename: 'interview-team.m4a',
      size_bytes: 2048,
      mime_type: 'audio/mp4',
      scan_status: 'CLEAN',
    },
  ];
}

describe('D1-FE1 space rail', () => {
  it('caps the badge at 99+ and keeps the exact number in aria-label', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SpaceRail
        spaces={[
          { id: 'space-a', name: 'Студия', security_mode: 'MANAGED' },
          { id: 'space-b', name: 'Семья', security_mode: 'MANAGED' },
        ]}
        activeSpaceId="space-a"
        unreadBySpace={{ 'space-a': 150, 'space-b': 0 }}
        onSelect={onSelect}
      />,
    );

    const active = screen.getByRole('button', { name: /Студия.*150/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(within(active).getByText('99+')).toBeInTheDocument();

    const quiet = screen.getByRole('button', { name: 'Пространство: Семья' });
    expect(within(quiet).queryByText('0')).not.toBeInTheDocument();
    expect(within(quiet).queryByText('99+')).not.toBeInTheDocument();

    await user.click(quiet);
    expect(onSelect).toHaveBeenCalledWith('space-b');
  });

  it('uses the 99/100 boundary and sums ChatSummary.unread_count', () => {
    expect(formatUnreadBadge(0)).toBeNull();
    expect(formatUnreadBadge(1)).toBe('1');
    expect(formatUnreadBadge(99)).toBe('99');
    expect(formatUnreadBadge(100)).toBe('99+');
    expect(formatUnreadBadge(1000)).toBe('99+');
    expect(sumUnread([{ unread_count: 50 }, { unread_count: 49 }])).toBe(99);
    expect(sumUnread([{ unread_count: 50 }, { unread_count: 50 }])).toBe(100);
    expect(sumUnread([{ unread_count: 0 }, { unread_count: 0 }])).toBe(0);
  });

  it('shows an inactive workspace badge from its cached chat list and switches space', async () => {
    addSecondWorkspaceWithUnread(123);
    const { user, store } = renderPasswordApp();
    await login(user);

    const rail = screen.getByRole('navigation', { name: 'Пространства' });
    const second = await within(rail).findByRole('button', { name: /Второе пространство.*123/ });
    expect(within(second).getByText('99+')).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: /Студия «Восход»/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(second);
    await waitFor(() => expect(store.getSnapshot().activeWorkspaceId).toBe(SECOND_WORKSPACE.id));
    expect(screen.getByRole('button', { name: /Второе пространство/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('recalculates the rail badge after a live message and after markRead', async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      const { store } = renderApp({ realtimeEnabled: true });
      await waitForChat();
      await vi.waitFor(() => expect(store.getSnapshot().realtimeStatus).toBe('online'), {
        timeout: 4_000,
      });

      const before = store.getSnapshot().chats.find((chat) => chat.id === GROUP)?.unread_count ?? 0;
      const message = insertMockMessage(mockDb, GROUP, 'Непрочитанное по WS');
      act(() => publishMockMessageCreated(mockDb, message));

      const rail = screen.getByRole('navigation', { name: 'Пространства' });
      await waitFor(() =>
        expect(store.getSnapshot().chats.find((chat) => chat.id === GROUP)?.unread_count).toBe(
          before + 1,
        ),
      );
      const active = within(rail).getByRole('button', { name: /Студия «Восход»/ });
      expect(active).toHaveAccessibleName(new RegExp(String(before + 1)));

      await act(async () => {
        await store.markRead(GROUP, message.seq);
      });
      await waitFor(() =>
        expect(store.getSnapshot().chats.find((chat) => chat.id === GROUP)?.unread_count).toBe(0),
      );
      expect(
        within(rail).getByRole('button', { name: /Студия «Восход»/ }),
      ).not.toHaveAccessibleName(/непрочитанных/);
      store.dispose();
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it('recomputes the active total from chats and keeps cached inactive totals', () => {
    const state = {
      chats: [
        { id: GROUP, unread_count: 70 },
        { id: DIRECT, unread_count: 30 },
      ],
      activeWorkspaceId: 'space-a',
      session: null,
      workspaceUnread: { 'space-a': 1, 'space-b': 42 },
    } as unknown as Parameters<typeof workspaceUnreadTotals>[0];
    expect(workspaceUnreadTotals(state)).toEqual({ 'space-a': 100, 'space-b': 42 });
  });
});

describe('D1-FE1 shell, pages and routing', () => {
  it('routes to Overview, preserves the active chat and returns to it', async () => {
    const { user, store } = renderApp();
    await waitForChat();
    const activeBefore = store.getSnapshot().activeChatId;

    await user.click(screen.getByRole('button', { name: 'Обзор' }));
    expect(await screen.findByRole('heading', { name: 'Обзор' })).toBeInTheDocument();
    expect(window.location.search).toBe('?view=overview');
    expect(screen.getByText(/Здравствуйте/)).toBeInTheDocument();
    expect(store.getSnapshot().activeChatId).toBe(activeBefore);

    await user.click(screen.getByRole('button', { name: 'К чатам' }));
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    expect(window.location.search).toBe('');
    expect(store.getSnapshot().activeChatId).toBe(activeBefore);
  });

  it('opens a quick chat from Overview and returns to the conversation', async () => {
    const { user, store } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Обзор' }));
    await screen.findByRole('heading', { name: 'Обзор' });

    const quick = screen.getByRole('button', { name: 'Анна Петрова' });
    await user.click(quick);
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    expect(store.getSnapshot().activeChatId).toBe(DIRECT);
    expect(window.location.search).toBe('');
  });

  it('renders Files with limits, search and empty state, then filters loaded attachments', async () => {
    addAttachmentFixture();
    const { user, store } = renderApp();
    await waitForChat();
    expect(
      store.getSnapshot().slices[GROUP]?.messages.some((m) => (m.attachments?.length ?? 0) > 0),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Файлы' }));
    await screen.findByRole('heading', { name: 'Файлы' });

    expect(screen.getByText('atlas-cover.png')).toBeInTheDocument();
    expect(screen.getByText('interview-team.m4a')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText(/До .* на файл/)).toBeInTheDocument();
    expect(screen.getByText(/До \d+ файлов в сообщении/)).toBeInTheDocument();
    expect(screen.getByText(/Гостевой лимит:/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');

    await user.type(screen.getByLabelText('Поиск файлов'), 'нет-такого');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));

    await user.click(screen.getByRole('button', { name: 'Аудио' }));
    expect(screen.getByText('interview-team.m4a')).toBeInTheDocument();
    expect(screen.queryByText('atlas-cover.png')).not.toBeInTheDocument();
  });

  it('shows the Files limits error and retries it', async () => {
    server.use(
      http.get('*/api/v1/workspaces/:workspaceId/limits', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'limits failed' }, { status: 500 }),
      ),
    );
    const { user } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Файлы' }));
    await screen.findByRole('heading', { name: 'Файлы' });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить лимиты')).toBeInTheDocument();

    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('renders honest disabled Plugins and Protection pages without fake controls', async () => {
    const { user } = renderApp();
    await waitForChat();

    await user.click(screen.getByRole('button', { name: 'Плагины' }));
    await screen.findByRole('heading', { name: 'Плагины' });
    expect(screen.getByText('Каталог плагинов пока недоступен')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Защита' }));
    await screen.findByRole('heading', { name: 'Защита' });
    expect(screen.getByText('DLP и журнал аудита пока недоступны')).toBeInTheDocument();
    expect(screen.getAllByText('Недоступно')).toHaveLength(2);
  });

  it('switches light/dark theme in Settings and opens existing notification settings', async () => {
    const { user } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await screen.findByRole('heading', { name: 'Настройки' });

    await user.click(screen.getByRole('button', { name: 'Тёмная' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Тёмная' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Светлая' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    await user.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки уведомлений' });
    expect(dialog).toBeInTheDocument();
  });

  it('supports the mobile drawer trigger, closes it on chat selection and uses card file rows', async () => {
    addAttachmentFixture();
    const { user, container } = renderApp();
    await waitForChat();

    const menu = screen.getByRole('button', { name: 'Открыть навигацию' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(screen.getByRole('button', { name: 'Закрыть навигацию' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(container.querySelector('.app')).toHaveClass('app--nav-open');

    const chatList = screen.getByRole('navigation', { name: 'Чаты' });
    await user.click(within(chatList).getByRole('button', { name: /Анна Петрова/ }));
    expect(container.querySelector('.app')).not.toHaveClass('app--nav-open');

    await user.click(screen.getByRole('button', { name: 'Файлы' }));
    await screen.findByRole('heading', { name: 'Файлы' });
    // Card-based rows: there is no table that could overflow at 390 px.
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('.file-row').length).toBeGreaterThan(0);
  });

  it('passes an axe audit on the Overview page', async () => {
    const { user } = renderApp();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Обзор' }));
    await screen.findByRole('heading', { name: 'Обзор' });

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

describe('D1-FE1 view routing helpers', () => {
  it('parses known views, normalises unknown values and preserves other params', () => {
    expect(parseView('/')).toBe('chat');
    expect(parseView('/?view=overview')).toBe('overview');
    expect(parseView('/?view=files')).toBe('files');
    expect(parseView('/?view=plugins')).toBe('plugins');
    expect(parseView('/?view=security')).toBe('security');
    expect(parseView('/?view=settings')).toBe('settings');
    expect(parseView('/?view=unknown')).toBe('chat');

    expect(withView('/?view=overview&x=1', 'settings')).toBe('/?view=settings&x=1');
    expect(withView('/?view=overview', 'chat')).toBe('/');
  });
});
