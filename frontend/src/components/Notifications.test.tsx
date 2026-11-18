import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '../store/chatStore';
import { IDS } from '../mocks/fixtures';
import { insertMockMessage, insertMockNotification } from '../mocks/db';
import { publishMockMessageCreated } from '../mocks/realtime';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const stores: ChatStore[] = [];

async function renderNotifications() {
  const result = renderApp();
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await screen.findByRole('button', { name: 'Уведомления: 2 непрочитанных' });
  return result;
}

async function openPanel(user: ReturnType<typeof renderApp>['user']): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /Уведомления/ }));
  return screen.findByRole('region', { name: 'Уведомления' });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('E6-F notifications', () => {
  it('shows the unread badge, panel rows and hides notification bodies behind E2EE-safe text', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);

    expect(mockDb.notificationListRequests[0]?.limit).toBe(30);
    expect(within(panel).getAllByText('Новое сообщение')).toHaveLength(2);
    expect(within(panel).getByText('Новое упоминание')).toBeVisible();
    expect(within(panel).getByText('Добро пожаловать в Pickle')).toBeVisible();

    // body=null (E2EE and the default-privacy shape): never render a message text.
    expect(within(panel).getAllByText(/Текст скрыт/).length).toBe(3);
    expect(within(panel).getByText('Макеты готовы — посмотрите, пожалуйста.')).toBeVisible();

    expect(within(panel).getAllByText('Не прочитано')).toHaveLength(2);
    expect(within(panel).getAllByText('Прочитано')).toHaveLength(2);
    expect(within(panel).getAllByText('Сообщение').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Упоминание')).toHaveLength(1);

    // The managed preview is the only body; no fixture message text leaks in.
    expect(within(panel).queryByText(/Созвон в 11:00/)).toBeNull();
  });

  it('marks all notifications read optimistically and updates the server state', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);

    await user.click(within(panel).getByRole('button', { name: 'Прочитать все' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Уведомления' })).toBeInTheDocument();
    });
    expect(mockDb.notifications.every((notification) => notification.read)).toBe(true);
    expect(mockDb.notificationReadRequests).toHaveLength(1);
    expect(mockDb.notificationReadRequests[0]?.body).toEqual({ all: true });
    expect(mockDb.notificationReadRequests[0]?.idempotencyKey).toBeTruthy();
    expect(within(panel).getAllByText('Прочитано')).toHaveLength(4);
  });

  it('rolls the read-all optimistic update back when the server fails', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);
    mockDb.failNextNotificationRead = 1;

    await user.click(within(panel).getByRole('button', { name: 'Прочитать все' }));

    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(/Изменение отменено/);
    expect(
      await screen.findByRole('button', { name: 'Уведомления: 2 непрочитанных' }),
    ).toBeInTheDocument();
    expect(mockDb.notifications.filter((notification) => !notification.read)).toHaveLength(2);
    expect(within(panel).getAllByText('Не прочитано')).toHaveLength(2);
  });

  it('marks one notification read and opens its chat', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);

    await user.click(within(panel).getByRole('button', { name: /Новое упоминание/ }));

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Уведомления' })).toBeNull();
    });
    const mention = mockDb.notifications.find(
      (item) => item.id === 'd0000000-0000-4000-8000-000000000002',
    );
    expect(mention?.read).toBe(true);
    expect(mockDb.notificationReadRequests[0]?.body).toEqual({
      ids: ['d0000000-0000-4000-8000-000000000002'],
      all: false,
    });
    expect(
      await screen.findByRole('button', { name: 'Уведомления: 1 непрочитанных' }),
    ).toBeInTheDocument();
  });

  it('shows the loading state while the first page is in flight', async () => {
    mockDb.notificationsDelayMs = 1_500;
    const { user, store } = renderApp();
    stores.push(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await user.click(screen.getByRole('button', { name: /Уведомления/ }));
    const panel = await screen.findByRole('region', { name: 'Уведомления' });
    expect(within(panel).getByText('Загружаем уведомления…')).toBeInTheDocument();
  });

  it('shows the empty state when there are no notifications', async () => {
    mockDb.notifications = [];
    const { user, store } = renderApp();
    stores.push(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await user.click(await screen.findByRole('button', { name: 'Уведомления' }));
    const panel = await screen.findByRole('region', { name: 'Уведомления' });
    expect(within(panel).getByText('Уведомлений нет')).toBeInTheDocument();
  });

  it('shows the error state and recovers on retry', async () => {
    mockDb.forceNotificationsError = {
      status: 500,
      code: 'INTERNAL',
      message: 'down',
    };
    const { user, store } = renderApp();
    stores.push(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await user.click(await screen.findByRole('button', { name: 'Уведомления' }));
    const panel = await screen.findByRole('region', { name: 'Уведомления' });
    expect(await within(panel).findByText('Не удалось загрузить уведомления')).toBeVisible();

    mockDb.forceNotificationsError = null;
    await user.click(within(panel).getByRole('button', { name: 'Повторить' }));
    expect(await within(panel).findAllByText('Новое сообщение')).toHaveLength(2);
  });

  it('refreshes the badge after a successful /sync', async () => {
    const { store } = await renderNotifications();
    insertMockNotification(mockDb, {
      type: 'MENTION',
      chat_id: IDS.groupChat,
      chat_name: 'Команда «Восход»',
      title: 'Новое упоминание',
    });

    await store.sync();

    expect(
      await screen.findByRole('button', { name: 'Уведомления: 3 непрочитанных' }),
    ).toBeInTheDocument();
  });

  it('refreshes after a live message.created event', async () => {
    const { store } = renderApp({ realtimeEnabled: true });
    stores.push(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await screen.findByRole('button', { name: 'Уведомления: 2 непрочитанных' });
    await vi.waitFor(
      () => {
        expect(store.getSnapshot().realtimeStatus).toBe('online');
      },
      { timeout: 4_000 },
    );

    const message = insertMockMessage(mockDb, IDS.groupChat, 'Живое уведомление');
    act(() => publishMockMessageCreated(mockDb, message));

    expect(
      await screen.findByRole('button', { name: 'Уведомления: 3 непрочитанных' }),
    ).toBeInTheDocument();
  });

  it('closes the panel with Escape and returns focus to the bell', async () => {
    const { user } = await renderNotifications();
    const bell = screen.getByRole('button', { name: /Уведомления/ });
    bell.focus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByRole('region', { name: 'Уведомления' });
    expect(panel).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Уведомления' })).toBeNull();
    });
    expect(bell).toHaveFocus();
    expect(screen.getByText('Непрочитанных уведомлений: 2')).toHaveAttribute('aria-live', 'polite');
  });

  it('rolls back a single read when the server rejects it', async () => {
    const { user, store } = await renderNotifications();
    const panel = await openPanel(user);
    mockDb.failNextNotificationRead = 1;

    await user.click(within(panel).getByRole('button', { name: /Новое упоминание/ }));

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeInTheDocument();
    await waitFor(() => {
      expect(store.getSnapshot().notifications.readError).not.toBeNull();
    });
    expect(store.getSnapshot().notifications.unreadCount).toBe(2);
    expect(
      store
        .getSnapshot()
        .notifications.items.find((item) => item.id === 'd0000000-0000-4000-8000-000000000002')
        ?.read,
    ).toBe(false);
  });

  it('paginates the list with the opaque cursor from the server', async () => {
    for (let index = 0; index < 35; index += 1) {
      insertMockNotification(mockDb, {
        title: `Уведомление ${index}`,
        body: null,
        created_at: new Date(Date.UTC(2026, 10, 16, 7, index, 0)).toISOString(),
      });
    }

    const { user, store } = renderApp();
    stores.push(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await user.click(await screen.findByRole('button', { name: /Уведомления/ }));
    const panel = await screen.findByRole('region', { name: 'Уведомления' });
    await within(panel).findByRole('button', { name: 'Показать ещё' });

    expect(store.getSnapshot().notifications.items).toHaveLength(30);
    await user.click(within(panel).getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => {
      expect(store.getSnapshot().notifications.items).toHaveLength(39);
    });
    expect(store.getSnapshot().notifications.hasMore).toBe(false);
    expect(mockDb.notificationListRequests.length).toBeGreaterThanOrEqual(2);
    expect(mockDb.notificationListRequests.some((request) => request.cursor)).toBe(true);
  });

  it('saves preferences per chat/type/channel and shows server validation errors', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Настройки уведомлений' }));

    const dialog = await screen.findByRole('dialog', { name: 'Настройки уведомлений' });
    await within(dialog).findByText('Сохранённые настройки');
    await user.selectOptions(within(dialog).getByLabelText('Режим'), 'MUTE');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await within(dialog).findByText('Настройка сохранена');
    expect(mockDb.notificationPreferencePatches).toHaveLength(1);
    expect(mockDb.notificationPreferencePatches[0]?.body).toMatchObject({
      type: 'MESSAGE',
      channel: 'IN_APP',
      mode: 'MUTE',
    });
    expect(mockDb.notificationPreferencePatches[0]?.idempotencyKey).toBeTruthy();
    expect(
      mockDb.notificationPreferences.find(
        (preference) =>
          preference.chat_id === null &&
          preference.type === 'MESSAGE' &&
          preference.channel === 'IN_APP',
      )?.mode,
    ).toBe('MUTE');
    expect(within(dialog).getAllByText('Отключено').length).toBeGreaterThan(0);

    mockDb.forceNotificationPrefsError = {
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'bad preference',
    };
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      await within(dialog).findByText('Проверьте значения: тип, канал и режим обязательны.'),
    ).toBeVisible();
  });

  it('scopes a preference to a specific chat', async () => {
    const { user } = await renderNotifications();
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Настройки уведомлений' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки уведомлений' });

    await user.selectOptions(within(dialog).getByLabelText('Чат'), IDS.groupChat);
    await user.selectOptions(within(dialog).getByLabelText('Режим'), 'MUTE');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await within(dialog).findByText('Настройка сохранена');
    expect(mockDb.notificationPreferencePatches[0]?.body).toMatchObject({
      chat_id: IDS.groupChat,
      type: 'MESSAGE',
      channel: 'IN_APP',
      mode: 'MUTE',
    });
  });
});
