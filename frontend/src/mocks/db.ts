import type {
  AdminAuditEvent,
  AdminChat,
  AdminPluginPackage,
  AdminSession,
  AdminStorage,
  AdminUser,
  AdminUserStatus,
  ApiAttachment,
  ApiMessage,
  AttachmentScanStatus,
  AuthLoginRequest,
  AuthRegisterRequest,
  AuthVerifyEmailRequest,
  BlockedUser,
  Bot,
  Chat,
  ChatInvite,
  ChatMember,
  ChatPermissions,
  ChatPin,
  ChatSummary,
  Device,
  DlpEventRow,
  DlpPolicy,
  FileItem,
  MeResponse,
  Mention,
  MusicRoomTrack,
  Notification,
  NotificationPreference,
  NotificationPreferencePatch,
  Poll,
  PreflightFile,
  ProfileSession,
  ReadNotificationsRequest,
  Session,
  StickerPack,
  StickerRef,
  Plugin,
  Task,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadSessionStatus,
  WorkspaceAuditEvent,
  WorkspaceInvite,
  WorkspaceLimits,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceOverview,
  WorkspacePermissionMatrix,
  WorkspaceSecurity,
  WorkspaceSession,
  WorkspaceSummary,
} from '../api/types';
import { newUuid } from '../lib/ids';
import {
  buildChatInvites,
  buildChatMembers,
  buildChatPermissions,
  buildChatPins,
  buildChatSummaries,
  buildDirectMessages,
  buildGroupMessages,
  buildMockBots,
  buildMockMe,
  buildMemberUsers,
  buildNotificationPreferences,
  buildSeedPoll,
  buildSeedPollVotes,
  buildSeedTask,
  buildMentions,
  buildNotifications,
  buildStickerPacks,
  buildWorkspaceMembers,
  IDS,
  MOCK_DISPLAY_NAME,
  MOCK_DEMO_EMAIL,
  MOCK_DEMO_PASSWORD,
  MOCK_INVITE_TOKENS,
  mockSession,
  type MockMemberUser,
} from './fixtures';

/** D1.2 (#86): static asset bytes of one mock external package. */
export interface MockPluginAssetRecord {
  contentType: string;
  body: Uint8Array;
}

/** D1.1 (#76): one mock poll plus its per-user votes (server-side state). */
export interface MockPollRecord {
  chatId: string;
  poll: Poll;
  /** user_id -> option_id; one vote per user, like the backend primary key. */
  votes: Map<string, string>;
}

/** D1.1 (#76): one mock chat-scoped task. */
export interface MockTaskRecord {
  chatId: string;
  task: Task;
}

export interface ChatRecord {
  summary: ChatSummary;
  workspaceId: string;
  /** #78: creator + selected members for a PRIVATE channel (RLS simulation). */
  memberIds: string[];
  messages: ApiMessage[];
  /** Server-side client_message_id dedupe (not exposed by the contract). */
  clientMessageIds: Map<string, string>;
  /** #63 `scope=me`: per-user markers hide rows only from this caller. */
  hiddenMessageIds: Set<string>;
}

export interface DeviceRequestRecord {
  bodyHash: string;
  device: Device;
}

export interface WorkspaceRequestRecord {
  bodyHash: string;
  workspace: WorkspaceSummary;
}

/**
 * P0-3 (#81) mock-only workspace security state. Rows are contract-shaped and
 * content-free by construction; request logs let the UI suites assert headers,
 * filters, cursors and device ids without inspecting private data.
 */
export interface MockSecurityState {
  dlpPolicies: DlpPolicy[];
  dlpEvents: DlpEventRow[];
  auditEvents: WorkspaceAuditEvent[];
  sessions: WorkspaceSession[];
  settings: WorkspaceSecurity;
  /** Export cap (10 000 in the real backend); suites lower it to test truncation. */
  auditExportLimit: number;
  policyRequests: Array<{
    action: 'list' | 'create' | 'update' | 'delete';
    policyId?: string;
    body?: Record<string, unknown>;
    deviceId: string | null;
  }>;
  eventRequests: Array<{
    policyId: string | null;
    action: string | null;
    cursor: string | null;
    limit: number;
  }>;
  auditRequests: Array<{
    action: string | null;
    actorId: string | null;
    from: string | null;
    to: string | null;
    cursor: string | null;
    limit: number;
  }>;
  exportRequests: Array<{
    format: string;
    action: string | null;
    actorId: string | null;
    from: string | null;
    to: string | null;
  }>;
  sessionRequests: Array<{ cursor: string | null; limit: number }>;
  sessionRevokeRequests: string[];
  revokeAllRequests: number;
  settingsRequests: number;
  settingsPatches: Array<Record<string, unknown>>;
  forcePolicyListError: ForcedSendError | null;
  forcePolicyMutationError: ForcedSendError | null;
  forceEventError: ForcedSendError | null;
  forceAuditError: ForcedSendError | null;
  forceExportError: ForcedSendError | null;
  forceSessionsError: ForcedSendError | null;
  forceSessionRevokeError: ForcedSendError | null;
  forceRevokeAllError: ForcedSendError | null;
  forceSettingsError: ForcedSendError | null;
  forceSettingsSaveError: ForcedSendError | null;
}

/** Deterministic P0-3 seeds: two rules, content-free events, audit, sessions. */
export function createMockSecurityState(): MockSecurityState {
  const policySecrets = 'c0000000-0000-4000-8000-000000000001';
  const policyDomains = 'c0000000-0000-4000-8000-000000000002';
  return {
    dlpPolicies: [
      {
        id: policySecrets,
        name: 'Секреты и ключи',
        action: 'BLOCK',
        pattern_type: 'KEYWORD',
        pattern: 'пароль',
        enabled: true,
        created_at: '2026-11-10T09:00:00.000Z',
        updated_at: '2026-11-10T09:00:00.000Z',
      },
      {
        id: policyDomains,
        name: 'Внешние адреса',
        action: 'WARN',
        pattern_type: 'PATTERN',
        pattern: '*@external.*',
        enabled: true,
        created_at: '2026-11-11T09:00:00.000Z',
        updated_at: '2026-11-11T09:00:00.000Z',
      },
    ],
    dlpEvents: [
      {
        id: 'd0000000-0000-4000-8000-000000000001',
        policy_id: policySecrets,
        policy_name: 'Секреты и ключи',
        action: 'BLOCK',
        actor_id: IDS.anna,
        chat_id: IDS.groupChat,
        created_at: '2026-11-19T10:15:00.000Z',
      },
      {
        id: 'd0000000-0000-4000-8000-000000000002',
        policy_id: policyDomains,
        policy_name: 'Внешние адреса',
        action: 'WARN',
        actor_id: IDS.user,
        chat_id: IDS.directChat,
        created_at: '2026-11-18T16:40:00.000Z',
      },
      {
        id: 'd0000000-0000-4000-8000-000000000003',
        policy_id: null,
        policy_name: 'Удалённое правило',
        action: 'WARN',
        actor_id: IDS.mark,
        chat_id: IDS.groupChat,
        created_at: '2026-11-17T08:05:00.000Z',
      },
    ],
    auditEvents: [
      {
        id: 'e0000000-0000-4000-8000-000000000001',
        action: 'workspace.security.updated',
        actor_id: IDS.user,
        target_type: 'workspace_security',
        target_id: IDS.workspace,
        created_at: '2026-11-19T12:10:00.000Z',
      },
      {
        id: 'e0000000-0000-4000-8000-000000000002',
        action: 'workspace.dlp.policy.created',
        actor_id: IDS.anna,
        target_type: 'dlp_policy',
        target_id: policySecrets,
        created_at: '2026-11-18T12:00:00.000Z',
      },
      {
        id: 'e0000000-0000-4000-8000-000000000003',
        action: 'workspace.session.revoked',
        actor_id: IDS.user,
        target_type: 'user',
        target_id: IDS.mark,
        created_at: '2026-11-17T18:30:00.000Z',
      },
      {
        id: 'e0000000-0000-4000-8000-000000000004',
        action: 'workspace.audit.exported',
        actor_id: null,
        target_type: null,
        target_id: null,
        created_at: '2026-11-16T09:45:00.000Z',
      },
    ],
    sessions: [
      {
        id: 'f0000000-0000-4000-8000-000000000001',
        user_id: IDS.user,
        device: 'krug-web · Chrome',
        created_at: '2026-11-18T18:05:00.000Z',
        last_seen_at: '2026-11-19T14:55:00.000Z',
        current: true,
      },
      {
        id: 'f0000000-0000-4000-8000-000000000002',
        user_id: IDS.user,
        device: 'krug-web · Safari',
        created_at: '2026-11-01T09:12:00.000Z',
        last_seen_at: '2026-11-19T12:40:00.000Z',
        current: false,
      },
      {
        id: 'f0000000-0000-4000-8000-000000000003',
        user_id: IDS.anna,
        device: 'krug-web · Firefox',
        created_at: '2026-11-12T11:20:00.000Z',
        last_seen_at: '2026-11-19T11:05:00.000Z',
        current: false,
      },
      {
        id: 'f0000000-0000-4000-8000-000000000004',
        user_id: IDS.anna,
        device: 'krug-mobile · Android',
        created_at: '2026-11-14T08:00:00.000Z',
        last_seen_at: '2026-11-18T20:30:00.000Z',
        current: false,
      },
    ],
    settings: {
      require_2fa: false,
      session_timeout_minutes: 60,
      dlp_enabled: true,
      retention_days: 30,
      updated_at: '2026-11-19T12:10:00.000Z',
    },
    auditExportLimit: 10_000,
    policyRequests: [],
    eventRequests: [],
    auditRequests: [],
    exportRequests: [],
    sessionRequests: [],
    sessionRevokeRequests: [],
    revokeAllRequests: 0,
    settingsRequests: 0,
    settingsPatches: [],
    forcePolicyListError: null,
    forcePolicyMutationError: null,
    forceEventError: null,
    forceAuditError: null,
    forceExportError: null,
    forceSessionsError: null,
    forceSessionRevokeError: null,
    forceRevokeAllError: null,
    forceSettingsError: null,
    forceSettingsSaveError: null,
  };
}

