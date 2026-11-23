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
/**
 * The generated schema marks `mention_all` as required because the contract has
 * `default: false`; the API contract still allows omitting it (and E2EE forbids
 * the field entirely). The client sends it only when the composer enables @all.
 */
export type MessageCreateBody = Omit<components['schemas']['MessageCreate'], 'mention_all'> & {
  mention_all?: boolean;
};
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
/** Channel icon/avatar (`POST /chats/{chatId}/avatar`) — an existing image id. */
export type ChatAvatarRequest = components['schemas']['ChatAvatarRequest'];
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
/* #84: workspace overview, bounded admin audit export, admin sessions and   */
/* installation translation-provider configuration.                          */
/* ------------------------------------------------------------------------- */

/** Counts/bytes only; never message bodies, filenames, IPs or tokens. */
export type WorkspaceOverview = components['schemas']['WorkspaceOverview'];
/** Bounded JSON export (`exported_rows` ≤ 10 000) with the same columns as the page. */
export type AdminAuditExport = components['schemas']['AdminAuditExport'];
export type AdminAuditExportFormat = 'csv' | 'json';
/** One Keycloak session without IP, username, email or tokens. */
export type AdminSession = components['schemas']['AdminSession'];
export type AdminSessionPage = components['schemas']['AdminSessionPage'];
export type AdminSessionRevokeAll = components['schemas']['AdminSessionRevokeAll'];
/** Effective `{enabled, url}`; there is no credential/API-key field. */
export type TranslationProviderSettings = components['schemas']['TranslationProviderSettings'];
/** Partial update: omitted fields stay unchanged; `url=''` clears the URL. */
export type TranslationProviderUpdate = components['schemas']['TranslationProviderUpdate'];
export type TranslationProviderTest = components['schemas']['TranslationProviderTest'];
export type TranslationProviderTestStatus = TranslationProviderTest['status'];

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
/* P0-4 (#82): profile avatar and TOTP second factor                        */
/* ------------------------------------------------------------------------- */

/** `POST /me/avatar` — an existing CLEAN image attachment owned by the caller. */
export type AvatarUpdate = components['schemas']['AvatarUpdate'];
/** `GET /me/avatar` body (the authenticated read also answers `302`). */
export type ProfileAvatar = components['schemas']['ProfileAvatar'];
/**
 * `GET /me/2fa`: never carries the secret or the recovery codes. The published
 * contract has no policy projection, so the authenticated-session gate reads an
 * optional additive `required`/`enrollment_required` and stays dormant without
 * it; login/refresh enforcement does not depend on these fields.
 */
export type TwoFactorStatus = components['schemas']['TwoFactorStatus'] & {
  required?: boolean;
  enrollment_required?: boolean;
};
/**
 * `POST /me/2fa/setup` / `POST /auth/2fa/enroll/start` result. The
 * secret/otpauth URI are shown exactly once and must never be persisted; they
 * are kept only in component/store memory.
 */
export type TwoFactorSetup = components['schemas']['TwoFactorSetup'];
export type TwoFactorSetupRequest = components['schemas']['TwoFactorSetupRequest'];
export type TwoFactorVerifyRequest = components['schemas']['TwoFactorVerifyRequest'];
export type TwoFactorDisableRequest = components['schemas']['TwoFactorDisableRequest'];
export type TwoFactorRecoveryCodesRequest = components['schemas']['TwoFactorRecoveryCodesRequest'];
/** One-time recovery codes; the server keeps only hashes. */
export type TwoFactorRecoveryCodes = components['schemas']['TwoFactorRecoveryCodes'];
/**
 * `202` response of `POST /auth/login` / `POST /auth/verify-email`.
 * `mode=ENROLL` means the server-wide policy requires setup and the account has
 * no authenticator yet; `TOTP` is the ordinary challenge.
 */
export type AuthTwoFactorChallenge = components['schemas']['AuthTwoFactorChallenge'] & {
  /** Additive alias some proxies send alongside `mode=ENROLL`. */
  enrollment_required?: boolean;
};
export type AuthTwoFactorVerifyRequest = components['schemas']['AuthTwoFactorVerifyRequest'];
export type TwoFactorMethod = AuthTwoFactorChallenge['methods'][number];

/**
 * #93 login-time enrollment. The password step already proved possession, so
 * these endpoints carry the single-use `challenge_id` instead of a password.
 */
export interface AuthTwoFactorEnrollStartRequest {
  challenge_id: string;
}
export interface AuthTwoFactorEnrollVerifyRequest {
  challenge_id: string;
  code: string;
}
/** Normalized `POST /auth/2fa/enroll/verify`: session + any inline codes (normally none). */
export interface AuthTwoFactorEnrollmentResult {
  session: AuthSession;
  recoveryCodes: string[];
}

/**
 * #93 `POST /media/images` multipart result. Only `file_id` is required; the
 * client passes it to the existing avatar/cover/logo setters. Metadata is
 * display-only and may be omitted by the server.
 */
