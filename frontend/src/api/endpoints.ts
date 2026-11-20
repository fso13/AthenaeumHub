import type { AppConfig } from '../config/env';
import { getSession, setSession } from '../auth/session';
import { getAuthRuntimeMode } from '../auth/runtime';
import { reauthenticate } from '../auth/reauth';
import type { ApiClient } from './http';
import { ApiError, isApiError } from './problem';
import type {
  AddChatMemberRequest,
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
  AuthUser,
  BlockedUserList,
  ChangeChatMemberRoleRequest,
  ChangeWorkspaceMemberRoleRequest,
  Chat,
  ChatCoverRequest,
  ChatCreateRequest,
  ChatInviteCreateRequest,
  ChatPermissions,
  ChatPermissionsUpdate,
  ChatPin,
  ChatPinList,
  ChatInviteCreated,
  ChatInviteList,
  ChatMember,
  ChatMembersResponse,
  ChatUpdateRequest,
  ChatList,
  ChatPluginState,
  ChatPluginStateList,
  ChatPluginUpdateRequest,
  PluginList,
  Poll,
  PollCloseRequest,
  PollCreate,
  PollList,
  PollVoteRequest,
  CreateWorkspaceRequest,
  Device,
  DeviceList,
  DeviceRegistration,
  DownloadUrl,
  FileKindFilter,
  FilePage,
  FileScanStatusFilter,
  InviteAcceptResult,
  MeResponse,
  MessageCreateBody,
  MessageDeleteScope,
  MessageEdit,
  MessagePage,
  NotificationPage,
  NotificationPreference,
  NotificationPreferencePatch,
  NotificationPreferences,
  PreflightFile,
  PreflightResponse,
  ProfileSessions,
  ProfileUpdate,
  ReactionSummary,
  ReadNotificationsRequest,
  RealtimeTicket,
  Session,
  SetupStatus,
  StickerPackList,
  SyncResponse,
  Task,
  TaskCreate,
  TaskList,
  TaskUpdate,
  Translation,
  TranslationRequest,
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

/**
 * #73 file-center query. Every filter maps 1:1 to the contract parameter; the
 * client never builds `cursor` locally (it is the opaque `next_cursor` of the
 * previous page) and never sends object keys or presigned URLs.
 */
export interface ListFilesQuery {
  workspaceId?: string;
  chatId?: string;
  kind?: FileKindFilter;
  scanStatus?: FileScanStatusFilter;
  /** Literal case-insensitive substring over filename and MIME (max 200). */
  query?: string;
  /** Exact MIME match (max 128). */
  mime?: string;
  /** Extension without the dot (max 10, `[A-Za-z0-9]`). */
  extension?: string;
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
  /** #72: partial profile update; the server owns validation and audit. */
  updateMe(body: ProfileUpdate): Promise<AuthUser>;
  /** #72: Keycloak sessions of the caller (no IP/username/tokens). */
  listMySessions(): Promise<ProfileSessions>;
  /** #72: revoke one own session; `404` means it is already gone. */
  revokeMySession(sessionId: string): Promise<void>;
  /** #73: file-center page with metadata-only rows and the workspace quota. */
  listFiles(query?: ListFilesQuery): Promise<FilePage>;

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
  /** D1-FE5: profile device list (id/name/platform/status only in the UI). */
  listDevices(): Promise<DeviceList>;
  createWorkspace(body: CreateWorkspaceRequest, idempotencyKey: string): Promise<WorkspaceSummary>;
  /** E8: GROUP creation is idempotent by `Idempotency-Key`; DIRECT needs `peer_id`. */
  createChat(workspaceId: string, body: ChatCreateRequest, idempotencyKey: string): Promise<Chat>;
  /** D1-FE5: `PATCH /chats/{chatId}` (workspace OWNER/ADMIN; no optimistic lock). */
  updateChat(chatId: string, body: ChatUpdateRequest): Promise<Chat>;
  /**
   * `GET /workspaces/{workspaceId}/chats`. `archived=true` returns only the
   * caller's personal archive; absent/false is the main list (P0-2 #80).
   */
  listChats(workspaceId: string, archived?: boolean): Promise<ChatList>;
  /**
   * #80 `DELETE /chats/{chatId}`: soft delete by the ACTIVE chat OWNER.
   * Named differently from the platform-admin `deleteChat(chatId)` above.
   */
  deleteOwnChat(chatId: string): Promise<void>;
  /**
   * #80 channel cover. There is no upload endpoint: `file_id` is an existing
   * managed image attachment of the same chat. Validation is server-side
   * (404 foreign/other-chat, 422 CHAT_COVER_INVALID, 409 ATTACHMENT_NOT_READY,
   * 423 ATTACHMENT_QUARANTINED).
   */
  setChatCover(chatId: string, body: ChatCoverRequest): Promise<Chat>;
  /** #80 idempotent `204`; the attachment itself is not deleted. */
  deleteChatCover(chatId: string): Promise<void>;
  /** #80 effective rights matrix; any ACTIVE GROUP participant may read it. */
  getChatPermissions(chatId: string): Promise<ChatPermissions>;
  /** #80 partial per-role patch; OWNER/ADMIN only, `owner` row rejected. */
  updateChatPermissions(chatId: string, body: ChatPermissionsUpdate): Promise<ChatPermissions>;
  /** #80 user-local archive (`204`, idempotent); DIRECT included. */
  archiveChat(chatId: string): Promise<void>;
  /** #80 user-local unarchive (`204`, idempotent). */
  unarchiveChat(chatId: string): Promise<void>;
  /** #80 pinned-message metadata; newest first, no content. */
  listChatPins(chatId: string): Promise<ChatPinList>;
  /** #80 pin (201 first, 200 repeat); `409 CHAT_PIN_LIMIT` at 50. */
  pinChatMessage(chatId: string, messageId: string): Promise<ChatPin>;
  /** #80 idempotent unpin (`204`). */
  unpinChatMessage(chatId: string, messageId: string): Promise<void>;
  listMessages(chatId: string, query?: ListMessagesQuery): Promise<MessagePage>;
  sendMessage(
    chatId: string,
    body: MessageCreateBody,
    idempotencyKey: string,
  ): Promise<SendMessageResult>;
  /**
   * #61–#63 message actions. All are managed-only: the backend rejects E2EE
   * metadata mutations with `422 E2EE_METADATA_FORBIDDEN`; the UI never calls
   * them for an E2EE chat. Reactions are idempotent (POST/DELETE), edits carry
   * an optional `version` for the optimistic lock, and delete defaults to
   * `scope=me`.
   */
  addReaction(chatId: string, messageId: string, emoji: string): Promise<ReactionSummary>;
  removeReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
  editMessage(chatId: string, messageId: string, body: MessageEdit): Promise<ApiMessage>;
  deleteMessage(chatId: string, messageId: string, scope: MessageDeleteScope): Promise<void>;
  markRead(chatId: string, lastSeq: number, idempotencyKey: string): Promise<void>;
  sync(workspaceId: string): Promise<SyncResponse>;
  /** E3: one-time ticket; each reconnect must request a fresh one. */
  createRealtimeTicket(): Promise<RealtimeTicket>;

  /*
   * D1.1 (#69): built-in plugin catalog and per-chat switches. The catalog is
   * closed (no marketplace/install); `PATCH` is chat OWNER/ADMIN only and the
   * server owns availability, so the UI never mutates state optimistically.
   */
  listPlugins(): Promise<PluginList>;
  listChatPlugins(chatId: string): Promise<ChatPluginStateList>;
  /** #77: active chat member ids for the group-call picker. */
  listChatMembers(chatId: string): Promise<ChatMembersResponse>;
  /**
   * #79 channel membership. The server owns role ceilings, the last-OWNER
   * guard, self actions and ACTIVE-workspace membership; the client only
   * echoes contract fields and replaces rows with server responses.
   */
  addChatMember(chatId: string, body: AddChatMemberRequest): Promise<ChatMember>;
  changeChatMemberRole(
    chatId: string,
    userId: string,
    body: ChangeChatMemberRoleRequest,
  ): Promise<ChatMember>;
  removeChatMember(chatId: string, userId: string): Promise<void>;
  /** Idempotent alias of self-removal (`204` on repeat). */
  leaveChat(chatId: string): Promise<void>;
  /** OWNER/ADMIN metadata list; the token is never returned again. */
  listChatInvites(chatId: string): Promise<ChatInviteList>;
  /** `token` in the response is the only readable copy; store it once. */
  createChatInvite(chatId: string, body: ChatInviteCreateRequest): Promise<ChatInviteCreated>;
  revokeChatInvite(chatId: string, inviteId: string): Promise<void>;
  /** The accept URL has no workspace: the server resolves it from the token. */
  acceptChatInvite(token: string): Promise<InviteAcceptResult>;
  /** Self-service blocks (identity-scoped, no workspace dimension). */
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  listBlockedUsers(): Promise<BlockedUserList>;
  updateChatPlugin(
    chatId: string,
    pluginId: string,
    body: ChatPluginUpdateRequest,
  ): Promise<ChatPluginState>;

  /*
   * D1.1 (#76): real plugin actions on managed chats. The server owns option
   * ids, vote/task permissions, ordering, timestamps and the translation
   * provider; the client never fabricates a poll/task/translation result and
   * never applies an optimistic vote or task mutation.
   */
  listPolls(chatId: string): Promise<PollList>;
  createPoll(chatId: string, body: PollCreate): Promise<Poll>;
  closePoll(chatId: string, pollId: string, body: PollCloseRequest): Promise<Poll>;
  votePoll(chatId: string, pollId: string, body: PollVoteRequest): Promise<Poll>;
  listTasks(chatId: string): Promise<TaskList>;
  createTask(chatId: string, body: TaskCreate): Promise<Task>;
  updateTask(chatId: string, taskId: string, body: TaskUpdate): Promise<Task>;
  /** Managed TEXT only; an unconfigured provider is an honest `503`. */
  translateMessage(
    chatId: string,
    messageId: string,
    body: TranslationRequest,
  ): Promise<Translation>;

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

    updateMe(body) {
      return withReauth(async () => {
        // All fields are optional; the caller sends only the changed ones.
        const response = await client.patch<AuthUser>('/me', body);
        return response.data;
      });
    },

    listMySessions() {
      return withReauth(async () => {
        const response = await client.get<ProfileSessions>('/me/sessions');
        return response.data;
      });
    },

    revokeMySession(sessionId) {
      return withReauth(async () => {
        // Success is `204`; a repeat revoke is `404` by design.
        await client.delete(`/me/sessions/${encodeURIComponent(sessionId)}`);
      });
    },

    listFiles(query = {}) {
      return withReauth(async () => {
        // Empty filters are omitted so the server applies its documented defaults.
        const response = await client.get<FilePage>('/files', {
          workspace_id: query.workspaceId,
          chat_id: query.chatId,
          kind: query.kind,
          scan_status: query.scanStatus,
          query: query.query?.trim() || undefined,
          mime: query.mime?.trim() || undefined,
          extension: query.extension?.trim() || undefined,
          cursor: query.cursor,
          limit: query.limit,
        });
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

    listDevices() {
      return withReauth(async () => {
        const response = await client.get<DeviceList>('/devices');
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

    updateChat(chatId, body) {
      return withReauth(async () => {
        const response = await client.patch<Chat>(`/chats/${encodeURIComponent(chatId)}`, body);
        return response.data;
      });
    },

    listChats(workspaceId, archived) {
      return withReauth(async () => {
        // `archived=false` is the documented default, so only `true` is sent.
        const response = await client.get<ChatList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/chats`,
          { archived: archived === true ? true : undefined },
        );
        return response.data;
      });
    },

    deleteOwnChat(chatId) {
      return withReauth(async () => {
        // Success is a bodyless `204`; a repeat is `404` by design.
        await client.delete(`/chats/${encodeURIComponent(chatId)}`);
      });
    },

    setChatCover(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<Chat>(
          `/chats/${encodeURIComponent(chatId)}/cover`,
          body,
        );
        return response.data;
      });
    },

    deleteChatCover(chatId) {
      return withReauth(async () => {
        // Idempotent `204`; the attachment stays in the file flow.
        await client.delete(`/chats/${encodeURIComponent(chatId)}/cover`);
      });
    },

    getChatPermissions(chatId) {
      return withReauth(async () => {
        const response = await client.get<ChatPermissions>(
          `/chats/${encodeURIComponent(chatId)}/permissions`,
        );
        return response.data;
      });
    },

    updateChatPermissions(chatId, body) {
      return withReauth(async () => {
        const response = await client.patch<ChatPermissions>(
          `/chats/${encodeURIComponent(chatId)}/permissions`,
          body,
        );
        return response.data;
      });
    },

    archiveChat(chatId) {
      return withReauth(async () => {
        await client.post(`/chats/${encodeURIComponent(chatId)}/archive`);
      });
    },

    unarchiveChat(chatId) {
      return withReauth(async () => {
        await client.post(`/chats/${encodeURIComponent(chatId)}/unarchive`);
      });
    },

    listChatPins(chatId) {
      return withReauth(async () => {
        const response = await client.get<ChatPinList>(`/chats/${encodeURIComponent(chatId)}/pins`);
        return response.data;
      });
    },

    pinChatMessage(chatId, messageId) {
      return withReauth(async () => {
        const response = await client.post<ChatPin>(`/chats/${encodeURIComponent(chatId)}/pins`, {
          message_id: messageId,
        });
        return response.data;
      });
    },

    unpinChatMessage(chatId, messageId) {
      return withReauth(async () => {
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/pins/${encodeURIComponent(messageId)}`,
        );
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

    addReaction(chatId, messageId, emoji) {
      return withReauth(async () => {
        const response = await client.post<ReactionSummary>(
          `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`,
          { emoji },
        );
        return response.data;
      });
    },

    removeReaction(chatId, messageId, emoji) {
      return withReauth(async () => {
        // The emoji is a path segment: encode ZWJ/VS16 sequences exactly once.
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(
            messageId,
          )}/reactions/${encodeURIComponent(emoji)}`,
        );
      });
    },

    editMessage(chatId, messageId, body) {
      return withReauth(async () => {
        const response = await client.patch<ApiMessage>(
          `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
          body,
        );
        return response.data;
      });
    },

    deleteMessage(chatId, messageId, scope) {
      return withReauth(async () => {
        // `scope` is a query parameter; `me` is the contract default.
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?scope=${scope}`,
        );
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
    /* D1.1 (#69): built-in plugins                                       */
    /* ------------------------------------------------------------------ */

    listPlugins() {
      return withReauth(async () => {
        // Catalog is global and authenticated; no chat/workspace is required.
        const response = await client.get<PluginList>('/plugins');
        return response.data;
      });
    },

    listChatMembers(chatId) {
      return withReauth(async () => {
        // #79: `members[]` carries display details and `user_ids` remains the
        // compat projection used by the group-call picker.
        const response = await client.get<ChatMembersResponse>(
          `/chats/${encodeURIComponent(chatId)}/members`,
        );
        return response.data;
      });
    },

    /*
     * #79: channel membership. Add is idempotent (`200` repeat / `201` first
     * write); PATCH is the only role-change path; DELETE/leave are soft and
     * idempotent for self. No `Idempotency-Key` is invented: the contract does
     * not require one for these operations.
     */
    addChatMember(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<ChatMember>(
          `/chats/${encodeURIComponent(chatId)}/members`,
          body,
        );
        return response.data;
      });
    },

    changeChatMemberRole(chatId, userId, body) {
      return withReauth(async () => {
        const response = await client.patch<ChatMember>(
          `/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`,
          body,
        );
        return response.data;
      });
    },

    removeChatMember(chatId, userId) {
      return withReauth(async () => {
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`,
        );
      });
    },

    leaveChat(chatId) {
      return withReauth(async () => {
        await client.post(`/chats/${encodeURIComponent(chatId)}/leave`);
      });
    },

    listChatInvites(chatId) {
      return withReauth(async () => {
        const response = await client.get<ChatInviteList>(
          `/chats/${encodeURIComponent(chatId)}/invites`,
        );
        return response.data;
      });
    },

    createChatInvite(chatId, body) {
      return withReauth(async () => {
        // The `token` field exists only in this response; it is never persisted
        // server-side and cannot be read back from the list.
        const response = await client.post<ChatInviteCreated>(
          `/chats/${encodeURIComponent(chatId)}/invites`,
          body,
        );
        return response.data;
      });
    },

    revokeChatInvite(chatId, inviteId) {
      return withReauth(async () => {
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/invites/${encodeURIComponent(inviteId)}`,
        );
      });
    },

    acceptChatInvite(token) {
      return withReauth(async () => {
        const response = await client.post<InviteAcceptResult>(
          `/invites/${encodeURIComponent(token)}/accept`,
        );
        return response.data;
      });
    },

    blockUser(userId) {
      return withReauth(async () => {
        await client.post(`/users/${encodeURIComponent(userId)}/block`);
      });
    },

    unblockUser(userId) {
      return withReauth(async () => {
        await client.delete(`/users/${encodeURIComponent(userId)}/block`);
      });
    },

    listBlockedUsers() {
      return withReauth(async () => {
        const response = await client.get<BlockedUserList>('/me/blocked');
        return response.data;
      });
    },

    listChatPlugins(chatId) {
      return withReauth(async () => {
        const response = await client.get<ChatPluginStateList>(
          `/chats/${encodeURIComponent(chatId)}/plugins`,
        );
        return response.data;
      });
    },

    updateChatPlugin(chatId, pluginId, body) {
      return withReauth(async () => {
        // The server is the source of truth: callers replace their row with the
        // returned state instead of applying the requested value locally.
        const response = await client.patch<ChatPluginState>(
          `/chats/${encodeURIComponent(chatId)}/plugins/${encodeURIComponent(pluginId)}`,
          body,
        );
        return response.data;
      });
    },

    /* ------------------------------------------------------------------ */
    /* D1.1 (#76): plugin actions                                         */
    /* ------------------------------------------------------------------ */

    listPolls(chatId) {
      return withReauth(async () => {
        const response = await client.get<PollList>(`/chats/${encodeURIComponent(chatId)}/polls`);
        return response.data;
      });
    },

    createPoll(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<Poll>(
          `/chats/${encodeURIComponent(chatId)}/polls`,
          body,
        );
        return response.data;
      });
    },

    closePoll(chatId, pollId, body) {
      return withReauth(async () => {
        const response = await client.patch<Poll>(
          `/chats/${encodeURIComponent(chatId)}/polls/${encodeURIComponent(pollId)}`,
          body,
        );
        return response.data;
      });
    },

    votePoll(chatId, pollId, body) {
      return withReauth(async () => {
        // The response carries the recalculated aggregate and `my_option_id`;
        // nothing is incremented locally.
        const response = await client.post<Poll>(
          `/chats/${encodeURIComponent(chatId)}/polls/${encodeURIComponent(pollId)}/votes`,
          body,
        );
        return response.data;
      });
    },

    listTasks(chatId) {
      return withReauth(async () => {
        const response = await client.get<TaskList>(`/chats/${encodeURIComponent(chatId)}/tasks`);
        return response.data;
      });
    },

    createTask(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<Task>(
          `/chats/${encodeURIComponent(chatId)}/tasks`,
          body,
        );
        return response.data;
      });
    },

    updateTask(chatId, taskId, body) {
      return withReauth(async () => {
        const response = await client.patch<Task>(
          `/chats/${encodeURIComponent(chatId)}/tasks/${encodeURIComponent(taskId)}`,
          body,
        );
        return response.data;
      });
    },

    translateMessage(chatId, messageId, body) {
      return withReauth(async () => {
        const response = await client.post<Translation>(
          `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/translate`,
          body,
        );
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
