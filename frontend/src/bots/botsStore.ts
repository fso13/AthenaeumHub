import type { ChatApi } from '../api/endpoints';
import { toApiError } from '../api/problem';
import type { ApiError } from '../api/problem';
import type {
  Bot,
  BotCommandAccepted,
  BotCommandInvoke,
  BotCreateRequest,
  BotDelivery,
  BotDeliveryAccepted,
  BotSigningSecret,
  BotToken,
  BotUpdateRequest,
  ChatBot,
} from '../api/types';

/**
 * #96/#98 bots UI store.
 *
 * Security rules encoded here:
 *  * `BotToken.token` and `signing_secret` live in this in-memory snapshot
 *    only. They are never written to storage/localStorage, never put into an
 *    audit/log call and are dropped by `clearToken()`/`clearSigningSecret()`,
 *    `reset()` and every workspace switch.
 *  * A bot row never keeps `signing_secret`: it is split off the PATCH/rotate
 *    response before the row is stored, so re-rendering the list cannot leak it.
 *  * The list endpoint never returns a credential; all mutations replace rows
 *    with the server response instead of inventing fields.
 *  * Deliveries are the content-free statuses from `GET .../deliveries`.
 */

export type BotsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Per-bot failure keeps the rest of the list interactive. */
export interface BotsActionError {
  botId: string;
  error: ApiError;
}

/** One-time signing-secret reveal; cleared when its dialog closes. */
export interface BotSigningSecretView {
  botId: string;
  secret: string;
  reason: 'activated' | 'rotated';
  createdAt: string | null;
}

export interface BotDeliveriesState {
  botId: string;
  status: BotsLoadStatus;
  items: BotDelivery[];
  error: ApiError | null;
}

/** The last command invocation: `202` means the delivery is queued only. */
export interface BotCommandAcceptance {
  deliveryId: string;
  botId: string;
  botName: string;
  command: string;
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
  /** #98 event/command settings PATCH (separate from status/name updates). */
  eventsSavingId: string | null;
  eventsError: BotsActionError | null;
  /** One-time signing secret of activation/rotation; never re-readable. */
  signingSecret: BotSigningSecretView | null;
  secretPendingId: string | null;
  secretError: BotsActionError | null;
  deliveries: BotDeliveriesState | null;
  testPendingId: string | null;
  testError: BotsActionError | null;
  testAccepted: { botId: string; deliveryId: string } | null;
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
  /** #98 slash-command invocation state for the active chat composer. */
  commandPending: boolean;
  commandError: ApiError | null;
  commandAccepted: BotCommandAcceptance | null;
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
    | 'rotateBotSigningSecret'
    | 'listBotDeliveries'
    | 'testBotEvent'
    | 'invokeBotCommand'
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
    eventsSavingId: null,
    eventsError: null,
    signingSecret: null,
    secretPendingId: null,
    secretError: null,
    deliveries: null,
    testPendingId: null,
    testError: null,
    testAccepted: null,
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
    commandPending: false,
    commandError: null,
    commandAccepted: null,
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

/**
 * Splits the one-time secret off a PATCH/rotate response. Rows stored in
 * `items` never carry `signing_secret`, so a re-render/list refresh cannot
 * resurface it; only the explicit `signingSecret` view shows it once.
 */
function splitSigningSecret(bot: Bot): { bot: Bot; secret: string | null } {
  const { signing_secret: secret, ...metadata } = bot;
  return { bot: metadata, secret: secret ?? null };
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
  /** Bumped by reset/dispose so an in-flight delivery read cannot leak across. */
  private deliveriesGeneration = 0;
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
    this.deliveriesGeneration += 1;
    this.workspaceInFlight = null;
    this.chatInFlight = null;
  }

