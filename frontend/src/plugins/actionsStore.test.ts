import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem';
import type { Poll, PollList, Task, TaskList } from '../api/types';
import { createPluginActionsStore, type PluginActionsStoreDeps } from './actionsStore';

const CHAT = '44444444-4444-4444-8444-444444444444';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POLL_ID = 'c0000000-0000-4000-8000-000000000001';
const OPTION_ID = 'c0000000-0000-4000-8000-000000000002';
const TASK_ID = 'c0000000-0000-4000-8000-000000000003';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function poll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: POLL_ID,
    question: 'Вопрос',
    options: [{ id: OPTION_ID, text: 'Да', position: 0, votes: 0 }],
    creator_id: 'u1',
    closed: false,
    closed_at: null,
    created_at: '2026-11-16T09:00:00.000Z',
    my_option_id: null,
    total_votes: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Задача',
    creator_id: 'u1',
    assignee_id: null,
    due_at: null,
    done: false,
    completed_by: null,
    completed_at: null,
    created_at: '2026-11-16T09:00:00.000Z',
    ...overrides,
  };
}

function makeStore() {
  const api = {
    listPolls: vi.fn(async (): Promise<PollList> => ({ items: [] })),
    createPoll: vi.fn(async () => poll()),
    closePoll: vi.fn(async () => poll({ closed: true })),
    votePoll: vi.fn(async () => poll({ total_votes: 1, my_option_id: OPTION_ID })),
    listTasks: vi.fn(async (): Promise<TaskList> => ({ items: [] })),
    createTask: vi.fn(async () => task()),
    updateTask: vi.fn(async () => task({ done: true })),
    translateMessage: vi.fn(async () => ({ text: '[en] hello' })),
  } satisfies PluginActionsStoreDeps['api'];
  const store = createPluginActionsStore({ api });
  store.enterChat(CHAT);
  return { api, store };
}

describe('D1.1 (#76) plugin actions store', () => {
  it('does not change poll votes until the server response arrives', async () => {
    const { api, store } = makeStore();
    api.listPolls.mockResolvedValueOnce({ items: [poll()] });
    await store.loadPolls(CHAT);
    const pending = deferred<Poll>();
    api.votePoll.mockReturnValueOnce(pending.promise);

    const vote = store.votePoll(CHAT, POLL_ID, OPTION_ID);
    expect(store.getSnapshot().pendingPollIds).toEqual([POLL_ID]);
    expect(store.getSnapshot().polls[0]?.total_votes).toBe(0);
    expect(store.getSnapshot().polls[0]?.my_option_id).toBeNull();

    pending.resolve(poll({ total_votes: 1, my_option_id: OPTION_ID }));
    await expect(vote).resolves.toBe(true);
    expect(store.getSnapshot().pendingPollIds).toEqual([]);
    expect(store.getSnapshot().polls[0]).toMatchObject({
      total_votes: 1,
      my_option_id: OPTION_ID,
    });
  });

  it('keeps the previous aggregate and surfaces a vote failure', async () => {
    const { api, store } = makeStore();
    api.listPolls.mockResolvedValueOnce({ items: [poll({ total_votes: 2 })] });
    await store.loadPolls(CHAT);
    api.votePoll.mockRejectedValueOnce(
      new ApiError({
        source: 'http',
        status: 500,
        code: 'SERVER_ERROR',
        message: 'boom',
      }),
    );

    await expect(store.votePoll(CHAT, POLL_ID, OPTION_ID)).resolves.toBe(false);
    expect(store.getSnapshot().polls[0]?.total_votes).toBe(2);
    expect(store.getSnapshot().pendingPollIds).toEqual([]);
    expect(store.getSnapshot().pollErrors[POLL_ID]?.code).toBe('SERVER_ERROR');
  });

  it('does not flip a task checkbox optimistically', async () => {
    const { api, store } = makeStore();
    api.listTasks.mockResolvedValueOnce({ items: [task()] });
    await store.loadTasks(CHAT);
    const pending = deferred<Task>();
    api.updateTask.mockReturnValueOnce(pending.promise);

    const update = store.updateTask(CHAT, TASK_ID, true);
    expect(store.getSnapshot().tasks[0]?.done).toBe(false);
    expect(store.getSnapshot().pendingTaskIds).toEqual([TASK_ID]);

    pending.resolve(
      task({ done: true, completed_by: 'u1', completed_at: '2026-11-16T10:00:00.000Z' }),
    );
    await expect(update).resolves.toBe(true);
    expect(store.getSnapshot().tasks[0]?.done).toBe(true);
    expect(store.getSnapshot().tasks[0]?.completed_by).toBe('u1');
  });

  it('keeps a task unchanged and reports the server failure', async () => {
    const { api, store } = makeStore();
    api.listTasks.mockResolvedValueOnce({ items: [task()] });
    await store.loadTasks(CHAT);
    api.updateTask.mockRejectedValueOnce(
      new ApiError({ source: 'http', status: 403, code: 'FORBIDDEN', message: 'no' }),
    );

    await expect(store.updateTask(CHAT, TASK_ID, true)).resolves.toBe(false);
    expect(store.getSnapshot().tasks[0]?.done).toBe(false);
    expect(store.getSnapshot().taskErrors[TASK_ID]?.code).toBe('FORBIDDEN');
  });

  it('stores an honest translation error and clears chat-scoped state', async () => {
    const { api, store } = makeStore();
    api.translateMessage.mockRejectedValueOnce(
      new ApiError({
        source: 'http',
        status: 503,
        code: 'TRANSLATION_UNAVAILABLE',
        message: 'provider offline',
        retryAfterSeconds: 30,
      }),
    );

    await store.translateMessage(CHAT, 'm1', 'en');
    const entry = store.translationFor(CHAT, 'm1');
    expect(entry).toMatchObject({ status: 'error', target: 'en' });
    expect(entry?.error?.code).toBe('TRANSLATION_UNAVAILABLE');
    expect(entry?.error?.retryAfterSeconds).toBe(30);

    store.enterChat(OTHER_CHAT);
    expect(store.translationFor(CHAT, 'm1')).toBeNull();
    expect(store.getSnapshot().chatId).toBe(OTHER_CHAT);
    expect(store.getSnapshot().polls).toEqual([]);
  });

  it('applies a successful translation for the requested target', async () => {
    const { api, store } = makeStore();
    await store.translateMessage(CHAT, 'm1', 'en');
    expect(api.translateMessage).toHaveBeenCalledWith(CHAT, 'm1', { target: 'en' });
    expect(store.translationFor(CHAT, 'm1')).toMatchObject({
      status: 'ready',
      text: '[en] hello',
    });
  });
});
