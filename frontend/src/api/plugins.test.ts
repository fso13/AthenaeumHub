import { describe, expect, it } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { IDS, mockSession } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { createApi } from './endpoints';
import { ApiClient } from './http';

const GROUP = IDS.groupChat;

function makeApi() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
  return createApi(client, { devSession: true });
}

describe('D1.1 plugins API', () => {
  it('reads the closed catalog in the server order', async () => {
    setSession(mockSession);
    const api = makeApi();

    const catalog = await api.listPlugins();

    expect(catalog.items.map((plugin) => plugin.id)).toEqual([
      'polls',
      'tasks',
      'translate',
      'telegram',
      'dlp',
    ]);
    expect(catalog.items[0]).toMatchObject({
      name: 'Опросы',
      icon: 'poll',
      permissions: ['MESSAGES', 'MEMBERS'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    });
    expect(mockDb.pluginCatalogRequests).toBe(1);
  });

  it('reads defaults, toggles idempotently and audits only real changes', async () => {
    setSession(mockSession);
    const api = makeApi();

    const initial = await api.listChatPlugins(GROUP);
    expect(initial.items).toHaveLength(5);
    expect(initial.items.every((item) => item.enabled === false)).toBe(true);
    expect(initial.items.every((item) => item.available === true)).toBe(true);
    expect(initial.items.every((item) => item.reason === undefined)).toBe(true);
    expect(initial.items.map((item) => item.plugin_id)).toEqual([
      'polls',
      'tasks',
      'translate',
      'telegram',
      'dlp',
    ]);

    const enabled = await api.updateChatPlugin(GROUP, 'polls', { enabled: true });
    expect(enabled).toEqual({ plugin_id: 'polls', enabled: true, available: true });
    expect(mockDb.chatPluginRequests[0]).toMatchObject({
      chatId: GROUP,
      pluginId: 'polls',
      body: { enabled: true },
    });
    expect(mockDb.chatPluginRequests[0]?.deviceId).toBe(mockSession.device.id);

    // Repeat with the same value: no second audit event, same server row.
    const repeated = await api.updateChatPlugin(GROUP, 'polls', { enabled: true });
    expect(repeated.enabled).toBe(true);
    expect(mockDb.chatPluginAudit).toEqual([{ pluginId: 'polls', enabled: true }]);

    const disabled = await api.updateChatPlugin(GROUP, 'polls', { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(mockDb.chatPluginAudit).toEqual([
      { pluginId: 'polls', enabled: true },
      { pluginId: 'polls', enabled: false },
    ]);
  });

  it('rejects unknown plugins with the contract code', async () => {
    setSession(mockSession);
    const api = makeApi();

    await expect(
      api.updateChatPlugin(GROUP, 'unknown-plugin', { enabled: true }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'PLUGIN_NOT_FOUND',
    });
  });

  it('keeps E2EE fail-closed for reads and writes', async () => {
    const group = mockDb.chats[GROUP];
    if (!group) throw new Error('Mock group chat is missing');
    group.summary.security_mode = 'E2EE';
    setSession(mockSession);
    const api = makeApi();

    const state = await api.listChatPlugins(GROUP);
    expect(state.items.every((item) => item.enabled === false)).toBe(true);
    expect(state.items.every((item) => item.available === false)).toBe(true);
    expect(state.items.every((item) => item.reason === 'PLUGIN_NOT_AVAILABLE')).toBe(true);

    // Enabling and disabling are both rejected; no row/audit is written.
    await expect(api.updateChatPlugin(GROUP, 'polls', { enabled: true })).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_AVAILABLE',
    });
    await expect(api.updateChatPlugin(GROUP, 'polls', { enabled: false })).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_AVAILABLE',
    });
    expect(mockDb.chatPlugins.get(GROUP)?.get('polls') ?? false).toBe(false);
    expect(mockDb.chatPluginAudit).toHaveLength(0);
  });

  it('lets the server enforce chat OWNER/ADMIN', async () => {
    mockDb.me = {
      ...mockDb.me,
      workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role: 'MEMBER' })),
    };
    setSession(mockSession);
    const api = makeApi();

    await expect(api.updateChatPlugin(GROUP, 'polls', { enabled: true })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(mockDb.chatPluginAudit).toHaveLength(0);
  });
});