/** E8 mock-only server state; the raw SMTP password is never retained. */
export interface MockAdminState {
  setupCompletedAt: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  smtpPasswordStored: boolean;
  smtpFrom: string | null;
  smtpStarttls: boolean;
  maxChatsPerUser: number;
  maxChatsPerWorkspace: number;
  maxWorkspaceMembers: number;
  allowedFileExtensions: string[];
  registrationOpen: boolean;
  /** #93: server-wide policy; every account must enroll a TOTP authenticator. */
  require2fa: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface MockChatRequestRecord {
  bodyHash: string;
  chat: Chat;
}

export interface MockAdminSettingsPatchRecord {
  body: Record<string, unknown>;
  completeSetup: boolean;
}

export interface IdempotencyRecord {
  bodyHash: string;
  status: number;
  body: ApiMessage;
  headers: Record<string, string>;
}

export interface ForcedSendError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export interface MockRealtimeTicket {
  deviceId: string | null;
  expiresAt: number;
  used: boolean;
}

export interface ForcedFileError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
  /** When true the handler clears the override after returning it once. */
  once?: boolean;
  /** Restrict a part failure to one part number. */
  partNo?: number;
}

export interface MockUploadPart {
  sha256: string;
  sizeBytes: number;
  bytes: Uint8Array;
}

export interface MockUpload {
  id: string;
  /** #83: `null` for a global workspace file that is not bound to a chat. */
  chatId: string | null;
  filename: string;
  size: number;
  mime: string | null;
  /** D1-BE2/FE2: sanitized client metadata, copied to the attachment. */
  media: UploadInitRequest['media'];
  declaredSha256: string | null;
  partSize: number;
  totalParts: number;
  received: Map<number, MockUploadPart>;
  status: UploadSessionStatus;
  expiresAt: number;
  attachmentId: string | null;
  scanStatus: AttachmentScanStatus;
  scanPollsRemaining: number;
  finalizedSha256: string | null;
  createdAt: number;
  /** Quota reservation was already committed/released; never double-count. */
  reservedReleased: boolean;
}

/**
 * E9-F mock-only knobs for the admin directory. The defaults are derived from
 * the seeded users/chats/workspaces so the mock stays consistent with
 * `/admin/overview`; suites that need pagination or a specific row inject an
 * override instead of mutating unrelated entities.
 */
export interface MockAdminDirectoryState {
  usersOverride: AdminUser[] | null;
  chatsOverride: AdminChat[] | null;
  storageOverride: AdminStorage | null;
  /** E11-F audit page source; `null` uses the deterministic seeded events. */
  auditEventsOverride: AdminAuditEvent[] | null;
  /** #84 export cap (10 000 in the real backend); suites lower it for truncation. */
  auditExportLimit: number;
  usersDelayMs: number;
  chatsDelayMs: number;
  storageDelayMs: number;
  auditDelayMs: number;
  forceUsersError: ForcedSendError | null;
  forceChatsError: ForcedSendError | null;
  forceStorageError: ForcedSendError | null;
  forceAuditError: ForcedSendError | null;
  /** #84: export failures are injected without breaking the audit page. */
  forceExportError: ForcedSendError | null;
  /** E11-F: action failures are injected per operation. */
  forceUserActionError: ForcedSendError | null;
  forceChatDeleteError: ForcedSendError | null;
  /** Rows appended by successful mock actions (newest first on read). */
  auditEvents: AdminAuditEvent[];
  /** E11-F: status changed by a mock suspend/activate (applies to any source). */
  userStatuses: Map<string, AdminUserStatus>;
  /** E11-F: soft-deleted chat ids; the admin chat list hides them. */
  deletedChatIds: Set<string>;
  usersRequests: Array<{ query: string | null; cursor: string | null; limit: number }>;
  chatsRequests: Array<{
    workspaceId: string | null;
    query: string | null;
    type: string | null;
    cursor: string | null;
    limit: number;
  }>;
  storageRequests: Array<{ workspaceId: string | null }>;
  auditRequests: Array<{ action: string | null; cursor: string | null; limit: number }>;
  /** `X-Device-Id` observed on each admin mutation (contract header). */
  userActionRequests: Array<{
    action: 'suspend' | 'activate';
    userId: string;
    deviceId: string | null;
  }>;
  chatDeleteRequests: Array<{ chatId: string; deviceId: string | null }>;
}

export function createMockAdminDirectoryState(): MockAdminDirectoryState {
  return {
    usersOverride: null,
    chatsOverride: null,
    storageOverride: null,
    auditEventsOverride: null,
    auditExportLimit: 10_000,
    usersDelayMs: 0,
    chatsDelayMs: 0,
    storageDelayMs: 0,
    auditDelayMs: 0,
    forceUsersError: null,
    forceChatsError: null,
    forceStorageError: null,
    forceAuditError: null,
    forceExportError: null,
    forceUserActionError: null,
    forceChatDeleteError: null,
    auditEvents: [],
    userStatuses: new Map(),
    deletedChatIds: new Set(),
    usersRequests: [],
    chatsRequests: [],
    storageRequests: [],
    auditRequests: [],
    userActionRequests: [],
    chatDeleteRequests: [],
  };
}

/**
 * #84 workspace overview knobs. The default projection is derived from the
 * seeded chats/files/DLP rows; suites inject `override` when they need exact
 * counters or a content-free audit preview.
 */
export interface MockWorkspaceOverviewState {
  override: WorkspaceOverview | null;
  delayMs: number;
  forceError: ForcedSendError | null;
  requests: Array<{ workspaceId: string }>;
}

export function createMockWorkspaceOverviewState(): MockWorkspaceOverviewState {
  return { override: null, delayMs: 0, forceError: null, requests: [] };
}

/**
 * #84 platform-admin sessions. Rows are contract-shaped: id, local user id,
 * client-derived device label and timestamps only (never IP/username/tokens).
 */
export interface MockAdminSessionsState {
  sessions: AdminSession[];
  delayMs: number;
  forceListError: ForcedSendError | null;
  forceRevokeError: ForcedSendError | null;
  forceRevokeAllError: ForcedSendError | null;
  listRequests: Array<{ userId: string; cursor: string | null; limit: number }>;
  revokeRequests: string[];
  revokeAllRequests: number;
}

/** Deterministic sessions for the seeded users; no PII beyond the local id. */
export function createMockAdminSessionsState(): MockAdminSessionsState {
  const session = (
    id: string,
    userId: string,
    device: string,
    created: string,
    lastSeen: string,
    current = false,
  ): AdminSession => ({
    id,
    user_id: userId,
    device,
    created_at: created,
    last_seen_at: lastSeen,
    current,
  });
  return {
    sessions: [
      session(
        'f0000000-0000-4000-8000-000000000101',
        IDS.user,
        'krug-web · Chrome',
        '2026-11-18T18:05:00.000Z',
        '2026-11-20T14:55:00.000Z',
        true,
      ),
      session(
        'f0000000-0000-4000-8000-000000000102',
        IDS.user,
        'krug-mobile · iOS',
        '2026-11-01T09:12:00.000Z',
        '2026-11-19T12:40:00.000Z',
      ),
      session(
        'f0000000-0000-4000-8000-000000000103',
        IDS.anna,
        'krug-web · Safari',
        '2026-11-12T11:20:00.000Z',
        '2026-11-19T11:05:00.000Z',
      ),
      session(
        'f0000000-0000-4000-8000-000000000104',
        IDS.anna,
        'krug-mobile · Android',
        '2026-11-14T08:00:00.000Z',
        '2026-11-18T20:30:00.000Z',
      ),
      session(
        'f0000000-0000-4000-8000-000000000105',
        IDS.mark,
        'krug-web · Firefox',
        '2026-11-15T10:10:00.000Z',
        '2026-11-18T09:05:00.000Z',
      ),
    ],
    delayMs: 0,
    forceListError: null,
    forceRevokeError: null,
    forceRevokeAllError: null,
    listRequests: [],
    revokeRequests: [],
    revokeAllRequests: 0,
  };
}

/**
 * #84 translation-provider installation settings. The effective view has no
 * secret field: only `enabled` and the https URL are stored/returned.
 */
export interface MockTranslationAdminState {
  enabled: boolean;
  url: string;
  updates: Array<{ body: Record<string, unknown>; changed: boolean }>;
  getRequests: number;
  testRequests: number;
  /** Result of the next probe; `UNAVAILABLE` simulates a provider failure. */
  testStatus: 'OK' | 'UNAVAILABLE';
  testLatencyMs: number;
  forceGetError: ForcedSendError | null;
  forceUpdateError: ForcedSendError | null;
  forceTestError: ForcedSendError | null;
}

export function createMockTranslationAdminState(): MockTranslationAdminState {
  return {
    enabled: true,
    url: 'https://translate.example.test/v1',
    updates: [],
    getRequests: 0,
    testRequests: 0,
    testStatus: 'OK',
    testLatencyMs: 84,
    forceGetError: null,
    forceUpdateError: null,
    forceTestError: null,
  };
}

/** E12-F: add-by-email request observed by the mock (no extra fields). */
export interface MockMemberAddRequestRecord {
  workspaceId: string;
  email: string;
  role: WorkspaceMemberRole;
  deviceId: string | null;
}

export interface MockMemberRoleRequestRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  deviceId: string | null;
}

export interface MockMemberRemoveRequestRecord {
  workspaceId: string;
  userId: string;
  deviceId: string | null;
}

/** #79: channel-membership request observed by the mock. */
export interface MockChatMemberRequestRecord {
  chatId: string;
  action: 'add' | 'role' | 'remove' | 'leave';
  userId: string;
  role?: ChatMember['role'];
  deviceId: string | null;
}

/** #79: invite-link request observed by the mock. */
export interface MockChatInviteRequestRecord {
  chatId: string;
  action: 'create' | 'revoke';
  inviteId?: string;
  body?: Record<string, unknown>;
  deviceId: string | null;
}

