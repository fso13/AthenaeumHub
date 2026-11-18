import { act, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertMockThreadReply } from '../mocks/db';
import { IDS, messageId } from '../mocks/fixtures';
import { publishMockMessageCreated } from '../mocks/realtime';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderApp>['user'];

const GROUP = IDS.groupChat;

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`message-${id}`);
  if (!row) throw new Error(`Message row ${id} is not rendered`);
  return row;
}

function mainRowCount(container: HTMLElement): number {
  return container.querySelectorAll('.messages .msg-row').length;
}

async function openThreadFromAction(user: TestUser, id: string): Promise<HTMLElement> {
  const row = rowFor(id);
  await user.click(within(row).getByRole('button', { name: /Начать тред|Открыть тред/ }));
  return screen.findByRole('dialog', { name: 'Тред' });
}

async function openThreadFromLink(user: TestUser, id: string, count: number): Promise<HTMLElement> {
  const row = rowFor(id);
  await user.click(within(row).getByRole('button', { name: `Открыть тред, ответов: ${count}` }));
  return screen.findByRole('dialog', { name: 'Тред' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D1-FE3 thread UI', () => {
  it('opens an empty thread, sends a reply and updates the root summary without touching the feed', async () => {
    const { container, user } = renderApp();
    await waitForChat();
    const rootId = messageId(44);
    const rootRow = rowFor(rootId);
    const before = mainRowCount(container);

    const dialog = await openThreadFromAction(user, rootId);
    expect(within(dialog).getByText('Пока нет ответов')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Ответ в тред')).toBeInTheDocument();
    // Opening the panel never duplicates the root or adds rows to the channel.
    expect(mainRowCount(container)).toBe(before);

    const composer = within(dialog).getByLabelText('Ответ в тред');
    await user.type(composer, 'Первый ответ в треде');
    await user.click(within(dialog).getByRole('button', { name: 'Отправить ответ' }));

    expect(await within(dialog).findByText('Первый ответ в треде')).toBeInTheDocument();
    expect(await within(rootRow).findByText('1 ответ')).toBeInTheDocument();
    expect(mainRowCount(container)).toBe(before);
    // The reply is not rendered as a channel message (only as link preview).
    const main = container.querySelector('.messages') as HTMLElement;
    const bubbleTexts = [...main.querySelectorAll('.bubble-text')].map((node) => node.textContent);
    expect(bubbleTexts).not.toContain('Первый ответ в треде');
    expect(mockDb.sendBodies.at(-1)?.thread_root_id).toBe(rootId);
  });

  it('pages older replies through before_seq and keeps the server order', async () => {
    const rootId = messageId(40);
    for (let index = 0; index < 35; index += 1) {
      insertMockThreadReply(mockDb, GROUP, rootId, `Ответ ${index}`);
    }
    const { user } = renderApp();
    await waitForChat();

    const dialog = await openThreadFromLink(user, rootId, 35);
    await within(dialog).findByText('Ответ 34');
    expect(within(dialog).queryByText('Ответ 0')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Более ранние ответы' }));
    expect(await within(dialog).findByText('Ответ 0')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.thread-panel__body .msg-row')).toHaveLength(35);
    expect(
      within(dialog).queryByRole('button', { name: 'Более ранние ответы' }),
    ).not.toBeInTheDocument();
  });

  it('routes a live thread reply to the panel and updates the root count', async () => {
    const { container, user } = renderApp({ realtimeEnabled: true });
    await waitForChat();
    await screen.findByTitle('Онлайн');
    const rootId = messageId(44);
    const rootRow = rowFor(rootId);
    const before = mainRowCount(container);

    const first = insertMockThreadReply(mockDb, GROUP, rootId, 'Первый live-ответ');
    act(() => publishMockMessageCreated(mockDb, first));
    expect(await within(rootRow).findByText('1 ответ')).toBeInTheDocument();
    const mainBeforeOpen = container.querySelector('.messages') as HTMLElement;
    expect(
      [...mainBeforeOpen.querySelectorAll('.bubble-text')].map((node) => node.textContent),
    ).not.toContain('Первый live-ответ');
    expect(mainRowCount(container)).toBe(before);

    const dialog = await openThreadFromLink(user, rootId, 1);
    expect(await within(dialog).findByText('Первый live-ответ')).toBeInTheDocument();

    const second = insertMockThreadReply(mockDb, GROUP, rootId, 'Второй live-ответ');
    act(() => publishMockMessageCreated(mockDb, second));
    expect(await within(dialog).findByText('Второй live-ответ')).toBeInTheDocument();
    expect(await within(rootRow).findByText('2 ответа')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.thread-panel__body .msg-row')).toHaveLength(2);
    expect(mainRowCount(container)).toBe(before);
  });

  it('does not double-count the summary when REST and WS deliver the same reply', async () => {
    const { user } = renderApp({ realtimeEnabled: true });
    await waitForChat();
    await screen.findByTitle('Онлайн');
    const rootId = messageId(44);
    const rootRow = rowFor(rootId);

    const dialog = await openThreadFromAction(user, rootId);
    const composer = within(dialog).getByLabelText('Ответ в тред');
    await user.type(composer, 'Свой ответ');
    await user.click(within(dialog).getByRole('button', { name: 'Отправить ответ' }));

    expect(await within(dialog).findByText('Свой ответ')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(rootRow).getByText('1 ответ')).toBeInTheDocument();
    });
    expect(within(rootRow).queryByText('2 ответа')).not.toBeInTheDocument();
  });

  it('closes on Escape and by button, traps focus and returns it to the trigger', async () => {
    const { user } = renderApp();
    await waitForChat();
    const rootId = messageId(44);
    const row = rowFor(rootId);
    const trigger = within(row).getByRole('button', { name: /Начать тред/ });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Тред' });
    const close = within(dialog).getByRole('button', { name: 'Закрыть тред' });
    await waitFor(() => expect(close).toHaveFocus());

    for (let index = 0; index < 12; index += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Тред' })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();

    // The explicit close/back control works the same way.
    await user.click(trigger);
    const dialogAgain = await screen.findByRole('dialog', { name: 'Тред' });
    await user.click(within(dialogAgain).getByRole('button', { name: 'Закрыть тред' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Тред' })).not.toBeInTheDocument(),
    );
  });

  it('shows the root-deleted state and disables the composer after a server 422', async () => {
    const { store, user } = renderApp();
    await waitForChat();
    const rootId = messageId(44);
    const dialog = await openThreadFromAction(user, rootId);
    expect(within(dialog).getByLabelText('Ответ в тред')).not.toBeDisabled();

    const root = mockDb.chats[GROUP]?.messages.find((message) => message.id === rootId);
    if (!root) throw new Error('Root fixture is missing');
    root.deleted_at = new Date().toISOString();

    await act(async () => {
      await store.retryThread(GROUP, rootId);
    });

    expect(
      (await within(dialog).findAllByText('Тред недоступен: исходное сообщение удалено.')).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText('Ответ в тред')).toHaveAttribute('readonly');
    expect(within(dialog).getByRole('button', { name: 'Отправить ответ' })).toBeDisabled();
  });

  it('renders an honest disabled thread action in an E2EE chat', async () => {
    const direct = mockDb.chats[IDS.directChat];
    if (!direct) throw new Error('Direct chat fixture is missing');
    direct.summary.security_mode = 'E2EE';
    const { store } = renderApp();
    await waitForChat();

    await act(async () => {
      await store.setActiveChat(IDS.directChat);
    });
    await screen.findByRole('heading', { name: 'Анна Петрова' });

    const disabled = screen.getAllByRole('button', { name: /Треды недоступны/ });
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled[0]).toBeDisabled();
    expect(store.threadsAvailable(IDS.directChat)).toBe(false);
    await expect(store.openThread(IDS.directChat, messageId(1))).resolves.toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Тред' })).not.toBeInTheDocument();
  });

  it('shows a thread load error with retry and recovers', async () => {
    mockDb.forceThreadError = { status: 500, code: 'INTERNAL', message: 'Thread list failed' };
    const { user } = renderApp();
    await waitForChat();

    const dialog = await openThreadFromAction(user, messageId(44));
    expect(await within(dialog).findByText('Сервер недоступен')).toBeInTheDocument();
    const retry = within(dialog).getByRole('button', { name: 'Повторить' });

    mockDb.forceThreadError = null;
    await user.click(retry);
    expect(await within(dialog).findByText('Пока нет ответов')).toBeInTheDocument();
  });

  it('shows a load-more error without dropping loaded replies and retries', async () => {
    const rootId = messageId(40);
    for (let index = 0; index < 35; index += 1) {
      insertMockThreadReply(mockDb, GROUP, rootId, `Ответ ${index}`);
    }
    const { user } = renderApp();
    await waitForChat();
    const dialog = await openThreadFromLink(user, rootId, 35);
    await within(dialog).findByText('Ответ 34');

    mockDb.forceThreadError = { status: 500, code: 'INTERNAL', message: 'Thread page failed' };
    await user.click(within(dialog).getByRole('button', { name: 'Более ранние ответы' }));
    expect(await within(dialog).findByText('Не удалось загрузить ответы')).toBeInTheDocument();
    expect(within(dialog).getByText('Ответ 34')).toBeInTheDocument();

    mockDb.forceThreadError = null;
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('Ответ 0')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.thread-panel__body .msg-row')).toHaveLength(35);
  });

  it('renders a mobile sheet with a back control at 390px', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('max-width: 900px'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const { user } = renderApp();
      await waitForChat();
      const dialog = await openThreadFromAction(user, messageId(44));
      expect(dialog).toHaveClass('thread-panel');
      await user.click(within(dialog).getByRole('button', { name: 'Назад' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Тред' })).not.toBeInTheDocument(),
      );
    } finally {
      window.matchMedia = original;
    }
  });

  it('passes an axe audit with the thread panel open', async () => {
    const rootId = messageId(40);
    insertMockThreadReply(mockDb, GROUP, rootId, 'Ответ для аудита');
    const { user } = renderApp();
    await waitForChat();
    const dialog = await openThreadFromLink(user, rootId, 1);
    await within(dialog).findByText('Ответ для аудита');

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    expect(within(dialog).getByRole('heading', { name: 'Тред' })).toBeInTheDocument();
  });
});
