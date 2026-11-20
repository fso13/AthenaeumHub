/**
 * Types are generated from contracts/openapi.yaml (npm run api:types).
 * Do not edit schema.d.ts manually; the contract is the only source of truth.
 */
import type { components, operations } from './schema';

export type ApiErrorBody = components['schemas']['Error'];
export type Session = components['schemas']['Session'];
export type ChatSummary = components['schemas']['ChatSummary'];
export type ChatList = components['schemas']['ChatList'];
export type ApiMessage = components['schemas']['Message'];
/** D1-FE3: server-computed reply summary; present on managed thread roots only. */
export type ThreadSummary = NonNullable<ApiMessage['thread_summary']>;
/** #61: aggregated reaction row (`emoji`/`count`/`me`) from the contract. */
export type ReactionSummary = components['schemas']['ReactionSummary'];
/** #62: managed-only edit body; `version` enables the optimistic lock. */
export type MessageEdit = components['schemas']['MessageEdit'];
/** #63: delete scope; `me` is the default, `all` is author-only. */
export type MessageDeleteScope = 'me' | 'all';
export type MessageCreateBody = components['schemas']['MessageCreate'];
export type MessagePage = components['schemas']['MessagePage'];
export type MessagePageMeta = MessagePage['page'];
export type ReadRequestBody = components['schemas']['ReadRequest'];
export type SyncResponse = components['schemas']['SyncResponse'];
export type SyncChat = SyncResponse['chats'][number];

export type MessageType = ApiMessage['type'];
export type ChatType = ChatSummary['type'];
export type SecurityMode = ChatSummary['security_mode'];
/** #78: GROUP channel audience; `null` for DIRECT and legacy rows. */
export type ChatVisibility = NonNullable<ChatSummary['visibility']>;
export type MeResponse = components['schemas']['MeResponse'];
export type MeUser = MeResponse['user'];
/** #72: `AuthUser` is the `GET/PATCH /me` profile projection (`bio`/`phone` nullable). */
export type AuthUser = components['schemas']['AuthUser'];
/** #72: PATCH body — absent field means "leave unchanged", null clears bio/phone. */
export type ProfileUpdate = components['schemas']['ProfileUpdate'];
/** #72: one Keycloak session (no IP, username or tokens in the contract). */
export type ProfileSession = components['schemas']['ProfileSession'];
export type ProfileSessions = components['schemas']['ProfileSessions'];
export type WorkspaceSummary = components['schemas']['WorkspaceSummary'];
export type WorkspaceRole = WorkspaceSummary['role'];
export type CreateWorkspaceRequest = components['schemas']['CreateWorkspaceRequest'];
export type DeviceRegistration = components['schemas']['DeviceRegistration'];
export type Device = components['schemas']['Device'];
/** D1-FE5: `GET /devices` projection for the profile modal (no secrets). */
export type DeviceList = components['schemas']['DeviceList'];
/** E3: one-time WebSocket ticket; `ws_url` is the server-advertised endpoint. */
export type RealtimeTicket = components['schemas']['RealtimeTicket'];

/* ------------------------------------------------------------------------- */
/* E8: first-run setup, platform admin, chat creation                        */
/* ------------------------------------------------------------------------- */

export type SetupStatus = components['schemas']['SetupStatus'];
export type AdminSettings = components['schemas']['AdminSettings'];
export type AdminSettingsPatch = components['schemas']['AdminSettingsPatch'];
export type AdminOverview = components['schemas']['AdminOverview'];

/* ------------------------------------------------------------------------- */
/* E9-F: platform-admin directory (users/chats/storage)                      */
/* ------------------------------------------------------------------------- */

