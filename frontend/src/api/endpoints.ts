import type { AppConfig } from '../config/env';
import { getSession, setSession } from '../auth/session';
import { getAuthRuntimeMode } from '../auth/runtime';
import { reauthenticate } from '../auth/reauth';
import { pluginAssetApiPath, pluginRelativeAssetApiPath } from '../plugins/assets';
import type { ApiClient } from './http';
import { ApiError, isApiError } from './problem';
import type {
  AddChatMemberRequest,
  AddWorkspaceMemberRequest,
  AdminAuditExportFormat,
  AdminAuditPage,
  AdminChatPage,
  AdminChatType,
  AdminOverview,
  AdminPluginPackage,
  AdminPluginPackageList,
  AdminSessionPage,
  AdminSessionRevokeAll,
  AdminSettings,
  AdminSettingsPatch,
  AdminStorage,
  AdminUserPage,
  ApiMessage,
  AuthUser,
  BlockedUserList,
  Bot,
  BotCommandAccepted,
  BotCommandInvoke,
  BotCreateRequest,
  BotDeliveryAccepted,
  BotDeliveryList,
  BotList,
  BotSigningSecret,
  BotToken,
  BotUpdateRequest,
  ChangeChatMemberRoleRequest,
  ChangeWorkspaceMemberRoleRequest,
  Chat,
  ChatCoverRequest,
  ChatAvatarRequest,
  ChatBot,
  ChatBotList,
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
  AuditExportFormat,
  AvatarUpdate,
  Device,
  DeviceList,
  DeviceRegistration,
  DlpAction,
  DlpEventPage,
  DlpPolicy,
  DlpPolicyCreateRequest,
  DlpPolicyList,
  DlpPolicyUpdateRequest,
  DownloadUrl,
  FileItem,
  FileKindFilter,
  FilePage,
  FileRename,
  FileScanStatusFilter,
  InviteAcceptResult,
  MentionPage,
  MediaImage,
  MeResponse,
  MessageCreateBody,
  MessageDeleteScope,
  MessageEdit,
  MessagePage,
  MessageSearchPage,
  NotificationPage,
  NotificationPreference,
  NotificationPreferencePatch,
  NotificationPreferences,
  PreflightFile,
  PreflightResponse,
  ProfileSessions,
  ProfileUpdate,
  ReactionSummary,
  ReadMentionsRequest,
  ReadNotificationsRequest,
  RealtimeTicket,
  Room,
  RoomCreateRequest,
  RoomList,
  RoomUpdateRequest,
  Session,
  SetupStatus,
  StickerPackList,
  SyncResponse,
  Task,
  TaskCreate,
  TaskList,
  TaskUpdate,
  Translation,
  TranslationProviderSettings,
  TranslationProviderTest,
  TranslationProviderUpdate,
  TranslationRequest,
  TestEmailRequest,
  TestEmailResponse,
  TwoFactorDisableRequest,
  TwoFactorRecoveryCodes,
  TwoFactorSetup,
  TwoFactorStatus,
  TwoFactorVerifyRequest,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadPart,
  UploadSession,
  WorkspaceAuditPage,
  WorkspaceAvatarRequest,
  WorkspaceInviteAcceptance,
  WorkspaceInviteCreateRequest,
  WorkspaceInviteCreated,
  WorkspaceInviteList,
  WorkspaceInvitePreview,
  WorkspaceLimits,
  WorkspaceMember,
  WorkspaceMemberPage,
  WorkspaceOverview,
  WorkspacePermissionMatrix,
  WorkspacePermissionUpdate,
  WorkspaceSecurity,
  WorkspaceSecurityUpdateRequest,
  WorkspaceSessionPage,
  WorkspaceSessionRevokeAll,
  WorkspaceSummary,
  WorkspaceUpdate,
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
 * #84 admin audit export. Same exact `action` filter as the page; the server
 * caps the result at 10 000 rows and reports truncation through headers.
 */
export interface ExportAdminAuditQuery {
  format: AdminAuditExportFormat;
  action?: string;
}

/**
 * Bounded export returned as a Blob so the browser writes exactly the server
 * bytes. `rows`/`truncated` come from `X-Export-Rows`/`X-Export-Truncated`;
 * `filename` comes from `Content-Disposition` when present.
 */
export interface AdminAuditExportResult {
  blob: Blob;
  filename: string | null;
  rows: number | null;
  truncated: boolean;
}

/**
 * #84 Keycloak sessions of the selected local user. `cursor` is opaque and
 * bound to `userId` server-side; the client only echoes it back.
 */
export interface ListAdminSessionsQuery {
  userId: string;
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
/**
 * P0-3 DLP event page. `policy_id` and `action` are exact filters; `cursor` is
 * the opaque workspace-bound `next_cursor` and is never built locally.
 */
export interface ListWorkspaceDlpEventsQuery {
  policyId?: string;
  action?: DlpAction;
  cursor?: string;
  limit?: number;
}

/** P0-3 workspace audit filters; dates are inclusive (`from > to` → 400). */
export interface ListWorkspaceAuditQuery {
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** Export has the same filters as the page but no cursor/limit (cap 10 000). */
export interface ExportWorkspaceAuditQuery {
  format: AuditExportFormat;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

/**
 * Bounded export returned as a Blob so the browser writes the exact server
 * bytes. `rows`/`truncated` come from `X-Export-Rows`/`X-Export-Truncated`;
 * `filename` comes from `Content-Disposition` when present.
 */
export interface WorkspaceAuditExportResult {
  blob: Blob;
  filename: string | null;
  rows: number | null;
  truncated: boolean;
}

export interface ListWorkspaceSessionsQuery {
  cursor?: string;
  limit?: number;
}

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

/** #83: progress/cancellation for the one-shot global file upload. */
export interface WorkspaceFileUploadOptions {
  signal?: AbortSignal;
  /** Bytes reported by `XMLHttpRequest.upload`; `total` may be 0 (unknown). */
  onProgress?: (loaded: number, total: number) => void;
}

/** #83: `GET /workspaces/{id}/search/messages`; `q` is a literal substring. */
export interface SearchMessagesQuery {
  q: string;
  chatId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** #83: `GET /me/mentions`; `workspaceId` overrides the claim scope. */
export interface ListMentionsQuery {
  workspaceId?: string;
  unread?: boolean;
  cursor?: string;
  limit?: number;
}

export interface SendMessageResult {
  message: ApiMessage;
  replayed: boolean;
}

/** D1.2 (#86): upload progress/cancellation for the admin ZIP install. */
export interface PluginPackageUploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * #93 device image upload. The optional `chat_id` scopes a cover/icon so the
 * existing setters accept it; profile/logo uploads omit it and the server binds
 * the direct image to the caller's active workspace.
 */
export interface ImageUploadOptions extends PluginPackageUploadOptions {
  /** Optional chat binding for a cover/icon; profile/logo uploads omit it. */
  chatId?: string | null;
}

/**
 * Tolerant `POST /media/images` normalization: the only value the next request
 * needs is `file_id`. A future nested `file`/`attachment` projection is
 * accepted instead of surfacing a broken UI over a successful upload.
 */
function normalizeMediaImage(data: unknown): MediaImage {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw ApiError.client('INVALID_RESPONSE', 'Image upload response is not an object');
  }
  const record = data as Record<string, unknown>;
  const nested =
    record.file !== null && typeof record.file === 'object'
      ? (record.file as Record<string, unknown>)
      : record.attachment !== null && typeof record.attachment === 'object'
        ? (record.attachment as Record<string, unknown>)
        : null;
  const fileId =
    typeof record.file_id === 'string'
      ? record.file_id
      : typeof record.id === 'string'
        ? record.id
        : typeof nested?.file_id === 'string'
          ? nested.file_id
          : typeof nested?.id === 'string'
            ? nested.id
            : null;
  if (!fileId) {
    throw ApiError.client('INVALID_RESPONSE', 'Image upload response has no file_id');
  }
  const readString = (key: string): string | null => {
    const value = record[key] ?? nested?.[key];
    return typeof value === 'string' ? value : null;
  };
  const size = record.size_bytes ?? record.size ?? nested?.size_bytes ?? nested?.size;
  return {
    file_id: fileId,
    filename: readString('filename'),
    mime_type: readString('mime_type') ?? readString('mime'),
    size_bytes: typeof size === 'number' ? size : null,
    scan_status: readString('scan_status'),
  };
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

  /*
   * P0-4 (#82): self-service avatar + TOTP authenticator. The setup secret and
   * recovery codes are readable only from their one-time responses; the client
   * keeps them in memory and never persists/logs them. Every mutating call
   * carries the password re-auth the server requires.
   */
  setMyAvatar(fileId: string): Promise<AuthUser>;
  removeMyAvatar(): Promise<void>;
  /** Authenticated avatar bytes (the contract `302` is followed by `fetch`). */
  getMyAvatarBlob(): Promise<Blob>;
  getMyTwoFactor(): Promise<TwoFactorStatus>;
  setupMyTwoFactor(password: string): Promise<TwoFactorSetup>;
  verifyMyTwoFactor(code: string): Promise<TwoFactorStatus>;
  disableMyTwoFactor(body: TwoFactorDisableRequest): Promise<void>;
  regenerateMyRecoveryCodes(password: string): Promise<TwoFactorRecoveryCodes>;

  /**
   * #93 `POST /media/images` (multipart, one `file` part). The trusted
   * direct-image path validates magic bytes and returns its `file_id`; the
   * caller applies it through the existing avatar/cover/logo setters. Never
   * sends storage keys or presigned URLs.
   */
  uploadImage(file: File, options?: ImageUploadOptions): Promise<MediaImage>;

  /*
   * P0-4 (#82): workspace settings, logo, invite links and the OWNER/ADMIN/
   * MEMBER permission matrix. The server owns every guard; the client only
   * echoes contract fields and replaces rows with server responses.
   */
  updateWorkspace(workspaceId: string, body: WorkspaceUpdate): Promise<WorkspaceSummary>;
  setWorkspaceAvatar(workspaceId: string, fileId: string): Promise<WorkspaceSummary>;
  deleteWorkspaceAvatar(workspaceId: string): Promise<void>;
  /**
   * #99 `DELETE /workspaces/{id}/members/me` (ACTIVE participant self-leave).
   * Idempotent `204`; the sole OWNER is `409 LAST_OWNER`, a non-member/foreign
   * workspace is an indistinguishable `403`. The server removes the caller's
   * chat participants too, so the client must drop every workspace-scoped row.
   */
  leaveWorkspace(workspaceId: string): Promise<void>;
  /**
   * #99 `DELETE /workspaces/{id}` (ACTIVE OWNER only, soft delete).
   * Idempotent `204`. MEMBER/ADMIN get `403 WORKSPACE_PERMISSION_DENIED`; the
   * client hides the action but still surfaces the honest server error.
   */
  deleteWorkspace(workspaceId: string): Promise<void>;
  /**
   * P0-4 workspace logo bytes. The contract/backend expose only POST/DELETE for
   * `/workspaces/{id}/avatar`; `logo_file_id` is an existing managed attachment,
   * so the read resolves its presigned download URL and follows it.
   */
  getWorkspaceAvatarBlob(workspaceId: string, fileId: string): Promise<Blob>;
  /** Metadata only: the raw token is returned once by create and never listed. */
  listWorkspaceInvites(workspaceId: string): Promise<WorkspaceInviteList>;
  createWorkspaceInvite(
    workspaceId: string,
    body: WorkspaceInviteCreateRequest,
  ): Promise<WorkspaceInviteCreated>;
  revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<void>;
  /**
   * #100 `GET /workspace-invites/{token}` — anonymous display metadata only.
   * No bearer token is sent; the response has no token/hash/invited address.
   */
  previewWorkspaceInvite(token: string): Promise<WorkspaceInvitePreview>;
  /** Accept requires an authenticated account; an email-bound invite must match. */
  acceptWorkspaceInvite(token: string): Promise<WorkspaceInviteAcceptance>;
  getWorkspacePermissions(workspaceId: string): Promise<WorkspacePermissionMatrix>;
  updateWorkspacePermissions(
    workspaceId: string,
    body: WorkspacePermissionUpdate,
  ): Promise<WorkspacePermissionMatrix>;

  /*
   * #96 bots. Management is JWT/OWNER-ADMIN only; the one-time `token` exists
   * exclusively in `BotToken` responses of create/rotate and is never listed,
   * cached or persisted by this client. The UI never calls the bot-token send
   * endpoint; it is documented as a curl snippet only.
   */
  listBots(workspaceId: string): Promise<BotList>;
  createBot(workspaceId: string, body: BotCreateRequest): Promise<BotToken>;
  updateBot(workspaceId: string, botId: string, body: BotUpdateRequest): Promise<Bot>;
  /** Soft delete/idempotent disable (`204`): the token stops authenticating. */
  disableBot(workspaceId: string, botId: string): Promise<void>;
  /** Rotates the token atomically; the returned token is shown once. */
  rotateBotToken(workspaceId: string, botId: string): Promise<BotToken>;
  listChatBots(chatId: string): Promise<ChatBotList>;
  /** ACTIVE chat OWNER/ADMIN only; idempotent for an already installed bot. */
  installChatBot(chatId: string, botId: string): Promise<ChatBot>;
  /** `204` is idempotent: a missing installation is not an error. */
  uninstallChatBot(chatId: string, botId: string): Promise<void>;

  /*
   * #98 signed events and slash commands.
   *  * The signing secret is a one-time response of rotate/activation; the
   *    client keeps it in memory only until its dialog closes.
   *  * Deliveries are content-free statuses (no payload/URL/secret).
   *  * A command invocation returns `202` and never creates a chat message;
   *    the bot answers later through its backend-only response URL.
   */
  rotateBotSigningSecret(workspaceId: string, botId: string): Promise<BotSigningSecret>;
  listBotDeliveries(workspaceId: string, botId: string, limit?: number): Promise<BotDeliveryList>;
  /** Queues a signed `test` ping; requires an events URL + signing secret. */
  testBotEvent(workspaceId: string, botId: string): Promise<BotDeliveryAccepted>;
  /** `202` only: the slash command delivery is queued, no message is written. */
  invokeBotCommand(chatId: string, body: BotCommandInvoke): Promise<BotCommandAccepted>;

  /** #73: file-center page with metadata-only rows and the workspace quota. */
  listFiles(query?: ListFilesQuery): Promise<FilePage>;
  /**
   * #83: one-shot global workspace file (`multipart/form-data`). The server
   * applies the same managed pipeline (type policy, quota, AV scan) and returns
   * an unbound `FileItem`; the client never invents object keys or URLs.
   */
  uploadWorkspaceFile(
    workspaceId: string,
    file: File,
    options?: WorkspaceFileUploadOptions,
  ): Promise<FileItem>;
  /** #83: display-name rename, owner only (server 404 hides existence). */
  renameFile(fileId: string, body: FileRename, idempotencyKey: string): Promise<FileItem>;
  /** #83: soft delete (owner or workspace OWNER/ADMIN); `204` is idempotent. */
  deleteFile(fileId: string, idempotencyKey: string): Promise<void>;
  /**
   * #83: literal, case-insensitive managed-text search. E2EE/deleted/hidden
   * rows never reach the client; `snippet` stays plain text.
   */
  searchMessages(workspaceId: string, query: SearchMessagesQuery): Promise<MessageSearchPage>;
  /** #83: content-free mention inbox plus the workspace unread counter. */
  listMentions(query?: ListMentionsQuery): Promise<MentionPage>;
  /** #83: `ids[]`/`all` read markers; one idempotency key per action. */
  markMentionsRead(body: ReadMentionsRequest, idempotencyKey: string): Promise<void>;

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
  /** #84: bounded CSV/JSON export of the installation audit log. */
  exportAdminAudit(query: ExportAdminAuditQuery): Promise<AdminAuditExportResult>;
  /** #84: live Keycloak sessions of one user (no IP/username/tokens). */
  listAdminSessions(query: ListAdminSessionsQuery): Promise<AdminSessionPage>;
  /** #84: idempotent `204`; a missing/already-revoked session is not an error. */
  revokeAdminSession(sessionId: string): Promise<void>;
  /** #84: revoke every session of the user; returns counters only. */
  revokeAdminUserSessions(userId: string): Promise<AdminSessionRevokeAll>;
  /** #84: effective translation provider settings (no secret field). */
  getAdminTranslationProvider(): Promise<TranslationProviderSettings>;
  updateAdminTranslationProvider(
    body: TranslationProviderUpdate,
  ): Promise<TranslationProviderSettings>;
  /** #84: one bounded probe; the response carries status/latency only. */
  testAdminTranslationProvider(): Promise<TranslationProviderTest>;
  /** #84: workspace dashboard aggregates (counts/bytes and a small audit preview). */
  getWorkspaceOverview(workspaceId: string): Promise<WorkspaceOverview>;

  /*
   * #105 rooms. The server keeps room metadata and a 30 s TTL presence row
   * only: no call, SDP/ICE, media, recording or SFU state. `chat_id` points at
   * the managed GROUP channel used by the existing call signaling.
   */
  /** ACTIVE rooms, newest first; participants are already TTL-filtered. */
  listRooms(workspaceId: string): Promise<RoomList>;
  /** Any ACTIVE workspace member; the server creates the backing channel. */
  createRoom(workspaceId: string, body: RoomCreateRequest): Promise<Room>;
  /** Creator or workspace OWNER/ADMIN; closed room is `409 ROOM_CLOSED`. */
  updateRoom(workspaceId: string, roomId: string, body: RoomUpdateRequest): Promise<Room>;
  /** Creator or workspace OWNER; soft close (backing channel soft-deleted). */
  closeRoom(workspaceId: string, roomId: string): Promise<void>;
  /** Contract detail read; a closed room is still returned with `status=CLOSED`. */
  getRoom(roomId: string): Promise<Room>;
  /** Join/heartbeat upsert (`204`); the server owns `joined_at` and the TTL. */
  joinRoomPresence(roomId: string): Promise<void>;
  /** Idempotent leave (`204`), also allowed for a closed room. */
  leaveRoomPresence(roomId: string): Promise<void>;

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
  /** #80/avatar: channel icon bytes (the contract `302` is followed by `fetch`). */
  getChatAvatarBlob(chatId: string): Promise<Blob>;
  /** Avatar: existing image attachment of the same chat; the `Chat` is authoritative. */
  setChatAvatar(chatId: string, body: ChatAvatarRequest): Promise<Chat>;
  /** Avatar: idempotent `204`; the attachment itself is not deleted. */
  deleteChatAvatar(chatId: string): Promise<void>;
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
  /*
   * D1.2 (#86): platform-admin external package lifecycle. The server enforces
   * the admin flag and every archive/manifest rule; the client only validates
   * obvious file shape before upload and surfaces contract error codes.
   */
  listAdminPlugins(): Promise<AdminPluginPackageList>;
  installPluginPackage(
    file: File,
    options?: PluginPackageUploadOptions,
  ): Promise<AdminPluginPackage>;
  uninstallPluginPackage(pluginId: string): Promise<void>;
  /**
   * Authenticated bytes of one package asset. `assetPath` is relative to the
   * entry document; when omitted the entry document itself is returned.
   */
  getPluginAsset(entryUrl: string, assetPath?: string): Promise<Blob>;
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

  /*
   * P0-3 (#81): workspace security. Every operation is OWNER/ADMIN and carries
   * the `X-Device-Id` header; the server owns validation, limits, audit,
   * permission checks and the immutable security mode. The client never
   * fabricates a policy/event/session/security value.
   */
  listWorkspaceDlpPolicies(workspaceId: string): Promise<DlpPolicyList>;
  createWorkspaceDlpPolicy(workspaceId: string, body: DlpPolicyCreateRequest): Promise<DlpPolicy>;
  updateWorkspaceDlpPolicy(
    workspaceId: string,
    policyId: string,
    body: DlpPolicyUpdateRequest,
  ): Promise<DlpPolicy>;
  deleteWorkspaceDlpPolicy(workspaceId: string, policyId: string): Promise<void>;
  listWorkspaceDlpEvents(
    workspaceId: string,
    query?: ListWorkspaceDlpEventsQuery,
  ): Promise<DlpEventPage>;
  listWorkspaceAudit(
    workspaceId: string,
    query?: ListWorkspaceAuditQuery,
  ): Promise<WorkspaceAuditPage>;
  /** Bounded blob export: CSV or JSON; headers carry rows/truncation. */
  exportWorkspaceAudit(
    workspaceId: string,
    query: ExportWorkspaceAuditQuery,
  ): Promise<WorkspaceAuditExportResult>;
  listWorkspaceSessions(
    workspaceId: string,
    query?: ListWorkspaceSessionsQuery,
  ): Promise<WorkspaceSessionPage>;
  revokeWorkspaceSession(workspaceId: string, sessionId: string): Promise<void>;
  revokeAllWorkspaceSessions(workspaceId: string): Promise<WorkspaceSessionRevokeAll>;
  getWorkspaceSecurity(workspaceId: string): Promise<WorkspaceSecurity>;
  updateWorkspaceSecurity(
    workspaceId: string,
    body: WorkspaceSecurityUpdateRequest,
  ): Promise<WorkspaceSecurity>;

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
  /**
   * #97: authenticated cover bytes of a server-extracted audio artwork
   * (`GET /attachments/{attachmentId}/artwork`). Never a presigned URL, never
   * a token in the query — the regular API client adds `Authorization`.
   * Errors keep the contract codes (`401`, `404` no artwork, `409` scanning,
   * `423` quarantined, `410` deleted) and surface as `ApiError`.
   */
  getAttachmentArtwork(attachmentId: string): Promise<Blob>;

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

/**
 * Extract a safe download name from `Content-Disposition`. Only a plain
 * basename is accepted: separators and control characters are stripped so a
 * server header cannot steer the browser to a path outside the download.
 */
export function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const quoted = /filename="([^"]+)"/i.exec(header);
  const bare = /filename=([^;]+)/i.exec(header);
  const raw = extended?.[1] ?? quoted?.[1] ?? bare?.[1];
  if (!raw) return null;
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw value; it is still sanitized below.
  }
  const rawBase = decoded.split(/[\\/]/).pop() ?? '';
  const base = [...rawBase]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  return base ? base.slice(0, 180) : null;
}

type ApiAuthConfig = Pick<AppConfig, 'devSession'> & { authMode?: AppConfig['authMode'] };

/**
 * Follow a presigned object URL to its bytes. The URL is short-lived and
 * self-authorizing, so no bearer token is attached (and no storage key is
 * accepted from the caller). The bytes are re-wrapped in the current realm for
 * `URL.createObjectURL`/`FileReader` consumers.
 */
async function fetchPresignedBlob(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
  } catch (error) {
    throw ApiError.network(error);
  }
  if (!response.ok) {
    throw new ApiError({
      source: 'http',
      status: response.status,
      code: `HTTP_${response.status}`,
      message: response.statusText || `HTTP ${response.status}`,
      requestId: response.headers.get('x-request-id') ?? undefined,
    });
  }
  const raw = await response.blob();
  if (typeof raw.arrayBuffer !== 'function') return raw;
  try {
    return new Blob([await raw.arrayBuffer()], { type: raw.type });
  } catch {
    return raw;
  }
}

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

    /* ------------------------------------------------------------------ */
    /* P0-4 (#82): avatar + TOTP second factor                            */
    /* ------------------------------------------------------------------ */

    setMyAvatar(fileId) {
      return withReauth(async () => {
        const body: AvatarUpdate = { file_id: fileId };
        const response = await client.post<AuthUser>('/me/avatar', body);
        return response.data;
      });
    },

    removeMyAvatar() {
      return withReauth(async () => {
        // Idempotent `204`; the attachment itself is not deleted.
        await client.delete('/me/avatar');
      });
    },

    getMyAvatarBlob() {
      return withReauth(async () => {
        // The endpoint answers `302` to a 5-minute presigned URL; `fetch`
        // follows it and the caller only ever sees image bytes. The raw
        // attachment id/storage key never reaches the browser.
        const response = await client.getBlob('/me/avatar');
        return response.blob;
      });
    },

    getMyTwoFactor() {
      return withReauth(async () => {
        const response = await client.get<TwoFactorStatus>('/me/2fa');
        return response.data;
      });
    },

    setupMyTwoFactor(password) {
      return withReauth(async () => {
        // The secret/otpauth URI are returned exactly once; nothing is cached.
        const response = await client.post<TwoFactorSetup>('/me/2fa/setup', { password });
        return response.data;
      });
    },

    verifyMyTwoFactor(code) {
      return withReauth(async () => {
        const body: TwoFactorVerifyRequest = { code };
        const response = await client.post<TwoFactorStatus>('/me/2fa/verify', body);
        return response.data;
      });
    },

    disableMyTwoFactor(body) {
      return withReauth(async () => {
        await client.delete('/me/2fa', { body });
      });
    },

    regenerateMyRecoveryCodes(password) {
      return withReauth(async () => {
        const response = await client.post<TwoFactorRecoveryCodes>('/me/2fa/recovery-codes', {
          password,
        });
        return response.data;
      });
    },

    uploadImage(file, options = {}) {
      return withReauth(async () => {
        // Multipart field name is fixed by the contract; the optional chat
        // binding lets the chat cover/icon setters accept the new image.
        const form = new FormData();
        form.append('file', file, file.name);
        if (options.chatId) form.append('chat_id', options.chatId);
        const response = await client.postFormData<unknown>('/media/images', form, {
          // A 5 MiB image can exceed the default request timeout on slow links.
          timeoutMs: 120_000,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        return normalizeMediaImage(response.data);
      });
    },

    /* ------------------------------------------------------------------ */
    /* P0-4 (#82): workspace settings, logo, invites, permissions         */
    /* ------------------------------------------------------------------ */

    updateWorkspace(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.patch<WorkspaceSummary>(
          `/workspaces/${encodeURIComponent(workspaceId)}`,
          body,
        );
        return response.data;
      });
    },

    setWorkspaceAvatar(workspaceId, fileId) {
      return withReauth(async () => {
        const body: WorkspaceAvatarRequest = { file_id: fileId };
        const response = await client.post<WorkspaceSummary>(
          `/workspaces/${encodeURIComponent(workspaceId)}/avatar`,
          body,
        );
        return response.data;
      });
    },

    deleteWorkspaceAvatar(workspaceId) {
      return withReauth(async () => {
        // Idempotent `204`; the logo attachment stays in the file center.
        await client.delete(`/workspaces/${encodeURIComponent(workspaceId)}/avatar`);
      });
    },

    leaveWorkspace(workspaceId) {
      return withReauth(async () => {
        // Self-leave is a bodyless idempotent `204`; the literal `/me` route is
        // chosen by the server before the `{userId}` template.
        await client.delete(`/workspaces/${encodeURIComponent(workspaceId)}/members/me`);
      });
    },

    deleteWorkspace(workspaceId) {
      return withReauth(async () => {
        // OWNER-only soft delete; a repeat is still `204` by contract.
        await client.delete(`/workspaces/${encodeURIComponent(workspaceId)}`);
      });
    },

    async getWorkspaceAvatarBlob(_workspaceId, fileId) {
      // The only read surface in the contract is the existing attachment flow:
      // `logo_file_id` is a managed attachment, not a dedicated avatar object.
      const download = await this.attachmentDownloadUrl(fileId);
      return fetchPresignedBlob(download.url);
    },

    listWorkspaceInvites(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceInviteList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/invites`,
        );
        return response.data;
      });
    },

    createWorkspaceInvite(workspaceId, body) {
      return withReauth(async () => {
        // `token`/`accept_url` exist only in this response; nothing is stored.
        const response = await client.post<WorkspaceInviteCreated>(
          `/workspaces/${encodeURIComponent(workspaceId)}/invites`,
          body,
        );
        return response.data;
      });
    },

    revokeWorkspaceInvite(workspaceId, inviteId) {
      return withReauth(async () => {
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`,
        );
      });
    },

    previewWorkspaceInvite(token) {
      // Public endpoint (`security: []`): never send the caller's bearer/device.
      return withReauth(async () => {
        const response = await client.get<WorkspaceInvitePreview>(
          `/workspace-invites/${encodeURIComponent(token)}`,
          undefined,
          { auth: false },
        );
        return response.data;
      });
    },

    acceptWorkspaceInvite(token) {
      return withReauth(async () => {
        const response = await client.post<WorkspaceInviteAcceptance>(
          `/workspace-invites/${encodeURIComponent(token)}/accept`,
        );
        return response.data;
      });
    },

    getWorkspacePermissions(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<WorkspacePermissionMatrix>(
          `/workspaces/${encodeURIComponent(workspaceId)}/permissions`,
        );
        return response.data;
      });
    },

    updateWorkspacePermissions(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.patch<WorkspacePermissionMatrix>(
          `/workspaces/${encodeURIComponent(workspaceId)}/permissions`,
          body,
        );
        return response.data;
      });
    },

    /* ------------------------------------------------------------------ */
    /* #96 bots: management responses never cache the one-time token      */
    /* ------------------------------------------------------------------ */

    listBots(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<BotList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots`,
        );
        return response.data;
      });
    },

    createBot(workspaceId, body) {
      return withReauth(async () => {
        // The only response with a raw token; the caller keeps it in memory
        // just long enough to show/copy it once (the store clears it on close).
        const response = await client.post<BotToken>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots`,
          body,
        );
        return response.data;
      });
    },

    updateBot(workspaceId, botId, body) {
      return withReauth(async () => {
        const response = await client.patch<Bot>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}`,
          body,
        );
        return response.data;
      });
    },

    disableBot(workspaceId, botId) {
      return withReauth(async () => {
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}`,
        );
      });
    },

    rotateBotToken(workspaceId, botId) {
      return withReauth(async () => {
        // The previous token is invalid as soon as this resolves.
        const response = await client.post<BotToken>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}/token`,
        );
        return response.data;
      });
    },

    listChatBots(chatId) {
      return withReauth(async () => {
        const response = await client.get<ChatBotList>(`/chats/${encodeURIComponent(chatId)}/bots`);
        return response.data;
      });
    },

    installChatBot(chatId, botId) {
      return withReauth(async () => {
        const response = await client.post<ChatBot>(`/chats/${encodeURIComponent(chatId)}/bots`, {
          bot_id: botId,
        });
        return response.data;
      });
    },

    uninstallChatBot(chatId, botId) {
      return withReauth(async () => {
        await client.delete(
          `/chats/${encodeURIComponent(chatId)}/bots/${encodeURIComponent(botId)}`,
        );
      });
    },

    /* #98: signed events and slash commands. Secrets stay one-time responses. */

    rotateBotSigningSecret(workspaceId, botId) {
      return withReauth(async () => {
        // The previous secret stops verifying signatures immediately.
        const response = await client.post<BotSigningSecret>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}/secret`,
        );
        return response.data;
      });
    },

    listBotDeliveries(workspaceId, botId, limit = 20) {
      return withReauth(async () => {
        const response = await client.get<BotDeliveryList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}/deliveries`,
          { limit },
        );
        return response.data;
      });
    },

    testBotEvent(workspaceId, botId) {
      return withReauth(async () => {
        const response = await client.post<BotDeliveryAccepted>(
          `/workspaces/${encodeURIComponent(workspaceId)}/bots/${encodeURIComponent(botId)}/test-event`,
        );
        return response.data;
      });
    },

    invokeBotCommand(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<BotCommandAccepted>(
          `/chats/${encodeURIComponent(chatId)}/commands`,
          body,
        );
        return response.data;
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

    uploadWorkspaceFile(workspaceId, file, options = {}) {
      return withReauth(async () => {
        // The multipart field name is fixed by the contract. The upload carries
        // its own progress surface; the store owns retry/cancel affordances.
        const form = new FormData();
        form.append('file', file, file.name);
        const response = await client.postFormData<FileItem>(
          `/workspaces/${encodeURIComponent(workspaceId)}/files`,
          form,
          {
            timeoutMs: 600_000,
            signal: options.signal,
            onProgress: options.onProgress,
          },
        );
        return response.data;
      });
    },

    renameFile(fileId, body, idempotencyKey) {
      return withReauth(async () => {
        const response = await client.patch<FileItem>(
          `/files/${encodeURIComponent(fileId)}`,
          body,
          { idempotencyKey },
        );
        return response.data;
      });
    },

    deleteFile(fileId, idempotencyKey) {
      return withReauth(async () => {
        await client.delete(`/files/${encodeURIComponent(fileId)}`, { idempotencyKey });
      });
    },

    searchMessages(workspaceId, query) {
      return withReauth(async () => {
        const response = await client.get<MessageSearchPage>(
          `/workspaces/${encodeURIComponent(workspaceId)}/search/messages`,
          {
            // `q` is required by the contract; callers never issue an empty query.
            q: query.q,
            chat_id: query.chatId,
            from: query.from,
            to: query.to,
            cursor: query.cursor,
            limit: query.limit,
          },
        );
        return response.data;
      });
    },

    listMentions(query = {}) {
      return withReauth(async () => {
        const response = await client.get<MentionPage>('/me/mentions', {
          workspace_id: query.workspaceId,
          unread: query.unread,
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    markMentionsRead(body, idempotencyKey) {
      return withReauth(async () => {
        await client.post('/me/mentions/read', body, { idempotencyKey });
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

    async exportAdminAudit(query) {
      // #84: the export is a Blob so the browser writes the exact server
      // bytes (RFC 4180 CSV or the bounded JSON object). Headers are the
      // authoritative row count/truncation summary.
      const response = await withReauth(async () =>
        client.getBlob('/admin/audit/export', {
          format: query.format,
          action: query.action?.trim() || undefined,
        }),
      );
      const rowsHeader = response.headers.get('x-export-rows');
      const parsedRows = rowsHeader === null ? Number.NaN : Number.parseInt(rowsHeader, 10);
      return {
        blob: response.blob,
        filename: contentDispositionFilename(response.headers.get('content-disposition')),
        rows: Number.isFinite(parsedRows) && parsedRows >= 0 ? parsedRows : null,
        truncated: response.headers.get('x-export-truncated') === 'true',
      };
    },

    listAdminSessions(query) {
      return withReauth(async () => {
        const response = await client.get<AdminSessionPage>('/admin/sessions', {
          user_id: query.userId,
          cursor: query.cursor,
          limit: query.limit,
        });
        return response.data;
      });
    },

    revokeAdminSession(sessionId) {
      return withReauth(async () => {
        await client.delete(`/admin/sessions/${encodeURIComponent(sessionId)}`);
      });
    },

    revokeAdminUserSessions(userId) {
      return withReauth(async () => {
        const response = await client.post<AdminSessionRevokeAll>(
          `/admin/users/${encodeURIComponent(userId)}/revoke-sessions`,
        );
        return response.data;
      });
    },

    getAdminTranslationProvider() {
      return withReauth(async () => {
        const response = await client.get<TranslationProviderSettings>('/admin/plugins/translate');
        return response.data;
      });
    },

    updateAdminTranslationProvider(body) {
      return withReauth(async () => {
        const response = await client.patch<TranslationProviderSettings>(
          '/admin/plugins/translate',
          body,
        );
        return response.data;
      });
    },

    testAdminTranslationProvider() {
      return withReauth(async () => {
        const response = await client.post<TranslationProviderTest>(
          '/admin/plugins/translate/test',
        );
        return response.data;
      });
    },

    getWorkspaceOverview(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceOverview>(
          `/workspaces/${encodeURIComponent(workspaceId)}/overview`,
        );
        return response.data;
      });
    },

    /* #105 rooms: metadata + REST presence (no server-side call state). */
    listRooms(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<RoomList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
        );
        return response.data;
      });
    },

    createRoom(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.post<Room>(
          `/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
          body,
        );
        return response.data;
      });
    },

    updateRoom(workspaceId, roomId, body) {
      return withReauth(async () => {
        const response = await client.patch<Room>(
          `/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`,
          body,
        );
        return response.data;
      });
    },

    closeRoom(workspaceId, roomId) {
      return withReauth(async () => {
        // Soft close, idempotent `204` for an authorised actor.
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`,
        );
      });
    },

    getRoom(roomId) {
      return withReauth(async () => {
        const response = await client.get<Room>(`/rooms/${encodeURIComponent(roomId)}`);
        return response.data;
      });
    },

    joinRoomPresence(roomId) {
      return withReauth(async () => {
        // Bodyless upsert: the server owns `joined_at`/`last_seen_at`.
        await client.post(`/rooms/${encodeURIComponent(roomId)}/presence`);
      });
    },

    leaveRoomPresence(roomId) {
      return withReauth(async () => {
        // Idempotent `204`; a missing row is not an error.
        await client.delete(`/rooms/${encodeURIComponent(roomId)}/presence`);
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

    getChatAvatarBlob(chatId) {
      return withReauth(async () => {
        // `302` to a 5-minute presigned object URL; `fetch` follows it and the
        // browser only ever sees bytes. The attachment id/key is never exposed.
        const response = await client.getBlob(`/chats/${encodeURIComponent(chatId)}/avatar`);
        return response.blob;
      });
    },

    setChatAvatar(chatId, body) {
      return withReauth(async () => {
        const response = await client.post<Chat>(
          `/chats/${encodeURIComponent(chatId)}/avatar`,
          body,
        );
        return response.data;
      });
    },

    deleteChatAvatar(chatId) {
      return withReauth(async () => {
        // Idempotent `204`; the attachment itself is not deleted.
        await client.delete(`/chats/${encodeURIComponent(chatId)}/avatar`);
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

    /* ------------------------------------------------------------------ */
    /* D1.2 (#86): external ZIP packages (platform_admin only)            */
    /* ------------------------------------------------------------------ */

    listAdminPlugins() {
      return withReauth(async () => {
        const response = await client.get<AdminPluginPackageList>('/admin/plugins');
        return response.data;
      });
    },

    installPluginPackage(file, options = {}) {
      return withReauth(async () => {
        // The multipart field name is fixed by the contract; `postFormData`
        // encodes the boundary exactly once so XHR and fetch agree.
        const form = new FormData();
        form.append('file', file, file.name);
        const response = await client.postFormData<AdminPluginPackage>('/admin/plugins', form, {
          // A 5 MiB upload can exceed the default request timeout on slow
          // links; the server itself is fast, so keep a generous cap.
          timeoutMs: 120_000,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        return response.data;
      });
    },

    uninstallPluginPackage(pluginId) {
      return withReauth(async () => {
        await client.delete(`/admin/plugins/${encodeURIComponent(pluginId)}`);
      });
    },

    getPluginAsset(entryUrl, assetPath) {
      return withReauth(async () => {
        const path = assetPath
          ? pluginRelativeAssetApiPath(entryUrl, assetPath)
          : pluginAssetApiPath(entryUrl);
        if (!path) {
          throw ApiError.client('PLUGIN_ASSET_INVALID', 'Asset path is not a package path');
        }
        const response = await client.getBlob(path);
        return response.blob;
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

    listWorkspaceDlpPolicies(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<DlpPolicyList>(
          `/workspaces/${encodeURIComponent(workspaceId)}/dlp/policies`,
        );
        return response.data;
      });
    },

    createWorkspaceDlpPolicy(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.post<DlpPolicy>(
          `/workspaces/${encodeURIComponent(workspaceId)}/dlp/policies`,
          body,
        );
        return response.data;
      });
    },

    updateWorkspaceDlpPolicy(workspaceId, policyId, body) {
      return withReauth(async () => {
        const response = await client.patch<DlpPolicy>(
          `/workspaces/${encodeURIComponent(workspaceId)}/dlp/policies/${encodeURIComponent(policyId)}`,
          body,
        );
        return response.data;
      });
    },

    deleteWorkspaceDlpPolicy(workspaceId, policyId) {
      return withReauth(async () => {
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/dlp/policies/${encodeURIComponent(policyId)}`,
        );
      });
    },

    listWorkspaceDlpEvents(workspaceId, query = {}) {
      return withReauth(async () => {
        const response = await client.get<DlpEventPage>(
          `/workspaces/${encodeURIComponent(workspaceId)}/dlp/events`,
          {
            policy_id: query.policyId,
            action: query.action,
            cursor: query.cursor,
            limit: query.limit,
          },
        );
        return response.data;
      });
    },

    listWorkspaceAudit(workspaceId, query = {}) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceAuditPage>(
          `/workspaces/${encodeURIComponent(workspaceId)}/audit`,
          {
            action: query.action,
            actor_id: query.actorId,
            from: query.from,
            to: query.to,
            cursor: query.cursor,
            limit: query.limit,
          },
        );
        return response.data;
      });
    },

    async exportWorkspaceAudit(workspaceId, query) {
      const response = await withReauth(async () =>
        client.getBlob(`/workspaces/${encodeURIComponent(workspaceId)}/audit/export`, {
          format: query.format,
          action: query.action,
          actor_id: query.actorId,
          from: query.from,
          to: query.to,
        }),
      );
      const rowsHeader = response.headers.get('x-export-rows');
      const parsedRows = rowsHeader === null ? Number.NaN : Number.parseInt(rowsHeader, 10);
      return {
        blob: response.blob,
        filename: contentDispositionFilename(response.headers.get('content-disposition')),
        rows: Number.isFinite(parsedRows) && parsedRows >= 0 ? parsedRows : null,
        truncated: response.headers.get('x-export-truncated') === 'true',
      };
    },

    listWorkspaceSessions(workspaceId, query = {}) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceSessionPage>(
          `/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
          { cursor: query.cursor, limit: query.limit },
        );
        return response.data;
      });
    },

    revokeWorkspaceSession(workspaceId, sessionId) {
      return withReauth(async () => {
        await client.delete(
          `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        );
      });
    },

    revokeAllWorkspaceSessions(workspaceId) {
      return withReauth(async () => {
        const response = await client.post<WorkspaceSessionRevokeAll>(
          `/workspaces/${encodeURIComponent(workspaceId)}/sessions/revoke-all`,
        );
        return response.data;
      });
    },

    getWorkspaceSecurity(workspaceId) {
      return withReauth(async () => {
        const response = await client.get<WorkspaceSecurity>(
          `/workspaces/${encodeURIComponent(workspaceId)}/security`,
        );
        return response.data;
      });
    },

    updateWorkspaceSecurity(workspaceId, body) {
      return withReauth(async () => {
        const response = await client.patch<WorkspaceSecurity>(
          `/workspaces/${encodeURIComponent(workspaceId)}/security`,
          body,
        );
        return response.data;
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

    getAttachmentArtwork(attachmentId) {
      return withReauth(async () => {
        // #97: authenticated raster bytes, not a JSON body and not a
        // presigned object URL. `getBlob` never puts the token in the URL.
        const response = await client.getBlob(
          `/attachments/${encodeURIComponent(attachmentId)}/artwork`,
          undefined,
          { accept: 'image/jpeg, image/png, image/webp, image/gif, image/bmp, image/avif' },
        );
        return response.blob;
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
