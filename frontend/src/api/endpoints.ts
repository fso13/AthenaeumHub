import type { AppConfig } from '../config/env';
import { getSession, setSession } from '../auth/session';
import { getAuthRuntimeMode } from '../auth/runtime';
import { reauthenticate } from '../auth/reauth';
import type { ApiClient } from './http';
import { ApiError, isApiError } from './problem';
import type {
  AddWorkspaceMemberRequest,
  AdminAuditPage,
  AdminChatPage,
  AdminChatType,
  AdminOverview,
  AdminSettings,
  AdminSettingsPatch,
  AdminStorage,
  AdminUserPage,
  ApiMessage,
  ChangeWorkspaceMemberRoleRequest,
  Chat,
  ChatCreateRequest,
  ChatList,
  CreateWorkspaceRequest,
  Device,
  DeviceRegistration,
  DownloadUrl,
  MeResponse,
  MessageCreateBody,
  MessagePage,
  NotificationPage,
  NotificationPreference,
  NotificationPreferencePatch,
  NotificationPreferences,
  PreflightFile,
  PreflightResponse,
  ReadNotificationsRequest,
  RealtimeTicket,
  Session,
  SetupStatus,
  StickerPackList,
  SyncResponse,
  TestEmailRequest,
  TestEmailResponse,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadPart,
  UploadSession,
  WorkspaceLimits,
  WorkspaceMember,
  WorkspaceMemberPage,
  WorkspaceSummary,
} from './types';

export interface ListMessagesQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  /**
   * D1-FE3: fetch replies of one flat thread. Without it the server returns
   * only the main feed (`thread_root_id = null`); replies never leak into it.
   */
  threadRootId?: string;
}

/**
 * E9-F admin directory queries. `cursor` is the opaque `next_cursor` returned by
 * the server and is never constructed locally (contract: `AdminUserPage` /
 * `AdminChatPage`).
 */
export interface ListAdminUsersQuery {
  /** Literal substring search over email/display name (max 254). */
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAdminChatsQuery {
  workspaceId?: string;
  /** Literal substring search over the chat name (max 120). */
  query?: string;
  type?: AdminChatType;
  cursor?: string;
  limit?: number;
}

export interface GetAdminStorageQuery {
  workspaceId?: string;
}

/**
 * E11-F audit query. `action` is an exact match on the audited action name
 * (contract: max 120 chars, no wildcards); `cursor` is the opaque
 * `next_cursor` of the previous page and is never constructed locally.
 */
export interface ListAdminAuditQuery {
  action?: string;
  cursor?: string;
  limit?: number;
}

/**
 * E10-F member directory query. `query` is a literal substring over
 * `display_name` (max 80); `cursor` is the opaque `next_cursor` from the
 * previous page and is never constructed locally (contract:
 * `WorkspaceMemberPage`).
 */
export interface ListWorkspaceMembersQuery {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface SendMessageResult {
  message: ApiMessage;
  replayed: boolean;
}

export interface ChatApi {
  bootstrapDevSession(): Promise<Session>;
  getMe(): Promise<MeResponse>;

