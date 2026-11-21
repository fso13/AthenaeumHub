import type { ChatApi } from '../api/endpoints';
import { toApiError } from '../api/problem';
import type { ApiError } from '../api/problem';
import type { Bot, BotCreateRequest, BotToken, BotUpdateRequest, ChatBot } from '../api/types';

/**
 * #96 bots UI store (MVP: `chat.write` only).
 *
 * Security rules encoded here:
 *  * `BotToken.token` lives in this in-memory snapshot only. It is never
 *    written to storage/localStorage, never put into an audit/log call and is
 *    dropped by `clearToken()`, `reset()` and every workspace switch.
 *  * The list endpoint never returns a token; all mutations replace rows with
 *    the server response instead of inventing fields.
 *  * Bots are never treated as users: the chat/workspace rows stay separate
 *    from member directories and message senders.
 */

export type BotsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Per-bot failure keeps the rest of the list interactive. */
export interface BotsActionError {
  botId: string;
  error: ApiError;
}

export interface WorkspaceBotsState {
  workspaceId: string | null;
  status: BotsLoadStatus;
  items: Bot[];
  error: ApiError | null;
  createStatus: 'idle' | 'creating' | 'error';
  createError: ApiError | null;
  /**
   * One-time token response of create/rotate. `reason` lets the modal explain
   * what just happened; `null` means "already dismissed/never issued".
   */
  token: BotToken | null;
  tokenReason: 'created' | 'rotated' | null;
  rotatePendingId: string | null;
  rotateError: BotsActionError | null;
  updatePendingId: string | null;
  updateError: BotsActionError | null;
  disablePendingId: string | null;
  disableError: BotsActionError | null;
}

export interface ChatBotsState {
  chatId: string | null;
  status: BotsLoadStatus;
  items: ChatBot[];
  error: ApiError | null;
  installPendingId: string | null;
  installError: ApiError | null;
  uninstallPendingId: string | null;
  uninstallError: BotsActionError | null;
}

export interface BotsState {
  workspace: WorkspaceBotsState;
  chat: ChatBotsState;
}

export interface BotsStoreDeps {
  api: Pick<
    ChatApi,
    | 'listBots'
    | 'createBot'
    | 'updateBot'
    | 'disableBot'
    | 'rotateBotToken'
    | 'listChatBots'
    | 'installChatBot'
    | 'uninstallChatBot'
  >;
}

export function createEmptyWorkspaceBotsState(): WorkspaceBotsState {
  return {
    workspaceId: null,
    status: 'idle',
    items: [],
    error: null,
    createStatus: 'idle',
    createError: null,
    token: null,
    tokenReason: null,
    rotatePendingId: null,
    rotateError: null,
    updatePendingId: null,
    updateError: null,
    disablePendingId: null,
    disableError: null,
  };
}

export function createEmptyChatBotsState(): ChatBotsState {
  return {
    chatId: null,
    status: 'idle',
    items: [],
    error: null,
    installPendingId: null,
    installError: null,
    uninstallPendingId: null,
    uninstallError: null,
  };
}

export function createEmptyBotsState(): BotsState {
  return {
    workspace: createEmptyWorkspaceBotsState(),
    chat: createEmptyChatBotsState(),
  };
}

function upsertBot(items: Bot[], bot: Bot): Bot[] {
  const index = items.findIndex((item) => item.id === bot.id);
  if (index < 0) return [bot, ...items];
  const next = [...items];
  next[index] = bot;
  return next;
}

function upsertChatBot(items: ChatBot[], chatBot: ChatBot): ChatBot[] {
  const filtered = items.filter((item) => item.bot.id !== chatBot.bot.id);
  return [chatBot, ...filtered];
}

export class BotsStore {
  private readonly api: BotsStoreDeps['api'];
  private state: BotsState;
  private listeners = new Set<() => void>();
  /**
   * Separate read generations: the chat tab loads the workspace list (picker)
   * and the installed list in parallel, so one read must never invalidate the
   * other. Reset/dispose bump both.
   */
  private workspaceGeneration = 0;
  private chatGeneration = 0;
  private disposed = false;
  private workspaceInFlight: Promise<void> | null = null;
  private chatInFlight: Promise<void> | null = null;