export type AdminUser = components['schemas']['AdminUser'];
export type AdminUserPage = components['schemas']['AdminUserPage'];
export type AdminUserStatus = AdminUser['status'];
export type AdminChat = components['schemas']['AdminChat'];
export type AdminChatPage = components['schemas']['AdminChatPage'];
export type AdminChatType = AdminChat['type'];
export type AdminStorage = components['schemas']['AdminStorage'];
export type AdminStorageTotals = components['schemas']['AdminStorageTotals'];
export type AdminStorageWorkspace = components['schemas']['AdminStorageWorkspace'];
export type TestEmailRequest = components['schemas']['TestEmailRequest'];
export type TestEmailResponse = components['schemas']['TestEmailResponse'];
export type Chat = components['schemas']['Chat'];
export type ChatCreateRequest = components['schemas']['ChatCreateRequest'];
/**
 * D1-FE5 + P0-2 (#80): merged settings patch for `PATCH /chats/{chatId}`.
 * `name`/`description` are D1-BE3 fields; `cover_file_id`, `read_only`,
 * `visibility`, `join_policy` and `rights` are the additive channel settings.
 */
export type ChatUpdateRequest = components['schemas']['ChatUpdateRequest'];
/** #80: `POST /chats/{chatId}/cover` — an existing image attachment id. */
export type ChatCoverRequest = components['schemas']['ChatCoverRequest'];
/** #80: effective rights of one channel role (always complete). */
export type ChatRolePermissions = components['schemas']['ChatRolePermissions'];
/** #80: effective 6×5 rights matrix (`owner` is fixed to all-true). */
export type ChatPermissions = components['schemas']['ChatPermissions'];
/** #80: partial per-role patch; `owner` is rejected by the server. */
export type ChatRolePermissionsUpdate = components['schemas']['ChatRolePermissionsUpdate'];
export type ChatPermissionsUpdate = components['schemas']['ChatPermissionsUpdate'];
/** #80: pinned-message metadata only (never message content). */
export type ChatPin = components['schemas']['ChatPin'];
export type ChatPinList = components['schemas']['ChatPinList'];
/** #80: GROUP join policy; `null` for DIRECT. */
export type ChatJoinPolicy = NonNullable<ChatSummary['join_policy']>;
/** #80: chat role rows are the same enum as the member directory. */
export type ChatPermissionRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
/** #80: the six configurable rights, in contract order. */
export type ChatPermissionKey =
  | 'post_messages'
  | 'invite_members'
  | 'create_polls'
  | 'start_calls'
  | 'pin_messages'
  | 'change_info';

/* ------------------------------------------------------------------------- */
/* E11-F: admin actions (suspend/activate/soft-delete) and the audit view     */
/* ------------------------------------------------------------------------- */

/**
 * Audit row as defined by `AdminAuditEvent`: id/action/actor/target/time only.
 * The contract deliberately has no `metadata`, hash-chain or `request_id`
 * fields, so the UI cannot render message bodies, filenames or secrets.
 */
export type AdminAuditEvent = components['schemas']['AdminAuditEvent'];
export type AdminAuditPage = components['schemas']['AdminAuditPage'];

/* ------------------------------------------------------------------------- */
/* Auth BFF (docs/TASKS-AUTH-BFF.md)                                         */
/* ------------------------------------------------------------------------- */

export type AuthSession = components['schemas']['AuthSession'];
export type AuthSessionUser = components['schemas']['AuthSessionUser'];
export type AuthRegisterRequest = components['schemas']['AuthRegisterRequest'];
export type AuthRegisterResponse = components['schemas']['AuthRegisterResponse'];
export type AuthVerifyEmailRequest = components['schemas']['AuthVerifyEmailRequest'];
export type AuthResendEmailCodeRequest = components['schemas']['AuthResendEmailCodeRequest'];
export type AuthResendEmailCodeResponse = components['schemas']['AuthResendEmailCodeResponse'];
export type AuthLoginRequest = components['schemas']['AuthLoginRequest'];
export type AuthRefreshRequest = components['schemas']['AuthRefreshRequest'];
export type AuthLogoutRequest = components['schemas']['AuthLogoutRequest'];

/* ------------------------------------------------------------------------- */
/* E4-F: managed files                                                       */
/* ------------------------------------------------------------------------- */

export type WorkspaceLimits = components['schemas']['WorkspaceLimits'];

/* ------------------------------------------------------------------------- */
/* E10-F: workspace member directory for DIRECT chats                       */
/* ------------------------------------------------------------------------- */