export interface MockInviteAcceptRequestRecord {
  token: string;
  deviceId: string | null;
  result: 'OK' | 'ALREADY_MEMBER' | 'ERROR';
}

/** D1-FE5: `PATCH /chats/{chatId}` body observed by the mock. */
export interface MockChatSettingsRequestRecord {
  chatId: string;
  body: Record<string, unknown>;
  deviceId: string | null;
}

/** #80: cover and rights requests observed by the mock. */
export interface MockChatCoverRequestRecord {
  chatId: string;
  fileId: string | null;
  action: 'SET' | 'DELETE';
  deviceId: string | null;
}

export interface MockChatAvatarRequestRecord {
  chatId: string;
  fileId: string | null;
  action: 'SET' | 'DELETE' | 'GET';
  deviceId: string | null;
}

export interface MockChatPermissionsRequestRecord {
  chatId: string;
  body: Record<string, unknown> | null;
  action: 'GET' | 'PATCH';
  deviceId: string | null;
}

export interface MockChatPinRequestRecord {
  chatId: string;
  messageId: string | null;
  action: 'LIST' | 'PIN' | 'UNPIN';
  deviceId: string | null;
}

export interface MockChatArchiveRequestRecord {
  chatId: string;
  action: 'ARCHIVE' | 'UNARCHIVE';
  deviceId: string | null;
}

export interface MockAttachment {
  ref: ApiAttachment;
  uploadId: string;
  messageId: string | null;
}

export interface MockDownloadRecord {
  attachmentId: string;
  issuedAt: number;
  expiresAt: number;
  sizeBytes: number;
  sha256: string;
}

export interface MockPreflightRecord {
  idempotencyKey: string;
  chatId: string;
  files: PreflightFile[];
}

export interface MockUploadInitRecord {
  idempotencyKey: string;
  uploadId: string;
  bodyHash: string;
  body: UploadInitRequest;
}

export interface MockPartUploadRecord {
  uploadId: string;
  partNo: number;
  sha256: string;
  sizeBytes: number;
}

export interface MockUploadCompleteRecord {
  uploadId: string;
  idempotencyKey: string;
  body: UploadCompleteRequest;
}

/** E6-F: server-owned notification row (RLS is simulated by `user_id`). */
export interface MockNotificationRecord extends Notification {
  user_id: string;
}

export interface MockNotificationReadRecord {
  body: ReadNotificationsRequest;
  idempotencyKey: string | null;
}

export interface MockNotificationPreferencePatchRecord {
  body: NotificationPreferencePatch;
  idempotencyKey: string | null;
}

export interface MockNotificationPreferenceReplay {
  bodyHash: string;
  preference: NotificationPreference;
}

/** Auth BFF mock state (MSW only; never shipped without `VITE_USE_MOCKS`). */
export interface MockAuthUserRecord {
  id: string;
  email: string;
  displayName: string;
  /** Demo-only password; the real backend never stores it in the app DB. */
  password: string;
  verified: boolean;
  /** E8/R-03: first mock user is the platform admin. */
  isPlatformAdmin: boolean;
}

export interface MockEmailVerification {
  id: string;
  email: string;
  displayName: string;
  /** Demo code; the real backend never stores or logs the code. */
  code: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
  lastSentAt: number;
}

export interface MockAuthTokenRecord {
  userId: string;
  expiresAt: number;
}

/** P0-4 : dev-only authenticator stand-in (the real secret is AES-GCM at rest). */
export interface MockTwoFactorRecord {
  enabled: boolean;
  enabledAt: string | null;
  secret: string | null;
  /** Secret from `POST /me/2fa/setup`, confirmed by the next verify. */
  pendingSecret: string | null;
  /** Recovery codes with their used flag; the real backend keeps only hashes. */
  recoveryCodes: Map<string, boolean>;
  /** Last accepted TOTP time step (replay protection). */
  lastStep: number | null;
}

/** P0-4 in-memory `202` login challenge (single-use, TTL, attempts). */
export interface MockTwoFactorChallengeRecord {
  id: string;
  userId: string;
  expiresAt: number;
  attempts: number;
  /** #93: `ENROLL` when the server policy forces setup before a session. */
  mode: 'TOTP' | 'ENROLL';
  /** #93: one-time secret generated by enroll/start, confirmed by enroll/verify. */
  pendingSecret: string | null;
}

/**
 * #93 `POST /media/images` record. Standalone images have no chat/message
 * provenance until an avatar/cover/logo setter references them; only metadata
 * is kept (never bytes or an object key).
 */
export interface MockMediaImageRecord {
  id: string;
  filename: string;
  mime: string;
  size: number;
  scanStatus: 'CLEAN';
  chatId: string | null;
  createdAt: string;
}

/** P0-4 workspace invite; `token` exists only in the mock to resolve accepts. */
export interface MockWorkspaceInviteRecord extends WorkspaceInvite {
  token: string;
}

/**
 * #96: workspace bot plus the mock-only credential. The real backend stores
 * only a SHA-256 hash; handlers never expose `token` in a response except the
 * one-time create/rotate `BotToken`.
 */
export interface MockBotRecord extends Bot {
  token: string;
}

