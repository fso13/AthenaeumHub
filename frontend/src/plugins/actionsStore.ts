import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { Poll, PollCreate, Task, TaskCreate } from '../api/types';

export type PluginActionLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TranslationEntry {
  status: 'loading' | 'ready' | 'error';
  target: string;
  text: string | null;
  error: ApiError | null;
}

/**
 * D1.1 (#76) poll/task/translation read model.
 *
 * Deliberately has no optimistic vote/task mutation: a server response replaces
 * or adds the row, and a failed call leaves the last known aggregate untouched.
 * Poll options/timestamps/totals and task `completed_*` are always the server
 * values. Translations are keyed by `chatId:messageId`, so switching chats can
 * never show another chat's text.
 */
export interface PluginActionsState {
  chatId: string | null;
  pollsStatus: PluginActionLoadStatus;
  polls: Poll[];
  pollsError: ApiError | null;
  tasksStatus: PluginActionLoadStatus;
  tasks: Task[];
  tasksError: ApiError | null;
  /** Polls with an in-flight vote/close; their controls stay disabled. */
  pendingPollIds: string[];
  /** Subset of `pendingPollIds` whose request is a close (label accuracy). */
  closingPollIds: string[];
  pendingTaskIds: string[];
  /** Inline vote/close failure, scoped to one poll card. */
  pollErrors: Record<string, ApiError>;
  /** Inline complete/reopen failure, scoped to one task row. */
  taskErrors: Record<string, ApiError>;
  createPollPending: boolean;
  createPollError: ApiError | null;
  createTaskPending: boolean;
  createTaskError: ApiError | null;
  translations: Record<string, TranslationEntry>;
}

export interface PluginActionsStoreDeps {
  api: Pick<
    ChatApi,
    | 'listPolls'
    | 'createPoll'
    | 'closePoll'
    | 'votePoll'
    | 'listTasks'
    | 'createTask'
    | 'updateTask'
    | 'translateMessage'
  >;
  /**
   * #95: push the fresh server projection into the chat message that embeds
   * it. Optional so API-only tests can construct the store without a chat.
   */
  onPollChanged?: (chatId: string, poll: Poll) => void;
  onTaskChanged?: (chatId: string, task: Task) => void;
}

export const EMPTY_PLUGIN_ACTIONS_STATE: PluginActionsState = {
  chatId: null,
  pollsStatus: 'idle',
  polls: [],
  pollsError: null,
  tasksStatus: 'idle',
  tasks: [],
  tasksError: null,
  pendingPollIds: [],
  closingPollIds: [],
  pendingTaskIds: [],
  pollErrors: {},
  taskErrors: {},
  createPollPending: false,
  createPollError: null,
  createTaskPending: false,
  createTaskError: null,
  translations: {},
};

export function translationKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

function createdDesc(a: { created_at: string }, b: { created_at: string }): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Contract order: newest polls first. */
export function sortPolls(polls: readonly Poll[]): Poll[] {
  return [...polls].sort(createdDesc);
}