  /* E8: first-run setup and platform admin (server enforces the admin flag). */
  /** Public; no token is required and no admin flag is read. */
  getSetupStatus(): Promise<SetupStatus>;
  getAdminSettings(): Promise<AdminSettings>;
  updateAdminSettings(body: AdminSettingsPatch): Promise<AdminSettings>;
  sendTestEmail(body: TestEmailRequest): Promise<TestEmailResponse>;
  getAdminOverview(): Promise<AdminOverview>;
  /* E9-F: platform-admin directory. Aggregates only, no message/file content. */
  listAdminUsers(query?: ListAdminUsersQuery): Promise<AdminUserPage>;
  listAdminChats(query?: ListAdminChatsQuery): Promise<AdminChatPage>;
  getAdminStorage(query?: GetAdminStorageQuery): Promise<AdminStorage>;
  /* E11-F: platform-admin actions and the cross-tenant audit view. */
  suspendUser(userId: string): Promise<void>;
  activateUser(userId: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  listAdminAudit(query?: ListAdminAuditQuery): Promise<AdminAuditPage>;

  registerDevice(body: DeviceRegistration, idempotencyKey: string): Promise<Device>;
  createWorkspace(body: CreateWorkspaceRequest, idempotencyKey: string): Promise<WorkspaceSummary>;
  /** E8: GROUP creation is idempotent by `Idempotency-Key`; DIRECT needs `peer_id`. */
  createChat(workspaceId: string, body: ChatCreateRequest, idempotencyKey: string): Promise<Chat>;
  listChats(workspaceId: string): Promise<ChatList>;
  listMessages(chatId: string, query?: ListMessagesQuery): Promise<MessagePage>;
  sendMessage(
    chatId: string,
    body: MessageCreateBody,
    idempotencyKey: string,
  ): Promise<SendMessageResult>;
  markRead(chatId: string, lastSeq: number, idempotencyKey: string): Promise<void>;
  sync(workspaceId: string): Promise<SyncResponse>;
  /** E3: one-time ticket; each reconnect must request a fresh one. */
  createRealtimeTicket(): Promise<RealtimeTicket>;

  /* E4-F: managed files. All shapes come from the generated contract types. */
  getWorkspaceLimits(workspaceId: string): Promise<WorkspaceLimits>;
  /**
   * E10-F: active workspace members for the DIRECT peer picker. The caller is
   * included by the server and is filtered out by the UI; the payload has no
   * email/devices/keys.
   */
  listWorkspaceMembers(
    workspaceId: string,
    query?: ListWorkspaceMembersQuery,
  ): Promise<WorkspaceMemberPage>;
  /**
   * E12-F (R-09): member administration. The server owns every guard (role,
   * limit, duplicate, self/last owner); the client only echoes contract fields.
   */
  addWorkspaceMember(
    workspaceId: string,
    body: AddWorkspaceMemberRequest,
  ): Promise<WorkspaceMember>;
  changeWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    body: ChangeWorkspaceMemberRoleRequest,
  ): Promise<WorkspaceMember>;
  removeWorkspaceMember(workspaceId: string, userId: string): Promise<void>;
  /** Server is the source of truth for size/quota/count/type decisions. */
  preflightUpload(
    chatId: string,
    files: PreflightFile[],
    idempotencyKey: string,
  ): Promise<PreflightResponse>;
  initUpload(body: UploadInitRequest, idempotencyKey: string): Promise<UploadSession>;
  getUpload(uploadId: string): Promise<UploadSession>;
  putUploadPart(
    uploadId: string,
    partNo: number,
    bytes: ArrayBuffer,
    sha256: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<UploadPart>;
  completeUpload(
    uploadId: string,
    body: UploadCompleteRequest,
    idempotencyKey: string,
  ): Promise<{ session: UploadSession; status: number }>;
  abortUpload(uploadId: string, idempotencyKey: string): Promise<void>;
  attachmentDownloadUrl(attachmentId: string): Promise<DownloadUrl>;

  /* E5-F: built-in stickers (managed only). */
  listStickerPacks(chatId: string): Promise<StickerPackList>;
  favoriteSticker(stickerId: string): Promise<void>;
  unfavoriteSticker(stickerId: string): Promise<void>;

  /* E6-F: in-app notifications (contract `/notifications*`). */
  listNotifications(query?: ListNotificationsQuery): Promise<NotificationPage>;
  markNotificationsRead(body: ReadNotificationsRequest, idempotencyKey: string): Promise<void>;
  getNotificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreference(
    body: NotificationPreferencePatch,
    idempotencyKey: string,
  ): Promise<NotificationPreference>;
}

export interface ListNotificationsQuery {
  /** Opaque base64url cursor from `page.next_cursor`; never constructed locally. */
  cursor?: string;
  limit?: number;
}

type ApiAuthConfig = Pick<AppConfig, 'devSession'> & { authMode?: AppConfig['authMode'] };

const REAUTH_COOLDOWN_MS = 5_000;

export function createApi(client: ApiClient, config: ApiAuthConfig): ChatApi {
  let bootstrapPromise: Promise<Session> | null = null;
  let reauthPromise: Promise<boolean> | null = null;
  let lastReauthAt = 0;

  const authMode = config.authMode ?? getAuthRuntimeMode();

  async function ensureSession(force: boolean): Promise<Session> {
    const existing = getSession();
    if (!force && existing) return existing;

    if (!config.devSession || authMode !== 'dev') {
      throw ApiError.client(
        'UNAUTHENTICATED',
        'Dev session is disabled; authenticate through the configured auth provider.',
        401,
      );
    }

    bootstrapPromise ??= client
      .post<Session>('/dev/session', {}, { auth: false })
      .then((response) => {
        setSession(response.data);
        return response.data;
      })
      .finally(() => {
        bootstrapPromise = null;
      });

    return bootstrapPromise;
  }

  /**
   * A request is retried at most once after a 401. Concurrent 401s share one
   * refresh attempt, and a short cooldown prevents a re-login/401 loop.
   */
  async function attemptReauth(): Promise<boolean> {
    if (authMode !== 'dev') {
      const now = Date.now();
      if (now - lastReauthAt < REAUTH_COOLDOWN_MS) return false;
      lastReauthAt = now;
      reauthPromise ??= reauthenticate().finally(() => {
        reauthPromise = null;
      });
      return reauthPromise;
    }

    try {
      await ensureSession(true);
      return true;
    } catch {
      return false;
    }
  }

  async function withReauth<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        const replayed = await attemptReauth();
        if (replayed) return run();
      }
      throw error;
    }
  }