export interface MockChatBotRecord {
  chatId: string;
  botId: string;
  workspaceId: string;
  enabled: boolean;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export type MockBotAction =
  | 'create'
  | 'list'
  | 'update'
  | 'disable'
  | 'rotate'
  | 'listChat'
  | 'install'
  | 'uninstall'
  | 'send';

export interface MockBotRequestRecord {
  action: MockBotAction;
  workspaceId: string | null;
  chatId: string | null;
  botId: string | null;
  deviceId: string | null;
}

export interface MockDb {
  session: Session;
  me: MeResponse;
  devices: Device[];
  deviceRequests: Map<string, DeviceRequestRecord>;
  workspaceRequests: Map<string, WorkspaceRequestRecord>;
  /** E8/R-01: GROUP creation idempotency records. */
  chatRequests: Map<string, MockChatRequestRecord>;
  chatCreateRequests: Array<{ idempotencyKey: string; body: Record<string, unknown> }>;
  /** E2E/debug: force a chat-create error without changing the limits read model. */
  forceChatCreateError: ForcedSendError | null;
  /** E10-F: active member directory used by the DIRECT peer picker. */
  workspaceMembers: WorkspaceMember[];
  membersDelayMs: number;
  memberDirectoryRequests: Array<{
    workspaceId: string;
    query: string | null;
    cursor: string | null;
    limit: number;
  }>;
  /** E12-F: registered users for add-by-email lookup (mock only). */
  memberUsers: MockMemberUser[];
  memberAddRequests: MockMemberAddRequestRecord[];
  memberRoleRequests: MockMemberRoleRequestRecord[];
  memberRemoveRequests: MockMemberRemoveRequestRecord[];
  forceMemberAddError: ForcedSendError | null;
  forceMemberRoleError: ForcedSendError | null;
  forceMemberRemoveError: ForcedSendError | null;
  /** #79: channel participants (GROUP + DIRECT), invite links and blocks. */
  chatMembers: Record<string, ChatMember[]>;
  chatMemberRequests: MockChatMemberRequestRecord[];
  chatMemberDelayMs: number;
  forceChatMemberListError: ForcedSendError | null;
  forceChatMemberAddError: ForcedSendError | null;
  forceChatMemberRoleError: ForcedSendError | null;
  forceChatMemberRemoveError: ForcedSendError | null;
  forceChatMemberLeaveError: ForcedSendError | null;
  chatInvites: Record<string, ChatInvite[]>;
  chatInviteTokens: Map<string, { chatId: string; inviteId: string }>;
  chatInviteRequests: MockChatInviteRequestRecord[];
  inviteAcceptRequests: MockInviteAcceptRequestRecord[];
  forceChatInviteListError: ForcedSendError | null;
  forceChatInviteCreateError: ForcedSendError | null;
  forceChatInviteRevokeError: ForcedSendError | null;
  forceInviteAcceptError: ForcedSendError | null;
  blockedUsers: BlockedUser[];
  blockRequests: Array<{ userId: string; action: 'BLOCK' | 'UNBLOCK'; deviceId: string | null }>;
  forceBlockedListError: ForcedSendError | null;
  forceBlockError: ForcedSendError | null;
  /** D1-FE5: chat settings requests and injectable failures. */
  chatSettingsRequests: MockChatSettingsRequestRecord[];
  chatSettingsDelayMs: number;
  forceChatSettingsError: ForcedSendError | null;
  /** P0-2 (#80): cover, rights, pins, archive and OWNER deletion. */
  chatPermissions: Record<string, ChatPermissions>;
  chatPermissionsRequests: MockChatPermissionsRequestRecord[];
  chatCoverRequests: MockChatCoverRequestRecord[];
  chatAvatarRequests: MockChatAvatarRequestRecord[];
  chatPins: Record<string, ChatPin[]>;
  chatPinRequests: MockChatPinRequestRecord[];
  /** #96: workspace bots, mock-only credentials and chat installations. */
  bots: MockBotRecord[];
  chatBots: MockChatBotRecord[];
  botRequests: MockBotRequestRecord[];
  botDelayMs: number;
  /** Server-side idempotency for `POST /bots/{botId}/messages`. */
  botSendIdempotency: Map<string, { bodyHash: string; messageId: string }>;
  forceBotListError: ForcedSendError | null;
  forceBotCreateError: ForcedSendError | null;
  forceBotUpdateError: ForcedSendError | null;
  forceBotDisableError: ForcedSendError | null;
  forceBotRotateError: ForcedSendError | null;
  forceChatBotListError: ForcedSendError | null;
  forceChatBotInstallError: ForcedSendError | null;
  forceChatBotUninstallError: ForcedSendError | null;
  forceBotSendError: ForcedSendError | null;
  chatArchiveRequests: MockChatArchiveRequestRecord[];
  chatDeleteRequests: Array<{ chatId: string; deviceId: string | null }>;
  forceChatCoverError: ForcedSendError | null;
  forceChatAvatarError: ForcedSendError | null;
  forceChatPermissionsError: ForcedSendError | null;
  forceChatPermissionsUpdateError: ForcedSendError | null;
  forceChatPinsError: ForcedSendError | null;
  forceChatPinError: ForcedSendError | null;
  forceChatArchiveError: ForcedSendError | null;
  forceChatDeleteError: ForcedSendError | null;
  /** D1.1 (#69): built-in plugin catalog and per-chat switches. */
  pluginCatalog: Plugin[];
  pluginCatalogRequests: number;
  pluginCatalogDelayMs: number;
  forcePluginCatalogError: ForcedSendError | null;
  chatPlugins: Map<string, Map<string, boolean>>;
  chatPluginListRequests: Array<{ chatId: string; deviceId: string | null }>;
  chatPluginRequests: Array<{
    chatId: string;
    pluginId: string;
    body: Record<string, unknown>;
    deviceId: string | null;
  }>;
  /** Mirrors the backend audit: only actual changes are recorded. */
  chatPluginAudit: Array<{ pluginId: string; enabled: boolean }>;
  chatPluginsDelayMs: number;
  chatPluginPatchDelayMs: number;
  forceChatPluginsError: ForcedSendError | null;
  forceChatPluginPatchError: ForcedSendError | null;
  /** #94: idempotent workspace music room + AUDIO-attachment track metadata. */
  musicRoomChats: Map<string, string>;
  musicRoomTracks: Map<string, MusicRoomTrack[]>;
  musicRoomOpenRequests: Array<{ workspaceId: string; deviceId: string | null }>;
  musicRoomTrackRequests: Array<{ chatId: string; deviceId: string | null }>;
  musicRoomDelayMs: number;
  forceMusicRoomOpenError: ForcedSendError | null;
  forceMusicRoomTracksError: ForcedSendError | null;
  /** D1.2 (#86): installed external ZIP packages and their static assets. */
  pluginPackages: AdminPluginPackage[];
  pluginPackageAssets: Map<string, Map<string, MockPluginAssetRecord>>;
  adminPluginListRequests: number;
  pluginPackageInstallRequests: Array<{ fileName: string; size: number; deviceId: string | null }>;
  pluginPackageUninstallRequests: string[];
  pluginPackageInstallDelayMs: number;
  forceAdminPluginPackagesError: ForcedSendError | null;
  forceInstallPluginPackageError: ForcedSendError | null;
  forceUninstallPluginPackageError: ForcedSendError | null;
  /* D1.1 (#76): poll/task/translate action state and injectable failures. */
  polls: Map<string, MockPollRecord>;
  tasks: Map<string, MockTaskRecord>;
  pollRequests: Array<{
    chatId: string;
    action: 'list' | 'create' | 'vote' | 'close';
    pollId?: string;
    body?: Record<string, unknown>;
    deviceId: string | null;
  }>;
  taskRequests: Array<{
    chatId: string;
    action: 'list' | 'create' | 'update';
    taskId?: string;
    body?: Record<string, unknown>;
    deviceId: string | null;
  }>;
  translationRequests: Array<{
    chatId: string;
    messageId: string;
    body: Record<string, unknown>;
    deviceId: string | null;
  }>;
  /** Mirrors the real provider switch: false makes translate return 503. */
  translationAvailable: boolean;
  forcePollListError: ForcedSendError | null;
  forcePollCreateError: ForcedSendError | null;
  forcePollMutationError: ForcedSendError | null;
  forceTaskListError: ForcedSendError | null;
  forceTaskCreateError: ForcedSendError | null;
  forceTaskUpdateError: ForcedSendError | null;
  forceTranslationError: ForcedSendError | null;
  chats: Record<string, ChatRecord>;
  idempotency: Map<string, IdempotencyRecord>;
  readReceipts: Record<string, number>;
  realtimeTickets: Map<string, MockRealtimeTicket>;
  failNextSend: number;
  forceSendError: ForcedSendError | null;
  /** D1-FE3: fail thread list pages without affecting the main feed. */
  forceThreadError: ForcedSendError | null;
  sendDelayMs: number;
  sendAttempts: Array<{ idempotencyKey: string; clientMessageId: string; bodyHash: string }>;
  /** Last validated request bodies, for E5 send-shape assertions. */
  sendBodies: Array<Record<string, unknown>>;
  /* #61–#63 message actions: observed requests + injectable failures. */
  reactionRequests: Array<{
    chatId: string;
    messageId: string;
    emoji: string;
    action: 'ADD' | 'REMOVE';
    deviceId: string | null;
  }>;
  editRequests: Array<{
    chatId: string;
    messageId: string;
    body: Record<string, unknown>;
    deviceId: string | null;
  }>;
  deleteRequests: Array<{
    chatId: string;
    messageId: string;
    scope: 'me' | 'all';
    deviceId: string | null;
  }>;
  forceReactionError: ForcedSendError | null;
  forceEditError: ForcedSendError | null;
  forceDeleteError: ForcedSendError | null;
  serverTime: () => string;

  /* E4-F managed files */
  limits: WorkspaceLimits;
  uploads: Map<string, MockUpload>;
  attachments: Map<string, MockAttachment>;
  preflightRequests: MockPreflightRecord[];
  uploadInits: MockUploadInitRecord[];
  uploadIdempotency: Map<string, MockUploadInitRecord>;
  partUploads: MockPartUploadRecord[];
  completeRequests: MockUploadCompleteRecord[];
  aborts: Array<{ uploadId: string; idempotencyKey: string }>;
  downloadRequests: MockDownloadRecord[];
  /** Scan polls before SCANNING becomes READY/QUARANTINED. */
  scanPolls: number;
  forceScanStatus: 'CLEAN' | 'INFECTED' | null;
  fileDelayMs: number;
  partDelayMs: number;
  failNextPart: number;
  failNextComplete: number;
  forcePreflightError: ForcedFileError | null;
  forceInitError: ForcedFileError | null;
  forcePartError: ForcedFileError | null;
  forceCompleteError: ForcedFileError | null;
  forceDownloadError: ForcedFileError | null;

  /* #97 server audio artwork (`GET /attachments/{id}/artwork`) */
  /** Extracted raster cover bytes, keyed by attachment id. */
  attachmentArtworks: Map<string, { mime: string; bytes: Uint8Array }>;
  /** Every cover request, so suites can assert the bearer token was sent. */
  artworkRequests: Array<{ attachmentId: string; authorized: boolean }>;
  forceArtworkError: ForcedFileError | null;

  /* #73 file-center (`GET /files`) */
  fileCenterItems: FileItem[];
  fileCenterRequests: Array<Record<string, string | null>>;
  fileCenterDelayMs: number;
  forceFileCenterError: ForcedSendError | null;

  /* #83 global files: upload/rename/delete request log + injectable failures */
  fileUploadRequests: Array<{ workspaceId: string; filename: string; size: number; mime: string }>;
  fileRenameRequests: Array<{ fileId: string; name: string; idempotencyKey: string }>;
  fileDeleteRequests: Array<{ fileId: string; idempotencyKey: string }>;
  /** Ids already soft-deleted so a repeat DELETE is idempotent (204). */
  deletedFileIds: Set<string>;
  forceWorkspaceUploadError: ForcedSendError | null;
  forceFileRenameError: ForcedSendError | null;
  forceFileDeleteError: ForcedSendError | null;

  /* #83 server search (`GET /workspaces/{id}/search/messages`) */
  searchRequests: Array<Record<string, string | null>>;
  searchDelayMs: number;
  forceSearchError: ForcedSendError | null;

  /* #83 mention inbox (`GET /me/mentions`, `POST /me/mentions/read`) */
  mentions: Mention[];
  mentionListRequests: Array<Record<string, string | null>>;
  mentionReadRequests: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string | null;
  }>;
  forceMentionListError: ForcedSendError | null;
  forceMentionReadError: ForcedSendError | null;

  /* P0-4 (#82): own avatar, TOTP authenticator, workspace settings/invites */
  profileAvatarFileId: string | null;
  avatarRequests: Array<{ action: 'SET' | 'DELETE' | 'GET'; fileId: string | null }>;
  twoFactor: MockTwoFactorRecord;
  twoFactorRequests: Array<{
    action:
      | 'STATUS'
      | 'SETUP'
      | 'VERIFY'
      | 'DISABLE'
      | 'RECOVERY'
      | 'CHALLENGE'
      | 'ENROLL_START'
      | 'ENROLL_VERIFY';
    password: string | null;
    code: string | null;
    deviceId: string | null;
  }>;
  /** #93: images uploaded through `POST /media/images` (no object keys). */
  mediaImages: Map<string, MockMediaImageRecord>;
  mediaImageDelayMs: number;
  mediaImageUploadRequests: Array<{
    filename: string;
    mime: string;
    size: number;
    chatId: string | null;
    deviceId: string | null;
  }>;
  forceMediaImageError: ForcedSendError | null;
  twoFactorChallenge: MockTwoFactorChallengeRecord | null;
  twoFactorLoginRequests: Array<{ challengeId: string; code: string }>;
  workspaceAvatarRequests: Array<{
    workspaceId: string;
    action: 'SET' | 'DELETE';
    fileId: string | null;
  }>;
  workspaceSettingsRequests: Array<{
    workspaceId: string;
    body: Record<string, unknown>;
    deviceId: string | null;
  }>;
  workspaceInvites: MockWorkspaceInviteRecord[];
  workspaceInviteRequests: Array<{
    workspaceId: string;
    action: 'LIST' | 'CREATE' | 'REVOKE' | 'ACCEPT';
    role?: string;
    inviteId?: string;
  }>;
  workspacePermissions: Record<string, WorkspacePermissionMatrix>;
  workspacePermissionRequests: Array<{
    workspaceId: string;
    body: Record<string, unknown> | null;
    deviceId: string | null;
  }>;
  forceAvatarError: ForcedSendError | null;
  forceTwoFactorError: ForcedSendError | null;
  forceWorkspaceSettingsError: ForcedSendError | null;
  forceWorkspaceInviteError: ForcedSendError | null;
  forceWorkspacePermissionError: ForcedSendError | null;

