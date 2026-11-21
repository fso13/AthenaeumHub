import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { insertMockBotMessage, insertMockMessage } from '../mocks/db';
import { IDS, MOCK_BOT_TOKENS } from '../mocks/fixtures';
import type { ChatStore } from '../store/chatStore';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const CHAT = IDS.groupChat;
const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function activeBot(): { id: string; name: string } {
  const bot = mockDb.bots.find((item) => item.id === IDS.botActive);
  if (!bot) throw new Error('Active mock bot is missing');
  return { id: bot.id, name: bot.name };
}

function installActiveBot(): void {
  mockDb.chatBots.push({
    chatId: CHAT,
    botId: IDS.botActive,
    workspaceId: IDS.workspace,
    enabled: true,
    installedBy: IDS.user,
    installedAt: '2026-01-11T09:00:00.000Z',
    updatedAt: '2026-01-11T09:00:00.000Z',
  });
}

async function waitForChat(store: ChatStore): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await waitFor(() => expect(store.getSnapshot().slices[CHAT]?.status).toBe('ready'));
}

function rowForText(text: string): HTMLElement {
  const node = screen.getByText(text).closest('article');
  if (!node) throw new Error(`Message row is missing: ${text}`);
  return node as HTMLElement;
}

describe('#96 BOT sender identity in the feed', () => {
  it('draws the BOT badge by sender_type and hides edit/delete, reactions stay', async () => {
    const bot = activeBot();
    const message = insertMockBotMessage(mockDb, CHAT, bot, 'Привет от бота');
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowForText('Привет от бота');
    expect(row).toHaveTextContent('БОТ');
    expect(screen.getByText('Сова Помощник')).toBeInTheDocument();
    // Identity is a badge, not a viewer-owned row.
    expect(within(row).queryByText('Вы')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Редактировать сообщение' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Удалить сообщение' })).toBeNull();
    // Reactions and replies remain available for a bot message.
    expect(within(row).getByRole('button', { name: 'Поставить реакцию' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Ответить/ })).toBeInTheDocument();

    // The rendered row never leaks the mock credential.
    expect(document.body.textContent ?? '').not.toContain(MOCK_BOT_TOKENS.active);
    expect(message.sender_type).toBe('BOT');
    expect(message.sender_id).toBeNull();
  });

  it('does not label a user message as a bot even when it uses the bot name', async () => {
    const bot = activeBot();
    insertMockMessage(mockDb, CHAT, 'Это пишет человек', {
      id: IDS.mark,
      name: bot.name,
    });
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowForText('Это пишет человек');
    expect(row).not.toHaveTextContent('БОТ');
  });

  it('shows the BOT badge for a message created through the bot token API', async () => {
    installActiveBot();
    const bot = activeBot();
    const response = await fetch(`http://api.test/api/v1/bots/${bot.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_BOT_TOKENS.active}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'f0e1d2c3-b4a5-4968-8778-99aabbccddee',
      },
      body: JSON.stringify({ chat_id: CHAT, text: 'Сообщение через bot token' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      sender_type: 'BOT',
      bot_id: bot.id,
      sender_id: null,
      sender_display_name: bot.name,
    });

    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowForText('Сообщение через bot token');
    expect(row).toHaveTextContent('БОТ');
    expect(within(row).queryByRole('button', { name: 'Удалить сообщение' })).toBeNull();
  });
});