  return {
    bootstrapDevSession: () => ensureSession(true),

    getMe() {
      return withReauth(async () => {
        const response = await client.get<MeResponse>('/me');
        return response.data;
      });
    },

    getSetupStatus() {
      // Public contract operation: setup must be reachable before login and
      // must never trigger the app 401/refresh loop.
      return client.get<SetupStatus>('/setup/status').then((response) => response.data);
    },

    getAdminSettings() {
      return withReauth(async () => {
        const response = await client.get<AdminSettings>('/admin/settings');
        return response.data;
      });
    },

    updateAdminSettings(body) {
      return withReauth(async () => {
        const response = await client.patch<AdminSettings>('/admin/settings', body);
        return response.data;
      });
    },

    sendTestEmail(body) {
      return withReauth(async () => {
        const response = await client.post<TestEmailResponse>('/admin/settings/test-email', body);
        return response.data;
      });
    },

    getAdminOverview() {
      return withReauth(async () => {
        const response = await client.get<AdminOverview>('/admin/overview');
        return response.data;
      });
    },

    listAdminUsers(query = {}) {
      return withReauth(async () => {
        // Empty search/filters are omitted: the contract defaults are server-side.
        const response = await client.get<AdminUserPage>('/admin/users', {
          query: query.query?.trim() || undefined,
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    listAdminChats(query = {}) {
      return withReauth(async () => {
        const response = await client.get<AdminChatPage>('/admin/chats', {
          workspace_id: query.workspaceId,
          query: query.query?.trim() || undefined,
          type: query.type,
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    getAdminStorage(query = {}) {
      return withReauth(async () => {
        const response = await client.get<AdminStorage>('/admin/storage', {
          workspace_id: query.workspaceId,
        });
        return response.data;
      });
    },

    /*
     * E11-F admin actions. The contract has no request/response body: success
     * is `204` and the resulting state is read back from the directory (the
     * server stays the source of truth). Repeat actions are `409` by design,
     * so no `Idempotency-Key` is invented here; `X-Device-Id` is attached by
     * the shared HTTP client for every authenticated request.
     */
    suspendUser(userId) {
      return withReauth(async () => {
        await client.post(`/admin/users/${encodeURIComponent(userId)}/suspend`);
      });
    },

    activateUser(userId) {
      return withReauth(async () => {
        await client.post(`/admin/users/${encodeURIComponent(userId)}/activate`);
      });
    },

    deleteChat(chatId) {
      return withReauth(async () => {
        await client.delete(`/admin/chats/${encodeURIComponent(chatId)}`);
      });
    },

    listAdminAudit(query = {}) {
      return withReauth(async () => {
        // Exact `action` filter, empty input omits the parameter (server
        // default = all actions).
        const response = await client.get<AdminAuditPage>('/admin/audit', {
          action: query.action?.trim() || undefined,
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    registerDevice(body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<Device>('/devices', body, { idempotencyKey });
        return response.data;
      });
    },

    createWorkspace(body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<WorkspaceSummary>('/workspaces', body, {
          idempotencyKey,
        });
        return response.data;
      });
    },

    createChat(workspaceId, body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<Chat>(
          `/workspaces/${encodeURIComponent(workspaceId)}/chats`,
          body,
          { idempotencyKey },
        );
        return response.data;
      });
    },

    listChats(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<ChatList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/chats`,
        );
        return response.data;
      });
    },

    listMessages(chatId, query = {}) {
      return withReauth(async () => {
        const response = await client.get<MessagePage>(
          `/chats/${encodeURIComponent(chatId)}/messages`,
          {
            after_seq: query.afterSeq,
            before_seq: query.beforeSeq,
            limit: query.limit,
            thread_root_id: query.threadRootId,
          },
        );
        return response.data;
      });
    },

    sendMessage(chatId, body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<ApiMessage>(
          `/chats/${encodeURIComponent(chatId)}/messages`,
          body,
          { idempotencyKey },
        );
        return {
          message: response.data,
          replayed: response.headers.get('Idempotent-Replay') === 'true',
        };
      });
    },

    markRead(chatId, lastSeq, idempotencyKey) {
      return withReauth(async () => {
        await client.post(
          `/chats/${encodeURIComponent(chatId)}/read`,
          { last_seq: lastSeq },
          { idempotencyKey },
        );
      });
    },

    sync(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<SyncResponse>('/sync', {
          workspace_id: workspaceId,
        });
        return response.data;
      });
    },

    createRealtimeTicket() {
      return withReauth(async () => {
        // Contract: POST /realtime/ticket, Bearer + X-Device-Id, no body.
        const response = await client.post<RealtimeTicket>('/realtime/ticket');
        return response.data;
      });
    },

    /* ------------------------------------------------------------------ */
    /* E4-F: managed files                                                */
    /* ------------------------------------------------------------------ */

    getWorkspaceLimits(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceLimits>(
          `/workspaces/${encodeURIComponent(workspaceId)}/limits`,
        );
        return response.data;
      });
    },

    listWorkspaceMembers(workspaceId, query = {}) {
      return withReauth(async () => {
        // `query` is literal server-side search; empty input is omitted so the
        // server applies its default first page (limit 50).
        const response = await client.get<WorkspaceMemberPage>(
          `/workspaces/${encodeURIComponent(workspaceId)}/members`,
          {
            query: query.query?.trim() || undefined,
            cursor: query.cursor,
            limit: query.limit,
          },
        );
        return response.data;
      });
    },

    addWorkspaceMember(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.post<WorkspaceMember>(
          `/workspaces/${encodeURIComponent(workspaceId)}/members`,
          body,
        );
        return response.data;
      });
    },

    changeWorkspaceMemberRole(workspaceId, userId, body) {
      return withReauth(async () => {
        const response = await client.patch<WorkspaceMember>(
          `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
          body,
        );
        return response.data;
      });
    },

    removeWorkspaceMember(workspaceId, userId) {
      return withReauth(async () => {
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
        );
      });
    },

    preflightUpload(chatId, files, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<PreflightResponse>(
          '/uploads/preflight',
          { chat_id: chatId, files },
          { idempotencyKey },
        );
        return response.data;
      });
    },

    initUpload(body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<UploadSession>('/uploads', body, { idempotencyKey });
        return response.data;
      });
    },

    getUpload(uploadId) {
      return withReauth(async () => {
        const response = await client.get<UploadSession>(
          `/uploads/${encodeURIComponent(uploadId)}`,
        );
        return response.data;
      });
    },

    putUploadPart(uploadId, partNo, bytes, sha256, options = {}) {
      return withReauth(async () => {
        const response = await client.put<UploadPart>(
          `/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}`,
          bytes,
          {
            headers: { 'Content-SHA256': sha256 },
            timeoutMs: options.timeoutMs ?? 60_000,
            signal: options.signal,
          },
        );
        return response.data;
      });
    },

    completeUpload(uploadId, body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.post<UploadSession>(
          `/uploads/${encodeURIComponent(uploadId)}/complete`,
          body,
          { idempotencyKey, timeoutMs: 60_000 },
        );
        return { session: response.data, status: response.status };
      });
    },

