import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_BOT_TOKENS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

function setWorkspaceRole(role: WorkspaceRole): void {
  const workspace = mockDb.me.workspaces[0];
  if (!workspace) throw new Error('Mock workspace is missing');
  workspace.role = role;
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openBots(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Настройки' }));
  await user.click(await screen.findByRole('button', { name: 'Боты' }));
  return screen.findByRole('heading', { name: 'Боты пространства' });
}

function botRow(name: string): HTMLElement {
  const node = screen.getByText(name).closest('li');
  if (!node) throw new Error(`Bot row is missing: ${name}`);
  return node as HTMLElement;
}

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

async function sendWithToken(token: string): Promise<Response> {
  return fetch(`http://api.test/api/v1/bots/${IDS.botActive}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'ce6f6f8e-8e1f-4a6e-9f0d-2b1c7e5a9d10',
    },
    body: JSON.stringify({ chat_id: IDS.groupChat, text: 'Привет от бота' }),
  });
}

describe('#96 workspace bots', () => {
  it('creates a bot, shows the token once, drops it on close and never persists it', async () => {
    const result = renderPasswordApp();
    const { user } = result;
    await openBots(user);

    expect(await screen.findByText('Сова Помощник')).toBeInTheDocument();
    expect(screen.getByText('Релиз-бот')).toBeInTheDocument();
    expect(screen.getAllByText('Отключён').length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText('Имя бота'), '  Тест-бот  ');
    await user.click(screen.getByRole('button', { name: 'Создать бота' }));

    const dialog = await screen.findByRole('dialog', { name: 'Токен бота' });
    const tokenInput = within(dialog).getByRole('textbox', { name: 'Bearer-токен' });
    const token = (tokenInput as HTMLInputElement).value;
    expect(token).toMatch(/^sova_bot_/);
    expect(token.length).toBeGreaterThan(90);
    expect(within(dialog).getByText(/Тест-бот/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Authorization: Bearer/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/chat_id/).length).toBeGreaterThan(0);

    // The created bot is in the server list; only its metadata is exposed.
    const created = mockDb.bots.find((bot) => bot.name === 'Тест-бот');
    expect(created?.token).toBe(token);

    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Токен бота' })).toBeNull());

    // One-time only: closing the modal clears in-memory state and the DOM.
    expect(result.store.bots.getSnapshot().workspace.token).toBeNull();
    expect(screen.queryByDisplayValue(token)).toBeNull();
    expect(screen.getByText('Тест-бот')).toBeInTheDocument();

    expect(mockDb.botRequests.filter((request) => request.action === 'create')).toHaveLength(1);
  });

  it('rotates the token, keeps the old one invalid and never re-shows the previous value', async () => {
    installActiveBot();
    const result = renderPasswordApp();
    const { user } = result;
    await openBots(user);

    await user.click(
      within(botRow('Сова Помощник')).getByRole('button', { name: 'Сменить токен' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Сменить токен бота?' });
    await user.click(within(confirm).getByRole('button', { name: 'Сменить токен' }));

    const dialog = await screen.findByRole('dialog', { name: 'Токен бота' });
    const rotated = (
      within(dialog).getByRole('textbox', { name: 'Bearer-токен' }) as HTMLInputElement
    ).value;
    expect(rotated).toMatch(/^sova_bot_/);
    expect(rotated).not.toBe(MOCK_BOT_TOKENS.active);
    expect(mockDb.bots.find((bot) => bot.id === IDS.botActive)?.token).toBe(rotated);

    const oldResponse = await sendWithToken(MOCK_BOT_TOKENS.active);
    expect(oldResponse.status).toBe(401);
    const newResponse = await sendWithToken(rotated);
    expect(newResponse.status).toBe(201);
    const body = (await newResponse.json()) as Record<string, unknown>;
    expect(body.sender_type).toBe('BOT');
    expect(body.bot_id).toBe(IDS.botActive);
    expect(body.sender_id).toBeNull();
    expect(body.sender_display_name).toBe('Сова Помощник');

    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(result.store.bots.getSnapshot().workspace.token).toBeNull());
    expect(screen.queryByDisplayValue(rotated)).toBeNull();
  });

  it('hides create/rotate/delete from a MEMBER but still shows the readable list', async () => {
    setWorkspaceRole('MEMBER');
    const { user } = renderPasswordApp();
    await openBots(user);

    expect(await screen.findByText(/Управлять ботами могут только владелец/)).toBeInTheDocument();
    expect(screen.getByText('Сова Помощник')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать бота' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сменить токен' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Удалить бота' })).toBeNull();
  });

  it('validates the name locally and explains a server 403 without leaking a token', async () => {
    const { user } = renderPasswordApp();
    await openBots(user);

    await user.click(screen.getByRole('button', { name: 'Создать бота' }));
    expect(await screen.findByText('Введите имя бота.')).toBeInTheDocument();
    expect(mockDb.botRequests.filter((request) => request.action === 'create')).toHaveLength(0);

    mockDb.forceBotCreateError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'OWNER or ADMIN role is required',
    };
    await user.type(screen.getByLabelText('Имя бота'), 'Запрещённый бот');
    await user.click(screen.getByRole('button', { name: 'Создать бота' }));
    expect(
      await screen.findByText('Недостаточно прав: нужен OWNER или ADMIN пространства.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies the token and the curl snippet from the one-time dialog', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      const { user } = renderPasswordApp();
      // userEvent installs its own clipboard stub in setup(); replace it after
      // setup so the component's copy path is the one under test.
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      await openBots(user);
      await user.type(screen.getByLabelText('Имя бота'), 'Копи-бот');
      await user.click(screen.getByRole('button', { name: 'Создать бота' }));

      const dialog = await screen.findByRole('dialog', { name: 'Токен бота' });
      const token = (
        within(dialog).getByRole('textbox', { name: 'Bearer-токен' }) as HTMLInputElement
      ).value;
      await user.click(within(dialog).getByRole('button', { name: 'Скопировать токен' }));
      expect(writeText).toHaveBeenCalledWith(token);
      expect(within(dialog).getAllByText('Скопировано').length).toBeGreaterThan(0);

      await user.click(within(dialog).getByRole('button', { name: 'Скопировать curl' }));
      const curl = writeText.mock.calls.at(-1)?.[0] as string;
      expect(curl).toContain('curl -X POST');
      expect(curl).toContain('Authorization: Bearer');
      expect(curl).toContain('/bots/');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('passes an axe audit with the one-time token dialog open', async () => {
    const { user } = renderPasswordApp();
    await openBots(user);

    await user.type(screen.getByLabelText('Имя бота'), 'Axe-бот');
    await user.click(screen.getByRole('button', { name: 'Создать бота' }));
    expect(await screen.findByRole('dialog', { name: 'Токен бота' })).toBeInTheDocument();

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