export interface MediaImage {
  file_id: string;
  filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  scan_status?: string | null;
}

/* ------------------------------------------------------------------------- */
/* P0-4 (#82): workspace settings, logo, invites and the permission matrix  */
/* ------------------------------------------------------------------------- */

/** `PATCH /workspaces/{id}`: absent = unchanged, `null` clears description/logo. */
export type WorkspaceUpdate = components['schemas']['WorkspaceUpdate'];
export type WorkspaceAvatarRequest = components['schemas']['WorkspaceAvatarRequest'];
/** Metadata only; the raw invite token is never re-readable from the list. */
export type WorkspaceInvite = components['schemas']['WorkspaceInvite'];
export type WorkspaceInviteRole = WorkspaceInvite['role'];
export type WorkspaceInviteStatus = WorkspaceInvite['status'];
export type WorkspaceInviteList = components['schemas']['WorkspaceInviteList'];
/**
 * #100 anonymous invite preview: display metadata only. The contract has no
 * token, hash or invited address field, so the public page cannot leak them.
 */
export type WorkspaceInvitePreview = components['schemas']['WorkspaceInvitePreview'];
/** `token`/`accept_url` exist only in this response and are shown once. */
export type WorkspaceInviteCreated = components['schemas']['WorkspaceInviteCreated'];
export type WorkspaceInviteCreateRequest = components['schemas']['WorkspaceInviteCreateRequest'];
export type WorkspaceInviteAcceptance = components['schemas']['WorkspaceInviteAcceptance'];
/** One row of the effective OWNER/ADMIN/MEMBER matrix (six rights). */
export type WorkspaceRolePermissions = components['schemas']['WorkspaceRolePermissions'];
export type WorkspacePermissionRole = WorkspaceRolePermissions['role'];
export type WorkspacePermissionKey =
  | 'manage_workspace'
  | 'manage_members'
  | 'manage_invites'
  | 'manage_permissions'
  | 'view_audit'
  | 'manage_security';
export type WorkspacePermissionMatrix = components['schemas']['WorkspacePermissionMatrix'];
export type WorkspacePermissionEntry = components['schemas']['WorkspacePermissionEntry'];
export type WorkspacePermissionUpdate = components['schemas']['WorkspacePermissionUpdate'];

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
/** #83: `PATCH /files/{fileId}` — display name only (object key stays). */
export type FileRename = components['schemas']['FileRename'];

/* ------------------------------------------------------------------------- */
/* #83: server-side message search                                           */
/* ------------------------------------------------------------------------- */

/** One highlight range `[start,end)` in `snippet` (UTF-16 code units). */
export type SearchHighlight = components['schemas']['SearchHighlight'];
/** One managed plaintext hit; `snippet` is text, never HTML. */
export type MessageSearchHit = components['schemas']['MessageSearchHit'];
export type MessageSearchPage = components['schemas']['MessageSearchPage'];

/* ------------------------------------------------------------------------- */
/* #83: mention inbox (`/me/mentions`)                                       */
/* ------------------------------------------------------------------------- */

/** Content-free mention row: chat/message/author/read state only. */
export type Mention = components['schemas']['Mention'];
export type MentionPage = components['schemas']['MentionPage'];
/** `ids[]` (≤200) or `all=true`; the server owns idempotency. */
export type ReadMentionsRequest = components['schemas']['ReadMentionsRequest'];

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
/* #94: Music Room (built-in `music-room` plugin)                            */
/* ------------------------------------------------------------------------- */

/**
 * Server projection of the built-in `music-room` plugin. The room itself is a
 * regular MANAGED GROUP channel; the server never stores audio, playback state
 * or an SFU session. Tracks are metadata-only AUDIO attachments of that chat.
 */
export type MusicRoomPlugin = components['schemas']['MusicRoomPlugin'];
export type MusicRoomOpen = components['schemas']['MusicRoomOpen'];
export type MusicRoomTrack = components['schemas']['MusicRoomTrack'];
export type MusicRoomTracks = components['schemas']['MusicRoomTracks'];

/* ------------------------------------------------------------------------- */
/* D1.2 (#86): external plugin packages (admin ZIP install)                  */
/* ------------------------------------------------------------------------- */

/** Metadata of one installed external package; never asset bytes/object keys. */
export type AdminPluginPackage = components['schemas']['AdminPluginPackage'];
export type AdminPluginPackageList = components['schemas']['AdminPluginPackageList'];
/** Closed manifest v1 permission vocabulary (external packages only). */
export type PluginPackagePermission = AdminPluginPackage['permissions'][number];

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
/* P0-3 (#81): workspace DLP, audit/export, sessions and security settings   */
/* ------------------------------------------------------------------------- */

