import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { insertMockBotMessage } from '../mocks/db';
import { IDS, messageId, SEED_POLL_SEQ } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const CHAT = IDS.groupChat;
const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function waitForChat(store?: ChatStore): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
  if (store) {
    await waitFor(() => expect(store.getSnapshot().slices[CHAT]?.status).toBe('ready'));
  }
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`message-${id}`);
  if (!row) throw new Error(`Message row ${id} is not rendered`);
  return row;
}

function enablePlugins(...plugins: Array<'polls' | 'tasks' | 'translate'>): void {
  mockDb.chatPlugins.set(CHAT, new Map(plugins.map((plugin) => [plugin, true])));
}

async function openMore(
  user: ReturnType<typeof renderApp>['user'],
  row: HTMLElement,
): Promise<HTMLElement> {
  await user.hover(row);
  await user.click(within(row).getByRole('button', { name: 'Ещё действия' }));
  return screen.findByRole('dialog', { name: 'Действия с сообщением' });
}

describe('message action overflow', () => {
  it('keeps only reaction, reply and «…» on the toolbar until the popup opens', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowFor(messageId(37));
    expect(within(row).getByRole('button', { name: 'Поставить реакцию' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Ответить/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Ещё действия' })).toBeInTheDocument();
    // Secondary actions are not in the accessibility tree before opening «…».
    expect(
      within(row).queryByRole('button', { name: 'Редактировать сообщение' }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: 'Удалить сообщение' }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: /Закрепить сообщение|Открепить сообщение/ }),
    ).not.toBeInTheDocument();

    await openMore(result.user, row);
    expect(
      within(row).getByRole('button', { name: 'Редактировать сообщение' }),
    ).toBeInTheDocument();
    expect(
      await within(row).findByRole('button', {
        name: /Закрепить сообщение|Открепить сообщение/,
      }),
    ).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Начать тред/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Удалить сообщение' })).toBeInTheDocument();
  });

  it('supports roving keyboard focus, Escape dismissal and focus return to «…»', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowFor(messageId(37));
    const more = within(row).getByRole('button', { name: 'Ещё действия' });
    more.focus();
    await result.user.keyboard('{Enter}');
    const menu = await screen.findByRole('dialog', { name: 'Действия с сообщением' });
    const edit = within(menu).getByRole('button', { name: 'Редактировать сообщение' });
    await waitFor(() => expect(edit).toHaveFocus());
    const pin = await within(menu).findByRole('button', {
      name: /Закрепить сообщение|Открепить сообщение/,
    });

    await result.user.keyboard('{ArrowDown}');
    expect(pin).toHaveFocus();
    await result.user.keyboard('{ArrowUp}');
    expect(edit).toHaveFocus();
    await result.user.keyboard('{End}');
    expect(within(menu).getByRole('button', { name: 'Удалить сообщение' })).toHaveFocus();
    await result.user.keyboard('{Home}');
    expect(edit).toHaveFocus();

    await result.user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Действия с сообщением' }),
      ).not.toBeInTheDocument(),
    );
    expect(more).toHaveFocus();
  });

  it('preserves bot rules: no edit/delete, reaction and reply remain', async () => {
    const bot = mockDb.bots.find((item) => item.id === IDS.botActive);
    if (!bot) throw new Error('Active mock bot is missing');
    insertMockBotMessage(mockDb, CHAT, bot, 'Привет от бота в overflow');
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = screen.getByText('Привет от бота в overflow').closest('article');
    if (!(row instanceof HTMLElement)) throw new Error('Bot row is not rendered');
    expect(within(row).getByRole('button', { name: 'Поставить реакцию' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Ответить/ })).toBeInTheDocument();

    await openMore(result.user, row);
    expect(
      within(row).queryByRole('button', { name: 'Редактировать сообщение' }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: 'Удалить сообщение' }),
    ).not.toBeInTheDocument();
    // Pinning and thread creation stay available on bot-authored rows.
    expect(
      await within(row).findByRole('button', {
        name: /Закрепить сообщение|Открепить сообщение/,
      }),
    ).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Начать тред/ })).toBeInTheDocument();
  });

  it('preserves structured poll/task rules: disabled edit, delete-for-me only, no thread', async () => {
    enablePlugins('polls');
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(SEED_POLL_SEQ));

    await openMore(result.user, row);
    const edit = within(row).getByRole('button', { name: 'Редактировать сообщение' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Можно редактировать только текстовые сообщения');
    expect(within(row).queryByRole('button', { name: /Начать тред/ })).not.toBeInTheDocument();

    await result.user.click(within(row).getByRole('button', { name: 'Удалить сообщение' }));
    const deleteMenu = await screen.findByRole('dialog', { name: 'Удалить сообщение' });
    expect(within(deleteMenu).getByText('Удалить у себя')).toBeInTheDocument();
    expect(within(deleteMenu).queryByText('Удалить у всех')).not.toBeInTheDocument();
    expect(
      within(deleteMenu).getByText(
        'Карточка скроется только у вас: сам опрос или задача останутся у участников.',
      ),
    ).toBeInTheDocument();
  });

  it('moves translation into the overflow popup when the plugin is enabled', async () => {
    enablePlugins('translate');
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(37));

    await openMore(result.user, row);
    await result.user.click(within(row).getByRole('button', { name: 'Перевести на русский' }));

    await waitFor(() => expect(mockDb.translationRequests).toHaveLength(1));
    expect(mockDb.translationRequests[0]).toMatchObject({
      chatId: CHAT,
      messageId: messageId(37),
      body: { target: 'ru' },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Действия с сообщением' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('passes an axe audit with the overflow popup open', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(37));
    await openMore(result.user, row);

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });
});