  reset(): void {
    this.workspaceGeneration += 1;
    this.chatGeneration += 1;
    this.deliveriesGeneration += 1;
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

  /** Drops the one-time signing secret; it is never retrievable again. */
  clearSigningSecret(): void {
    const workspace = this.state.workspace;
    if (workspace.signingSecret === null && workspace.secretError === null) return;
    this.patch({
      workspace: {
        ...workspace,
        signingSecret: null,
        secretError: null,
      },
    });
  }

  /** Clears the composer command feedback when the chat changes. */
  clearCommandState(): void {
    const chat = this.state.chat;
    if (!chat.commandPending && chat.commandError === null && chat.commandAccepted === null) {
      return;
    }
    this.patch({
      chat: { ...chat, commandPending: false, commandError: null, commandAccepted: null },
    });
  }

  /**
   * Settings dialog closes: drop the one-time secret, test notice and stale
   * per-bot errors so reopening cannot show a value that is no longer valid.
   */
  clearBotEventFeedback(): void {
    const workspace = this.state.workspace;
    if (
      workspace.signingSecret === null &&
      workspace.secretError === null &&
      workspace.testError === null &&
      workspace.testAccepted === null &&
      workspace.eventsError === null
    ) {
      return;
    }
    this.patch({
      workspace: {
        ...workspace,
        signingSecret: null,
        secretError: null,
        testError: null,
        testAccepted: null,
        eventsError: null,
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
      const { bot } = splitSigningSecret(issued.bot);
      this.patch({
        workspace: {
          ...this.state.workspace,
          workspaceId,
          status: 'ready',
          items: upsertBot(this.state.workspace.items, bot),
          createStatus: 'idle',
          createError: null,
          token: { ...issued, bot },
          tokenReason: 'created',
        },
      });
      return bot;
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
      const { bot } = splitSigningSecret(issued.bot);
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, bot),
          rotatePendingId: null,
          rotateError: null,
          token: { ...issued, bot },
          tokenReason: 'rotated',
        },
      });
      return { ...issued, bot };
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
      const response = await this.api.updateBot(workspaceId, botId, body);
      if (this.disposed) return null;
      const { bot, secret } = splitSigningSecret(response);
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, bot),
          updatePendingId: null,
          updateError: null,
          ...(secret !== null
            ? {
                signingSecret: {
                  botId: bot.id,
                  secret,
                  reason: 'activated' as const,
                  createdAt: bot.signing_secret_created_at ?? null,
                },
              }
            : {}),
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
   * #98 event/command settings save. It is the same PATCH as `updateBot`, but
   * with its own pending/error slot so the settings card does not disable the
   * list actions and vice versa. A newly generated signing secret is split off
   * the response and exposed once through `signingSecret`.
   */
  async saveBotEvents(
    workspaceId: string,
    botId: string,
    body: BotUpdateRequest,
  ): Promise<Bot | null> {
    if (this.state.workspace.eventsSavingId !== null) return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        eventsSavingId: botId,
        eventsError: null,
      },
    });
    try {
      const response = await this.api.updateBot(workspaceId, botId, body);
      if (this.disposed) return null;
      const { bot, secret } = splitSigningSecret(response);
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, bot),
          eventsSavingId: null,
          eventsError: null,
          ...(secret !== null
            ? {
                signingSecret: {
                  botId: bot.id,
                  secret,
                  reason: 'activated' as const,
                  createdAt: bot.signing_secret_created_at ?? null,
                },
              }
            : {}),
        },
      });
      return bot;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          eventsSavingId: null,
          eventsError: { botId, error: toApiError(error) },
        },
      });
      return null;
    }
  }

  /** #98 rotate the signing secret; the raw value is exposed once. */
  async rotateSigningSecret(workspaceId: string, botId: string): Promise<BotSigningSecret | null> {
    if (this.state.workspace.secretPendingId !== null) return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        secretPendingId: botId,
        secretError: null,
      },
    });
    try {
      const issued = await this.api.rotateBotSigningSecret(workspaceId, botId);
      if (this.disposed) return null;
      const { bot } = splitSigningSecret(issued.bot);
      this.patch({
        workspace: {
          ...this.state.workspace,
          items: upsertBot(this.state.workspace.items, bot),
          secretPendingId: null,
          secretError: null,
          signingSecret: {
            botId: bot.id,
            secret: issued.signing_secret,
            reason: 'rotated',
            createdAt: bot.signing_secret_created_at ?? null,
          },
        },
      });
      return issued;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        workspace: {
          ...this.state.workspace,
          secretPendingId: null,
          secretError: { botId, error: toApiError(error) },
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

  /**
   * Content-free delivery statuses for one bot. The default `limit` is small:
   * the settings card only needs the latest rows, and the server caps it at 100.
   */
  async loadBotDeliveries(
    workspaceId: string,
    botId: string,
    limit = 20,
    force = false,
  ): Promise<void> {
    const current = this.state.workspace.deliveries;
    if (!force && current?.botId === botId && current.status === 'loading') return;
    if (!force && current?.botId === botId && current.status === 'ready') return;
    const generation = ++this.deliveriesGeneration;
    this.patch({
      workspace: {
        ...this.state.workspace,
        deliveries: {
          botId,
          status: 'loading',
          items: current?.botId === botId ? current.items : [],
          error: null,
        },
      },
    });
    try {
      const response = await this.api.listBotDeliveries(workspaceId, botId, limit);
      if (this.disposed || generation !== this.deliveriesGeneration) return;
      this.patch({
        workspace: {
          ...this.state.workspace,
          deliveries: { botId, status: 'ready', items: response.items, error: null },
        },
      });
    } catch (error) {
      if (this.disposed || generation !== this.deliveriesGeneration) return;
      this.patch({
        workspace: {
          ...this.state.workspace,
          deliveries: {
            botId,
            status: 'error',
            items:
              this.state.workspace.deliveries?.botId === botId
                ? (this.state.workspace.deliveries?.items ?? [])
                : [],
            error: toApiError(error),
          },
        },
      });
    }
  }

  /** Queues a signed `test` ping (`202`); content-free statuses then refresh. */
  async testBotEvent(workspaceId: string, botId: string): Promise<boolean> {
    if (this.state.workspace.testPendingId !== null) return false;
    this.patch({
      workspace: {
        ...this.state.workspace,
        testPendingId: botId,
        testError: null,
        testAccepted: null,
      },
    });
    try {
      const accepted: BotDeliveryAccepted = await this.api.testBotEvent(workspaceId, botId);
      if (this.disposed) return false;
      this.patch({
        workspace: {
          ...this.state.workspace,
          testPendingId: null,
          testError: null,
          testAccepted: { botId, deliveryId: accepted.delivery_id },
        },
      });
      await this.loadBotDeliveries(workspaceId, botId, 20, true);
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.patch({
        workspace: {
          ...this.state.workspace,
          testPendingId: null,
          testError: { botId, error: toApiError(error) },
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

  /**
   * #98 slash-command invocation. The server answers `202` with only a
   * `delivery_id`: no chat message exists yet, so the store never inserts one.
   * The bot's later answer arrives through its backend-only response URL as a
   * normal BOT message via the regular message pipeline.
   */
  async invokeBotCommand(
    chatId: string,
    body: BotCommandInvoke,
  ): Promise<BotCommandAccepted | null> {
    if (this.state.chat.commandPending) return null;
    const command = body.command.trim().toLowerCase();
    const installed = this.state.chat.chatId === chatId ? this.state.chat.items : [];
    const owner =
      installed.find(
        (item) =>
          item.enabled &&
          item.bot.status === 'ACTIVE' &&
          (item.bot.commands ?? []).some((entry) => entry.command === command),
      ) ?? null;
    this.patch({
      chat: {
        ...this.state.chat,
        commandPending: true,
        commandError: null,
        commandAccepted: null,
      },
    });
    try {
      const accepted = await this.api.invokeBotCommand(chatId, {
        command,
        args: body.args ?? '',
      });
      if (this.disposed) return null;
      this.patch({
        chat: {
          ...this.state.chat,
          commandPending: false,
          commandError: null,
          commandAccepted: {
            deliveryId: accepted.delivery_id,
            botId: owner?.bot.id ?? '',
            botName: owner?.bot.name ?? '',
            command,
          },
        },
      });
      return accepted;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({
        chat: {
          ...this.state.chat,
          commandPending: false,
          commandError: toApiError(error),
          commandAccepted: null,
        },
      });
      return null;
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
