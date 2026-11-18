/**
 * Types are generated from contracts/openapi.yaml (npm run api:types).
 * Do not edit schema.d.ts manually; the contract is the only source of truth.
 */
import type { components } from './schema';

export type ApiErrorBody = components['schemas']['Error'];
export type Session = components['schemas']['Session'];
export type ChatSummary = components['schemas']['ChatSummary'];
export type ChatList = components['schemas']['ChatList'];
export type ApiMessage = components['schemas']['Message'];
export type MessageCreateBody = components['schemas']['MessageCreate'];
export type MessagePage = components['schemas']['MessagePage'];
export type MessagePageMeta = MessagePage['page'];
export type ReadRequestBody = components['schemas']['ReadRequest'];
export type SyncResponse = components['schemas']['SyncResponse'];
export type SyncChat = SyncResponse['chats'][number];

export type MessageType = ApiMessage['type'];
export type ChatType = ChatSummary['type'];
export type SecurityMode = ChatSummary['security_mode'];
export type MeResponse = components['schemas']['MeResponse'];
export type MeUser = MeResponse['user'];
export type WorkspaceSummary = components['schemas']['WorkspaceSummary'];
export type WorkspaceRole = WorkspaceSummary['role'];
export type CreateWorkspaceRequest = components['schemas']['CreateWorkspaceRequest'];
export type DeviceRegistration = components['schemas']['DeviceRegistration'];
export type Device = components['schemas']['Device'];
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
export type PreflightFile = components['schemas']['PreflightFile'];
export type PreflightRequest = components['schemas']['PreflightRequest'];
export type PreflightDecision = components['schemas']['PreflightDecision'];
export type PreflightResponse = components['schemas']['PreflightResponse'];
export type UploadInitRequest = components['schemas']['UploadInitRequest'];
export type UploadSession = components['schemas']['UploadSession'];
export type UploadSessionStatus = UploadSession['status'];
export type UploadPart = components['schemas']['UploadPart'];
export type UploadCompleteRequest = components['schemas']['UploadCompleteRequest'];
export type ApiAttachment = components['schemas']['AttachmentRef'];
export type AttachmentScanStatus = ApiAttachment['scan_status'];
export type DownloadUrl = components['schemas']['DownloadUrl'];

/* ------------------------------------------------------------------------- */
/* E5-F: built-in stickers                                                   */
/* ------------------------------------------------------------------------- */

export type StickerRef = components['schemas']['StickerRef'];
export type StickerPack = components['schemas']['StickerPack'];
export type StickerPackList = components['schemas']['StickerPackList'];

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