/** Active member of a workspace: catalog fields only, no email/devices/keys. */
export type WorkspaceMember = components['schemas']['WorkspaceMember'];
export type WorkspaceMemberPage = components['schemas']['WorkspaceMemberPage'];
export type WorkspaceMemberRole = WorkspaceMember['role'];
/** E12-F: roles assignable through the member UI; OWNER is never offered. */
export type AssignableMemberRole = Exclude<WorkspaceMemberRole, 'OWNER'>;
export type AddWorkspaceMemberRequest = components['schemas']['AddWorkspaceMemberRequest'];
export type ChangeWorkspaceMemberRoleRequest =
  components['schemas']['ChangeWorkspaceMemberRoleRequest'];
export type WorkspaceUsage = WorkspaceLimits['usage'];

/* ------------------------------------------------------------------------- */
/* #79: channel members, invite links and self-service user blocks           */
/* ------------------------------------------------------------------------- */

/**
 * ACTIVE channel participant. `display_name` comes from the profile; email,
 * devices and keys are not part of the contract. `status` is kept because the
 * contract exposes it even though the list returns ACTIVE rows only.
 */
export type ChatMember = components['schemas']['ChatMember'];
export type ChatMemberRole = ChatMember['role'];
export type ChatMemberStatus = ChatMember['status'];
/** `GET /chats/{chatId}/members`: detailed rows plus the legacy flat ids. */
export type ChatMembersResponse = components['schemas']['ChatMemberIds'];
export type AddChatMemberRequest = components['schemas']['AddChatMemberRequest'];
export type ChangeChatMemberRoleRequest = components['schemas']['ChangeChatMemberRoleRequest'];
/** Metadata only: the raw token is never re-readable (`ChatInviteCreated`). */
export type ChatInvite = components['schemas']['ChatInvite'];
export type ChatInviteRole = ChatInvite['role'];
export type ChatInviteStatus = ChatInvite['status'];
export type ChatInviteCreated = components['schemas']['ChatInviteCreated'];
export type ChatInviteCreateRequest = components['schemas']['ChatInviteCreateRequest'];
export type ChatInviteList = components['schemas']['ChatInviteList'];
export type InviteAcceptResult = components['schemas']['InviteAcceptResult'];
/** Own block row: `user_id`/`blocked_at` only (no email/display name). */
export type BlockedUser = components['schemas']['BlockedUser'];
export type BlockedUserList = components['schemas']['BlockedUserList'];
export type PreflightFile = components['schemas']['PreflightFile'];
export type PreflightRequest = components['schemas']['PreflightRequest'];
export type PreflightDecision = components['schemas']['PreflightDecision'];
export type PreflightResponse = components['schemas']['PreflightResponse'];
export type UploadInitRequest = components['schemas']['UploadInitRequest'];
/** D1-FE2: managed-only media metadata sent with upload init. */
export type UploadMediaMetadata = NonNullable<UploadInitRequest['media']>;
export type MediaKind = UploadMediaMetadata['kind'];
export type MediaMetadataSource = UploadMediaMetadata['metadata_source'];
export type UploadSession = components['schemas']['UploadSession'];
export type UploadSessionStatus = UploadSession['status'];
export type UploadPart = components['schemas']['UploadPart'];
export type UploadCompleteRequest = components['schemas']['UploadCompleteRequest'];
export type ApiAttachment = components['schemas']['AttachmentRef'];
/** D1-FE2: sanitized managed media metadata (absent/null for plain files). */
export type AttachmentMedia = NonNullable<ApiAttachment['media']>;
export type AttachmentScanStatus = ApiAttachment['scan_status'];
export type DownloadUrl = components['schemas']['DownloadUrl'];
/** #73: file-center row — attachment metadata + chat/message provenance. */
export type FileItem = components['schemas']['FileItem'];
/** #73: workspace quota snapshot rendered in the file-center header. */
export type FileQuotaSummary = components['schemas']['FileQuotaSummary'];
/** #73: one cursor page; `next_cursor` stays opaque and is never built locally. */
export type FilePage = components['schemas']['FilePage'];
export type FilePageMeta = FilePage['page'];
/** Server-side kind filter (the contract enum, not the UI tile classifier). */
export type FileKindFilter = NonNullable<operations['listFiles']['parameters']['query']>['kind'];
export type FileScanStatusFilter = NonNullable<
  operations['listFiles']['parameters']['query']
