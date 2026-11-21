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

async function openBotsTab(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
  await user.click(within(dialog).getByRole('tab', { name: 'Боты' }));
  return dialog;
}

function setViewerChatRole(role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'): void {
  const members = mockDb.chatMembers[IDS.groupChat];
  const viewer = members?.find((member) => member.user_id === IDS.user);
  if (!viewer) throw new Error('Viewer chat member is missing');
  viewer.role = role;
}

describe('#96 chat bots tab', () => {
  it('installs an ACTIVE workspace bot and uninstalls it again', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openBotsTab(user);

    expect(await within(dialog).findByText('В чат не установлен ни один бот.')).toBeInTheDocument();
    const select = await within(dialog).findByLabelText('Бот');
    expect(select).toBeEnabled();
    // The disabled workspace bot is not offered for installation.
    expect(within(select).queryByRole('option', { name: 'Релиз-бот' })).toBeNull();
    expect(within(select).getByRole('option', { name: 'Сова Помощник' })).toBeInTheDocument();

    await user.selectOptions(select, IDS.botActive);
    await user.click(within(dialog).getByRole('button', { name: 'Установить в чат' }));

    expect(await within(dialog).findByText('Бот установлен в чат.')).toBeInTheDocument();
    expect(mockDb.chatBots).toHaveLength(1);
    expect(mockDb.chatBots[0]).toMatchObject({
      chatId: IDS.groupChat,
      botId: IDS.botActive,
      enabled: true,
    });
    expect(within(dialog).getByText('Сова Помощник')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Активен').length).toBeGreaterThan(0);
    // Once installed it is no longer in the picker.
    await waitFor(() =>
      expect(within(dialog).queryByRole('option', { name: 'Сова Помощник' })).toBeNull(),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Убрать из чата' }));
    const confirm = await screen.findByRole('dialog', { name: 'Убрать бота из чата?' });
    await user.click(within(confirm).getByRole('button', { name: 'Убрать' }));

    expect(await within(dialog).findByText('Бот убран из чата.')).toBeInTheDocument();
    expect(mockDb.chatBots).toHaveLength(0);
    expect(within(dialog).getByText('В чат не установлен ни один бот.')).toBeInTheDocument();
    expect(mockDb.botRequests.map((request) => request.action)).toContain('install');
    expect(mockDb.botRequests.map((request) => request.action)).toContain('uninstall');
  });

  it('keeps the tab readable but hides install/uninstall from a channel MEMBER', async () => {
    setViewerChatRole('MEMBER');
    const { user } = renderPasswordApp();
    const dialog = await openBotsTab(user);

    expect(
      await within(dialog).findByText(
        'Устанавливать и удалять ботов могут только владелец и администраторы канала.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Бот')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Установить в чат' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Убрать из чата' })).toBeNull();
  });

  it('never offers installation in an E2EE chat', async () => {
    const chat = mockDb.chats[IDS.groupChat];
    if (!chat) throw new Error('Mock group chat is missing');
    chat.summary.security_mode = 'E2EE';
    const { user } = renderPasswordApp();
    const dialog = await openBotsTab(user);

    expect(
      await within(dialog).findByText(
        'В E2EE-канале боты недоступны: сервер не может прочитать сообщение для отправки.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Установить в чат' })).toBeNull();
  });

  it('explains a server-side install failure (disabled bot) and keeps the picker', async () => {
    mockDb.forceChatBotInstallError = {
      status: 422,
      code: 'BOT_DISABLED',
      message: 'Bot is disabled',
    };
    const { user } = renderPasswordApp();
    const dialog = await openBotsTab(user);

    const select = await within(dialog).findByLabelText('Бот');
    await user.selectOptions(select, IDS.botActive);
    await user.click(within(dialog).getByRole('button', { name: 'Установить в чат' }));

    expect(await within(dialog).findByText('Бот отключён в пространстве.')).toBeInTheDocument();
    expect(mockDb.chatBots).toHaveLength(0);
  });

  it('passes an axe audit on the bots tab', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openBotsTab(user);
    expect(await within(dialog).findByLabelText('Бот')).toBeInTheDocument();

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
