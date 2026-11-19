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

function enable(pluginId: 'polls' | 'tasks' | 'translate'): void {
  const stored = mockDb.chatPlugins.get(GROUP) ?? new Map<string, boolean>();
  stored.set(pluginId, true);
  mockDb.chatPlugins.set(GROUP, stored);
}

describe('D1.1 (#76) poll API', () => {
  it('creates, votes, changes a vote and closes with server aggregates', async () => {
    setSession(mockSession);
    enable('polls');
    const api = makeApi();

    expect(await api.listPolls(GROUP)).toEqual({ items: [] });

    const created = await api.createPoll(GROUP, {
      question: 'Куда идём обедать?',
      options: ['Пицца', 'Суши'],
    });
    expect(created).toMatchObject({
      question: 'Куда идём обедать?',
      creator_id: mockDb.me.user.id,
      closed: false,
      total_votes: 0,
      my_option_id: null,
    });
    expect(created.options.map((option) => [option.position, option.text, option.votes])).toEqual([
      [0, 'Пицца', 0],
      [1, 'Суши', 0],
    ]);

    const [first, second] = created.options;
    if (!first || !second) throw new Error('Poll options missing');

    const voted = await api.votePoll(GROUP, created.id, { option_id: first.id });
    expect(voted.total_votes).toBe(1);
    expect(voted.my_option_id).toBe(first.id);
    expect(voted.options[0]?.votes).toBe(1);

    // Same option: idempotent, one unique voter.
    const repeated = await api.votePoll(GROUP, created.id, { option_id: first.id });
    expect(repeated.total_votes).toBe(1);

    // Different option replaces the vote instead of adding one.
    const changed = await api.votePoll(GROUP, created.id, { option_id: second.id });
    expect(changed.total_votes).toBe(1);
    expect(changed.my_option_id).toBe(second.id);
    expect(changed.options[0]?.votes).toBe(0);
    expect(changed.options[1]?.votes).toBe(1);

    const closed = await api.closePoll(GROUP, created.id, { closed: true });
    expect(closed.closed).toBe(true);
    expect(closed.closed_at).toEqual(expect.any(String));
    await expect(api.votePoll(GROUP, created.id, { option_id: first.id })).rejects.toMatchObject({
      status: 422,
      code: 'POLL_CLOSED',
    });
    // Repeated close is idempotent.
    await expect(api.closePoll(GROUP, created.id, { closed: true })).resolves.toMatchObject({
      closed: true,
    });
  });

  it('rejects an option from another poll and a non-creator close', async () => {
    setSession(mockSession);
    enable('polls');
    const api = makeApi();

    const first = await api.createPoll(GROUP, { question: 'Первый', options: ['A', 'B'] });
    const second = await api.createPoll(GROUP, { question: 'Второй', options: ['C', 'D'] });
    await expect(
      api.votePoll(GROUP, first.id, { option_id: second.options[0]!.id }),
    ).rejects.toMatchObject({ status: 422, code: 'POLL_OPTION_INVALID' });

    const record = mockDb.polls.get(first.id);
    if (!record) throw new Error('Poll record missing');
    record.poll.creator_id = IDS.anna;
    await expect(api.closePoll(GROUP, first.id, { closed: true })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    // `closed=false` is invalid regardless of the caller.
    await expect(api.closePoll(GROUP, first.id, { closed: false })).rejects.toMatchObject({
      status: 422,
      code: 'POLL_STATE_INVALID',
    });
  });

  it('validates the create body and the plugin gate', async () => {
    setSession(mockSession);
    enable('polls');
    const api = makeApi();

    await expect(
      api.createPoll(GROUP, { question: '   ', options: ['A', 'B'] }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(
      api.createPoll(GROUP, { question: 'Q', options: ['same', 'same'] }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(
      api.createPoll(GROUP, { question: 'Q', options: ['only-one'] as unknown as string[] }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    mockDb.chatPlugins.clear();
    await expect(api.listPolls(GROUP)).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_ENABLED',
    });
  });

  it('keeps server plugins unavailable in E2EE', async () => {
    mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
    setSession(mockSession);
    enable('polls');
    const api = makeApi();

    await expect(api.listPolls(GROUP)).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_AVAILABLE',
    });
    await expect(
      api.createPoll(GROUP, { question: 'Q', options: ['A', 'B'] }),
    ).rejects.toMatchObject({ status: 422, code: 'PLUGIN_NOT_AVAILABLE' });
  });
});

describe('D1.1 (#76) task API', () => {
  it('creates, orders, completes and reopens a task', async () => {
    setSession(mockSession);
    enable('tasks');
    const api = makeApi();

    expect(await api.listTasks(GROUP)).toEqual({ items: [] });

    const first = await api.createTask(GROUP, {
      title: 'Собрать макеты',
      assignee_id: IDS.anna,
      due_at: '2026-12-01T12:00:00.000Z',
    });
    expect(first).toMatchObject({
      title: 'Собрать макеты',
      creator_id: mockDb.me.user.id,
      assignee_id: IDS.anna,
      due_at: '2026-12-01T12:00:00.000Z',
      done: false,
      completed_by: null,
      completed_at: null,
    });

    const done = await api.updateTask(GROUP, first.id, { done: true });
    expect(done.done).toBe(true);
    expect(done.completed_by).toBe(mockDb.me.user.id);
    expect(done.completed_at).toEqual(expect.any(String));

    const second = await api.createTask(GROUP, { title: 'Сверить текст' });
    const list = await api.listTasks(GROUP);
    expect(list.items.map((task) => [task.title, task.done])).toEqual([
      ['Сверить текст', false],
      ['Собрать макеты', true],
    ]);

    const reopened = await api.updateTask(GROUP, first.id, { done: false });
    expect(reopened.completed_by).toBeNull();
    expect(reopened.completed_at).toBeNull();
    expect(second.done).toBe(false);
  });

  it('rejects a foreign assignee and enforces task permissions', async () => {
    setSession(mockSession);
    enable('tasks');
    const api = makeApi();

    await expect(
      api.createTask(GROUP, {
        title: 'Чужая',
        assignee_id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'TASK_ASSIGNEE_INVALID' });

    const task = await api.createTask(GROUP, { title: 'Только моя' });
    const record = mockDb.tasks.get(task.id);
    if (!record) throw new Error('Task record missing');
    record.task.creator_id = IDS.anna;
    mockDb.me = {
      ...mockDb.me,
      workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role: 'MEMBER' })),
    };
    await expect(api.updateTask(GROUP, task.id, { done: true })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    record.task.assignee_id = mockDb.me.user.id;
    await expect(api.updateTask(GROUP, task.id, { done: true })).resolves.toMatchObject({
      done: true,
    });
  });

  it('keeps the plugin gate and E2EE fail-closed', async () => {
    setSession(mockSession);
    const api = makeApi();
    await expect(api.listTasks(GROUP)).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_ENABLED',
    });

    enable('tasks');
    mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
    await expect(api.listTasks(GROUP)).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_AVAILABLE',
    });
  });
});

