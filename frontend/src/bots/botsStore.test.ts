import { describe, expect, it, vi } from 'vitest';
import type { Bot, BotToken, ChatBot } from '../api/types';
import { createBotsStore, type BotsStoreDeps } from './botsStore';

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const CHAT = '44444444-4444-4444-8444-444444444444';

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'b0000000-0000-4000-8000-000000000001',
    workspace_id: WORKSPACE,
    name: 'Сова Помощник',
    avatar_file_id: null,
    scopes: ['chat.write'],
    status: 'ACTIVE',
    created_by: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-01-10T09:00:00.000Z',
    updated_at: '2026-01-10T09:00:00.000Z',
    token_rotated_at: null,
    ...overrides,
  };
}

function issued(overrides: Partial<Bot> = {}): BotToken {
  return {
    bot: bot(overrides),
    token: `sova_bot_${WORKSPACE}_b0000000-0000-4000-8000-000000000001_${'a'.repeat(43)}`,
  };
}

function chatBot(overrides: Partial<ChatBot> = {}): ChatBot {
  return {
    chat_id: CHAT,
    bot: bot(),
    enabled: true,
    installed_at: '2026-01-11T09:00:00.000Z',
    ...overrides,
  };
}

function deps(overrides: Partial<BotsStoreDeps['api']> = {}): BotsStoreDeps {
  return {
    api: {
      listBots: vi.fn().mockResolvedValue({ items: [bot()] }),
      createBot: vi.fn().mockResolvedValue(issued()),
      updateBot: vi.fn().mockResolvedValue(bot({ status: 'DISABLED' })),
      disableBot: vi.fn().mockResolvedValue(undefined),
      rotateBotToken: vi
        .fn()
        .mockResolvedValue(issued({ token_rotated_at: '2026-02-01T00:00:00Z' })),
      listChatBots: vi.fn().mockResolvedValue({ items: [chatBot()] }),
      installChatBot: vi.fn().mockResolvedValue(chatBot()),
      uninstallChatBot: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe('#96 bots store', () => {
  it('keeps the issued token in memory only and drops it on clearToken/reset', async () => {
    const store = createBotsStore(deps());
    const created = await store.createBot(WORKSPACE, { name: 'Сова', scopes: ['chat.write'] });
    expect(created?.id).toBe(bot().id);
    expect(store.getSnapshot().workspace.token?.token).toMatch(/^sova_bot_/);
    expect(store.getSnapshot().workspace.tokenReason).toBe('created');

    store.clearToken();
    expect(store.getSnapshot().workspace.token).toBeNull();
    expect(store.getSnapshot().workspace.tokenReason).toBeNull();
    // Metadata stays: closing the modal must not reload/erase the list.
    expect(store.getSnapshot().workspace.items).toHaveLength(1);

    await store.rotateBotToken(WORKSPACE, bot().id);
    expect(store.getSnapshot().workspace.tokenReason).toBe('rotated');
    store.reset();
    expect(store.getSnapshot().workspace.token).toBeNull();
    expect(store.getSnapshot().workspace.items).toHaveLength(0);
    store.dispose();
  });

  it('loads the workspace picker and installed chat list in parallel', async () => {
    let resolveBots: (value: { items: Bot[] }) => void = () => undefined;
    let resolveChat: (value: { items: ChatBot[] }) => void = () => undefined;
    const store = createBotsStore(
      deps({
        listBots: vi.fn(
          () =>
            new Promise<{ items: Bot[] }>((resolve) => {
              resolveBots = resolve;
            }),
        ),
        listChatBots: vi.fn(
          () =>
            new Promise<{ items: ChatBot[] }>((resolve) => {
              resolveChat = resolve;
            }),
        ),
      }),
    );

    const workspaceLoad = store.loadWorkspaceBots(WORKSPACE);
    const chatLoad = store.loadChatBots(CHAT);
    resolveBots({ items: [bot()] });
    resolveChat({ items: [chatBot()] });
    await Promise.all([workspaceLoad, chatLoad]);

    expect(store.getSnapshot().workspace.status).toBe('ready');
    expect(store.getSnapshot().workspace.items).toHaveLength(1);
    expect(store.getSnapshot().chat.status).toBe('ready');
    expect(store.getSnapshot().chat.items).toHaveLength(1);
    store.dispose();
  });

  it('re-reads the row after the soft-disable 204 instead of guessing status', async () => {
    const listBots = vi
      .fn()
      .mockResolvedValueOnce({ items: [bot()] })
      .mockResolvedValueOnce({ items: [bot({ status: 'DISABLED' })] });
    const store = createBotsStore(deps({ listBots }));
    await store.loadWorkspaceBots(WORKSPACE);
    expect(store.getSnapshot().workspace.items[0]?.status).toBe('ACTIVE');

    await expect(store.disableBot(WORKSPACE, bot().id)).resolves.toBe(true);
    expect(listBots).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().workspace.items[0]?.status).toBe('DISABLED');
    store.dispose();
  });

  it('removes an installation only after the server confirms it', async () => {
    const store = createBotsStore(deps());
    await store.loadChatBots(CHAT);
    expect(store.getSnapshot().chat.items).toHaveLength(1);

    await expect(store.uninstallChatBot(CHAT, bot().id)).resolves.toBe(true);
    expect(store.getSnapshot().chat.items).toHaveLength(0);
    store.clearChatBots();
    expect(store.getSnapshot().chat.chatId).toBeNull();
    store.dispose();
  });
});