/**
 * One DLP rule. `pattern` is a literal (KEYWORD) or a literal with `*`
 * wildcards (PATTERN); it is never a regular expression. The UI therefore
 * never claims regex support and validates only the contract bounds.
 */
export type DlpPolicy = components['schemas']['DlpPolicy'];
export type DlpAction = DlpPolicy['action'];
export type DlpPatternType = DlpPolicy['pattern_type'];
/** #101 surface: `ALL` (default), message text/edit, attachment metadata, plugin payload. */
export type DlpScope = DlpPolicy['scope'];
export type DlpPolicyList = components['schemas']['DlpPolicyList'];
export type DlpPolicyCreateRequest = components['schemas']['DlpPolicyCreateRequest'];
/** PATCH body: every field optional; at least one is required by the contract. */
export type DlpPolicyUpdateRequest = components['schemas']['DlpPolicyUpdateRequest'];
/**
 * Content-free DLP event: ids, rule-name snapshot, action and time only.
 * Message text, attachments, email and IP are not part of the contract, so the
 * UI cannot render them.
 */
export type DlpEventRow = components['schemas']['DlpEvent'];
export type DlpEventPage = components['schemas']['DlpEventPage'];
/** Workspace audit row: action/actor/target/time only (no metadata/hash/email). */
export type WorkspaceAuditEvent = components['schemas']['WorkspaceAuditEvent'];
export type WorkspaceAuditPage = components['schemas']['WorkspaceAuditPage'];
/** Bounded JSON export shape (`exported_rows` ≤ 10 000). */
export type WorkspaceAuditExport = components['schemas']['WorkspaceAuditExport'];
export type AuditExportFormat = NonNullable<
  operations['exportWorkspaceAudit']['parameters']['query']
>['format'];
/** Member Keycloak session: no IP/username/tokens in the contract. */
export type WorkspaceSession = components['schemas']['WorkspaceSession'];
export type WorkspaceSessionPage = components['schemas']['WorkspaceSessionPage'];
export type WorkspaceSessionRevokeAll = components['schemas']['WorkspaceSessionRevokeAll'];
/**
 * Workspace security policy values. Deliberately has no `security_mode`: the
 * mode is immutable and changing it is a documented `422 MODE_CHANGE_FORBIDDEN`.
 */
export type WorkspaceSecurity = components['schemas']['WorkspaceSecurity'];
export type WorkspaceSecurityUpdateRequest =
  components['schemas']['WorkspaceSecurityUpdateRequest'];

/* ------------------------------------------------------------------------- */
/* #96 bots + #98 signed events, deliveries and slash commands               */
/* ------------------------------------------------------------------------- */

/**
 * Bot metadata. The contract deliberately has no bearer token/hash field: the
 * token exists only in the one-time `BotToken` response of create/rotate. #98
 * adds the event configuration and slash commands; `signing_secret` appears
 * only in the response that generated it and is stripped by the store.
 */
export type Bot = components['schemas']['Bot'];
export type BotStatus = Bot['status'];
/** MVP scope vocabulary: only `chat.write` can be granted. */
export type BotScope = Bot['scopes'][number];
export type BotList = components['schemas']['BotList'];
export type BotCreateRequest = components['schemas']['BotCreateRequest'];
/**
 * Absent fields stay unchanged; `clear_avatar` is mutually exclusive with
 * `avatar_file_id`. The generated schema marks `clear_avatar` as required
 * because of its `default: false`, while the contract allows omitting it (the
 * same shape as `MessageCreateBody.mention_all`).
 */
export type BotUpdateRequest = Omit<components['schemas']['BotUpdateRequest'], 'clear_avatar'> & {
  clear_avatar?: boolean;
};
/** One-time response: `token` is shown once and never listed again. */
export type BotToken = components['schemas']['BotToken'];
export type ChatBot = components['schemas']['ChatBot'];
export type ChatBotList = components['schemas']['ChatBotList'];
export type ChatBotInstallRequest = components['schemas']['ChatBotInstallRequest'];
/** #98 slash-command registration (lowercase name without the leading `/`). */
export type BotCommand = components['schemas']['BotCommand'];
/** #98 one-time signing-secret response of PATCH activation / POST .../secret. */
export type BotSigningSecret = components['schemas']['BotSigningSecret'];
export type BotDelivery = components['schemas']['BotDelivery'];
export type BotDeliveryList = components['schemas']['BotDeliveryList'];
export type BotDeliveryAccepted = components['schemas']['BotDeliveryAccepted'];
export type BotCommandInvoke = components['schemas']['BotCommandInvoke'];
export type BotCommandAccepted = components['schemas']['BotCommandAccepted'];
/** Wire event types the bot can subscribe to (delivery statuses reuse it). */
export type BotEventType = BotDelivery['event_type'];
export type BotDeliveryStatus = BotDelivery['status'];
/** `USER` for members, `BOT` for bot-authored rows (badge/identity gate). */
export type MessageSenderType = ApiMessage['sender_type'];

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