  constructor(deps: BotsStoreDeps) {
    this.api = deps.api;
    this.state = createEmptyBotsState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): BotsState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.workspaceGeneration += 1;
    this.chatGeneration += 1;
    this.workspaceInFlight = null;
    this.chatInFlight = null;
  }

  reset(): void {
    this.workspaceGeneration += 1;
    this.chatGeneration += 1;
    this.workspaceInFlight = null;
    this.chatInFlight = null;
    this.patch(createEmptyBotsState());
  }

  /** Drops the one-time token from memory; listing/rotation remain possible. */
  clearToken(): void {
    if (this.state.workspace.token === null && this.state.workspace.tokenReason === null) return;
    this.patch({
      workspace: {
        ...this.state.workspace,
        token: null,
        tokenReason: null,
      },
    });
  }

  /** Chat settings closes: installed rows are chat-scoped and must not leak. */
  clearChatBots(): void {
    this.chatGeneration += 1;
    this.chatInFlight = null;
    if (this.state.chat.chatId === null && this.state.chat.items.length === 0) return;
    this.patch({ chat: createEmptyChatBotsState() });
  }

  async loadWorkspaceBots(workspaceId: string, force = false): Promise<void> {
    const current = this.state.workspace;
    if (!force && current.workspaceId === workspaceId) {
      if (current.status === 'ready') return;
      if (current.status === 'loading' && this.workspaceInFlight) {
        return this.workspaceInFlight;
      }
    }
    const generation = ++this.workspaceGeneration;
    this.patch({
      workspace: {
        ...(current.workspaceId === workspaceId ? current : createEmptyWorkspaceBotsState()),
        workspaceId,
        status: 'loading',
        error: null,
      },
    });
    const promise = (async () => {
      try {
        const response = await this.api.listBots(workspaceId);
        if (this.isWorkspaceStale(generation)) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            status: 'ready',
            items: response.items,
            error: null,
          },
        });
      } catch (error) {
        if (this.isWorkspaceStale(generation)) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            status: 'error',
            error: toApiError(error),
          },
        });
      } finally {
        if (!this.isWorkspaceStale(generation)) this.workspaceInFlight = null;
      }
    })();
    this.workspaceInFlight = promise;
    return promise;
  }

  async createBot(workspaceId: string, body: BotCreateRequest): Promise<Bot | null> {
    if (this.state.workspace.createStatus === 'creating') return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        createStatus: 'creating',
        createError: null,
      },
    });
    try {
      const issued = await this.api.createBot(workspaceId, body);
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          workspaceId,
          status: 'ready',
          items: upsertBot(this.state.workspace.items, issued.bot),
          createStatus: 'idle',
          createError: null,
          token: issued,
          tokenReason: 'created',
        },
      });
      return issued.bot;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          createStatus: 'error',
          createError: toApiError(error),
        },
      });
      return null;
    }
  }

  async rotateBotToken(workspaceId: string, botId: string): Promise<BotToken | null> {
    if (this.state.workspace.rotatePendingId !== null) return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        rotatePendingId: botId,
        rotateError: null,
      },
    });
    try {
      const issued = await this.api.rotateBotToken(workspaceId, botId);
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, issued.bot),
          rotatePendingId: null,
          rotateError: null,
          token: issued,
          tokenReason: 'rotated',
        },
      });
      return issued;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          rotatePendingId: null,
          rotateError: { botId, error: toApiError(error) },
        },
      });
      return null;
    }
  }

  async updateBot(workspaceId: string, botId: string, body: BotUpdateRequest): Promise<Bot | null> {
    if (this.state.workspace.updatePendingId !== null) return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        updatePendingId: botId,
        updateError: null,
      },
    });
    try {
      const bot = await this.api.updateBot(workspaceId, botId, body);
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, bot),
          updatePendingId: null,
          updateError: null,
        },
      });
      return bot;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          updatePendingId: null,
          updateError: { botId, error: toApiError(error) },
        },
      });
      return null;
    }
  }

  /**
   * `DELETE /workspaces/{id}/bots/{botId}` is the soft disable from the
   * contract (`204`, no body). The row is refreshed from the server so the UI
   * never invents the new `status`/`updated_at`.
   */
  async disableBot(workspaceId: string, botId: string): Promise<boolean> {
    if (this.state.workspace.disablePendingId !== null) return false;
    this.patch({
      workspace: {
        ...this.state.workspace,
        disablePendingId: botId,
        disableError: null,
      },
    });
    try {
      await this.api.disableBot(workspaceId, botId);
      if (this.disposed) return false;
      this.patch({
        workspace: {
          ...this.state.workspace,
          disablePendingId: null,
          disableError: null,
        },
      });
      await this.loadWorkspaceBots(workspaceId, true);
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.patch({
        workspace: {
          ...this.state.workspace,
          disablePendingId: null,
          disableError: { botId, error: toApiError(error) },
        },
      });
      return false;
    }
  }

  async loadChatBots(chatId: string, force = false): Promise<void> {
    const current = this.state.chat;
    if (!force && current.chatId === chatId) {
      if (current.status === 'ready') return;
      if (current.status === 'loading' && this.chatInFlight) return this.chatInFlight;
    }
    const generation = ++this.chatGeneration;
    this.patch({
      chat: {
        ...(current.chatId === chatId ? current : createEmptyChatBotsState()),
        chatId,
        status: 'loading',
        error: null,
      },
    });
    const promise = (async () => {
      try {
        const response = await this.api.listChatBots(chatId);
        if (this.isChatStale(generation)) return;
        this.patch({
          chat: {
            ...this.state.chat,
            status: 'ready',
            items: response.items,
            error: null,
          },
        });
      } catch (error) {
        if (this.isChatStale(generation)) return;
        this.patch({
          chat: {
            ...this.state.chat,
            status: 'error',
            error: toApiError(error),
          },
        });
      } finally {
        if (!this.isChatStale(generation)) this.chatInFlight = null;
      }
    })();
    this.chatInFlight = promise;
    return promise;
  }

  async installChatBot(chatId: string, botId: string): Promise<ChatBot | null> {
    if (this.state.chat.installPendingId !== null) return null;
    this.patch({
      chat: {
        ...this.state.chat,
        chatId,
        installPendingId: botId,
        installError: null,
      },
    });
    try {
      const installed = await this.api.installChatBot(chatId, botId);
      if (this.disposed) return null;
      this.patch({
        chat: {
          ...this.state.chat,
          status: 'ready',
          items: upsertChatBot(this.state.chat.items, installed),
          installPendingId: null,
          installError: null,
        },
      });
      return installed;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        chat: {
          ...this.state.chat,
          installPendingId: null,
          installError: toApiError(error),
        },
      });
      return null;
    }
  }

  async uninstallChatBot(chatId: string, botId: string): Promise<boolean> {
    if (this.state.chat.uninstallPendingId !== null) return false;
    this.patch({
      chat: {
        ...this.state.chat,
        uninstallPendingId: botId,
        uninstallError: null,
      },
    });
    try {
      await this.api.uninstallChatBot(chatId, botId);
      if (this.disposed) return false;
      this.patch({
        chat: {
          ...this.state.chat,
          items: this.state.chat.items.filter((item) => item.bot.id !== botId),
          uninstallPendingId: null,
          uninstallError: null,
        },
      });
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.patch({
        chat: {
          ...this.state.chat,
          uninstallPendingId: null,
          uninstallError: { botId, error: toApiError(error) },
        },
      });
      return false;
    }
  }

  private isWorkspaceStale(generation: number): boolean {
    return this.disposed || generation !== this.workspaceGeneration;
  }

  private isChatStale(generation: number): boolean {
    return this.disposed || generation !== this.chatGeneration;
  }

  private patch(patch: Partial<BotsState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function createBotsStore(deps: BotsStoreDeps): BotsStore {
  return new BotsStore(deps);
}