  /* #72 profile edit + Keycloak sessions */
  profileUpdateRequests: Array<{ body: Record<string, unknown>; deviceId: string | null }>;
  forceProfileUpdateError: ForcedSendError | null;
  profileSessions: ProfileSession[];
  profileSessionListRequests: number;
  profileSessionRevokeRequests: string[];
  forceProfileSessionsError: ForcedSendError | null;
  forceSessionRevokeError: ForcedSendError | null;

  /* E5-F built-in stickers */
  stickerPacks: StickerPack[];
  stickerFavorites: Set<string>;
  disabledStickerPacks: Set<string>;
  stickerFavoriteRequests: Array<{ stickerId: string; action: 'PUT' | 'DELETE' }>;
  stickerPacksDelayMs: number;
  forceStickerPacksError: ForcedSendError | null;

  /* E6-F notifications */
  notifications: MockNotificationRecord[];
  notificationPreferences: NotificationPreference[];
  notificationReadRequests: MockNotificationReadRecord[];
  notificationPreferencePatches: MockNotificationPreferencePatchRecord[];
  notificationPreferenceIdempotency: Map<string, MockNotificationPreferenceReplay>;
  notificationListRequests: Array<{ cursor: string | null; limit: number }>;
  notificationsDelayMs: number;

  /* E8/R-03..R-04: setup + platform admin */
  admin: MockAdminState;
  adminSettingsPatches: MockAdminSettingsPatchRecord[];
  adminTestEmails: string[];
  forceTestEmailError: ForcedSendError | null;
  /** E9-F admin directory (users/chats/storage) mock knobs. */
  adminDirectory: MockAdminDirectoryState;
  /** #84 workspace dashboard read model. */
  workspaceOverview: MockWorkspaceOverviewState;
  /** #84 platform-admin Keycloak sessions. */
  adminSessions: MockAdminSessionsState;
  /** #84 installation translation-provider settings. */
  translationAdmin: MockTranslationAdminState;
  /** P0-3 (#81) workspace DLP/audit/sessions/settings mock state. */
  security: MockSecurityState;

  /* Auth BFF (docs/TASKS-AUTH-BFF.md) */
  authUsers: MockAuthUserRecord[];
  authVerifications: Map<string, MockEmailVerification>;
  authAccessTokens: Map<string, MockAuthTokenRecord>;
  authRefreshTokens: Map<string, MockAuthTokenRecord>;
  authRegisterRequests: AuthRegisterRequest[];
  authLoginRequests: AuthLoginRequest[];
  authVerifyRequests: AuthVerifyEmailRequest[];
  authResendRequests: string[];
  authRefreshRequests: string[];
  authLogoutRequests: string[];