    abortUpload(uploadId, idempotencyKey) {
      return withReauth(async () => {
        await client.post(`/uploads/${encodeURIComponent(uploadId)}/abort`, undefined, {
          idempotencyKey,
        });
      });
    },

    attachmentDownloadUrl(attachmentId) {
      return withReauth(async () => {
        const response = await client.get<DownloadUrl>(
          `/attachments/${encodeURIComponent(attachmentId)}/download-url`,
        );
        return response.data;
      });
    },

    /* ------------------------------------------------------------------ */
    /* E5-F: built-in stickers                                            */
    /* ------------------------------------------------------------------ */

    listStickerPacks(chatId) {
      return withReauth(async () => {
        const response = await client.get<StickerPackList>('/sticker-packs', {
          chat_id: chatId,
        });
        return response.data;
      });
    },

    favoriteSticker(stickerId) {
      return withReauth(async () => {
        await client.put(`/stickers/${encodeURIComponent(stickerId)}/favorite`);
      });
    },

    unfavoriteSticker(stickerId) {
      return withReauth(async () => {
        await client.delete(`/stickers/${encodeURIComponent(stickerId)}/favorite`);
      });
    },

    /* ------------------------------------------------------------------ */
    /* E6-F: in-app notifications                                         */
    /* ------------------------------------------------------------------ */

    listNotifications(query = {}) {
      return withReauth(async () => {
        const response = await client.get<NotificationPage>('/notifications', {
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    markNotificationsRead(body, idempotencyKey) {
      return withReauth(async () => {
        await client.post('/notifications/read', body, { idempotencyKey });
      });
    },

    getNotificationPreferences() {
      return withReauth(async () => {
        const response = await client.get<NotificationPreferences>('/notification-preferences');
        return response.data;
      });
    },

    updateNotificationPreference(body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.patch<NotificationPreference>(
          '/notification-preferences',
          body,
          { idempotencyKey },
        );
        return response.data;
      });
    },
  };
}
