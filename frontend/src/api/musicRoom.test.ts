import { describe, expect, it } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { IDS, mockSession } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { createApi } from './endpoints';
import { ApiClient } from './http';
import { isApiError } from './problem';

const GROUP = IDS.groupChat;
const WORKSPACE = IDS.workspace;

function makeApi() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
  return createApi(client, { devSession: true });
}

async function expectCode(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe('#94 Music Room API', () => {
  it('opens the workspace room idempotently and lists it in the chat list', async () => {
    setSession(mockSession);
    const api = makeApi();

    const first = await api.openMusicRoom(WORKSPACE);
    expect(first.created).toBe(true);
    expect(first.chat).toMatchObject({
      type: 'GROUP',
      security_mode: 'MANAGED',
      visibility: 'PUBLIC',
      name: 'Музыкальная комната',
      join_policy: 'OPEN',
    });
    expect(first.plugin).toMatchObject({
      plugin_id: 'music-room',
      enabled: true,
      available: true,
      version: '1.0.0',
    });
    const chatId = first.chat.id;
    expect(mockDb.chatPlugins.get(chatId)?.get('music-room')).toBe(true);

    const second = await api.openMusicRoom(WORKSPACE);
    expect(second.created).toBe(false);
    expect(second.chat.id).toBe(chatId);
    expect(mockDb.musicRoomOpenRequests).toHaveLength(2);

    const chats = await api.listChats(WORKSPACE);
    expect(chats.items.some((chat) => chat.id === chatId)).toBe(true);
  });

  it('never creates two rooms under concurrent opens', async () => {
    setSession(mockSession);
    const api = makeApi();
    const [left, right] = await Promise.all([
      api.openMusicRoom(WORKSPACE),
      api.openMusicRoom(WORKSPACE),
    ]);
    expect(left.created === right.created).toBe(false);
    expect(left.chat.id).toBe(right.chat.id);
    expect(mockDb.musicRoomChats.size).toBe(1);
  });

  it('returns metadata-only AUDIO tracks when the plugin is enabled', async () => {
    setSession(mockSession);
    mockDb.chatPlugins.set(GROUP, new Map([['music-room', true]]));
    const api = makeApi();

    const room = await api.getMusicRoom(GROUP);
    expect(room.chat_id).toBe(GROUP);
    expect(room.plugin.version).toBe('1.0.0');
    expect(room.items).toHaveLength(2);
    expect(room.items[0]).toMatchObject({
      title: 'Ночная сова',
      artist: 'Сова',
      duration_ms: 214_000,
      size_bytes: 5_242_880,
      mime_type: 'audio/mpeg',
    });
    expect(room.items[0]).not.toHaveProperty('url');
    expect(room.items[0]).not.toHaveProperty('sha256');
    expect(room.has_more).toBe(false);
    expect(mockDb.musicRoomTrackRequests).toHaveLength(1);
  });

  it('rejects a disabled plugin, E2EE chat and foreign chat', async () => {
    setSession(mockSession);
    const api = makeApi();

    await expectCode(api.getMusicRoom(GROUP), 422, 'PLUGIN_NOT_ENABLED');

    mockDb.chatPlugins.set(GROUP, new Map([['music-room', true]]));
    mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
    await expectCode(api.getMusicRoom(GROUP), 422, 'PLUGIN_NOT_AVAILABLE');

    mockDb.chats[GROUP]!.summary.security_mode = 'MANAGED';
    await expectCode(api.getMusicRoom('ffffffff-ffff-4fff-8fff-ffffffffffff'), 404, 'NOT_FOUND');
  });

  it('surfaces open errors honestly (catalog disabled / E2EE workspace)', async () => {
    setSession(mockSession);
    const api = makeApi();
    const catalog = mockDb.pluginCatalog.find((plugin) => plugin.id === 'music-room');
    if (!catalog) throw new Error('music-room plugin is missing');
    catalog.state = 'DISABLED';
    await expectCode(api.openMusicRoom(WORKSPACE), 422, 'PLUGIN_DISABLED');

    catalog.state = 'ACTIVE';
    mockDb.me = {
      ...mockDb.me,
      workspaces: mockDb.me.workspaces.map((workspace) => ({
        ...workspace,
        security_mode: 'E2EE',
      })),
    };
    await expectCode(api.openMusicRoom(WORKSPACE), 422, 'PLUGIN_NOT_AVAILABLE');
  });
});