/** Contract order: open before done, newest first inside each group. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const doneDelta = Number(a.done) - Number(b.done);
    return doneDelta !== 0 ? doneDelta : createdDesc(a, b);
  });
}

function upsertPoll(polls: readonly Poll[], poll: Poll): Poll[] {
  const found = polls.some((item) => item.id === poll.id);
  return sortPolls(
    found ? polls.map((item) => (item.id === poll.id ? poll : item)) : [poll, ...polls],
  );
}

function upsertTask(tasks: readonly Task[], task: Task): Task[] {
  const found = tasks.some((item) => item.id === task.id);
  return sortTasks(
    found ? tasks.map((item) => (item.id === task.id ? task : item)) : [task, ...tasks],
  );
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export class PluginActionsStore {
  private readonly api: PluginActionsStoreDeps['api'];
  private readonly onPollChanged: PluginActionsStoreDeps['onPollChanged'];
  private readonly onTaskChanged: PluginActionsStoreDeps['onTaskChanged'];
  private state: PluginActionsState = { ...EMPTY_PLUGIN_ACTIONS_STATE };
  private readonly listeners = new Set<() => void>();
  private pollsPromise: Promise<void> | null = null;
  private tasksPromise: Promise<void> | null = null;
  /** Latest translation request per message; stale responses are dropped. */
  private readonly translationTokens = new Map<string, number>();
  private translationToken = 0;
  /** Invalidates in-flight reads/mutations when the chat changes or resets. */
  private epoch = 0;
  private disposed = false;

  constructor(deps: PluginActionsStoreDeps) {
    this.api = deps.api;
    this.onPollChanged = deps.onPollChanged;
    this.onTaskChanged = deps.onTaskChanged;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PluginActionsState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<PluginActionsState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private isCurrent(chatId: string, epoch: number): boolean {
    return !this.disposed && this.epoch === epoch && this.state.chatId === chatId;
  }

  /**
   * Move the read model to another chat. Cached rows/translations belong to the
   * previous chat, so they are dropped before the new panel issues its reads.
   */
  enterChat(chatId: string): void {
    if (this.state.chatId === chatId) return;
    this.epoch += 1;
    this.pollsPromise = null;
    this.tasksPromise = null;
    this.translationTokens.clear();
    this.patch({ ...EMPTY_PLUGIN_ACTIONS_STATE, chatId });
  }

  async ensurePolls(chatId: string): Promise<void> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.pollsStatus === 'ready') return;
    return this.loadPolls(chatId);
  }

  async loadPolls(chatId: string, force = false): Promise<void> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (!force && this.state.pollsStatus === 'ready') return;
    if (this.pollsPromise) return this.pollsPromise;

    const epoch = this.epoch;
    this.patch({ pollsStatus: 'loading', pollsError: null });
    const promise = this.api
      .listPolls(chatId)
      .then((response) => {
        if (!this.isCurrent(chatId, epoch)) return;
        this.patch({ pollsStatus: 'ready', polls: sortPolls(response.items), pollsError: null });
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(chatId, epoch)) return;
        this.patch({ pollsStatus: 'error', pollsError: toApiError(error) });
      })
      .finally(() => {
        if (this.pollsPromise === promise) this.pollsPromise = null;
      });
    this.pollsPromise = promise;
    return promise;
  }

  async ensureTasks(chatId: string): Promise<void> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.tasksStatus === 'ready') return;
    return this.loadTasks(chatId);
  }

  async loadTasks(chatId: string, force = false): Promise<void> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (!force && this.state.tasksStatus === 'ready') return;
    if (this.tasksPromise) return this.tasksPromise;

    const epoch = this.epoch;
    this.patch({ tasksStatus: 'loading', tasksError: null });
    const promise = this.api
      .listTasks(chatId)
      .then((response) => {
        if (!this.isCurrent(chatId, epoch)) return;
        this.patch({ tasksStatus: 'ready', tasks: sortTasks(response.items), tasksError: null });
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(chatId, epoch)) return;
        this.patch({ tasksStatus: 'error', tasksError: toApiError(error) });
      })
      .finally(() => {
        if (this.tasksPromise === promise) this.tasksPromise = null;
      });
    this.tasksPromise = promise;
    return promise;
  }

  async createPoll(chatId: string, body: PollCreate): Promise<Poll | null> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.createPollPending) return null;
    const epoch = this.epoch;
    this.patch({ createPollPending: true, createPollError: null });
    try {
      const poll = await this.api.createPoll(chatId, body);
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          createPollPending: false,
          polls: upsertPoll(this.state.polls, poll),
          createPollError: null,
        });
        this.onPollChanged?.(chatId, poll);
      }
      return poll;
    } catch (error) {
      if (this.isCurrent(chatId, epoch)) {
        this.patch({ createPollPending: false, createPollError: toApiError(error) });
      }
      return null;
    }
  }

  async votePoll(chatId: string, pollId: string, optionId: string): Promise<boolean> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.pendingPollIds.includes(pollId)) return false;
    const epoch = this.epoch;
    this.patch({
      pendingPollIds: [...this.state.pendingPollIds, pollId],
      pollErrors: omitKey(this.state.pollErrors, pollId),
    });
    try {
      // No optimistic count: the server aggregate replaces the card row.
      const poll = await this.api.votePoll(chatId, pollId, { option_id: optionId });
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingPollIds: this.state.pendingPollIds.filter((id) => id !== pollId),
          polls: upsertPoll(this.state.polls, poll),
        });
        this.onPollChanged?.(chatId, poll);
      }
      return true;
    } catch (error) {
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingPollIds: this.state.pendingPollIds.filter((id) => id !== pollId),
          pollErrors: { ...this.state.pollErrors, [pollId]: toApiError(error) },
        });
      }
      return false;
    }
  }

  async closePoll(chatId: string, pollId: string): Promise<boolean> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.pendingPollIds.includes(pollId)) return false;
    const epoch = this.epoch;
    this.patch({
      pendingPollIds: [...this.state.pendingPollIds, pollId],
      closingPollIds: [...this.state.closingPollIds, pollId],
      pollErrors: omitKey(this.state.pollErrors, pollId),
    });
    try {
      const poll = await this.api.closePoll(chatId, pollId, { closed: true });
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingPollIds: this.state.pendingPollIds.filter((id) => id !== pollId),
          closingPollIds: this.state.closingPollIds.filter((id) => id !== pollId),
          polls: upsertPoll(this.state.polls, poll),
        });
        this.onPollChanged?.(chatId, poll);
      }
      return true;
    } catch (error) {
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingPollIds: this.state.pendingPollIds.filter((id) => id !== pollId),
          closingPollIds: this.state.closingPollIds.filter((id) => id !== pollId),
          pollErrors: { ...this.state.pollErrors, [pollId]: toApiError(error) },
        });
      }
      return false;
    }
  }

  clearPollError(pollId: string): void {
    if (!this.state.pollErrors[pollId]) return;
    this.patch({ pollErrors: omitKey(this.state.pollErrors, pollId) });
  }

  clearCreatePollError(): void {
    if (!this.state.createPollError) return;
    this.patch({ createPollError: null });
  }

  async createTask(chatId: string, body: TaskCreate): Promise<Task | null> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.createTaskPending) return null;
    const epoch = this.epoch;
    this.patch({ createTaskPending: true, createTaskError: null });
    try {
      const task = await this.api.createTask(chatId, body);
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          createTaskPending: false,
          tasks: upsertTask(this.state.tasks, task),
          createTaskError: null,
        });
        this.onTaskChanged?.(chatId, task);
      }
      return task;
    } catch (error) {
      if (this.isCurrent(chatId, epoch)) {
        this.patch({ createTaskPending: false, createTaskError: toApiError(error) });
      }
      return null;
    }
  }

  async updateTask(chatId: string, taskId: string, done: boolean): Promise<boolean> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    if (this.state.pendingTaskIds.includes(taskId)) return false;
    const epoch = this.epoch;
    this.patch({
      pendingTaskIds: [...this.state.pendingTaskIds, taskId],
      taskErrors: omitKey(this.state.taskErrors, taskId),
    });
    try {
      // No optimistic checkbox: `done`/`completed_*` come back from the server.
      const task = await this.api.updateTask(chatId, taskId, { done });
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingTaskIds: this.state.pendingTaskIds.filter((id) => id !== taskId),
          tasks: upsertTask(this.state.tasks, task),
        });
        this.onTaskChanged?.(chatId, task);
      }
      return true;
    } catch (error) {
      if (this.isCurrent(chatId, epoch)) {
        this.patch({
          pendingTaskIds: this.state.pendingTaskIds.filter((id) => id !== taskId),
          taskErrors: { ...this.state.taskErrors, [taskId]: toApiError(error) },
        });
      }
      return false;
    }
  }

  clearTaskError(taskId: string): void {
    if (!this.state.taskErrors[taskId]) return;
    this.patch({ taskErrors: omitKey(this.state.taskErrors, taskId) });
  }

  clearCreateTaskError(): void {
    if (!this.state.createTaskError) return;
    this.patch({ createTaskError: null });
  }

  translationFor(chatId: string, messageId: string): TranslationEntry | null {
    return this.state.translations[translationKey(chatId, messageId)] ?? null;
  }

  async translateMessage(chatId: string, messageId: string, target: string): Promise<void> {
    if (this.state.chatId !== chatId) this.enterChat(chatId);
    const key = translationKey(chatId, messageId);
    const epoch = this.epoch;
    const token = ++this.translationToken;
    this.translationTokens.set(key, token);
    this.patch({
      translations: {
        ...this.state.translations,
        [key]: { status: 'loading', target, text: null, error: null },
      },
    });
    try {
      const translation = await this.api.translateMessage(chatId, messageId, { target });
      if (!this.isCurrent(chatId, epoch) || this.translationTokens.get(key) !== token) return;
      this.patch({
        translations: {
          ...this.state.translations,
          [key]: { status: 'ready', target, text: translation.text, error: null },
        },
      });
    } catch (error) {
      if (!this.isCurrent(chatId, epoch) || this.translationTokens.get(key) !== token) return;
      this.patch({
        translations: {
          ...this.state.translations,
          [key]: { status: 'error', target, text: null, error: toApiError(error) },
        },
      });
    }
  }

  /** Retry with the language the failed request used. */
  async retryTranslation(chatId: string, messageId: string): Promise<void> {
    const entry = this.translationFor(chatId, messageId);
    if (!entry) return;
    await this.translateMessage(chatId, messageId, entry.target);
  }

  clearTranslation(chatId: string, messageId: string): void {
    const key = translationKey(chatId, messageId);
    this.translationTokens.delete(key);
    if (!this.state.translations[key]) return;
    this.patch({ translations: omitKey(this.state.translations, key) });
  }

  /** Drop all user-scoped state on logout/account switch. */
  reset(): void {
    this.epoch += 1;
    this.pollsPromise = null;
    this.tasksPromise = null;
    this.translationTokens.clear();
    this.state = { ...EMPTY_PLUGIN_ACTIONS_STATE, polls: [], tasks: [], translations: {} };
    this.emit();
  }
}

export function createPluginActionsStore(deps: PluginActionsStoreDeps): PluginActionsStore {
  return new PluginActionsStore(deps);
}