>['scan_status'];

/* ------------------------------------------------------------------------- */
/* E5-F: built-in stickers                                                   */
/* ------------------------------------------------------------------------- */

export type StickerRef = components['schemas']['StickerRef'];
export type StickerPack = components['schemas']['StickerPack'];
export type StickerPackList = components['schemas']['StickerPackList'];

/* ------------------------------------------------------------------------- */
/* D1.1 (#69): built-in plugin catalog and per-chat state                     */
/* ------------------------------------------------------------------------- */

/**
 * Built-in first-party plugin metadata: id/name/description/icon, descriptive
 * permission tokens, allowed security modes and the catalog kill switch. There
 * is no manifest, archive, version, signature or executable code in the
 * contract, and the UI never invents any.
 */
export type Plugin = components['schemas']['Plugin'];
export type PluginList = components['schemas']['PluginList'];
export type PluginPermission = Plugin['permissions'][number];
export type PluginMode = Plugin['modes'][number];
export type PluginCatalogState = NonNullable<Plugin['state']>;
/** Per-chat toggle plus the server-computed effective availability. */
export type ChatPluginState = components['schemas']['ChatPluginState'];
export type ChatPluginStateList = components['schemas']['ChatPluginStateList'];
export type ChatPluginUnavailableReason = NonNullable<ChatPluginState['reason']>;
export type ChatPluginUpdateRequest = components['schemas']['ChatPluginUpdateRequest'];

/* ------------------------------------------------------------------------- */
/* D1.1 (#76): plugin actions — polls, tasks, translation                    */
/* ------------------------------------------------------------------------- */

/** Managed-only poll metadata; there is no E2EE content path in this shape. */
export type Poll = components['schemas']['Poll'];
export type PollOption = components['schemas']['PollOption'];
export type PollList = components['schemas']['PollList'];
/** Create body; the server trims/normalizes plain text and owns option ids. */
export type PollCreate = components['schemas']['PollCreate'];
export type PollVoteRequest = components['schemas']['PollVoteRequest'];
export type PollCloseRequest = components['schemas']['PollCloseRequest'];
/** Chat-scoped task metadata; assignee/due date are optional labels only. */
export type Task = components['schemas']['Task'];
export type TaskList = components['schemas']['TaskList'];
export type TaskCreate = components['schemas']['TaskCreate'];
/** Only `done` is mutable; `completed_by`/`completed_at` are server-owned. */
export type TaskUpdate = components['schemas']['TaskUpdate'];
export type TranslationRequest = components['schemas']['TranslationRequest'];
/** Server-returned plain text; absence of a provider is an honest `503`. */
export type Translation = components['schemas']['Translation'];

/* ------------------------------------------------------------------------- */
/* E6-F: in-app notifications and preferences                                */
/* ------------------------------------------------------------------------- */

export type Notification = components['schemas']['Notification'];
export type NotificationType = Notification['type'];
export type NotificationPage = components['schemas']['NotificationPage'];
export type NotificationPageMeta = NotificationPage['page'];
export type ReadNotificationsRequest = components['schemas']['ReadNotificationsRequest'];
export type NotificationPreference = components['schemas']['NotificationPreference'];
export type NotificationPreferences = components['schemas']['NotificationPreferences'];
/**
 * Contract: NotificationPreferencePatch = allOf[NotificationPreference, {required:[mode]}].
 * `mode` is already required by NotificationPreference, so the PATCH body is
 * structurally identical. openapi-typescript renders the allOf as
 * `NotificationPreference & Record<string, never>`, which makes it unusable;
 * alias the base schema instead of hand-writing fields.
 */
export type NotificationPreferencePatch = NotificationPreference;
export type NotificationChannel = NotificationPreference['channel'];
export type NotificationMode = NotificationPreference['mode'];
