import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

function installActiveBot(): void {
  mockDb.chatBots.push({
    chatId: IDS.groupChat,
    botId: IDS.botActive,
    workspaceId: IDS.workspace,
    enabled: true,
    installedBy: IDS.user,
    installedAt: '2026-01-11T09:00:00.000Z',
    updatedAt: '2026-01-11T09:00:00.000Z',
  });
}

function groupMessages(): number {
  const chat = mockDb.chats[IDS.groupChat];
  if (!chat) throw new Error('Mock group chat is missing');
  return chat.messages.length;
}

async function openComposer(): Promise<{
  user: ReturnType<typeof renderApp>['user'];
  store: ReturnType<typeof renderApp>['store'];
  textarea: HTMLElement;
}> {
  const { user, store } = renderApp();
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  const textarea = await screen.findByLabelText('Текст сообщения');
  await waitFor(() => expect(store.bots.getSnapshot().chat.status).toBe('ready'));
  return { user, store, textarea };
}

describe('#98 slash commands in the composer', () => {
  it('offers installed commands and invokes the 202 endpoint without a fake message', async () => {
    installActiveBot();
    const before = groupMessages();
    const { user, textarea } = await openComposer();

    await user.type(textarea, '/ec');
    const listbox = await screen.findByRole('listbox', { name: 'Slash-команды ботов' });
    const option = await within(listbox).findByRole('option', { name: /\/echo/ });
    expect(option).toHaveTextContent('/echo');
    expect(option).toHaveTextContent('Повторить текст');
    expect(option).toHaveTextContent('Сова Помощник');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('/echo '));
    await user.type(textarea, 'проверка');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(
        'Команда /echo отправлена боту «Сова Помощник». Ответ появится сообщением.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      const request = mockDb.botRequests.find(
        (item) => item.action === 'command' && item.command === 'echo',
      );
      expect(request).toMatchObject({ command: 'echo', args: 'проверка', chatId: IDS.groupChat });
    });
    // 202 only: no chat message and no optimistic bubble.
    expect(groupMessages()).toBe(before);
    expect(
      mockDb.chats[IDS.groupChat]?.messages.some((m) => (m.text ?? '').includes('проверка')),
    ).toBe(false);
    expect(screen.queryByText('проверка')).toBeNull();
    // The bot got a signed slash_command delivery (answered later via response_url).
    expect(mockDb.botDeliveries.at(-1)).toMatchObject({
      event_type: 'slash_command',
      chat_id: IDS.groupChat,
      botId: IDS.botActive,
      status: 'PENDING',
    });
  });

  it('surfaces an ambiguous-command 409 and restores the draft without a message', async () => {
    installActiveBot();
    mockDb.forceBotCommandError = {
      status: 409,
      code: 'BOT_COMMAND_AMBIGUOUS',
      message: 'More than one installed bot registers this command',
    };
    const before = groupMessages();
    const { user, textarea } = await openComposer();

    await user.type(textarea, '/echo fail');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(
        'Команду зарегистрировали несколько ботов — вызов отклонён. Уточните команду.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(textarea).toHaveValue('/echo fail'));
    expect(groupMessages()).toBe(before);
    expect(screen.queryByText(/Команда \/echo отправлена/)).toBeNull();
  });

  it('explains an unconfigured bot (422) honestly', async () => {
    installActiveBot();
    mockDb.forceBotCommandError = {
      status: 422,
      code: 'BOT_EVENTS_NOT_CONFIGURED',
      message: 'events_url and signing secret are required',
    };
    const { user, textarea } = await openComposer();

    await user.type(textarea, '/status now');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByText('У бота нет активного events URL и signing secret.'),
    ).toBeInTheDocument();
  });

  it('sends an unknown slash text as an ordinary message, not an invocation', async () => {
    installActiveBot();
    const { user, textarea } = await openComposer();
    const beforeCommands = mockDb.botRequests.filter((item) => item.action === 'command').length;

    await user.type(textarea, '/unknown');
    expect(await screen.findByText('Нет подходящих команд.')).toBeInTheDocument();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mockDb.sendAttempts.length).toBeGreaterThan(0));
    expect(mockDb.botRequests.filter((item) => item.action === 'command')).toHaveLength(
      beforeCommands,
    );
    await waitFor(() => expect(screen.queryByText('Нет подходящих команд.')).toBeNull());
  });

  it('passes an axe audit with the command palette open', async () => {
    installActiveBot();
    const { user, textarea } = await openComposer();
    await user.type(textarea, '/');
    expect(await screen.findByRole('listbox', { name: 'Slash-команды ботов' })).toBeInTheDocument();

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