  failNextNotifications: number;
  failNextNotificationRead: number;
  failNextNotificationPrefs: number;
  forceNotificationsError: ForcedSendError | null;
  forceNotificationReadError: ForcedSendError | null;
  forceNotificationPrefsError: ForcedSendError | null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildChats(): Record<string, ChatRecord> {
  const summaries = buildChatSummaries();
  const group = summaries.find((summary) => summary.id === IDS.groupChat);
  const direct = summaries.find((summary) => summary.id === IDS.directChat);
  if (!group || !direct) throw new Error('Mock fixtures are broken');

  return {
    [IDS.groupChat]: {
      summary: clone(group),
      workspaceId: IDS.workspace,
      memberIds: [],
      messages: buildGroupMessages(),
      clientMessageIds: new Map(),
      hiddenMessageIds: new Set(),
    },
    [IDS.directChat]: {
      summary: clone(direct),
      workspaceId: IDS.workspace,
      memberIds: [],
      messages: buildDirectMessages(),
      clientMessageIds: new Map(),
      hiddenMessageIds: new Set(),
    },
  };
}

export function createMockLimits(): WorkspaceLimits {
  const storage = 1024 ** 4;
  return {
    tariff: 'TEAM',
    max_file_bytes: 2 * 1024 ** 3,
    storage_bytes: storage,
    max_attachments: 10,
    guest_file_bytes: 500 * 1024 ** 2,
    usage: { used: 0, reserved: 0, limit: storage },
    max_chats_per_user: 100,
    chats_used: 0,
  };
}

/** D1.1 (#69) seed mirrors V34: five first-party MANAGED plugins, fixed order. */
export function createMockPluginCatalog(): Plugin[] {
  return [
    {
      id: 'polls',
      kind: 'BUILTIN',
      name: 'Опросы',
      description: 'Голосования и быстрые решения прямо в переписке.',
      icon: 'poll',
      permissions: ['MESSAGES', 'MEMBERS'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
    {
      id: 'tasks',
      kind: 'BUILTIN',
      name: 'Задачи',
      description: 'Чек-листы, дедлайны и напоминания в чате.',
      icon: 'task',
      permissions: ['MESSAGES'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
    {
      id: 'translate',
      kind: 'BUILTIN',
      name: 'Перевод',
      description: 'Перевод входящих сообщений на лету.',
      icon: 'translate',
      permissions: ['MESSAGES'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
    {
      id: 'telegram',
      kind: 'BUILTIN',
      name: 'Мост в Telegram',
      description: 'Двусторонний мост для внешних команд и подрядчиков.',
      icon: 'plug',
      permissions: ['MESSAGES', 'MEMBERS', 'WEBHOOKS'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
    {
      id: 'dlp',
      kind: 'BUILTIN',
      name: 'DLP-подсказки',
      description: 'Предупреждает об отправке чувствительных данных.',
      icon: 'shield',
      permissions: ['MESSAGES', 'FILES'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
    {
      id: 'music-room',
      kind: 'BUILTIN',
      name: 'Музыкальная комната',
      description: 'Совместное прослушивание музыки: аудиофайлы канала и общий плеер.',
      icon: 'music',
      permissions: ['FILES', 'MESSAGES'],
      modes: ['MANAGED'],
      state: 'ACTIVE',
    },
  ];
}

/**
 * #94 seeded AUDIO attachments of the group channel. The mock does not model
 * real bytes: the track list is metadata-only, exactly like the server response.
 */
export function buildMusicRoomTracks(): Map<string, MusicRoomTrack[]> {
  return new Map([
    [
      IDS.groupChat,
      [
        {
          id: 'c1000000-0000-4000-8000-000000000001',
          message_id: 'd1000000-0000-4000-8000-000000000001',
          filename: 'sova-night.mp3',
          mime_type: 'audio/mpeg',
          duration_ms: 214_000,
          artwork_url: null,
          title: 'Ночная сова',
          artist: 'Сова',
          size_bytes: 5_242_880,
          created_at: '2026-11-19T21:10:00.000Z',
        },
        {
          id: 'c1000000-0000-4000-8000-000000000002',
          message_id: 'd1000000-0000-4000-8000-000000000002',
          filename: 'forest-walk.flac',
          mime_type: 'audio/flac',
          duration_ms: 187_500,
          artwork_url: 'https://cdn.example.test/art/forest.jpg',
          title: 'Прогулка по лесу',
          artist: 'Анна Петрова',
          size_bytes: 31_457_280,
          created_at: '2026-11-18T09:30:00.000Z',
        },
      ],
    ],
  ]);
}

/** D1.2 (#86): project an installed package into the public catalog shape. */
export function externalCatalogPlugin(pkg: AdminPluginPackage): Plugin {
  return {
    id: pkg.id,
    kind: 'EXTERNAL',
    name: pkg.name,
    description: pkg.description,
    icon: 'plug',
    permissions: pkg.permissions,
    modes: pkg.modes,
    state: 'ACTIVE',
    version: pkg.version,
    author: pkg.author,
    entry_url: `/api/v1/plugins/${pkg.id}/assets/${pkg.entry}`,
  };
}

/** Built-in catalog followed by installed external packages (server order). */
export function allCatalogPlugins(db: MockDb): Plugin[] {
  return [...db.pluginCatalog, ...db.pluginPackages.map(externalCatalogPlugin)];
}

const MOCK_ASSET_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  json: 'application/json; charset=utf-8',
};

function mockAssetContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MOCK_ASSET_TYPES[extension] ?? 'application/octet-stream';
}

export interface MockPluginPackageSeed {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  entry?: string;
  permissions?: AdminPluginPackage['permissions'];
  modes?: AdminPluginPackage['modes'];
  installed_at?: string;
  assets?: Record<string, string | Uint8Array>;
}

/**
 * Seed one installed external package (used by UI tests before GET /plugins).
 * Mirrors the catalog row and the exact-match asset store of the backend.
 */
export function seedMockPluginPackage(
  db: MockDb,
  seed: MockPluginPackageSeed = {},
): AdminPluginPackage {
  const entry = seed.entry ?? 'index.html';
  const id = seed.id ?? 'hello-panel';
  const assets: Record<string, string | Uint8Array> = {
    [entry]:
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/app.css"></head><body><h1>Hello panel</h1><img src="assets/logo.svg" alt="Sova"><script src="assets/app.js"></script></body></html>',
    'assets/app.js': 'window.addEventListener("message", () => {});',
    'assets/app.css': 'body { font: 14px system-ui; }',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    ...seed.assets,
  };
  const pkg: AdminPluginPackage = {
    id,
    name: seed.name ?? 'Hello panel',
    version: seed.version ?? '1.0.0',
    description: seed.description ?? 'Пример статической панели',
    author: seed.author ?? 'Sova',
    entry,
    permissions: seed.permissions ?? ['chat.messages.read'],
    modes: seed.modes ?? ['MANAGED'],
    size_bytes: 2048,
    file_count: Object.keys(assets).length,
    sha256: 'a'.repeat(64),
    installed_at: seed.installed_at ?? '2026-11-20T10:00:00.000Z',
  };
  const encoder = new TextEncoder();
  const map = new Map<string, MockPluginAssetRecord>();
  for (const [path, body] of Object.entries(assets)) {
    map.set(path, {
      contentType: mockAssetContentType(path),
      body: typeof body === 'string' ? encoder.encode(body) : body,
    });
  }
  db.pluginPackages = [...db.pluginPackages.filter((item) => item.id !== id), pkg];
  db.pluginPackageAssets.set(id, map);
  return pkg;
}

export function createMockAdminState(): MockAdminState {
  const now = new Date().toISOString();
  return {
    // Existing suites expect a ready installation; setup-specific tests (and
    // E2E init scripts) flip this to null before boot.
    setupCompletedAt: now,
    smtpHost: null,
    smtpPort: null,
    smtpUsername: null,
    smtpPasswordStored: false,
    smtpFrom: null,
    smtpStarttls: true,
    maxChatsPerUser: 100,
    maxChatsPerWorkspace: 1000,
    maxWorkspaceMembers: 100,
    allowedFileExtensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'gif',
      'mp3',
      'm4a',
      'wav',
      'mp4',
      'webm',
      'txt',
      'csv',
      'json',
      'zip',
    ],
    registrationOpen: true,
    require2fa: false,
    updatedAt: now,
    updatedBy: null,
  };
}

/** P0-4 (#82): effective workspace permission defaults (OWNER/ADMIN all true). */
export function createDefaultWorkspacePermissions(
  workspaceId: string = IDS.workspace,
): WorkspacePermissionMatrix {
  return {
    workspace_id: workspaceId,
    roles: [
      {
        role: 'OWNER',
        manage_workspace: true,
        manage_members: true,
        manage_invites: true,
        manage_permissions: true,
        view_audit: true,
        manage_security: true,
      },
      {
        role: 'ADMIN',
        manage_workspace: true,
        manage_members: true,
        manage_invites: true,
        manage_permissions: true,
        view_audit: true,
        manage_security: true,
      },
      {
        role: 'MEMBER',
        manage_workspace: false,
        manage_members: false,
        manage_invites: false,
        manage_permissions: false,
        view_audit: false,
        manage_security: false,
      },
    ],
  };
}

/** P0-4 (#82): fresh authenticator state (disabled, no pending secret). */
export function createMockTwoFactor(): MockTwoFactorRecord {
  return {
    enabled: false,
    enabledAt: null,
    secret: null,
    pendingSecret: null,
    recoveryCodes: new Map(),
    lastStep: null,
  };
}

/** #72: two Keycloak sessions; the second is the current browser. */
export function createMockProfileSessions(): ProfileSession[] {
  return [
    {
      id: '90000000-0000-4000-8000-000000000001',
      name: 'krug-web · Safari',
      created_at: '2026-11-01T09:12:00.000Z',
      last_access_at: '2026-11-19T12:40:00.000Z',
      current: false,
    },
    {
      id: '90000000-0000-4000-8000-000000000002',
      name: 'krug-web · Chrome',
      created_at: '2026-11-18T18:05:00.000Z',
      last_access_at: '2026-11-19T14:55:00.000Z',
      current: true,
    },
  ];
}

function buildMockInviteTokens(): Map<string, { chatId: string; inviteId: string }> {
  return new Map([
    [MOCK_INVITE_TOKENS.active, { chatId: IDS.groupChat, inviteId: IDS.inviteActive }],
    [MOCK_INVITE_TOKENS.exhausted, { chatId: IDS.groupChat, inviteId: IDS.inviteExhausted }],
    [MOCK_INVITE_TOKENS.expired, { chatId: IDS.groupChat, inviteId: IDS.inviteExpired }],
    [MOCK_INVITE_TOKENS.revoked, { chatId: IDS.groupChat, inviteId: IDS.inviteRevoked }],
  ]);
}

function buildSeedPolls(): Map<string, MockPollRecord> {
  const poll = buildSeedPoll();
  return new Map([[poll.id, { chatId: IDS.groupChat, poll, votes: buildSeedPollVotes() }]]);
}

function buildSeedTasks(): Map<string, MockTaskRecord> {
  const task = buildSeedTask();
  return new Map([[task.id, { chatId: IDS.groupChat, task }]]);
}

export function createMockDb(): MockDb {
  return {
    session: clone(mockSession),
    me: buildMockMe(),
    devices: [],
    deviceRequests: new Map(),
    workspaceRequests: new Map(),
    chatRequests: new Map(),
    chatCreateRequests: [],
    forceChatCreateError: null,
    workspaceMembers: buildWorkspaceMembers(),
    membersDelayMs: 0,
    memberDirectoryRequests: [],
    memberUsers: buildMemberUsers(),
    memberAddRequests: [],
    memberRoleRequests: [],
    memberRemoveRequests: [],
    forceMemberAddError: null,
    forceMemberRoleError: null,
    forceMemberRemoveError: null,
    chatMembers: buildChatMembers(),
    chatMemberRequests: [],
    chatMemberDelayMs: 0,
    forceChatMemberListError: null,
    forceChatMemberAddError: null,
    forceChatMemberRoleError: null,
    forceChatMemberRemoveError: null,
    forceChatMemberLeaveError: null,
    chatInvites: buildChatInvites(),
    chatInviteTokens: buildMockInviteTokens(),
    chatInviteRequests: [],
    inviteAcceptRequests: [],
    forceChatInviteListError: null,
    forceChatInviteCreateError: null,
    forceChatInviteRevokeError: null,
    forceInviteAcceptError: null,
    blockedUsers: [],
    blockRequests: [],
    forceBlockedListError: null,
    forceBlockError: null,
    chatSettingsRequests: [],
    chatSettingsDelayMs: 0,
    forceChatSettingsError: null,
    chatPermissions: buildChatPermissions(),
    chatPermissionsRequests: [],
    chatCoverRequests: [],
    chatAvatarRequests: [],
    chatPins: buildChatPins(),
    chatPinRequests: [],
    bots: buildMockBots(),
    chatBots: [],
    botRequests: [],
    botDelayMs: 0,
    botSendIdempotency: new Map(),
    forceBotListError: null,
    forceBotCreateError: null,
    forceBotUpdateError: null,
    forceBotDisableError: null,
    forceBotRotateError: null,
    forceChatBotListError: null,
    forceChatBotInstallError: null,
    forceChatBotUninstallError: null,
    forceBotSendError: null,
    chatArchiveRequests: [],
    chatDeleteRequests: [],
    forceChatCoverError: null,
    forceChatAvatarError: null,
    forceChatPermissionsError: null,
    forceChatPermissionsUpdateError: null,
    forceChatPinsError: null,
    forceChatPinError: null,
    forceChatArchiveError: null,
    forceChatDeleteError: null,
    pluginCatalog: createMockPluginCatalog(),
    pluginCatalogRequests: 0,
    pluginCatalogDelayMs: 0,
    forcePluginCatalogError: null,
    chatPlugins: new Map(),
    chatPluginListRequests: [],
    chatPluginRequests: [],
    chatPluginAudit: [],
    chatPluginsDelayMs: 0,
    chatPluginPatchDelayMs: 0,
    forceChatPluginsError: null,
    forceChatPluginPatchError: null,
    musicRoomChats: new Map(),
    musicRoomTracks: buildMusicRoomTracks(),
    musicRoomOpenRequests: [],
    musicRoomTrackRequests: [],
    musicRoomDelayMs: 0,
    forceMusicRoomOpenError: null,
    forceMusicRoomTracksError: null,
    pluginPackages: [],
    pluginPackageAssets: new Map(),
    adminPluginListRequests: 0,
    pluginPackageInstallRequests: [],
    pluginPackageUninstallRequests: [],
    pluginPackageInstallDelayMs: 0,
    forceAdminPluginPackagesError: null,
    forceInstallPluginPackageError: null,
    forceUninstallPluginPackageError: null,
    polls: buildSeedPolls(),
    tasks: buildSeedTasks(),
    pollRequests: [],
    taskRequests: [],
    translationRequests: [],
    // The mock stands in for a configured provider; tests can force the
    // contract's default 503 with `translationAvailable = false`.
    translationAvailable: true,
    forcePollListError: null,
    forcePollCreateError: null,
    forcePollMutationError: null,
    forceTaskListError: null,
    forceTaskCreateError: null,
    forceTaskUpdateError: null,
    forceTranslationError: null,
    chats: buildChats(),
    idempotency: new Map(),
    readReceipts: {},
    realtimeTickets: new Map(),
    failNextSend: 0,
    forceSendError: null,
    forceThreadError: null,
    sendDelayMs: 0,
    sendAttempts: [],
    sendBodies: [],
    reactionRequests: [],
    editRequests: [],
    deleteRequests: [],
    forceReactionError: null,
    forceEditError: null,
    forceDeleteError: null,
    serverTime: () => new Date().toISOString(),

    limits: createMockLimits(),
    uploads: new Map(),
    attachments: new Map(),
    preflightRequests: [],
    uploadInits: [],
    uploadIdempotency: new Map(),
    partUploads: [],
    completeRequests: [],
    aborts: [],
    downloadRequests: [],
    scanPolls: 1,
    forceScanStatus: null,
    fileDelayMs: 0,
    partDelayMs: 0,
    failNextPart: 0,
    failNextComplete: 0,
    forcePreflightError: null,
    forceInitError: null,
    forcePartError: null,
    forceCompleteError: null,
    forceDownloadError: null,

    attachmentArtworks: new Map(),
    artworkRequests: [],
    forceArtworkError: null,

    fileCenterItems: [],
    fileCenterRequests: [],
    fileCenterDelayMs: 0,
    forceFileCenterError: null,
    fileUploadRequests: [],
    fileRenameRequests: [],
    fileDeleteRequests: [],
    deletedFileIds: new Set(),
    forceWorkspaceUploadError: null,
    forceFileRenameError: null,
    forceFileDeleteError: null,
    searchRequests: [],
    searchDelayMs: 0,
    forceSearchError: null,
    mentions: buildMentions(),
    mentionListRequests: [],
    mentionReadRequests: [],
    forceMentionListError: null,
    forceMentionReadError: null,

    profileAvatarFileId: null,
    avatarRequests: [],
    twoFactor: createMockTwoFactor(),
    twoFactorRequests: [],
    twoFactorChallenge: null,
    twoFactorLoginRequests: [],
    mediaImages: new Map(),
    mediaImageDelayMs: 0,
    mediaImageUploadRequests: [],
    forceMediaImageError: null,
    workspaceAvatarRequests: [],
    workspaceSettingsRequests: [],
    workspaceInvites: [],
    workspaceInviteRequests: [],
    workspacePermissions: { [IDS.workspace]: createDefaultWorkspacePermissions() },
    workspacePermissionRequests: [],
    forceAvatarError: null,
    forceTwoFactorError: null,
    forceWorkspaceSettingsError: null,
    forceWorkspaceInviteError: null,
    forceWorkspacePermissionError: null,

    profileUpdateRequests: [],
    forceProfileUpdateError: null,
    profileSessions: createMockProfileSessions(),
    profileSessionListRequests: 0,
    profileSessionRevokeRequests: [],
    forceProfileSessionsError: null,
    forceSessionRevokeError: null,

    stickerPacks: buildStickerPacks(),
    stickerFavorites: new Set(),
    disabledStickerPacks: new Set(),
    stickerFavoriteRequests: [],
    stickerPacksDelayMs: 0,
    forceStickerPacksError: null,

    notifications: buildNotifications().map((notification) => ({
      ...notification,
      user_id: IDS.user,
    })),
    notificationPreferences: buildNotificationPreferences(),
    notificationReadRequests: [],
    notificationPreferencePatches: [],
    notificationPreferenceIdempotency: new Map(),
    notificationListRequests: [],
    notificationsDelayMs: 0,
    failNextNotifications: 0,
    failNextNotificationRead: 0,
    failNextNotificationPrefs: 0,
    forceNotificationsError: null,
    forceNotificationReadError: null,
    forceNotificationPrefsError: null,

    admin: createMockAdminState(),
    adminSettingsPatches: [],
    adminTestEmails: [],
    forceTestEmailError: null,
    adminDirectory: createMockAdminDirectoryState(),
    workspaceOverview: createMockWorkspaceOverviewState(),
    adminSessions: createMockAdminSessionsState(),
    translationAdmin: createMockTranslationAdminState(),
    security: createMockSecurityState(),

    authUsers: [
      {
        id: IDS.user,
        email: MOCK_DEMO_EMAIL,
        displayName: MOCK_DISPLAY_NAME,
        password: MOCK_DEMO_PASSWORD,
        verified: true,
        // FR-ADM-1: the first user of the installation is the platform admin.
        isPlatformAdmin: true,
      },
    ],
    authVerifications: new Map(),
    authAccessTokens: new Map(),
    authRefreshTokens: new Map(),
    authRegisterRequests: [],
    authLoginRequests: [],
    authVerifyRequests: [],
    authResendRequests: [],
    authRefreshRequests: [],
    authLogoutRequests: [],
  };
}

/** Mutates in place so handler closures keep pointing at the same db object. */
export function resetMockDb(db: MockDb): void {
  const fresh = createMockDb();
  db.session = fresh.session;
  db.me = fresh.me;
  db.devices = fresh.devices;
  db.deviceRequests.clear();
  db.workspaceRequests.clear();
  db.chatRequests.clear();
  db.chatCreateRequests = [];
  db.forceChatCreateError = null;
  db.workspaceMembers = fresh.workspaceMembers;
  db.membersDelayMs = 0;
  db.memberDirectoryRequests = [];
  db.memberUsers = fresh.memberUsers;
  db.memberAddRequests = [];
  db.memberRoleRequests = [];
  db.memberRemoveRequests = [];
  db.forceMemberAddError = null;
  db.forceMemberRoleError = null;
  db.forceMemberRemoveError = null;
  db.chatMembers = fresh.chatMembers;
  db.chatMemberRequests = [];
  db.chatMemberDelayMs = 0;
  db.forceChatMemberListError = null;
  db.forceChatMemberAddError = null;
  db.forceChatMemberRoleError = null;
  db.forceChatMemberRemoveError = null;
  db.forceChatMemberLeaveError = null;
  db.chatInvites = fresh.chatInvites;
  db.chatInviteTokens = fresh.chatInviteTokens;
  db.chatInviteRequests = [];
  db.inviteAcceptRequests = [];
  db.forceChatInviteListError = null;
  db.forceChatInviteCreateError = null;
  db.forceChatInviteRevokeError = null;
  db.forceInviteAcceptError = null;
  db.blockedUsers = fresh.blockedUsers;
  db.blockRequests = [];
  db.forceBlockedListError = null;
  db.forceBlockError = null;
  db.chatSettingsRequests = [];
  db.chatSettingsDelayMs = 0;
  db.forceChatSettingsError = null;
  db.chatPermissions = fresh.chatPermissions;
  db.chatPermissionsRequests = [];
  db.chatCoverRequests = [];
  db.chatAvatarRequests = [];
  db.chatPins = fresh.chatPins;
  db.chatPinRequests = [];
  db.bots = fresh.bots;
  db.chatBots = fresh.chatBots;
  db.botRequests = [];
  db.botDelayMs = 0;
  db.botSendIdempotency.clear();
  db.forceBotListError = null;
  db.forceBotCreateError = null;
  db.forceBotUpdateError = null;
  db.forceBotDisableError = null;
  db.forceBotRotateError = null;
  db.forceChatBotListError = null;
  db.forceChatBotInstallError = null;
  db.forceChatBotUninstallError = null;
  db.forceBotSendError = null;
  db.chatArchiveRequests = [];
  db.chatDeleteRequests = [];
  db.forceChatCoverError = null;
  db.forceChatAvatarError = null;
  db.forceChatPermissionsError = null;
  db.forceChatPermissionsUpdateError = null;
  db.forceChatPinsError = null;
  db.forceChatPinError = null;
  db.forceChatArchiveError = null;
  db.forceChatDeleteError = null;
  db.pluginCatalog = fresh.pluginCatalog;
  db.pluginCatalogRequests = 0;
  db.pluginCatalogDelayMs = 0;
  db.forcePluginCatalogError = null;
  db.chatPlugins.clear();
  db.chatPluginListRequests = [];
  db.chatPluginRequests = [];
  db.chatPluginAudit = [];
  db.chatPluginsDelayMs = 0;
  db.chatPluginPatchDelayMs = 0;
  db.forceChatPluginsError = null;
  db.forceChatPluginPatchError = null;
  db.musicRoomChats = fresh.musicRoomChats;
  db.musicRoomTracks = fresh.musicRoomTracks;
  db.musicRoomOpenRequests = [];
  db.musicRoomTrackRequests = [];
  db.musicRoomDelayMs = 0;
  db.forceMusicRoomOpenError = null;
  db.forceMusicRoomTracksError = null;
  db.pluginPackages = fresh.pluginPackages;
  db.pluginPackageAssets.clear();
  db.adminPluginListRequests = 0;
  db.pluginPackageInstallRequests = [];
  db.pluginPackageUninstallRequests = [];
  db.pluginPackageInstallDelayMs = 0;
  db.forceAdminPluginPackagesError = null;
  db.forceInstallPluginPackageError = null;
  db.forceUninstallPluginPackageError = null;
  db.polls = fresh.polls;
  db.tasks = fresh.tasks;
  db.pollRequests = [];
  db.taskRequests = [];
  db.translationRequests = [];
  db.translationAvailable = true;
  db.forcePollListError = null;
  db.forcePollCreateError = null;
  db.forcePollMutationError = null;
  db.forceTaskListError = null;
  db.forceTaskCreateError = null;
  db.forceTaskUpdateError = null;
  db.forceTranslationError = null;
  db.chats = fresh.chats;
  db.idempotency.clear();
  db.readReceipts = {};
  db.realtimeTickets.clear();
  db.failNextSend = 0;
  db.forceSendError = null;
  db.forceThreadError = null;
  db.sendDelayMs = 0;
  db.sendAttempts = [];
  db.sendBodies = [];
  db.reactionRequests = [];
  db.editRequests = [];
  db.deleteRequests = [];
  db.forceReactionError = null;
  db.forceEditError = null;
  db.forceDeleteError = null;

  db.limits = fresh.limits;
  db.uploads = fresh.uploads;
  db.attachments = fresh.attachments;
  db.preflightRequests = [];
  db.uploadInits = [];
  db.uploadIdempotency.clear();
  db.partUploads = [];
  db.completeRequests = [];
  db.aborts = [];
  db.downloadRequests = [];
  db.scanPolls = 1;
  db.forceScanStatus = null;
  db.fileDelayMs = 0;
  db.partDelayMs = 0;
  db.failNextPart = 0;
  db.failNextComplete = 0;
  db.forcePreflightError = null;
  db.forceInitError = null;
  db.forcePartError = null;
  db.forceCompleteError = null;
  db.forceDownloadError = null;

  db.attachmentArtworks.clear();
  db.artworkRequests = [];
  db.forceArtworkError = null;

  db.fileCenterItems = [];
  db.fileCenterRequests = [];
  db.fileCenterDelayMs = 0;
  db.forceFileCenterError = null;
  db.fileUploadRequests = [];
  db.fileRenameRequests = [];
  db.fileDeleteRequests = [];
  db.deletedFileIds = new Set();
  db.forceWorkspaceUploadError = null;
  db.forceFileRenameError = null;
  db.forceFileDeleteError = null;
  db.searchRequests = [];
  db.searchDelayMs = 0;
  db.forceSearchError = null;
  db.mentions = fresh.mentions;
  db.mentionListRequests = [];
  db.mentionReadRequests = [];
  db.forceMentionListError = null;
  db.forceMentionReadError = null;

  db.profileAvatarFileId = null;
  db.avatarRequests = [];
  db.twoFactor = createMockTwoFactor();
  db.twoFactorRequests = [];
  db.twoFactorChallenge = null;
  db.twoFactorLoginRequests = [];
  db.mediaImages.clear();
  db.mediaImageDelayMs = 0;
  db.mediaImageUploadRequests = [];
  db.forceMediaImageError = null;
  db.workspaceAvatarRequests = [];
  db.workspaceSettingsRequests = [];
  db.workspaceInvites = [];
  db.workspaceInviteRequests = [];
  db.workspacePermissions = { [IDS.workspace]: createDefaultWorkspacePermissions() };
  db.workspacePermissionRequests = [];
  db.forceAvatarError = null;
  db.forceTwoFactorError = null;
  db.forceWorkspaceSettingsError = null;
  db.forceWorkspaceInviteError = null;
  db.forceWorkspacePermissionError = null;
  db.me = { ...db.me, user: { ...db.me.user, avatar_url: null } };

  db.profileUpdateRequests = [];
  db.forceProfileUpdateError = null;
  db.profileSessions = fresh.profileSessions;
  db.profileSessionListRequests = 0;
  db.profileSessionRevokeRequests = [];
  db.forceProfileSessionsError = null;
  db.forceSessionRevokeError = null;

  db.stickerPacks = fresh.stickerPacks;
  db.stickerFavorites.clear();
  db.disabledStickerPacks.clear();
  db.stickerFavoriteRequests = [];
  db.stickerPacksDelayMs = 0;
  db.forceStickerPacksError = null;

  db.notifications = fresh.notifications;
  db.notificationPreferences = fresh.notificationPreferences;
  db.notificationReadRequests = [];
  db.notificationPreferencePatches = [];
  db.notificationPreferenceIdempotency.clear();
  db.notificationListRequests = [];
  db.notificationsDelayMs = 0;
  db.failNextNotifications = 0;
  db.failNextNotificationRead = 0;
  db.failNextNotificationPrefs = 0;
  db.forceNotificationsError = null;
  db.forceNotificationReadError = null;
  db.forceNotificationPrefsError = null;

  db.admin = fresh.admin;
  db.adminSettingsPatches = [];
  db.adminTestEmails = [];
  db.forceTestEmailError = null;
  db.adminDirectory = fresh.adminDirectory;
  db.workspaceOverview = fresh.workspaceOverview;
  db.adminSessions = fresh.adminSessions;
  db.translationAdmin = fresh.translationAdmin;
  db.security = fresh.security;

  db.authUsers = fresh.authUsers;
  db.authVerifications.clear();
  db.authAccessTokens.clear();
  db.authRefreshTokens.clear();
  db.authRegisterRequests = [];
  db.authLoginRequests = [];
  db.authVerifyRequests = [];
  db.authResendRequests = [];
  db.authRefreshRequests = [];
  db.authLogoutRequests = [];
}

/**
 * Simulates another participant posting a message (used by reconnect/sync
 * tests and by the dev debug controls). Returns the created message.
 */
export function insertMockMessage(
  db: MockDb,
  chatId: string,
  text: string,
  sender: { id: string; name: string } = {
    id: '99999999-9999-4999-8999-999999999999',
    name: 'Марк Соколов',
  },
): ApiMessage {
  const chat = db.chats[chatId];
  if (!chat) throw new Error(`Unknown mock chat: ${chatId}`);

  const seq = chat.summary.last_seq + 1;
  const created = new Date().toISOString();
  const message: ApiMessage = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: chatId,
    seq,
    type: 'TEXT',
    sender_type: 'USER',
    sender_id: sender.id,
    sender_display_name: sender.name,
    text,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
  };

  chat.messages.push(message);
  chat.summary.last_seq = seq;
  chat.summary.last_message_at = created;

  // E6 fan-out smoke: a message from someone else produces a notification for
  // the current user. Body stays null (E6-D-02), exactly like the contract.
  if (sender.id !== db.me.user.id) {
    insertMockNotification(db, {
      type: 'MESSAGE',
      chat_id: chatId,
      chat_name: chat.summary.name,
      title: 'Новое сообщение',
      body: null,
      created_at: created,
    });
  }
  return message;
}

/**
 * #96: bot-authored message. Mirrors the backend shape: `sender_type=BOT`,
 * `bot_id` set and both `sender_id`/sender device null (no impersonation).
 */
export function insertMockBotMessage(
  db: MockDb,
  chatId: string,
  bot: { id: string; name: string },
  text: string,
): ApiMessage {
  const chat = db.chats[chatId];
  if (!chat) throw new Error(`Unknown mock chat: ${chatId}`);

  const seq = chat.summary.last_seq + 1;
  const created = new Date().toISOString();
  const message: ApiMessage = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: chatId,
    seq,
    type: 'TEXT',
    sender_type: 'BOT',
    sender_id: null,
    sender_display_name: bot.name,
    bot_id: bot.id,
    text,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
  };

  chat.messages.push(message);
  chat.summary.last_seq = seq;
  chat.summary.last_message_at = created;
  return message;
}

/**
 * #95: server-created POLL/TASK row. The backend writes the message together
 * with the poll/task, so the mock must do the same and return its id.
 */
export function insertMockPluginMessage(
  db: MockDb,
  chatId: string,
  input: { type: 'POLL'; poll: Poll } | { type: 'TASK'; task: Task },
  sender: { id: string; name: string } = { id: db.me.user.id, name: MOCK_DISPLAY_NAME },
): ApiMessage {
  const chat = db.chats[chatId];
  if (!chat) throw new Error(`Unknown mock chat: ${chatId}`);

  const seq = chat.summary.last_seq + 1;
  const created = new Date().toISOString();
  const message: ApiMessage = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: chatId,
    seq,
    type: input.type,
    sender_type: 'USER',
    sender_id: sender.id,
    sender_display_name: sender.name,
    text: null,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
    ...(input.type === 'POLL'
      ? { poll_id: input.poll.id, poll: input.poll }
      : { task_id: input.task.id, task: input.task }),
  };

  chat.messages.push(message);
  chat.summary.last_seq = seq;
  chat.summary.last_message_at = created;
  return message;
}

/**
 * D1-FE3: simulate a reply written by another participant. The message is a
 * normal chat row with `thread_root_id`; the main feed handler filters it out,
 * while the thread endpoint and `thread_summary` include it.
 */
export function insertMockThreadReply(
  db: MockDb,
  chatId: string,
  rootId: string,
  text: string,
  sender: { id: string; name: string } = {
    id: IDS.mark,
    name: 'Марк Соколов',
  },
): ApiMessage {
  const chat = db.chats[chatId];
  if (!chat) throw new Error(`Unknown mock chat: ${chatId}`);
  if (!chat.messages.some((message) => message.id === rootId && !message.thread_root_id)) {
    throw new Error(`Unknown thread root: ${rootId}`);
  }
  const message = insertMockMessage(db, chatId, text, sender);
  message.thread_root_id = rootId;
  return message;
}

/** E6: add a notification row (used by handlers/tests/E2E debug controls). */
export function insertMockNotification(
  db: MockDb,
  input: Partial<Notification> & { title: string },
): MockNotificationRecord {
  const chat = input.chat_id ? db.chats[input.chat_id] : undefined;
  const notification: MockNotificationRecord = {
    id: input.id ?? newUuid(),
    type: input.type ?? 'MESSAGE',
    chat_id: input.chat_id ?? null,
    chat_name: input.chat_name ?? chat?.summary.name ?? null,
    title: input.title,
    body: input.body ?? null,
    created_at: input.created_at ?? new Date().toISOString(),
    read: input.read ?? false,
    user_id: db.me.user.id,
  };
  db.notifications.push(notification);
  return notification;
}

/** E5: simulate another participant posting a built-in sticker. */
export function insertMockStickerMessage(
  db: MockDb,
  chatId: string,
  sticker: StickerRef,
  sender: { id: string; name: string } = {
    id: '99999999-9999-4999-8999-999999999999',
    name: 'Марк Соколов',
  },
): ApiMessage {
  const chat = db.chats[chatId];
  if (!chat) throw new Error(`Unknown mock chat: ${chatId}`);

  const seq = chat.summary.last_seq + 1;
  const created = new Date().toISOString();
  const message: ApiMessage = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: chatId,
    seq,
    type: 'STICKER',
    sender_type: 'USER',
    sender_id: sender.id,
    sender_display_name: sender.name,
    text: null,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
    sticker_id: sticker.id,
    sticker: { ...sticker },
  };

  chat.messages.push(message);
  chat.summary.last_seq = seq;
  chat.summary.last_message_at = created;
  return message;
}

/** E8: flip the platform-admin flag for both `/me` and the auth-session DTO. */
export function setMockPlatformAdmin(db: MockDb, isAdmin: boolean): void {
  db.me = { ...db.me, user: { ...db.me.user, is_platform_admin: isAdmin } };
  for (const user of db.authUsers) {
    if (user.id === db.me.user.id) user.isPlatformAdmin = isAdmin;
  }
}

/** E8: `null` means setup has not been completed yet. */
export function setMockSetupRequired(db: MockDb, required: boolean): void {
  const now = new Date().toISOString();
  db.admin.setupCompletedAt = required ? null : now;
  db.admin.updatedAt = now;
}

/** R-01 counters: every mock chat belongs to the workspace and its viewer. */
export function countActiveChatsInWorkspace(db: MockDb, workspaceId: string): number {
  return Object.values(db.chats).filter((chat) => chat.workspaceId === workspaceId).length;
}

export function countActiveChatsForUser(db: MockDb, workspaceId: string, userId: string): number {
  // The fixture/mock membership model has no per-user chat membership rows;
  // every chat in the workspace counts for the current user, matching the
  // default single-owner fixtures used by the UI tests.
  void userId;
  return countActiveChatsInWorkspace(db, workspaceId);
}

/**
 * E2E/debug control: simulate a first login without any workspaces.
 * Empty workspaces also drop the fixture chats so onboarding is realistic.
 */
export function setMockWorkspaces(db: MockDb, workspaces: WorkspaceSummary[]): void {
  db.me = {
    ...db.me,
    workspaces,
    default_workspace_id: workspaces[0]?.id ?? null,
  };
  if (workspaces.length === 0) {
    db.chats = {};
  }
}
