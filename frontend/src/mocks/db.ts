import type {
  AdminAuditEvent,
  AdminChat,
  AdminStorage,
  AdminUser,
  AdminUserStatus,
  ApiAttachment,
  ApiMessage,
  AttachmentScanStatus,
  AuthLoginRequest,
  AuthRegisterRequest,
  AuthVerifyEmailRequest,
  Chat,
  ChatSummary,
  Device,
  MeResponse,
  Notification,
  NotificationPreference,
  NotificationPreferencePatch,
  PreflightFile,
  ReadNotificationsRequest,
  Session,
  StickerPack,
  StickerRef,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadSessionStatus,
  WorkspaceLimits,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceSummary,
} from '../api/types';
import { newUuid } from '../lib/ids';
import {
  buildChatSummaries,
  buildDirectMessages,
  buildGroupMessages,
  buildMockMe,
  buildMemberUsers,
  buildNotificationPreferences,
  buildNotifications,
  buildStickerPacks,
  buildWorkspaceMembers,
  IDS,
  MOCK_DISPLAY_NAME,
  MOCK_DEMO_EMAIL,
  MOCK_DEMO_PASSWORD,
  mockSession,
  type MockMemberUser,
} from './fixtures';

export interface ChatRecord {
  summary: ChatSummary;
  workspaceId: string;
  messages: ApiMessage[];
  /** Server-side client_message_id dedupe (not exposed by the contract). */
  clientMessageIds: Map<string, string>;
}

export interface DeviceRequestRecord {
  bodyHash: string;
  device: Device;
}

export interface WorkspaceRequestRecord {
  bodyHash: string;
  workspace: WorkspaceSummary;
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
  registrationOpen: boolean;
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
  chatId: string;
  filename: string;
  size: number;
  mime: string | null;
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
  usersDelayMs: number;
  chatsDelayMs: number;
  storageDelayMs: number;
  auditDelayMs: number;
  forceUsersError: ForcedSendError | null;
  forceChatsError: ForcedSendError | null;
  forceStorageError: ForcedSendError | null;
  forceAuditError: ForcedSendError | null;
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
    usersDelayMs: 0,
    chatsDelayMs: 0,
    storageDelayMs: 0,
    auditDelayMs: 0,
    forceUsersError: null,
    forceChatsError: null,
    forceStorageError: null,
    forceAuditError: null,
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
      messages: buildGroupMessages(),
      clientMessageIds: new Map(),
    },
    [IDS.directChat]: {
      summary: clone(direct),
      workspaceId: IDS.workspace,
      messages: buildDirectMessages(),
      clientMessageIds: new Map(),
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
    registrationOpen: true,
    updatedAt: now,
    updatedBy: null,
  };
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
    sender_id: sender.id,
    sender_display_name: sender.name,
    text,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
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
    sender_id: sender.id,
    sender_display_name: sender.name,
    text: null,
    reply_to_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    version: 1,
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