describe('D1.1 (#76) translation API', () => {
  it('translates a managed TEXT message through the server', async () => {
    setSession(mockSession);
    enable('translate');
    const api = makeApi();
    const message = mockDb.chats[GROUP]!.messages.find(
      (item) => item.type === 'TEXT' && !item.deleted_at && item.text?.trim(),
    );
    if (!message) throw new Error('No managed TEXT fixture');

    const result = await api.translateMessage(GROUP, message.id, { target: 'en' });
    expect(result.text).toBe(`[en] ${message.text!.replace(/\s+/g, ' ').trim()}`);
    expect(mockDb.translationRequests[0]).toMatchObject({
      chatId: GROUP,
      messageId: message.id,
      body: { target: 'en' },
      deviceId: mockSession.device.id,
    });
  });

  it('returns the honest 503 when the provider is not configured', async () => {
    setSession(mockSession);
    enable('translate');
    mockDb.translationAvailable = false;
    const api = makeApi();
    const message = mockDb.chats[GROUP]!.messages.find((item) => item.type === 'TEXT');
    if (!message) throw new Error('No TEXT fixture');

    await expect(api.translateMessage(GROUP, message.id, { target: 'ru' })).rejects.toMatchObject({
      status: 503,
      code: 'TRANSLATION_UNAVAILABLE',
      retryAfterSeconds: 30,
    });
  });

  it('rejects E2EE, non-TEXT and disabled-plugin calls', async () => {
    setSession(mockSession);
    enable('translate');
    const api = makeApi();
    const text = mockDb.chats[GROUP]!.messages.find((item) => item.type === 'TEXT');
    const sticker = mockDb.chats[GROUP]!.messages.find((item) => item.type === 'STICKER');
    if (!text || !sticker) throw new Error('TEXT/STICKER fixtures missing');

    await expect(api.translateMessage(GROUP, sticker.id, { target: 'en' })).rejects.toMatchObject({
      status: 422,
      code: 'MESSAGE_NOT_TRANSLATABLE',
    });
    await expect(api.translateMessage(GROUP, text.id, { target: 'EN!' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
    await expect(api.translateMessage(GROUP, text.id, { target: 'en' })).rejects.toMatchObject({
      status: 422,
      code: 'E2EE_METADATA_FORBIDDEN',
    });

    mockDb.chats[GROUP]!.summary.security_mode = 'MANAGED';
    mockDb.chatPlugins.clear();
    await expect(api.translateMessage(GROUP, text.id, { target: 'en' })).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_ENABLED',
    });
  });
});
