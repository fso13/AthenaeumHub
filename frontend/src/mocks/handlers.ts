import { delay, http, HttpResponse } from 'msw';
import type {
  AdminAuditEvent,
  AdminAuditPage,
  AdminChat,
  AdminChatPage,
  AdminOverview,
  AdminSettings,
  AdminStorage,
  AdminStorageTotals,
  AdminUser,
  AdminUserPage,
  ApiAttachment,
  ApiErrorBody,
  ApiMessage,
  AuthLoginRequest,
  AuthRegisterRequest,
  AuthSession,
  Chat,
  ChatPluginState,
  CreateWorkspaceRequest,
  DeviceRegistration,
  FileItem,
  MessageCreateBody,
  Notification,
  NotificationPreference,
  NotificationPreferencePatch,
  Plugin,
  PreflightDecision,
  PreflightFile,
  ReadNotificationsRequest,
  ReactionSummary,
  RealtimeTicket,
  StickerRef,
  SyncResponse,
  ThreadSummary,
  UploadInitRequest,
  UploadSession,
  WorkspaceMember,
  WorkspaceMemberPage,
  WorkspaceRole,
  WorkspaceSummary,
} from '../api/types';
import { sha256Bytes } from '../files/hash';
import { newUuid } from '../lib/ids';
import { pluginUnavailableReason } from '../plugins/model';
import {
  countActiveChatsForUser,
  countActiveChatsInWorkspace,
  type ChatRecord,
  type MockAuthUserRecord,
  type MockDb,
  type MockUpload,
} from './db';
import { IDS, MOCK_ACCESS_TOKEN, MOCK_DEMO_EMAIL, MOCK_EMAIL_CODE, messageId } from './fixtures';
import {
  publishMockMessageCreated,
  publishMockMessageDeleted,
  publishMockMessageUpdated,
  publishMockReactionChanged,
} from './realtime';

const API = '*/api/v1';
/** Mock presigned media origin (MinIO in the real contour). */
const MOCK_MEDIA_ORIGIN = 'http://localhost:9002';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ErrorOptions {
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
  requestId?: string;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  options: ErrorOptions = {},
): Response {
  const requestId = options.requestId ?? `req_${newUuid()}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
  };
  if (options.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(options.retryAfterSeconds);
  }

  const body: ApiErrorBody = {
    code,
    message,
    ...(options.details ? { details: options.details } : {}),
    request_id: requestId,
  };

  return HttpResponse.json(body, { status, headers });
}

function requireBearer(request: Request): Response | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return errorResponse(401, 'UNAUTHENTICATED', 'Authentication is missing');
  }
  return null;
}

function requireAuth(request: Request): Response | null {
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
  if (!request.headers.get('x-device-id')) {
    return errorResponse(401, 'UNAUTHENTICATED', 'Device id is missing');
  }
  return null;
}

type ChatLike = ChatRecord;

/** Managed-only excerpt: normalized and cut by code points (never a surrogate half). */
function threadExcerpt(value: string | null | undefined): string | null {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  const chars = Array.from(normalized);
  return chars.length <= 160 ? normalized : `${chars.slice(0, 159).join('')}…`;
}

/** Live (non-deleted) replies of one root in seq order. */
function threadRepliesOf(chat: ChatLike, rootId: string): ApiMessage[] {
  return chat.messages
    .filter(
      (message) =>
        message.thread_root_id === rootId &&
        !message.deleted_at &&
        !chat.hiddenMessageIds.has(message.id),
    )
    .sort((a, b) => a.seq - b.seq);
}

/** #61: `ReactionCreate.emoji` — 1..32 code points, no HTML/space/control. */
function validReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const points = Array.from(value);
  if (points.length < 1 || points.length > 32) return false;
  if (/[\s<>"'`&]/.test(value)) return false;
  return points.every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

/** Hidden-for-me rows behave like missing messages (`404` on metadata writes). */
function visibleMessage(chat: ChatLike, messageId: string): ApiMessage | null {
  const message = chat.messages.find((item) => item.id === messageId);
  if (!message || chat.hiddenMessageIds.has(message.id)) return null;
  return message;
}

function buildThreadSummary(chat: ChatLike, rootId: string): ThreadSummary | null {
  // E2EE never builds a plaintext reply summary (contract `null`).
  if (chat.summary.security_mode === 'E2EE') return null;
  const replies = threadRepliesOf(chat, rootId);
  const last = replies[replies.length - 1] ?? null;
  return {
    reply_count: replies.length,
    last_reply_at: last?.created_at ?? null,
    last_reply_author_id: last?.sender_id ?? null,
    last_reply_excerpt:
      last && last.type !== 'STICKER' && !last.sticker_id ? threadExcerpt(last.text) : null,
  };
}

/** Adds the root-only `thread_summary` the real server computes per page. */
function presentMessage(chat: ChatLike, message: ApiMessage): ApiMessage {
  const threadRootId = message.thread_root_id ?? null;
  if (threadRootId !== null) {
    return {
      ...message,
      thread_root_id: threadRootId,
      thread_summary: null,
      reactions: message.reactions ?? [],
    };
  }
  return {
    ...message,
    thread_root_id: null,
    thread_summary: buildThreadSummary(chat, message.id),
    reactions: message.reactions ?? [],
  };
}

/** Validates a thread root the same way the backend does (422, typed codes). */
function validateThreadRoot(chat: ChatLike, rootId: string): Response | null {
  if (chat.summary.security_mode === 'E2EE') {
    return errorResponse(
      422,
      'THREADS_E2EE_UNSUPPORTED',
      'Threads are not supported in an E2EE chat',
    );
  }
  const root = visibleMessage(chat, rootId);
  if (!root) {
    return errorResponse(422, 'THREAD_ROOT_NOT_FOUND', 'Thread root not found');
  }
  if (root.thread_root_id) {
    return errorResponse(422, 'THREAD_NESTING_UNSUPPORTED', 'A reply cannot be a thread root');
  }
  if (root.deleted_at) {
    return errorResponse(422, 'THREAD_ROOT_DELETED', 'Thread root is deleted');
  }
  return null;
}

/** Mirrors D1-BE3 plain-text rules (no control chars except LF/TAB in description). */
function hasDisallowedControl(value: string, allowed: ReadonlySet<number>): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !allowed.has(code)) return true;
  }
  return false;
}

const NO_CONTROL = new Set<number>();
const DESCRIPTION_CONTROL_ALLOWED = new Set<number>([0x09, 0x0a]);

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

function addWorkspaceChat(
  db: MockDb,
  workspaceId: string,
  securityMode: WorkspaceSummary['security_mode'],
): ChatRecord {
  const chatId = newUuid();
  const chat: ChatRecord = {
    summary: {
      id: chatId,
      name: 'Общий чат',
      type: 'GROUP',
      security_mode: securityMode,
      last_message_at: null,
      unread_count: 0,
      last_seq: 0,
    },
    workspaceId,
    messages: [],
    clientMessageIds: new Map(),
    hiddenMessageIds: new Set(),
  };
  db.chats[chatId] = chat;
  return chat;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/* E6-F: opaque cursor = base64url({created_at,id}), mirroring §7.3. */
function encodeNotificationCursor(notification: Notification): string {
  const raw = JSON.stringify({
    created_at: notification.created_at,
    id: notification.id,
  });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeNotificationCursor(value: string): { created_at: string; id: string } | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.created_at !== 'string' || typeof record.id !== 'string') return null;
    return { created_at: record.created_at, id: record.id };
  } catch {
    return null;
  }
}

function notificationDto(notification: Notification): Notification {
  // `user_id` is mock-only server state; the contract DTO never exposes it.
  const { id, type, chat_id, chat_name, title, body, created_at, read } = notification;
  return { id, type, chat_id, chat_name, title, body, created_at, read };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* E4-F mock file pipeline                                                   */
/* ------------------------------------------------------------------------- */

const PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const DANGEROUS_EXTENSIONS = /\.(exe|bat|cmd|com|msi|scr|ps1|sh|jar|apk|dmg|vbs)$/i;

function workspaceRole(db: MockDb, workspaceId: string): WorkspaceRole {
  return db.me.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? 'MEMBER';
}

/** Analysis §12.1: a guest gets the smaller per-file cap. */
function effectiveFileMax(db: MockDb, workspaceId: string): number {
  const role = workspaceRole(db, workspaceId);
  if (role === 'GUEST') {
    return Math.min(db.limits.max_file_bytes, db.limits.guest_file_bytes);
  }
  return db.limits.max_file_bytes;
}

function quotaAvailable(db: MockDb): number {
  const { used, reserved, limit } = db.limits.usage;
  return Math.max(0, limit - used - reserved);
}

function isDangerousFile(name: string, mime: string | null | undefined): boolean {
  if (DANGEROUS_EXTENSIONS.test(name)) return true;
  return mime === 'application/x-msdownload' || mime === 'application/x-dosexec';
}

function uploadSession(upload: MockUpload): UploadSession {
  return {
    upload_id: upload.id,
    status: upload.status,
    part_size: upload.partSize,
    total_parts: upload.totalParts,
    received_parts: [...upload.received.keys()].sort((a, b) => a - b),
    expires_at: new Date(upload.expiresAt).toISOString(),
    attachment_id: upload.attachmentId,
  };
}

/** Reassemble the uploaded bytes so mock media previews serve the real file. */
function uploadedBytes(upload: MockUpload): Uint8Array {
  const bytes = new Uint8Array(upload.size);
  for (const [partNo, part] of upload.received) {
    const start = (partNo - 1) * upload.partSize;
    bytes.set(part.bytes.slice(0, Math.max(0, upload.size - start)), start);
  }
  return bytes;
}

function expireUpload(db: MockDb, upload: MockUpload): boolean {
  if (
    upload.status === 'ABORTED' ||
    upload.status === 'EXPIRED' ||
    upload.status === 'BOUND' ||
    upload.status === 'QUARANTINED' ||
    upload.status === 'READY' ||
    upload.status === 'SCANNING' ||
    upload.status === 'FAILED'
  ) {
    return upload.status === 'EXPIRED';
  }
  if (upload.expiresAt > Date.now()) return false;

  if (upload.reservedReleased !== true) {
    db.limits.usage.reserved = Math.max(0, db.limits.usage.reserved - upload.size);
  }
  upload.status = 'EXPIRED';
  return true;
}

function finalizeScan(db: MockDb, upload: MockUpload): void {
  if (upload.status !== 'SCANNING') return;
  const infected = db.forceScanStatus === 'INFECTED';
  upload.scanStatus = infected ? 'INFECTED' : 'CLEAN';
  upload.status = infected ? 'QUARANTINED' : 'READY';
  const attachment = upload.attachmentId ? db.attachments.get(upload.attachmentId) : undefined;
  if (attachment) {
    attachment.ref = { ...attachment.ref, scan_status: upload.scanStatus };
  }
}

function partSizeFor(upload: MockUpload, partNo: number): number {
  if (partNo < upload.totalParts) return upload.partSize;
  return upload.size - upload.partSize * (upload.totalParts - 1);
}

function bytesToPart(request: Request): Promise<Uint8Array> {
  return request.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function concatParts(upload: MockUpload): Uint8Array {
  const output = new Uint8Array(upload.size);
  let offset = 0;
  for (let partNo = 1; partNo <= upload.totalParts; partNo += 1) {
    const part = upload.received.get(partNo);
    if (!part) throw new Error(`Missing part ${partNo}`);
    output.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return output;
}

function attachmentRef(
  id: string,
  upload: Pick<MockUpload, 'filename' | 'size' | 'mime' | 'media'>,
  scanStatus: ApiAttachment['scan_status'],
): ApiAttachment {
  return {
    id,
    filename: upload.filename,
    size_bytes: upload.size,
    mime_type: upload.mime,
    scan_status: scanStatus,
    media: upload.media ?? null,
  };
}

function fileErrorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryAfterSeconds?: number,
): Response {
  return errorResponse(status, code, message, {
    ...(details ? { details } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

/* ------------------------------------------------------------------------- */
/* E5-F mock sticker catalog                                                 */
/* ------------------------------------------------------------------------- */

function findStickerRecord(
  db: MockDb,
  stickerId: string,
): { packId: string; packName: string; sticker: StickerRef } | null {
  for (const pack of db.stickerPacks) {
    const sticker = pack.stickers.find((item) => item.id === stickerId);
    if (sticker) return { packId: pack.id, packName: pack.name, sticker };
  }
  return null;
}

/** `favorite` is per current user, so the catalog response is projected. */
function presentSticker(db: MockDb, sticker: StickerRef): StickerRef {
  return { ...sticker, favorite: db.stickerFavorites.has(sticker.id) };
}

function presentPacks(db: MockDb) {
  return db.stickerPacks
    .filter((pack) => !db.disabledStickerPacks.has(pack.id))
    .map((pack) => ({
      ...pack,
      stickers: pack.stickers.map((sticker) => presentSticker(db, sticker)),
    }));
}

/* ------------------------------------------------------------------------- */
/* Auth BFF (docs/TASKS-AUTH-BFF.md)                                         */
/* ------------------------------------------------------------------------- */

const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const AUTH_ACCESS_TTL_MS = 15 * 60 * 1000;
const AUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function findAuthUser(db: MockDb, email: string): MockAuthUserRecord | undefined {
  const normalized = normalizeEmail(email);
  return db.authUsers.find((user) => user.email === normalized);
}

function findActiveVerification(db: MockDb, email: string) {
  const now = Date.now();
  const normalized = normalizeEmail(email);
  for (const verification of db.authVerifications.values()) {
    if (
      verification.email === normalized &&
      !verification.consumed &&
      verification.expiresAt > now
    ) {
      return verification;
    }
  }
  return null;
}

/**
 * E8 mock admin projection. Mirrors the backend `AdminSettings` DTO: the SMTP
 * password is never part of it; `smtp_configured` is host+from.
 */
function adminSettingsView(db: MockDb): AdminSettings {
  const admin = db.admin;
  return {
    setup_completed: admin.setupCompletedAt !== null,
    setup_completed_at: admin.setupCompletedAt,
    smtp_host: admin.smtpHost,
    smtp_port: admin.smtpPort,
    smtp_username: admin.smtpUsername,
    smtp_from: admin.smtpFrom,
    smtp_starttls: admin.smtpStarttls,
    smtp_configured: Boolean(admin.smtpHost && admin.smtpFrom),
    max_chats_per_user: admin.maxChatsPerUser,
    max_chats_per_workspace: admin.maxChatsPerWorkspace,
    max_workspace_members: admin.maxWorkspaceMembers,
    registration_open: admin.registrationOpen,
    allowed_file_extensions: admin.allowedFileExtensions,
    updated_at: admin.updatedAt,
    updated_by: admin.updatedBy,
  };
}

function requirePlatformAdmin(db: MockDb, request: Request): Response | null {
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
  // `/me` is the mock projection of the platform flag; the real backend reads
  // `auth.users.is_platform_admin` under RLS.
  if (!db.me.user.is_platform_admin) {
    return errorResponse(403, 'FORBIDDEN', 'Platform admin access is required');
  }
  return null;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function issueAuthSession(db: MockDb, user: MockAuthUserRecord): AuthSession {
  const now = Date.now();
  const accessToken = `mock-access-${newUuid()}`;
  const refreshToken = `mock-refresh-${newUuid()}`;
  db.authAccessTokens.set(accessToken, { userId: user.id, expiresAt: now + AUTH_ACCESS_TTL_MS });
  db.authRefreshTokens.set(refreshToken, { userId: user.id, expiresAt: now + AUTH_REFRESH_TTL_MS });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(AUTH_ACCESS_TTL_MS / 1000),
    token_type: 'Bearer',
    user: {
      id: user.id,
      display_name: user.displayName,
      email: user.email,
      is_platform_admin: user.isPlatformAdmin,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* E9-F admin directory mock projections                                     */
/* ------------------------------------------------------------------------ */

/**
 * Defaults are derived from the seeded entities so `/admin/*` and
 * `/admin/overview` never disagree; suites inject `*Override` for exact rows.
 */
function adminUsersView(db: MockDb): AdminUser[] {
  return db.authUsers.map((user, index) => ({
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    is_platform_admin: user.isPlatformAdmin,
    status: 'ACTIVE',
    workspaces_count: user.id === db.me.user.id ? db.me.workspaces.length : 0,
    chats_count: user.id === db.me.user.id ? Object.keys(db.chats).length : 0,
    storage_used_bytes: user.id === db.me.user.id ? db.limits.usage.used : 0,
    created_at: new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString(),
  }));
}

function adminChatsView(db: MockDb): AdminChat[] {
  return Object.values(db.chats).map((record, index) => {
    const workspace = db.me.workspaces.find((item) => item.id === record.workspaceId);
    return {
      id: record.summary.id,
      name: record.summary.name ?? null,
      type: record.summary.type,
      security_mode: record.summary.security_mode,
      workspace_id: record.workspaceId,
      workspace_name: workspace?.name ?? 'Пространство',
      members_count: record.summary.type === 'GROUP' ? 4 : 2,
      messages_count: record.summary.last_seq,
      created_at: new Date(Date.UTC(2026, 0, 1 + index, 10, 0, 0)).toISOString(),
      last_activity_at: record.summary.last_message_at ?? null,
    };
  });
}

function adminStorageView(db: MockDb): AdminStorage {
  const attached = db.attachments.size;
  const workspaces = db.me.workspaces.map((workspace, index) => ({
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    security_mode: workspace.security_mode,
    used_bytes: index === 0 ? db.limits.usage.used : 0,
    reserved_bytes: index === 0 ? db.limits.usage.reserved : 0,
    storage_limit_bytes: index === 0 ? db.limits.usage.limit : 0,
    objects: index === 0 ? attached : 0,
    attachments: index === 0 ? attached : 0,
  }));
  return {
    totals: {
      used_bytes: sumBy(workspaces, (row) => row.used_bytes),
      reserved_bytes: sumBy(workspaces, (row) => row.reserved_bytes),
      objects: sumBy(workspaces, (row) => row.objects),
      attachments: sumBy(workspaces, (row) => row.attachments),
    },
    workspaces,
  };
}

/**
 * E11-F: the mock applies the same visible effects as the backend — a changed
 * user status and a hidden soft-deleted chat — without touching other suites'
 * entities (`db.chats` stays intact; the admin projection filters).
 */
function adminUserRows(db: MockDb): AdminUser[] {
  const base = db.adminDirectory.usersOverride ?? adminUsersView(db);
  return base.map((user) => {
    const status = db.adminDirectory.userStatuses.get(user.id);
    return status ? { ...user, status } : user;
  });
}

function adminChatRows(db: MockDb): AdminChat[] {
  const base = db.adminDirectory.chatsOverride ?? adminChatsView(db);
  return base.filter((chat) => !db.adminDirectory.deletedChatIds.has(chat.id));
}

/**
 * Deterministic audit seed. The real log is append-only and installation-wide;
 * the mock only needs contract-shaped rows, and successful admin actions below
 * append to `db.adminDirectory.auditEvents` so the Audit tab is end-to-end
 * testable without a database.
 */
const SEEDED_AUDIT_EVENTS: AdminAuditEvent[] = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    action: 'admin.users.viewed',
    actor_id: IDS.user,
    actor_email: MOCK_DEMO_EMAIL,
    target_type: 'admin_users',
    target_id: null,
    created_at: '2026-01-05T09:00:00Z',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    action: 'settings.updated',
    actor_id: IDS.user,
    actor_email: MOCK_DEMO_EMAIL,
    target_type: 'system_settings',
    target_id: null,
    created_at: '2026-01-04T12:30:00Z',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000003',
    action: 'user.provisioned',
    actor_id: null,
    actor_email: null,
    target_type: 'user',
    target_id: IDS.anna,
    created_at: '2026-01-03T08:15:00Z',
  },
];

function adminAuditRows(db: MockDb): AdminAuditEvent[] {
  const base = db.adminDirectory.auditEventsOverride ?? SEEDED_AUDIT_EVENTS;
  return sortAdminRows([...base, ...db.adminDirectory.auditEvents]);
}

function appendMockAudit(
  db: MockDb,
  input: Pick<AdminAuditEvent, 'action' | 'target_type' | 'target_id'>,
): void {
  db.adminDirectory.auditEvents.push({
    id: newUuid(),
    action: input.action,
    actor_id: db.me.user.id,
    actor_email: db.me.user.email,
    target_type: input.target_type,
    target_id: input.target_id,
    created_at: new Date().toISOString(),
  });
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/** Server order: `created_at DESC, id DESC` (contract). */
function sortAdminRows<T extends { created_at: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
}

/** Decodes the mock's own opaque cursor; `0` for the first page. */
function decodeAdminCursor(
  cursor: string | null,
  endpoint: 'users' | 'chats' | 'audit',
): number | Response {
  if (cursor === null) return 0;
  const marker = endpoint === 'users' ? 'u' : endpoint === 'chats' ? 'c' : 'a';
  const match = /^a([uca]):(\d+)$/.exec(cursor);
  if (!match || match[1] !== marker) {
    return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
  }
  return Number(match[2]);
}

function paginateAdminRows<T extends { id: string }>(
  rows: T[],
  offset: number,
  limit: number,
  endpoint: 'users' | 'chats' | 'audit',
): { items: T[]; next_cursor: string | null; has_more: boolean } {
  const items = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  const marker = endpoint === 'users' ? 'u' : endpoint === 'chats' ? 'c' : 'a';
  return {
    items,
    next_cursor: hasMore ? `a${marker}:${offset + limit}` : null,
    has_more: hasMore,
  };
}

/**
 * E11-F suspend/activate. Mirrors the backend order: guard → 404 → self →
 * last-admin → already-in-state → mutate + audit. Every response is a status
 * code, exactly like the contract (204/400/403/404/409).
 */
function handleUserStatusChange(
  db: MockDb,
  request: Request,
  rawUserId: string,
  action: 'suspend' | 'activate',
): Response {
  const forbidden = requirePlatformAdmin(db, request);
  if (forbidden) return forbidden;
  // The contract sends X-Device-Id on authenticated calls; recorded so tests
  // can assert the header without inspecting internals.
  db.adminDirectory.userActionRequests.push({
    action,
    userId: rawUserId,
    deviceId: request.headers.get('x-device-id'),
  });
  if (!UUID_RE.test(rawUserId)) {
    return errorResponse(400, 'VALIDATION_FAILED', 'userId must be a UUID');
  }
  const forced = db.adminDirectory.forceUserActionError;
  if (forced) {
    return errorResponse(forced.status, forced.code, forced.message, {
      details: forced.details,
      retryAfterSeconds: forced.retryAfterSeconds,
    });
  }

  const rows = adminUserRows(db);
  const target = rows.find((user) => user.id === rawUserId);
  if (!target || target.status === 'DELETED') {
    return errorResponse(404, 'NOT_FOUND', 'User not found');
  }
  if (target.id === db.me.user.id) {
    return errorResponse(409, 'SELF_ACTION_FORBIDDEN', 'An admin cannot change their own status');
  }
  if (target.is_platform_admin) {
    const admins = rows.filter((user) => user.is_platform_admin && user.status !== 'DELETED');
    if (admins.length <= 1) {
      return errorResponse(409, 'LAST_PLATFORM_ADMIN', 'The last platform admin cannot be changed');
    }
  }

  const desired = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
  if (target.status === desired) {
    return errorResponse(
      409,
      action === 'suspend' ? 'USER_ALREADY_SUSPENDED' : 'USER_ALREADY_ACTIVE',
      action === 'suspend' ? 'User is already suspended' : 'User is already active',
    );
  }

  db.adminDirectory.userStatuses.set(rawUserId, desired);
  appendMockAudit(db, {
    action: action === 'suspend' ? 'admin.user.suspended' : 'admin.user.activated',
    target_type: 'user',
    target_id: rawUserId,
  });
  return new HttpResponse(null, { status: 204 });
}

/**
 * Contract-shaped MSW handlers. The same handler set is used by the browser
 * worker (dev) and by the Node server in tests.
 */
/** #73: server kind derivation (media metadata first, then MIME). */
function fileItemKind(item: FileItem): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' {
  if (item.media?.kind) return item.media.kind;
  const mime = (item.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

/** The list never exposes object keys, hashes or presigned URLs. */
function fileItemView(item: FileItem): FileItem {
  const view: FileItem = {
    id: item.id,
    size_bytes: item.size_bytes,
    scan_status: item.scan_status,
    chat_id: item.chat_id,
    message_id: item.message_id,
    created_at: item.created_at,
    chat_name: item.chat_name ?? null,
    filename: item.filename ?? null,
    mime_type: item.mime_type ?? null,
  };
  if (item.media) view.media = { ...item.media };
  return view;
}

/** Mirrors the backend Bio/Phone control-character guard. */
function hasForbiddenControl(value: string, allowLineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) return true;
    if (code < 0x20 || code === 0x7f) {
      if (!allowLineBreaks || (char !== '\n' && char !== '\r' && char !== '\t')) return true;
    }
  }
  return false;
}

export function createHandlers(db: MockDb) {
  return [
    http.get(`${API}/health`, () => HttpResponse.json({ status: 'ok' })),

    http.post(`${API}/dev/session`, async ({ request }) => {
      const body = await readJson(request);
      if (
        body !== null &&
        typeof body === 'object' &&
        'display_name' in body &&
        typeof (body as { display_name?: unknown }).display_name === 'string' &&
        (body as { display_name: string }).display_name.length > 80
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'display_name is longer than 80');
      }
      return HttpResponse.json(db.session);
    }),

    http.post(`${API}/auth/register`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const email = readStringField(body, 'email');
      const displayName = readStringField(body, 'display_name');
      const password = readStringField(body, 'password');
      if (!email || !displayName || !password) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid registration payload');
      }
      const payload: AuthRegisterRequest = {
        email: normalizeEmail(email),
        display_name: displayName,
        password,
      };
      db.authRegisterRequests.push(payload);

      if (findAuthUser(db, email)) {
        return errorResponse(409, 'EMAIL_TAKEN', 'Email is already registered');
      }

      const user: MockAuthUserRecord = {
        id: newUuid(),
        email: normalizeEmail(email),
        displayName: displayName.trim(),
        password,
        verified: false,
        // Only the seeded first user is a platform admin (FR-ADM-1).
        isPlatformAdmin: false,
      };
      db.authUsers.push(user);
      const now = Date.now();
      const verificationId = newUuid();
      db.authVerifications.set(verificationId, {
        id: verificationId,
        email: user.email,
        displayName: user.displayName,
        code: MOCK_EMAIL_CODE,
        expiresAt: now + VERIFICATION_TTL_MS,
        attempts: 0,
        consumed: false,
        lastSentAt: now,
      });
      return HttpResponse.json(
        {
          verification_id: verificationId,
          expires_in: Math.floor(VERIFICATION_TTL_MS / 1000),
          resend_after: Math.floor(RESEND_COOLDOWN_MS / 1000),
        },
        { status: 202 },
      );
    }),

    http.post(`${API}/auth/verify-email`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const verificationId = readStringField(body, 'verification_id');
      const code = readStringField(body, 'code');
      if (!verificationId || !code) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid verification payload');
      }
      db.authVerifyRequests.push({ verification_id: verificationId, code });

      const verification = db.authVerifications.get(verificationId);
      if (!verification) return errorResponse(404, 'NOT_FOUND', 'Verification not found');
      if (verification.consumed || verification.expiresAt <= Date.now()) {
        return errorResponse(410, 'CODE_EXPIRED', 'Verification code expired');
      }
      if (verification.attempts >= MAX_CODE_ATTEMPTS) {
        return errorResponse(429, 'RATE_LIMITED', 'Too many verification attempts', {
          retryAfterSeconds: 60,
          details: { scope: 'verify', max_attempts: MAX_CODE_ATTEMPTS },
        });
      }
      if (code !== verification.code) {
        verification.attempts += 1;
        if (verification.attempts >= MAX_CODE_ATTEMPTS) {
          return errorResponse(429, 'RATE_LIMITED', 'Too many verification attempts', {
            retryAfterSeconds: 60,
            details: { scope: 'verify', max_attempts: MAX_CODE_ATTEMPTS },
          });
        }
        return errorResponse(422, 'CODE_INVALID', 'Verification code is invalid', {
          details: { attempts_left: MAX_CODE_ATTEMPTS - verification.attempts },
        });
      }

      const user = findAuthUser(db, verification.email);
      if (!user) return errorResponse(404, 'NOT_FOUND', 'User not found');
      user.verified = true;
      verification.consumed = true;
      return HttpResponse.json(issueAuthSession(db, user));
    }),

    http.post(`${API}/auth/resend-email-code`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const verificationId = readStringField(body, 'verification_id');
      if (!verificationId) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid resend payload');
      }
      db.authResendRequests.push(verificationId);

      const verification = db.authVerifications.get(verificationId);
      if (!verification) return errorResponse(404, 'NOT_FOUND', 'Verification not found');
      if (verification.consumed || verification.expiresAt <= Date.now()) {
        return errorResponse(410, 'CODE_EXPIRED', 'Verification code expired');
      }
      const now = Date.now();
      const elapsed = now - verification.lastSentAt;
      if (elapsed < RESEND_COOLDOWN_MS) {
        return errorResponse(429, 'RATE_LIMITED', 'Verification code was sent recently', {
          retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
          details: { scope: 'resend', window_seconds: Math.floor(RESEND_COOLDOWN_MS / 1000) },
        });
      }
      verification.lastSentAt = now;
      verification.attempts = 0;
      return HttpResponse.json(
        {
          expires_in: Math.max(1, Math.ceil((verification.expiresAt - now) / 1000)),
          resend_after: Math.floor(RESEND_COOLDOWN_MS / 1000),
        },
        { status: 202 },
      );
    }),

    http.post(`${API}/auth/login`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const email = readStringField(body, 'email');
      const password = readStringField(body, 'password');
      if (!email || !password) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid login payload');
      }
      const payload: AuthLoginRequest = { email: normalizeEmail(email), password };
      db.authLoginRequests.push(payload);

      const user = findAuthUser(db, email);
      if (!user || user.password !== password) {
        return errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }
      if (!user.verified) {
        const verification = findActiveVerification(db, user.email);
        return errorResponse(403, 'EMAIL_NOT_VERIFIED', 'Email is not verified', {
          details: verification ? { verification_id: verification.id } : undefined,
        });
      }
      return HttpResponse.json(issueAuthSession(db, user));
    }),

    http.post(`${API}/auth/refresh`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const refreshToken = readStringField(body, 'refresh_token');
      if (!refreshToken) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid refresh payload');
      }
      db.authRefreshRequests.push(refreshToken);
      const record = db.authRefreshTokens.get(refreshToken);
      if (!record || record.expiresAt <= Date.now()) {
        return errorResponse(401, 'INVALID_CREDENTIALS', 'Refresh token is invalid');
      }
      const user = db.authUsers.find((candidate) => candidate.id === record.userId);
      if (!user) return errorResponse(401, 'INVALID_CREDENTIALS', 'Refresh token is invalid');
      // Rotation: the old refresh token is no longer usable.
      db.authRefreshTokens.delete(refreshToken);
      return HttpResponse.json(issueAuthSession(db, user));
    }),

    http.post(`${API}/auth/logout`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const refreshToken = readStringField(body, 'refresh_token');
      if (!refreshToken) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid logout payload');
      }
      db.authLogoutRequests.push(refreshToken);
      db.authRefreshTokens.delete(refreshToken);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/me`, ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      return HttpResponse.json(db.me);
    }),

    /* #72: partial profile update (display_name/bio/phone only). */
    http.patch(`${API}/me`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');

      db.profileUpdateRequests.push({
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceProfileUpdateError) {
        const forced = db.forceProfileUpdateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const hasField = (name: string) => Object.prototype.hasOwnProperty.call(body, name);
      if (!hasField('display_name') && !hasField('bio') && !hasField('phone')) {
        return errorResponse(422, 'VALIDATION_FAILED', 'At least one field is required', {
          details: { reason: 'empty_patch' },
        });
      }

      let displayName = db.me.user.display_name;
      let bio = db.me.user.bio ?? null;
      let phone = db.me.user.phone ?? null;

      if (hasField('display_name')) {
        const raw = body.display_name;
        if (typeof raw !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'display_name must be a string', {
            details: { field: 'display_name' },
          });
        }
        const normalized = raw.trim();
        if (normalized.length === 0) {
          return errorResponse(400, 'VALIDATION_FAILED', 'display_name must not be blank', {
            details: { field: 'display_name', reason: 'blank' },
          });
        }
        if (normalized.length > 80) {
          return errorResponse(400, 'VALIDATION_FAILED', 'display_name is too long', {
            details: { field: 'display_name', max_length: 80 },
          });
        }
        displayName = normalized;
      }

      if (hasField('bio')) {
        const raw = body.bio;
        if (raw !== null && typeof raw !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'bio must be a string', {
            details: { field: 'bio' },
          });
        }
        const normalized = typeof raw === 'string' ? raw.trim() : '';
        if (normalized.length > 280) {
          return errorResponse(400, 'VALIDATION_FAILED', 'bio is too long', {
            details: { field: 'bio', max_length: 280 },
          });
        }
        if (hasForbiddenControl(normalized, true)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'bio must be plain text', {
            details: { field: 'bio', reason: 'control_characters' },
          });
        }
        bio = normalized.length > 0 ? normalized : null;
      }

      if (hasField('phone')) {
        const raw = body.phone;
        if (raw !== null && typeof raw !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'phone must be a string', {
            details: { field: 'phone' },
          });
        }
        const normalized = typeof raw === 'string' ? raw.trim() : '';
        if (normalized.length > 32) {
          return errorResponse(400, 'VALIDATION_FAILED', 'phone is too long', {
            details: { field: 'phone', max_length: 32 },
          });
        }
        if (hasForbiddenControl(normalized, false)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'phone must be plain text', {
            details: { field: 'phone', reason: 'control_characters' },
          });
        }
        phone = normalized.length > 0 ? normalized : null;
      }

      db.me = {
        ...db.me,
        user: { ...db.me.user, display_name: displayName, bio, phone },
      };
      const authUser = db.authUsers.find((user) => user.id === db.me.user.id);
      if (authUser) authUser.displayName = displayName;
      db.session = {
        ...db.session,
        user: { ...db.session.user, display_name: displayName },
      };
      return HttpResponse.json(db.me.user);
    }),

    /* #72: Keycloak sessions of the caller (no IP/username/tokens). */
    http.get(`${API}/me/sessions`, ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      db.profileSessionListRequests += 1;
      if (db.forceProfileSessionsError) {
        const forced = db.forceProfileSessionsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const sessions = [...db.profileSessions].sort((left, right) =>
        right.last_access_at.localeCompare(left.last_access_at),
      );
      return HttpResponse.json({ sessions });
    }),

    http.delete(`${API}/me/sessions/:sessionId`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const sessionId = String(params.sessionId);
      if (!UUID_RE.test(sessionId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'sessionId must be a UUID', {
          details: { field: 'sessionId' },
        });
      }
      db.profileSessionRevokeRequests.push(sessionId);
      if (db.forceSessionRevokeError) {
        const forced = db.forceSessionRevokeError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const index = db.profileSessions.findIndex((session) => session.id === sessionId);
      if (index < 0) return errorResponse(404, 'NOT_FOUND', 'Session not found');
      db.profileSessions.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),

    /* E8/R-03..R-04: public setup status + platform admin. */
    http.get(`${API}/setup/status`, () => {
      return HttpResponse.json({
        setup_required: db.admin.setupCompletedAt === null,
        registration_open: db.admin.registrationOpen,
      });
    }),

    http.get(`${API}/admin/settings`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      return HttpResponse.json(adminSettingsView(db));
    }),

    http.patch(`${API}/admin/settings`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const complete = body.complete_setup === true || body.setup_completed === true;
      if (complete && db.admin.setupCompletedAt !== null) {
        return errorResponse(409, 'SETUP_ALREADY_COMPLETED', 'Setup is already completed');
      }

      const next = { ...db.admin };
      const numericFields: Array<
        [
          'smtp_port' | 'max_chats_per_user' | 'max_chats_per_workspace' | 'max_workspace_members',
          'smtpPort' | 'maxChatsPerUser' | 'maxChatsPerWorkspace' | 'maxWorkspaceMembers',
          number,
          number,
        ]
      > = [
        ['smtp_port', 'smtpPort', 1, 65535],
        ['max_chats_per_user', 'maxChatsPerUser', 1, 1_000_000],
        ['max_chats_per_workspace', 'maxChatsPerWorkspace', 1, 1_000_000],
        ['max_workspace_members', 'maxWorkspaceMembers', 1, 1_000_000],
      ];
      for (const [field, target, min, max] of numericFields) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
          return errorResponse(422, 'VALIDATION_FAILED', `${field} is out of range`, {
            details: { field },
          });
        }
        next[target] = value;
      }

      const stringFields: Array<
        [
          'smtp_host' | 'smtp_username' | 'smtp_from',
          'smtpHost' | 'smtpUsername' | 'smtpFrom',
          number,
        ]
      > = [
        ['smtp_host', 'smtpHost', 255],
        ['smtp_username', 'smtpUsername', 255],
        ['smtp_from', 'smtpFrom', 254],
      ];
      for (const [field, target, maxLength] of stringFields) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string' || value.length > maxLength) {
          return errorResponse(422, 'VALIDATION_FAILED', `${field} is invalid`, {
            details: { field },
          });
        }
        next[target] = normalizeOptionalString(value, maxLength);
      }

      if (body.smtp_starttls !== undefined && body.smtp_starttls !== null) {
        if (typeof body.smtp_starttls !== 'boolean') {
          return errorResponse(422, 'VALIDATION_FAILED', 'smtp_starttls must be a boolean', {
            details: { field: 'smtp_starttls' },
          });
        }
        next.smtpStarttls = body.smtp_starttls;
      }
      if (body.registration_open !== undefined && body.registration_open !== null) {
        if (typeof body.registration_open !== 'boolean') {
          return errorResponse(422, 'VALIDATION_FAILED', 'registration_open must be a boolean', {
            details: { field: 'registration_open' },
          });
        }
        next.registrationOpen = body.registration_open;
      }
      if (body.allowed_file_extensions !== undefined && body.allowed_file_extensions !== null) {
        if (
          !Array.isArray(body.allowed_file_extensions) ||
          body.allowed_file_extensions.length === 0 ||
          body.allowed_file_extensions.length > 100 ||
          body.allowed_file_extensions.some(
            (value) => typeof value !== 'string' || !/^[a-z0-9]{1,10}$/.test(value),
          )
        ) {
          return errorResponse(422, 'VALIDATION_FAILED', 'allowed_file_extensions is invalid', {
            details: { field: 'allowed_file_extensions' },
          });
        }
        next.allowedFileExtensions = [...new Set(body.allowed_file_extensions)];
      }
      if (body.smtp_password !== undefined && body.smtp_password !== null) {
        if (typeof body.smtp_password !== 'string' || body.smtp_password.length > 512) {
          return errorResponse(422, 'VALIDATION_FAILED', 'smtp_password is invalid', {
            details: { field: 'smtp_password' },
          });
        }
        // Empty password keeps the stored one (contract: write-only, blank = no change).
        if (body.smtp_password.trim().length > 0) next.smtpPasswordStored = true;
      }

      const now = new Date().toISOString();
      if (complete) next.setupCompletedAt = now;
      next.updatedAt = now;
      next.updatedBy = db.me.user.id;
      db.admin = next;
      db.limits = { ...db.limits, max_chats_per_user: next.maxChatsPerUser };
      const auditBody = { ...body };
      if (typeof auditBody.smtp_password === 'string' && auditBody.smtp_password.length > 0) {
        // Mock audit record mirrors the real audit: field names only, never the
        // secret value.
        auditBody.smtp_password = '[redacted]';
      }
      db.adminSettingsPatches.push({
        body: auditBody,
        completeSetup: complete,
      });
      return HttpResponse.json(adminSettingsView(db));
    }),

    http.post(`${API}/admin/settings/test-email`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const body = asRecord(await readJson(request));
      const to = readStringField(body, 'to');
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'A valid email recipient is required', {
          details: { field: 'to' },
        });
      }
      if (db.forceTestEmailError) {
        const forced = db.forceTestEmailError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!db.admin.smtpHost || !db.admin.smtpFrom) {
        return errorResponse(503, 'SMTP_UNAVAILABLE', 'SMTP delivery failed', {
          details: { reason: 'smtp_unavailable' },
        });
      }
      db.adminTestEmails.push(to);
      return HttpResponse.json({ sent: true, to }, { status: 202 });
    }),

    http.get(`${API}/admin/overview`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const overview: AdminOverview = {
        users: db.authUsers.length,
        workspaces: db.me.workspaces.length,
        chats: Object.keys(db.chats).length,
      };
      return HttpResponse.json(overview);
    }),

    /* E9-F: platform-admin directory (aggregates only, no content). */
    http.get(`${API}/admin/users`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const query = url.searchParams.get('query');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? '30');
      if (query !== null && query.length > 254) {
        return errorResponse(400, 'VALIDATION_FAILED', 'query is longer than 254');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = decodeAdminCursor(cursor, 'users');
      if (offset instanceof Response) return offset;

      db.adminDirectory.usersRequests.push({ query, cursor, limit });
      if (db.adminDirectory.usersDelayMs > 0) await delay(db.adminDirectory.usersDelayMs);
      const forced = db.adminDirectory.forceUsersError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const needle = (query ?? '').trim().toLowerCase();
      const rows = sortAdminRows(adminUserRows(db)).filter(
        (user) =>
          needle.length === 0 ||
          (user.email ?? '').toLowerCase().includes(needle) ||
          user.display_name.toLowerCase().includes(needle),
      );
      const page: AdminUserPage = paginateAdminRows(rows, offset, limit, 'users');
      return HttpResponse.json(page);
    }),

    http.get(`${API}/admin/chats`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspace_id');
      const query = url.searchParams.get('query');
      const type = url.searchParams.get('type');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? '30');
      if (query !== null && query.length > 120) {
        return errorResponse(400, 'VALIDATION_FAILED', 'query is longer than 120');
      }
      if (type !== null && type !== 'DIRECT' && type !== 'GROUP') {
        return errorResponse(400, 'VALIDATION_FAILED', 'type must be DIRECT or GROUP');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = decodeAdminCursor(cursor, 'chats');
      if (offset instanceof Response) return offset;

      db.adminDirectory.chatsRequests.push({ workspaceId, query, type, cursor, limit });
      if (db.adminDirectory.chatsDelayMs > 0) await delay(db.adminDirectory.chatsDelayMs);
      const forced = db.adminDirectory.forceChatsError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const needle = (query ?? '').trim().toLowerCase();
      const rows = sortAdminRows(adminChatRows(db)).filter(
        (chat) =>
          (workspaceId === null || chat.workspace_id === workspaceId) &&
          (type === null || chat.type === type) &&
          (needle.length === 0 || (chat.name ?? '').toLowerCase().includes(needle)),
      );
      const page: AdminChatPage = paginateAdminRows(rows, offset, limit, 'chats');
      return HttpResponse.json(page);
    }),

    http.get(`${API}/admin/storage`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspace_id');
      db.adminDirectory.storageRequests.push({ workspaceId });
      if (db.adminDirectory.storageDelayMs > 0) await delay(db.adminDirectory.storageDelayMs);
      const forced = db.adminDirectory.forceStorageError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const source = db.adminDirectory.storageOverride ?? adminStorageView(db);
      if (workspaceId === null) return HttpResponse.json(source);
      // Contract: `?workspace_id=` narrows both the rows and the totals.
      const workspaces = source.workspaces.filter((row) => row.workspace_id === workspaceId);
      const totals: AdminStorageTotals = {
        used_bytes: sumBy(workspaces, (row) => row.used_bytes),
        reserved_bytes: sumBy(workspaces, (row) => row.reserved_bytes),
        objects: sumBy(workspaces, (row) => row.objects),
        attachments: sumBy(workspaces, (row) => row.attachments),
      };
      return HttpResponse.json({ totals, workspaces });
    }),

    /* E11-F: admin actions (suspend/activate/soft-delete) + audit view. */
    http.post(`${API}/admin/users/:userId/suspend`, ({ request, params }) =>
      handleUserStatusChange(db, request, String(params.userId ?? ''), 'suspend'),
    ),

    http.post(`${API}/admin/users/:userId/activate`, ({ request, params }) =>
      handleUserStatusChange(db, request, String(params.userId ?? ''), 'activate'),
    ),

    http.delete(`${API}/admin/chats/:chatId`, ({ request, params }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const chatId = String(params.chatId ?? '');
      db.adminDirectory.chatDeleteRequests.push({
        chatId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (!UUID_RE.test(chatId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'chatId must be a UUID');
      }
      const forced = db.adminDirectory.forceChatDeleteError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const source = db.adminDirectory.chatsOverride ?? adminChatsView(db);
      const target = source.find((chat) => chat.id === chatId);
      if (!target) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      // Repeat delete: the contract deliberately returns 409 (not a silent 204).
      if (db.adminDirectory.deletedChatIds.has(chatId)) {
        return errorResponse(409, 'CHAT_ALREADY_DELETED', 'Chat is already deleted');
      }

      db.adminDirectory.deletedChatIds.add(chatId);
      appendMockAudit(db, {
        action: 'admin.chat.deleted',
        target_type: 'chat',
        target_id: chatId,
      });
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/admin/audit`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const action = url.searchParams.get('action');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? '30');
      if (action !== null && action.length > 120) {
        return errorResponse(400, 'VALIDATION_FAILED', 'action is longer than 120');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = decodeAdminCursor(cursor, 'audit');
      if (offset instanceof Response) return offset;

      db.adminDirectory.auditRequests.push({ action, cursor, limit });
      if (db.adminDirectory.auditDelayMs > 0) await delay(db.adminDirectory.auditDelayMs);
      const forced = db.adminDirectory.forceAuditError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const rows = adminAuditRows(db).filter((event) => action === null || event.action === action);
      const page: AdminAuditPage = paginateAdminRows(rows, offset, limit, 'audit');
      return HttpResponse.json(page);
    }),

    http.get(`${API}/sticker-packs`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chatId = new URL(request.url).searchParams.get('chat_id');
      if (!chatId) {
        return errorResponse(400, 'VALIDATION_FAILED', 'chat_id is required');
      }
      if (!db.chats[chatId]) {
        return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      }
      if (db.stickerPacksDelayMs > 0) await delay(db.stickerPacksDelayMs);
      if (db.forceStickerPacksError) {
        const forced = db.forceStickerPacksError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      return HttpResponse.json({ items: presentPacks(db) });
    }),

    http.put(`${API}/stickers/:stickerId/favorite`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const stickerId = String(params.stickerId);
      const record = findStickerRecord(db, stickerId);
      if (!record) return errorResponse(404, 'STICKER_NOT_FOUND', 'Sticker not found');

      db.stickerFavorites.add(stickerId);
      db.stickerFavoriteRequests.push({ stickerId, action: 'PUT' });
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${API}/stickers/:stickerId/favorite`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const stickerId = String(params.stickerId);
      const record = findStickerRecord(db, stickerId);
      if (!record) return errorResponse(404, 'STICKER_NOT_FOUND', 'Sticker not found');

      db.stickerFavorites.delete(stickerId);
      db.stickerFavoriteRequests.push({ stickerId, action: 'DELETE' });
      return new HttpResponse(null, { status: 204 });
    }),

    /* ------------------------------------------------------------------ */
    /* D1.1 (#69): built-in plugins                                       */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/plugins`, async ({ request }) => {
      // Contract: authenticated but workspace/chat independent, so no
      // X-Device-Id requirement here.
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      db.pluginCatalogRequests += 1;
      if (db.pluginCatalogDelayMs > 0) await delay(db.pluginCatalogDelayMs);
      if (db.forcePluginCatalogError) {
        const forced = db.forcePluginCatalogError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      return HttpResponse.json({
        items: db.pluginCatalog.map((plugin) => ({
          ...plugin,
          permissions: [...plugin.permissions],
          modes: [...plugin.modes],
        })),
      });
    }),

    http.get(`${API}/chats/:chatId/plugins`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      db.chatPluginListRequests.push({
        chatId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.chatPluginsDelayMs > 0) await delay(db.chatPluginsDelayMs);
      if (db.forceChatPluginsError) {
        const forced = db.forceChatPluginsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const record = db.chats[chatId];
      const workspace = record
        ? db.me.workspaces.find((item) => item.id === record.workspaceId)
        : undefined;
      if (!record || !workspace) return errorResponse(404, 'NOT_FOUND', 'Chat not found');

      const stored = db.chatPlugins.get(chatId);
      const items: ChatPluginState[] = db.pluginCatalog.map((plugin) => {
        const reason = pluginUnavailableReason(plugin, record.summary.security_mode);
        return {
          plugin_id: plugin.id,
          enabled: stored?.get(plugin.id) ?? false,
          available: reason === null,
          ...(reason ? { reason } : {}),
        };
      });
      return HttpResponse.json({ items });
    }),

    http.patch(`${API}/chats/:chatId/plugins/:pluginId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const pluginId = String(params.pluginId);
      const rawBody = await readJson(request);
      const body = asRecord(rawBody);
      db.chatPluginRequests.push({
        chatId,
        pluginId,
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.chatPluginPatchDelayMs > 0) await delay(db.chatPluginPatchDelayMs);
      if (db.forceChatPluginPatchError) {
        const forced = db.forceChatPluginPatchError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const record = db.chats[chatId];
      const workspace = record
        ? db.me.workspaces.find((item) => item.id === record.workspaceId)
        : undefined;
      if (!record || !workspace) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');

      // The mock has one role per workspace member; the backend checks the
      // chat role in the same OWNER/ADMIN direction.
      if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
        return errorResponse(403, 'FORBIDDEN', 'Not a chat owner/admin');
      }

      const plugin: Plugin | undefined = db.pluginCatalog.find((item) => item.id === pluginId);
      if (!plugin) return errorResponse(404, 'PLUGIN_NOT_FOUND', 'Plugin not found');
      if (typeof body.enabled !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'enabled must be a boolean', {
          details: { field: 'enabled' },
        });
      }

      const reason = pluginUnavailableReason(plugin, record.summary.security_mode);
      if (reason) {
        return errorResponse(
          422,
          reason,
          reason === 'PLUGIN_DISABLED'
            ? 'Plugin is disabled in the catalog'
            : 'Plugin is not available in this chat mode',
        );
      }

      const stored = db.chatPlugins.get(chatId) ?? new Map<string, boolean>();
      const previous = stored.get(pluginId) ?? false;
      stored.set(pluginId, body.enabled);
      db.chatPlugins.set(chatId, stored);
      // Mirrors the backend: a no-op PATCH writes no audit event.
      if (previous !== body.enabled) {
        db.chatPluginAudit.push({ pluginId, enabled: body.enabled });
      }
      return HttpResponse.json({
        plugin_id: pluginId,
        enabled: body.enabled,
        available: true,
      });
    }),

    http.post(`${API}/devices`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }

      const candidate = body as Partial<DeviceRegistration>;
      const bodyHash = canonicalJson(candidate);
      const replay = db.deviceRequests.get(idempotencyKey);
      if (replay) {
        if (replay.bodyHash !== bodyHash) {
          return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused');
        }
        return HttpResponse.json(replay.device, {
          status: 201,
          headers: { 'Idempotent-Replay': 'true' },
        });
      }

      if (
        typeof candidate.name !== 'string' ||
        candidate.name.trim().length === 0 ||
        candidate.name.length > 80
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'name must be 1..80 characters');
      }
      if (candidate.platform !== 'WEB') {
        return errorResponse(422, 'VALIDATION_FAILED', 'platform must be WEB');
      }
      if (typeof candidate.app_version !== 'string' || candidate.app_version.length > 40) {
        return errorResponse(422, 'VALIDATION_FAILED', 'app_version must be a string <= 40');
      }
      if (db.devices.length >= 5) {
        return errorResponse(409, 'DEVICE_LIMIT_REACHED', 'Device limit reached');
      }

      const created = new Date().toISOString();
      const device = {
        id: newUuid(),
        platform: 'WEB' as const,
        created_at: created,
      };
      db.devices.push(device);
      db.deviceRequests.set(idempotencyKey, { bodyHash, device });

      return HttpResponse.json(device, { status: 201 });
    }),

    /** D1-FE5: own devices for the profile modal (contract `DeviceList`). */
    http.get(`${API}/devices`, ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      return HttpResponse.json({ items: db.devices });
    }),

    http.post(`${API}/workspaces`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const deviceId = request.headers.get('x-device-id') ?? '';
      if (!db.devices.some((device) => device.id === deviceId)) {
        return errorResponse(401, 'UNAUTHENTICATED', 'Unknown device');
      }

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }

      const candidate = body as Partial<CreateWorkspaceRequest>;
      const bodyHash = canonicalJson(candidate);
      const replay = db.workspaceRequests.get(idempotencyKey);
      if (replay) {
        if (replay.bodyHash !== bodyHash) {
          return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused');
        }
        return HttpResponse.json(replay.workspace, {
          status: 201,
          headers: { 'Idempotent-Replay': 'true' },
        });
      }

      if (
        typeof candidate.name !== 'string' ||
        candidate.name.trim().length === 0 ||
        candidate.name.length > 120
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'name must be 1..120 characters');
      }
      if (candidate.security_mode !== 'MANAGED' && candidate.security_mode !== 'E2EE') {
        return errorResponse(422, 'VALIDATION_FAILED', 'security_mode is invalid');
      }

      const workspace: WorkspaceSummary = {
        id: newUuid(),
        name: candidate.name.trim(),
        slug: `${slugify(candidate.name)}-${db.me.workspaces.length + 1}`,
        role: 'OWNER',
        security_mode: candidate.security_mode,
      };
      db.me = {
        ...db.me,
        workspaces: [...db.me.workspaces, workspace],
        default_workspace_id: db.me.default_workspace_id ?? workspace.id,
      };
      addWorkspaceChat(db, workspace.id, workspace.security_mode);
      db.workspaceRequests.set(idempotencyKey, { bodyHash, workspace });

      return HttpResponse.json(workspace, { status: 201 });
    }),

    http.get(`${API}/workspaces/:workspaceId/chats`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = db.me.workspaces.find((item) => item.id === String(params.workspaceId));
      if (!workspace) {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }
      return HttpResponse.json({
        items: Object.values(db.chats)
          .filter((chat) => chat.workspaceId === workspace.id)
          .map((chat) => chat.summary),
      });
    }),

    /**
     * D1-FE5: `PATCH /chats/{chatId}` (D1-BE3). Mirrors the server contract:
     * workspace OWNER/ADMIN only, MEMBER/GUEST -> 403, unknown/foreign -> 404,
     * E2EE description -> 422 CHAT_SETTINGS_E2EE_UNSUPPORTED, name 1..120,
     * description <=500, plain text, empty patch -> 422. No optimistic state:
     * the returned Chat is the only accepted update.
     */
    http.patch(`${API}/chats/:chatId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      const workspace = record
        ? db.me.workspaces.find((item) => item.id === record.workspaceId)
        : undefined;
      if (!record || !workspace) return errorResponse(404, 'NOT_FOUND', 'Chat not found');

      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      db.chatSettingsRequests.push({
        chatId,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.chatSettingsDelayMs > 0) await delay(db.chatSettingsDelayMs);
      if (db.forceChatSettingsError) {
        const forced = db.forceChatSettingsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace owner/admin');
      }

      const hasName = body.name !== undefined && body.name !== null;
      const hasDescription = body.description !== undefined && body.description !== null;
      if (!hasName && !hasDescription) {
        return errorResponse(422, 'VALIDATION_FAILED', 'At least one field is required', {
          details: { reason: 'empty_patch' },
        });
      }
      if (record.summary.security_mode === 'E2EE' && hasDescription) {
        return errorResponse(
          422,
          'CHAT_SETTINGS_E2EE_UNSUPPORTED',
          'Description is not available in an E2EE chat',
        );
      }

      const next = { ...record.summary };
      if (hasName) {
        if (typeof body.name !== 'string') {
          return errorResponse(422, 'VALIDATION_FAILED', 'name must be a string', {
            details: { field: 'name' },
          });
        }
        const normalized = body.name.trim().replace(/\s+/g, ' ');
        const length = Array.from(normalized).length;
        if (
          length < 1 ||
          length > 120 ||
          /[<>]/.test(normalized) ||
          hasDisallowedControl(normalized, NO_CONTROL)
        ) {
          return errorResponse(422, 'VALIDATION_FAILED', 'name is invalid', {
            details: { field: 'name', max_length: 120 },
          });
        }
        next.name = normalized;
      }
      if (hasDescription) {
        if (typeof body.description !== 'string') {
          return errorResponse(422, 'VALIDATION_FAILED', 'description must be a string', {
            details: { field: 'description' },
          });
        }
        const normalized = body.description.replace(/\r\n?/g, '\n').trim();
        if (
          Array.from(normalized).length > 500 ||
          /[<>]/.test(normalized) ||
          hasDisallowedControl(normalized, DESCRIPTION_CONTROL_ALLOWED)
        ) {
          return errorResponse(422, 'VALIDATION_FAILED', 'description is invalid', {
            details: { field: 'description', max_length: 500 },
          });
        }
        next.description = normalized.length === 0 ? null : normalized;
      }

      record.summary = next;
      const chat: Chat = {
        id: next.id,
        type: next.type,
        security_mode: next.security_mode,
        peer_id: next.peer_id ?? null,
        peer_has_e2ee_capable_devices: next.peer_has_e2ee_capable_devices ?? false,
        name: next.name,
        description: next.description ?? null,
        last_seq: next.last_seq,
        unread_count: next.unread_count,
        created_at: new Date().toISOString(),
      };
      return HttpResponse.json(chat);
    }),

    /**
     * E10-F: active member directory for the DIRECT peer picker. Cursor is
     * opaque, bound to the workspace and implemented as an offset; the caller
     * is included (like the real backend) and filtered by the UI.
     */
    http.get(`${API}/workspaces/:workspaceId/members`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');

      const url = new URL(request.url);
      const query = url.searchParams.get('query');
      const cursor = url.searchParams.get('cursor');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (query !== null && query.length > 80) {
        return errorResponse(400, 'VALIDATION_FAILED', 'query is longer than 80');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      let offset = 0;
      if (cursor !== null) {
        const match = /^wm:([0-9a-f-]+):(\d+)$/.exec(cursor);
        if (!match || match[1] !== workspaceId) {
          return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
        }
        offset = Number(match[2]);
      }

      db.memberDirectoryRequests.push({
        workspaceId,
        query,
        cursor,
        limit,
      });
      if (db.membersDelayMs > 0) await delay(db.membersDelayMs);

      const needle = (query ?? '').trim().toLowerCase();
      const rows = [...db.workspaceMembers]
        .sort(
          (left, right) =>
            left.display_name.localeCompare(right.display_name, 'ru') ||
            left.user_id.localeCompare(right.user_id),
        )
        .filter(
          (member) => needle.length === 0 || member.display_name.toLowerCase().includes(needle),
        );
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + limit < rows.length;
      const page: WorkspaceMemberPage = {
        items,
        next_cursor: hasMore ? `wm:${workspaceId}:${offset + limit}` : null,
        has_more: hasMore,
      };
      return HttpResponse.json(page);
    }),

    /**
     * E12-F (R-09): add an existing ACTIVE user by email. The mock mirrors the
     * backend guards: OWNER/ADMIN only, no OWNER assignment, ADMIN cannot add
     * ADMIN, duplicate -> 409, unknown email -> 404, `max_workspace_members`
     * -> 409 with `details.limit/used`.
     */
    http.post(`${API}/workspaces/:workspaceId/members`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');

      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const role = body.role;
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'email is invalid', {
          details: { field: 'email' },
        });
      }
      if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'MEMBER' && role !== 'GUEST') {
        return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
          details: { field: 'role' },
        });
      }

      db.memberAddRequests.push({
        workspaceId,
        email,
        role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceMemberAddError) {
        const forced = db.forceMemberAddError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace owner/admin');
      }
      if (role === 'OWNER' || (workspace.role === 'ADMIN' && role === 'ADMIN')) {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role cannot be assigned');
      }

      const user = db.memberUsers.find(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
      );
      if (!user) return errorResponse(404, 'USER_NOT_FOUND', 'User not found');
      if (db.workspaceMembers.some((member) => member.user_id === user.user_id)) {
        return errorResponse(409, 'MEMBER_ALREADY_EXISTS', 'User is already a member');
      }
      if (db.workspaceMembers.length >= db.admin.maxWorkspaceMembers) {
        return errorResponse(409, 'WORKSPACE_MEMBER_LIMIT_REACHED', 'Member limit reached', {
          details: {
            scope: 'WORKSPACE',
            limit: db.admin.maxWorkspaceMembers,
            used: db.workspaceMembers.length,
          },
        });
      }

      const member: WorkspaceMember = {
        user_id: user.user_id,
        display_name: user.display_name,
        role,
        joined_at: new Date().toISOString(),
      };
      db.workspaceMembers.push(member);
      return HttpResponse.json(member, { status: 201 });
    }),

    /**
     * E12-F (R-09): change a role. OWNER is not assignable, self/last-owner and
     * ADMIN-vs-ADMIN guards are the same as the backend; a no-op is `200`.
     */
    http.patch(`${API}/workspaces/:workspaceId/members/:userId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');

      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const role = body.role;
      if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'MEMBER' && role !== 'GUEST') {
        return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
          details: { field: 'role' },
        });
      }
      const userId = String(params.userId);
      db.memberRoleRequests.push({
        workspaceId,
        userId,
        role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceMemberRoleError) {
        const forced = db.forceMemberRoleError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace owner/admin');
      }
      const target = db.workspaceMembers.find((member) => member.user_id === userId);
      if (!target) return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (role === 'OWNER') {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'OWNER cannot be assigned');
      }
      if (target.user_id === db.me.user.id) {
        return errorResponse(
          409,
          target.role === 'OWNER' ? 'LAST_OWNER' : 'SELF_ACTION_FORBIDDEN',
          'Cannot change your own role',
        );
      }
      if (target.role === 'OWNER') return errorResponse(409, 'LAST_OWNER', 'Last owner');
      if (workspace.role === 'ADMIN' && (target.role === 'ADMIN' || role === 'ADMIN')) {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role change forbidden');
      }
      if (target.role === role) return HttpResponse.json(target);
      target.role = role;
      return HttpResponse.json(target);
    }),

    /**
     * E12-F (R-09): soft removal. The row disappears from the mock directory,
     * matching the ACTIVE-only read model; self/last-owner guards stay 409.
     */
    http.delete(`${API}/workspaces/:workspaceId/members/:userId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');

      const userId = String(params.userId);
      db.memberRemoveRequests.push({
        workspaceId,
        userId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceMemberRemoveError) {
        const forced = db.forceMemberRemoveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace owner/admin');
      }
      const target = db.workspaceMembers.find((member) => member.user_id === userId);
      if (!target) return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (target.user_id === db.me.user.id) {
        return errorResponse(
          409,
          target.role === 'OWNER' ? 'LAST_OWNER' : 'SELF_ACTION_FORBIDDEN',
          'Cannot remove yourself',
        );
      }
      if (target.role === 'OWNER') return errorResponse(409, 'LAST_OWNER', 'Last owner');
      if (workspace.role === 'ADMIN' && target.role === 'ADMIN') {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Cannot remove an admin');
      }

      db.workspaceMembers = db.workspaceMembers.filter((member) => member.user_id !== userId);
      return new HttpResponse(null, { status: 204 });
    }),

    /**
     * E8/R-01: GROUP creation with server-side chat limits. `Idempotency-Key` is
     * required; a replay returns the same chat without consuming a slot.
     */
    http.post(`${API}/workspaces/:workspaceId/chats`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = db.me.workspaces.find((item) => item.id === String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      if (db.forceChatCreateError) {
        const forced = db.forceChatCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const bodyHash = canonicalJson(body);
      const replay = db.chatRequests.get(idempotencyKey);
      if (replay) {
        if (replay.bodyHash !== bodyHash) {
          return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused');
        }
        return HttpResponse.json(replay.chat, {
          status: 201,
          headers: { 'Idempotent-Replay': 'true' },
        });
      }

      const type = body.type;
      if (type !== 'GROUP' && type !== 'DIRECT') {
        return errorResponse(422, 'VALIDATION_FAILED', 'type must be DIRECT or GROUP', {
          details: { field: 'type' },
        });
      }
      if (type === 'GROUP' && body.peer_id !== undefined && body.peer_id !== null) {
        return errorResponse(422, 'VALIDATION_FAILED', 'peer_id is only valid for DIRECT', {
          details: { field: 'peer_id' },
        });
      }

      if (type === 'DIRECT') {
        const peerId = typeof body.peer_id === 'string' ? body.peer_id : null;
        if (!peerId) {
          return errorResponse(422, 'VALIDATION_FAILED', 'peer_id is required for DIRECT', {
            details: { field: 'peer_id' },
          });
        }
        // E10-B: peer must be another ACTIVE workspace member; self is rejected
        // even though the caller appears in the member directory.
        const peer = db.workspaceMembers.find((member) => member.user_id === peerId);
        if (peerId === db.me.user.id || !peer) {
          return errorResponse(400, 'VALIDATION_FAILED', 'peer_id is invalid', {
            details: { field: 'peer_id' },
          });
        }
        const existing = Object.values(db.chats).find(
          (chat) =>
            chat.workspaceId === workspace.id &&
            chat.summary.type === 'DIRECT' &&
            chat.summary.peer_id === peerId,
        );
        if (existing) {
          const chat: Chat = {
            id: existing.summary.id,
            type: 'DIRECT',
            security_mode: existing.summary.security_mode,
            peer_id: peerId,
            peer_has_e2ee_capable_devices: existing.summary.peer_has_e2ee_capable_devices ?? false,
            name: null,
            last_seq: existing.summary.last_seq,
            unread_count: existing.summary.unread_count,
            created_at: new Date().toISOString(),
          };
          db.chatCreateRequests.push({ idempotencyKey, body });
          return HttpResponse.json(chat, { status: 200 });
        }
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (type === 'GROUP' && (name.length === 0 || name.length > 120)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'name must be 1..120 characters', {
          details: { field: 'name', max_length: 120 },
        });
      }

      const usedByUser = countActiveChatsForUser(db, workspace.id, db.me.user.id);
      if (usedByUser >= db.admin.maxChatsPerUser) {
        return errorResponse(409, 'CHAT_LIMIT_REACHED', 'Chat limit reached', {
          details: { scope: 'USER', limit: db.admin.maxChatsPerUser, used: usedByUser },
        });
      }
      const usedInWorkspace = countActiveChatsInWorkspace(db, workspace.id);
      if (usedInWorkspace >= db.admin.maxChatsPerWorkspace) {
        return errorResponse(409, 'CHAT_LIMIT_REACHED', 'Chat limit reached', {
          details: {
            scope: 'WORKSPACE',
            limit: db.admin.maxChatsPerWorkspace,
            used: usedInWorkspace,
          },
        });
      }

      const chatId = newUuid();
      const now = new Date().toISOString();
      const chat: Chat = {
        id: chatId,
        type,
        security_mode: workspace.security_mode,
        peer_id: type === 'DIRECT' ? String(body.peer_id) : null,
        peer_has_e2ee_capable_devices: false,
        name: type === 'GROUP' ? name : null,
        last_seq: 1,
        unread_count: 0,
        created_at: now,
      };
      const systemMessage: ApiMessage = {
        id: newUuid(),
        chat_id: chatId,
        seq: 1,
        type: 'SYSTEM',
        sender_id: null,
        sender_display_name: null,
        text: 'Чат создан',
        reply_to_id: null,
        created_at: now,
        edited_at: null,
        deleted_at: null,
        version: 1,
        reactions: [],
      };
      db.chats[chatId] = {
        summary: {
          id: chatId,
          name: chat.name ?? null,
          type: chat.type,
          security_mode: chat.security_mode,
          peer_id: chat.peer_id ?? null,
          peer_has_e2ee_capable_devices: false,
          last_message_at: now,
          unread_count: 0,
          last_seq: 1,
        },
        workspaceId: workspace.id,
        messages: [systemMessage],
        clientMessageIds: new Map(),
        hiddenMessageIds: new Set(),
      };
      db.chatRequests.set(idempotencyKey, { bodyHash, chat });
      db.chatCreateRequests.push({ idempotencyKey, body });
      return HttpResponse.json(chat, { status: 201 });
    }),

    /* #73: metadata-only file center with filters, cursor and quota. */
    http.get(`${API}/files`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const url = new URL(request.url);
      const record: Record<string, string | null> = {};
      for (const key of [
        'workspace_id',
        'chat_id',
        'kind',
        'scan_status',
        'query',
        'mime',
        'extension',
        'cursor',
        'limit',
      ]) {
        record[key] = url.searchParams.get(key);
      }
      db.fileCenterRequests.push(record);
      if (db.fileCenterDelayMs > 0) await delay(db.fileCenterDelayMs);
      if (db.forceFileCenterError) {
        const forced = db.forceFileCenterError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const workspaceId = record.workspace_id;
      if (workspaceId) {
        const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }

      const kind = record.kind;
      if (kind && !['IMAGE', 'VIDEO', 'AUDIO', 'FILE'].includes(kind)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'kind is invalid', {
          details: { field: 'kind' },
        });
      }
      const scanStatus = record.scan_status;
      if (
        scanStatus &&
        !['PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED'].includes(scanStatus)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'scan_status is invalid', {
          details: { field: 'scan_status' },
        });
      }
      const limitRaw = record.limit;
      const limit = limitRaw === null ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be 1..100', {
          details: { field: 'limit' },
        });
      }

      let offset = 0;
      if (record.cursor) {
        try {
          const decoded = atob(record.cursor);
          if (!decoded.startsWith('file-center:')) throw new Error('bad prefix');
          offset = Number(decoded.slice('file-center:'.length));
          if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
        } catch {
          return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid', {
            details: { field: 'cursor' },
          });
        }
      }

      const query = record.query?.toLowerCase() ?? null;
      const mime = record.mime?.toLowerCase() ?? null;
      const extension = record.extension?.toLowerCase() ?? null;
      const filtered = db.fileCenterItems
        .filter((item) => !record.chat_id || item.chat_id === record.chat_id)
        .filter((item) => !kind || fileItemKind(item) === kind)
        .filter((item) => !scanStatus || item.scan_status === scanStatus)
        .filter((item) => {
          if (!query) return true;
          return (
            (item.filename ?? '').toLowerCase().includes(query) ||
            (item.mime_type ?? '').toLowerCase().includes(query)
          );
        })
        .filter((item) => !mime || (item.mime_type ?? '').toLowerCase() === mime)
        .filter(
          (item) =>
            !extension || (item.filename ?? '').split('.').pop()?.toLowerCase() === extension,
        )
        .sort((left, right) => {
          const byDate = right.created_at.localeCompare(left.created_at);
          return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
        });

      const pageItems = filtered.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      const hasMore = nextOffset < filtered.length;
      const quota = {
        used_bytes: db.limits.usage.used,
        reserved_bytes: db.limits.usage.reserved,
        storage_bytes: db.limits.storage_bytes,
        percent:
          db.limits.storage_bytes > 0
            ? Math.min(
                100,
                Math.round(
                  ((db.limits.usage.used + db.limits.usage.reserved) * 100) /
                    db.limits.storage_bytes,
                ),
              )
            : 0,
      };

      return HttpResponse.json({
        items: pageItems.map(fileItemView),
        page: {
          next_cursor: hasMore ? btoa(`file-center:${nextOffset}`) : null,
          has_more: hasMore,
        },
        quota,
      });
    }),

    http.get(`${API}/workspaces/:workspaceId/limits`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = db.me.workspaces.find((item) => item.id === String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);
      return HttpResponse.json({
        ...db.limits,
        max_chats_per_user: db.admin.maxChatsPerUser,
        chats_used: countActiveChatsForUser(db, workspace.id, db.me.user.id),
      });
    }),

    http.post(`${API}/uploads/preflight`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      if (db.forcePreflightError) {
        const forced = db.forcePreflightError;
        if (forced.once) db.forcePreflightError = null;
        return fileErrorResponse(
          forced.status,
          forced.code,
          forced.message,
          forced.details,
          forced.retryAfterSeconds,
        );
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }
      const candidate = body as { chat_id?: unknown; files?: unknown };
      if (typeof candidate.chat_id !== 'string' || !UUID_RE.test(candidate.chat_id)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'chat_id must be a UUID');
      }
      const chat = db.chats[candidate.chat_id];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
        return errorResponse(422, 'VALIDATION_FAILED', 'files must not be empty');
      }
      if (candidate.files.length > 10) {
        return fileErrorResponse(422, 'TOO_MANY_FILES', 'Too many files in one message', {
          limit: 10,
          actual: candidate.files.length,
        });
      }

      const files = candidate.files as PreflightFile[];
      const maxFileBytes = effectiveFileMax(db, chat.workspaceId);
      const maxAttachments = db.limits.max_attachments;
      let available = quotaAvailable(db);
      const decisions: PreflightDecision[] = [];

      for (const file of files) {
        const name = typeof file.name === 'string' ? file.name : '';
        const size = typeof file.size === 'number' ? file.size : 0;
        const mime = typeof file.mime === 'string' ? file.mime : null;
        const denied = (error: string, details?: Record<string, unknown>): PreflightDecision => ({
          name,
          allowed: false,
          error,
          ...(details ? { details } : {}),
        });

        if (!name || name.length > 255) {
          decisions.push(denied('VALIDATION_FAILED', { reason: 'name' }));
        } else if (!Number.isInteger(size) || size < 1) {
          decisions.push(denied('VALIDATION_FAILED', { reason: 'size' }));
        } else if (size > maxFileBytes) {
          decisions.push(
            denied('FILE_TOO_LARGE', {
              limit: maxFileBytes,
              actual: size,
              tariff: db.limits.tariff,
            }),
          );
        } else if (isDangerousFile(name, mime)) {
          decisions.push(denied('DANGEROUS_TYPE_BLOCKED', { mime, policy: 'blocked_extensions' }));
        } else if (size > available) {
          decisions.push(
            denied('QUOTA_EXCEEDED', {
              used: db.limits.usage.used,
              reserved: db.limits.usage.reserved,
              limit: db.limits.usage.limit,
              required: size,
            }),
          );
        } else {
          available -= size;
          decisions.push({
            name,
            allowed: true,
            error: null,
            part_size: PART_SIZE,
          });
        }
      }

      const response = {
        decision: decisions.some((decision) => decision.allowed) ? 'ALLOW' : 'DENY',
        max_file_bytes: maxFileBytes,
        max_attachments: maxAttachments,
        quota: { ...db.limits.usage },
        files: decisions,
      };
      db.preflightRequests.push({
        idempotencyKey,
        chatId: chat.summary.id,
        files,
      });
      return HttpResponse.json(response);
    }),

    http.post(`${API}/uploads`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }
      const candidate = body as Partial<UploadInitRequest>;
      const bodyHash = canonicalJson(candidate);

      const replay = db.uploadIdempotency.get(idempotencyKey);
      if (replay) {
        if (replay.bodyHash !== bodyHash) {
          return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused');
        }
        const upload = db.uploads.get(replay.uploadId);
        if (upload) {
          return HttpResponse.json(uploadSession(upload), {
            status: 201,
            headers: { 'Idempotent-Replay': 'true' },
          });
        }
      }

      if (db.forceInitError) {
        const forced = db.forceInitError;
        if (forced.once) db.forceInitError = null;
        return fileErrorResponse(
          forced.status,
          forced.code,
          forced.message,
          forced.details,
          forced.retryAfterSeconds,
        );
      }

      if (
        typeof candidate.chat_id !== 'string' ||
        !UUID_RE.test(candidate.chat_id) ||
        typeof candidate.filename !== 'string' ||
        candidate.filename.length === 0 ||
        candidate.filename.length > 255 ||
        !Number.isInteger(candidate.size) ||
        (candidate.size ?? 0) < 1 ||
        candidate.encryption_mode !== 'MANAGED'
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Invalid upload init body');
      }

      const chat = db.chats[candidate.chat_id];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (candidate.mime !== undefined && typeof candidate.mime !== 'string') {
        return errorResponse(422, 'VALIDATION_FAILED', 'mime must be a string');
      }
      if (candidate.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'sha256 must be lowercase hex');
      }

      const maxFileBytes = effectiveFileMax(db, chat.workspaceId);
      if (candidate.size! > maxFileBytes) {
        return fileErrorResponse(413, 'FILE_TOO_LARGE', 'File exceeds the workspace limit', {
          limit: maxFileBytes,
          actual: candidate.size,
          tariff: db.limits.tariff,
        });
      }
      if (candidate.size! > quotaAvailable(db)) {
        return fileErrorResponse(409, 'QUOTA_EXCEEDED', 'Workspace quota exceeded', {
          used: db.limits.usage.used,
          reserved: db.limits.usage.reserved,
          limit: db.limits.usage.limit,
          required: candidate.size,
        });
      }

      const totalParts = Math.ceil(candidate.size! / PART_SIZE);
      if (totalParts > MAX_PARTS) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Too many upload parts');
      }

      const uploadId = newUuid();
      const upload: MockUpload = {
        id: uploadId,
        chatId: chat.summary.id,
        filename: candidate.filename,
        size: candidate.size!,
        mime: candidate.mime ?? null,
        media: candidate.media ?? null,
        declaredSha256: candidate.sha256 ?? null,
        partSize: PART_SIZE,
        totalParts,
        received: new Map(),
        status: 'INIT',
        expiresAt: Date.now() + UPLOAD_TTL_MS,
        attachmentId: null,
        scanStatus: 'PENDING',
        scanPollsRemaining: db.scanPolls,
        finalizedSha256: null,
        createdAt: Date.now(),
        reservedReleased: false,
      };
      db.uploads.set(uploadId, upload);
      db.limits.usage.reserved += candidate.size!;
      db.uploadInits.push({
        idempotencyKey,
        uploadId,
        bodyHash,
        body: candidate as UploadInitRequest,
      });
      db.uploadIdempotency.set(idempotencyKey, {
        idempotencyKey,
        uploadId,
        bodyHash,
        body: candidate as UploadInitRequest,
      });

      return HttpResponse.json(uploadSession(upload), { status: 201 });
    }),

    http.get(`${API}/uploads/:uploadId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      const upload = db.uploads.get(String(params.uploadId));
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Upload not found');
      if (expireUpload(db, upload)) {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload has expired', {
          expired_at: new Date(upload.expiresAt).toISOString(),
        });
      }

      if (upload.status === 'SCANNING') {
        if (upload.scanPollsRemaining > 0) upload.scanPollsRemaining -= 1;
        if (upload.scanPollsRemaining === 0) finalizeScan(db, upload);
      }

      return HttpResponse.json(uploadSession(upload));
    }),

    http.put(`${API}/uploads/:uploadId/parts/:partNo`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.partDelayMs > 0) await delay(db.partDelayMs);

      const upload = db.uploads.get(String(params.uploadId));
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Upload not found');
      if (expireUpload(db, upload)) {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload has expired');
      }
      if (upload.status === 'BOUND' || upload.status === 'ABORTED') {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload is no longer writable');
      }
      if (upload.status === 'SCANNING' || upload.status === 'READY') {
        return errorResponse(409, 'UPLOAD_LOCKED', 'Upload is completing or scanning');
      }

      const partNo = Number.parseInt(String(params.partNo), 10);
      if (!Number.isInteger(partNo) || partNo < 1 || partNo > upload.totalParts) {
        return errorResponse(422, 'VALIDATION_FAILED', 'partNo is out of range');
      }

      const declared = request.headers.get('content-sha256') ?? '';
      if (!/^[a-f0-9]{64}$/.test(declared)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Content-SHA256 is required');
      }

      if (db.failNextPart > 0) {
        db.failNextPart -= 1;
        return errorResponse(500, 'INTERNAL', 'Temporary mock part failure');
      }
      if (db.forcePartError) {
        const forced = db.forcePartError;
        if (forced.partNo === undefined || forced.partNo === partNo) {
          if (forced.once) db.forcePartError = null;
          return fileErrorResponse(
            forced.status,
            forced.code,
            forced.message,
            forced.details,
            forced.retryAfterSeconds,
          );
        }
      }

      const bytes = await bytesToPart(request);
      const expectedSize = partSizeFor(upload, partNo);
      if (bytes.length !== expectedSize) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Unexpected part size', {
          details: { expected: expectedSize, actual: bytes.length },
        });
      }
      const actualSha = sha256Bytes(bytes);
      if (actualSha !== declared) {
        return fileErrorResponse(422, 'CHUNK_HASH_MISMATCH', 'Chunk hash mismatch', {
          part_no: partNo,
          expected: actualSha,
          actual: declared,
        });
      }

      const existing = upload.received.get(partNo);
      if (existing) {
        if (existing.sha256 !== actualSha) {
          return fileErrorResponse(
            409,
            'CHUNK_CONFLICT',
            'Part already uploaded with another hash',
            {
              part_no: partNo,
            },
          );
        }
        return HttpResponse.json({
          part_no: partNo,
          received: true,
          etag: actualSha,
          size_bytes: bytes.length,
        });
      }

      upload.received.set(partNo, {
        sha256: actualSha,
        sizeBytes: bytes.length,
        bytes,
      });
      upload.status = 'UPLOADING';
      db.partUploads.push({
        uploadId: upload.id,
        partNo,
        sha256: actualSha,
        sizeBytes: bytes.length,
      });

      return HttpResponse.json({
        part_no: partNo,
        received: true,
        etag: actualSha,
        size_bytes: bytes.length,
      });
    }),

    http.post(`${API}/uploads/:uploadId/complete`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      const upload = db.uploads.get(String(params.uploadId));
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Upload not found');
      if (expireUpload(db, upload)) {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload has expired');
      }
      if (upload.status === 'SCANNING' || upload.status === 'READY' || upload.status === 'BOUND') {
        return HttpResponse.json(uploadSession(upload), {
          status: upload.status === 'SCANNING' ? 202 : 200,
          headers: { 'Idempotent-Replay': 'true' },
        });
      }
      if (upload.status === 'ABORTED') {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload was aborted');
      }

      if (db.failNextComplete > 0) {
        db.failNextComplete -= 1;
        return errorResponse(500, 'INTERNAL', 'Temporary mock complete failure');
      }
      if (db.forceCompleteError) {
        const forced = db.forceCompleteError;
        if (forced.once) db.forceCompleteError = null;
        return fileErrorResponse(
          forced.status,
          forced.code,
          forced.message,
          forced.details,
          forced.retryAfterSeconds,
        );
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }
      const candidate = body as { sha256?: unknown; parts_count?: unknown };
      if (
        typeof candidate.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
        !Number.isInteger(candidate.parts_count) ||
        (candidate.parts_count as number) < 1
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Invalid complete body');
      }

      const missing: number[] = [];
      for (let partNo = 1; partNo <= upload.totalParts; partNo += 1) {
        if (!upload.received.has(partNo)) missing.push(partNo);
      }
      if (missing.length > 0) {
        return fileErrorResponse(409, 'CONFLICT', 'Upload has missing parts', {
          missing_parts: missing,
        });
      }
      if (candidate.parts_count !== upload.received.size) {
        return errorResponse(422, 'VALIDATION_FAILED', 'parts_count does not match received parts');
      }

      const finalSha = sha256Bytes(concatParts(upload));
      if (finalSha !== candidate.sha256) {
        return fileErrorResponse(422, 'CHUNK_HASH_MISMATCH', 'Final file hash mismatch', {
          expected: finalSha,
          actual: candidate.sha256,
        });
      }

      upload.finalizedSha256 = finalSha;
      upload.status = 'SCANNING';
      upload.scanStatus = 'PENDING';
      upload.scanPollsRemaining = db.scanPolls;
      upload.attachmentId = newUuid();
      db.attachments.set(upload.attachmentId, {
        ref: attachmentRef(upload.attachmentId, upload, 'PENDING'),
        uploadId: upload.id,
        messageId: null,
      });

      // Reservation -> committed on complete (E4-D-03). Release once.
      if (!upload.reservedReleased) {
        db.limits.usage.reserved = Math.max(0, db.limits.usage.reserved - upload.size);
        db.limits.usage.used += upload.size;
        upload.reservedReleased = true;
      }

      const idempotencyKey = request.headers.get('idempotency-key');
      if (idempotencyKey) {
        db.completeRequests.push({
          uploadId: upload.id,
          idempotencyKey,
          body: candidate as { sha256: string; parts_count: number },
        });
      }

      if (upload.scanPollsRemaining <= 0) finalizeScan(db, upload);
      return HttpResponse.json(uploadSession(upload), {
        status: upload.status === 'SCANNING' ? 202 : 200,
      });
    }),

    http.post(`${API}/uploads/:uploadId/abort`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      const upload = db.uploads.get(String(params.uploadId));
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Upload not found');
      if (upload.status === 'ABORTED') return new HttpResponse(null, { status: 204 });
      if (upload.status === 'BOUND') {
        return errorResponse(409, 'CONFLICT', 'Upload is already bound to a message');
      }
      if (expireUpload(db, upload)) {
        return fileErrorResponse(410, 'UPLOAD_EXPIRED', 'Upload has expired');
      }

      if (!upload.reservedReleased) {
        db.limits.usage.reserved = Math.max(0, db.limits.usage.reserved - upload.size);
      } else {
        db.limits.usage.used = Math.max(0, db.limits.usage.used - upload.size);
      }
      if (upload.attachmentId) db.attachments.delete(upload.attachmentId);
      upload.attachmentId = null;
      upload.status = 'ABORTED';
      upload.reservedReleased = true;
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';
      db.aborts.push({ uploadId: upload.id, idempotencyKey });
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/attachments/:attachmentId/download-url`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      if (db.forceDownloadError) {
        const forced = db.forceDownloadError;
        if (forced.once) db.forceDownloadError = null;
        return fileErrorResponse(
          forced.status,
          forced.code,
          forced.message,
          forced.details,
          forced.retryAfterSeconds,
        );
      }

      const attachment = db.attachments.get(String(params.attachmentId));
      if (!attachment) return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
      const upload = db.uploads.get(attachment.uploadId);
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Attachment not found');

      if (upload.status === 'EXPIRED' || upload.status === 'ABORTED') {
        return fileErrorResponse(410, 'ATTACHMENT_DELETED', 'Attachment was deleted');
      }
      if (upload.status === 'QUARANTINED' || attachment.ref.scan_status === 'INFECTED') {
        return fileErrorResponse(423, 'ATTACHMENT_QUARANTINED', 'Attachment is quarantined', {
          reason: 'INFECTED',
        });
      }
      if (attachment.ref.scan_status !== 'CLEAN' || upload.status === 'SCANNING') {
        return fileErrorResponse(409, 'SCAN_PENDING', 'Attachment is still being scanned', {
          status: attachment.ref.scan_status,
        });
      }
      if (upload.status !== 'READY' && upload.status !== 'BOUND') {
        return fileErrorResponse(409, 'SCAN_PENDING', 'Attachment is not ready', {
          status: upload.status,
        });
      }

      const issuedAt = Date.now();
      const expiresAt = issuedAt + DOWNLOAD_TTL_MS;
      db.downloadRequests.push({
        attachmentId: attachment.ref.id,
        issuedAt,
        expiresAt,
        sizeBytes: attachment.ref.size_bytes,
        sha256: upload.finalizedSha256 ?? '',
      });

      return HttpResponse.json({
        url: `http://localhost:9002/krug/${attachment.ref.id}?X-Amz-Expires=300&X-Amz-Signature=mock`,
        expires_at: new Date(expiresAt).toISOString(),
        size_bytes: attachment.ref.size_bytes,
        sha256: upload.finalizedSha256 ?? '',
      });
    }),

    /**
     * Mock "presigned MinIO" object. It serves the uploaded bytes for media
     * MIME types only, so image/video/audio previews can be exercised without
     * a real S3/MinIO. Non-media objects stay unreachable, mirroring the
     * "no SVG/HTML as media" rule.
     */
    http.get(`${MOCK_MEDIA_ORIGIN}/krug/:attachmentId`, ({ params }) => {
      const attachment = db.attachments.get(String(params.attachmentId));
      if (!attachment) return new HttpResponse(null, { status: 404 });
      const upload = db.uploads.get(attachment.uploadId);
      if (!upload) return new HttpResponse(null, { status: 404 });
      const mime = attachment.ref.mime_type ?? 'application/octet-stream';
      if (!/^(image|video|audio)\//i.test(mime)) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(uploadedBytes(upload), {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(upload.size),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }),

    http.get(`${API}/chats/:chatId/messages`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');

      const url = new URL(request.url);
      const afterSeq = parseSeq(url.searchParams.get('after_seq'));
      const beforeSeq = parseSeq(url.searchParams.get('before_seq'));
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;

      // D1-FE3: with `thread_root_id` the server pages replies of one root;
      // without it only the main feed (`thread_root_id = null`) is returned.
      const rawThreadRootId = url.searchParams.get('thread_root_id');
      let threadRootId: string | null = null;
      if (rawThreadRootId !== null) {
        if (!UUID_RE.test(rawThreadRootId)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'thread_root_id must be a UUID');
        }
        const invalid = validateThreadRoot(chat, rawThreadRootId);
        if (invalid) return invalid;
        threadRootId = rawThreadRootId;
        if (db.forceThreadError) {
          const forced = db.forceThreadError;
          return errorResponse(forced.status, forced.code, forced.message, {
            details: forced.details,
            retryAfterSeconds: forced.retryAfterSeconds,
          });
        }
      }

      const sorted = [...chat.messages]
        .sort((a, b) => a.seq - b.seq)
        .filter((message) =>
          threadRootId === null ? !message.thread_root_id : message.thread_root_id === threadRootId,
        )
        // #63 `scope=me`: hidden rows disappear from this caller's pages only.
        .filter((message) => !chat.hiddenMessageIds.has(message.id));
      let pageItems = sorted;
      let hasMore = false;

      if (afterSeq !== null) {
        const newer = sorted.filter((message) => message.seq > afterSeq);
        hasMore = newer.length > limit;
        pageItems = newer.slice(0, limit);
      } else if (beforeSeq !== null) {
        const older = sorted.filter((message) => message.seq < beforeSeq);
        hasMore = older.length > limit;
        pageItems = older.slice(-limit);
      } else {
        hasMore = sorted.length > limit;
        pageItems = sorted.slice(-limit);
      }

      return HttpResponse.json({
        items: pageItems.map((message) => presentMessage(chat, message)),
        page: { next_cursor: null, has_more: hasMore },
      });
    }),

    http.post(`${API}/chats/:chatId/messages`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');

      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }

      const candidate = body as Partial<MessageCreateBody>;
      const bodyHash = canonicalJson(candidate);

      db.sendAttempts.push({
        idempotencyKey,
        clientMessageId: candidate.client_message_id ?? '',
        bodyHash,
      });
      db.sendBodies.push(candidate as Record<string, unknown>);

      if (db.sendDelayMs > 0) await delay(db.sendDelayMs);

      const replay = db.idempotency.get(idempotencyKey);
      if (replay) {
        if (replay.bodyHash !== bodyHash) {
          return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused', {
            details: { original_request_hash: replay.bodyHash },
          });
        }
        return HttpResponse.json(presentMessage(chat, replay.body), {
          status: replay.status,
          headers: { ...replay.headers, 'Idempotent-Replay': 'true' },
        });
      }

      if (db.forceSendError) {
        const forced = db.forceSendError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (db.failNextSend > 0) {
        db.failNextSend -= 1;
        return errorResponse(500, 'INTERNAL', 'Temporary mock failure');
      }

      if (candidate.type !== 'TEXT' && candidate.type !== 'STICKER') {
        return errorResponse(400, 'VALIDATION_FAILED', 'type must be TEXT or STICKER');
      }
      if (
        typeof candidate.client_message_id !== 'string' ||
        !UUID_RE.test(candidate.client_message_id)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'client_message_id must be a UUID');
      }
      if (
        candidate.reply_to_id !== undefined &&
        candidate.reply_to_id !== null &&
        typeof candidate.reply_to_id !== 'string'
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'reply_to_id must be a UUID or null');
      }

      // D1-FE3: same-chat / depth-1 / deleted-root / E2EE guards (contract 422).
      const threadRootId = candidate.thread_root_id ?? null;
      if (threadRootId !== null) {
        if (typeof threadRootId !== 'string' || !UUID_RE.test(threadRootId)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'thread_root_id must be a UUID');
        }
        const invalid = validateThreadRoot(chat, threadRootId);
        if (invalid) return invalid;
      }

      let text: string | null | undefined;
      const attachments: ApiAttachment[] = [];
      let sticker: StickerRef | null = null;

      if (candidate.type === 'STICKER') {
        const rawText = candidate.text;
        const rawAttachments = candidate.attachment_ids;
        const hasText = typeof rawText === 'string' && rawText.length > 0;
        const hasAttachments = Array.isArray(rawAttachments) && rawAttachments.length > 0;
        if (
          hasText ||
          hasAttachments ||
          (rawText !== undefined && rawText !== null && typeof rawText !== 'string') ||
          (rawAttachments !== undefined &&
            rawAttachments !== null &&
            !Array.isArray(rawAttachments))
        ) {
          return errorResponse(
            422,
            'INVALID_STICKER_MESSAGE',
            'A sticker message accepts exactly one sticker and no text or attachments',
          );
        }
        if (typeof candidate.sticker_id !== 'string' || !UUID_RE.test(candidate.sticker_id)) {
          return errorResponse(422, 'INVALID_STICKER_MESSAGE', 'sticker_id must be a UUID');
        }

        const record = findStickerRecord(db, candidate.sticker_id);
        if (!record) {
          return errorResponse(404, 'STICKER_NOT_FOUND', 'Sticker not found');
        }
        if (db.disabledStickerPacks.has(record.packId)) {
          return errorResponse(409, 'STICKER_PACK_DISABLED', 'Sticker pack is disabled', {
            details: { pack_id: record.packId, status: 'DISABLED' },
          });
        }
        sticker = presentSticker(db, record.sticker);
        text = null;
      } else {
        const attachmentIds = candidate.attachment_ids;
        if (attachmentIds !== undefined && !Array.isArray(attachmentIds)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'attachment_ids must be an array');
        }
        if (attachmentIds && attachmentIds.length > 10) {
          return errorResponse(422, 'TOO_MANY_FILES', 'Too many attachments', {
            details: { limit: 10, actual: attachmentIds.length },
          });
        }
        if (attachmentIds && new Set(attachmentIds).size !== attachmentIds.length) {
          return errorResponse(422, 'VALIDATION_FAILED', 'attachment_ids must be unique');
        }

        for (const attachmentId of attachmentIds ?? []) {
          if (typeof attachmentId !== 'string' || !UUID_RE.test(attachmentId)) {
            return errorResponse(400, 'VALIDATION_FAILED', 'attachment_ids must be UUIDs');
          }
          const attachment = db.attachments.get(attachmentId);
          const upload = attachment ? db.uploads.get(attachment.uploadId) : undefined;
          if (!attachment || !upload) {
            return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
          }
          if (upload.chatId !== chat.summary.id) {
            return errorResponse(403, 'FORBIDDEN', 'Attachment belongs to another chat');
          }
          if (attachment.messageId) {
            return errorResponse(409, 'CONFLICT', 'Attachment is already bound');
          }
          if (upload.status === 'QUARANTINED' || attachment.ref.scan_status === 'INFECTED') {
            return errorResponse(423, 'ATTACHMENT_QUARANTINED', 'Attachment is quarantined', {
              details: { attachment_id: attachmentId, status: upload.status },
            });
          }
          if (upload.status !== 'READY' || attachment.ref.scan_status !== 'CLEAN') {
            return errorResponse(409, 'ATTACHMENT_NOT_READY', 'Attachment is not ready', {
              details: { attachment_id: attachmentId, status: upload.status },
            });
          }
          attachments.push(attachment.ref);
        }

        text = candidate.text;
        if (text !== undefined && text !== null && typeof text !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'text must be a string or null');
        }
        if (typeof text === 'string' && text.length > 8000) {
          return errorResponse(422, 'MESSAGE_TOO_LONG', 'Message text is too long', {
            details: { max_length: 8000 },
          });
        }
        const envelopes = candidate.envelopes;
        const isE2ee = Array.isArray(envelopes) && envelopes.length > 0;
        if (isE2ee) {
          // E2EE body: envelopes only, no plaintext fields (contract §4.2).
          if (
            (typeof text === 'string' && text.length > 0) ||
            attachments.length > 0 ||
            candidate.reply_to_id !== undefined ||
            threadRootId !== null
          ) {
            return errorResponse(
              422,
              'E2EE_PLAINTEXT_FORBIDDEN',
              'E2EE messages must not contain plaintext fields',
            );
          }
          if (envelopes.length > 10) {
            return errorResponse(422, 'TOO_MANY_ENVELOPES', 'Too many envelopes');
          }
          const recipients = envelopes.map((envelope) => envelope.recipient_device_id);
          if (new Set(recipients).size !== recipients.length) {
            return errorResponse(422, 'DUPLICATE_ENVELOPE', 'Duplicate envelope');
          }
        } else if (
          (text === undefined || text === null || text.length === 0) &&
          attachments.length === 0
        ) {
          return errorResponse(400, 'VALIDATION_FAILED', 'text or attachment_ids must be present');
        }
      }

      // Contract §7.3: client_message_id survives the Idempotency-Key TTL.
      const existingId = chat.clientMessageIds.get(candidate.client_message_id);
      if (existingId) {
        const existing = chat.messages.find((message) => message.id === existingId);
        if (existing) {
          db.idempotency.set(idempotencyKey, {
            bodyHash,
            status: 201,
            body: existing,
            headers: {},
          });
          return HttpResponse.json(presentMessage(chat, existing), {
            status: 201,
            headers: { 'Idempotent-Replay': 'true' },
          });
        }
      }

      const seq = chat.summary.last_seq + 1;
      const created = new Date().toISOString();
      const message: ApiMessage = {
        id: messageId(seq),
        chat_id: chat.summary.id,
        seq,
        type: sticker ? 'STICKER' : 'TEXT',
        sender_id: db.session.user.id,
        sender_display_name: db.session.user.display_name,
        text: sticker ? null : typeof text === 'string' && text.length > 0 ? text : null,
        reply_to_id: candidate.reply_to_id ?? null,
        thread_root_id: threadRootId,
        client_message_id: candidate.client_message_id,
        crypto: null,
        created_at: created,
        edited_at: null,
        deleted_at: null,
        version: 1,
        reactions: [],
        ...(sticker ? { sticker_id: sticker.id, sticker } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };

      for (const attachment of attachments) {
        const bound = db.attachments.get(attachment.id);
        const upload = bound ? db.uploads.get(bound.uploadId) : undefined;
        if (bound && upload) {
          upload.status = 'BOUND';
          bound.messageId = message.id;
        }
      }

      chat.messages.push(message);
      chat.summary.last_seq = seq;
      chat.summary.last_message_at = created;
      chat.summary.unread_count = 0;
      chat.clientMessageIds.set(candidate.client_message_id, message.id);

      db.idempotency.set(idempotencyKey, {
        bodyHash,
        status: 201,
        body: message,
        headers: {},
      });

      publishMockMessageCreated(db, message);

      return HttpResponse.json(presentMessage(chat, message), { status: 201 });
    }),

    /*
     * #61–#63 message actions (MSW parity with the backend contract):
     * managed-only reaction/edit metadata, opaque idempotent reactions,
     * optimistic-lock edit (409), and delete scope=me|all.
     */

    http.post(`${API}/chats/:chatId/messages/:messageId/reactions`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (chat.summary.security_mode === 'E2EE') {
        return errorResponse(
          422,
          'E2EE_METADATA_FORBIDDEN',
          'Reactions are not available in an E2EE chat',
        );
      }
      const message = visibleMessage(chat, String(params.messageId));
      if (!message || message.deleted_at) {
        return errorResponse(404, 'NOT_FOUND', 'Message not found');
      }
      if (message.type === 'SYSTEM') {
        return errorResponse(422, 'MESSAGE_NOT_EDITABLE', 'System messages accept no reactions');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }
      const emoji = (body as { emoji?: unknown }).emoji;
      if (!validReactionEmoji(emoji)) {
        return errorResponse(
          400,
          'VALIDATION_FAILED',
          'emoji must be 1..32 Unicode characters without spaces or HTML',
        );
      }

      db.reactionRequests.push({
        chatId: chat.summary.id,
        messageId: message.id,
        emoji,
        action: 'ADD',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceReactionError) {
        const forced = db.forceReactionError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const userId = db.session.user.id;
      const reactions = [...(message.reactions ?? [])];
      const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
      const current = index >= 0 ? reactions[index] : undefined;
      // Idempotent per (message, user, emoji): the mock has one caller.
      const next: ReactionSummary =
        current && current.me
          ? { ...current }
          : { emoji, count: (current?.count ?? 0) + 1, me: true };
      if (index >= 0) reactions[index] = next;
      else reactions.push(next);
      message.reactions = reactions;

      publishMockReactionChanged(
        db,
        chat.summary.id,
        message.id,
        userId,
        emoji,
        'ADDED',
        next.count,
      );
      return HttpResponse.json(next, { status: 200 });
    }),

    http.delete(
      `${API}/chats/:chatId/messages/:messageId/reactions/:emoji`,
      ({ request, params }) => {
        const unauthorized = requireAuth(request);
        if (unauthorized) return unauthorized;

        const chat = db.chats[String(params.chatId)];
        if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
        if (chat.summary.security_mode === 'E2EE') {
          return errorResponse(
            422,
            'E2EE_METADATA_FORBIDDEN',
            'Reactions are not available in an E2EE chat',
          );
        }
        const message = visibleMessage(chat, String(params.messageId));
        if (!message || message.deleted_at) {
          return errorResponse(404, 'NOT_FOUND', 'Message not found');
        }

        let emoji = String(params.emoji);
        try {
          emoji = decodeURIComponent(emoji);
        } catch {
          return errorResponse(400, 'VALIDATION_FAILED', 'emoji path segment is malformed');
        }
        if (!validReactionEmoji(emoji)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'emoji is invalid');
        }

        db.reactionRequests.push({
          chatId: chat.summary.id,
          messageId: message.id,
          emoji,
          action: 'REMOVE',
          deviceId: request.headers.get('x-device-id'),
        });
        if (db.forceReactionError) {
          const forced = db.forceReactionError;
          return errorResponse(forced.status, forced.code, forced.message, {
            details: forced.details,
            retryAfterSeconds: forced.retryAfterSeconds,
          });
        }

        const reactions = [...(message.reactions ?? [])];
        const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
        const current = index >= 0 ? reactions[index] : undefined;
        if (current?.me) {
          const count = Math.max(0, current.count - 1);
          if (count === 0) reactions.splice(index, 1);
          else reactions[index] = { emoji, count, me: false };
          message.reactions = reactions;
          publishMockReactionChanged(
            db,
            chat.summary.id,
            message.id,
            db.session.user.id,
            emoji,
            'REMOVED',
            count,
          );
        }
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.patch(`${API}/chats/:chatId/messages/:messageId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (chat.summary.security_mode === 'E2EE') {
        return errorResponse(
          422,
          'E2EE_METADATA_FORBIDDEN',
          'Editing is not available in an E2EE chat',
        );
      }
      const message = visibleMessage(chat, String(params.messageId));
      if (!message || message.deleted_at) {
        return errorResponse(404, 'NOT_FOUND', 'Message not found');
      }
      if (message.type !== 'TEXT') {
        return errorResponse(422, 'MESSAGE_NOT_EDITABLE', 'Only TEXT messages can be edited');
      }
      if (message.sender_id !== db.session.user.id) {
        return errorResponse(403, 'FORBIDDEN', 'Only the author can edit this message');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      }
      const candidate = body as { text?: unknown; version?: unknown };
      if (typeof candidate.text !== 'string') {
        return errorResponse(400, 'VALIDATION_FAILED', 'text is required');
      }
      const text = candidate.text;
      if (text.trim().length < 1) {
        return errorResponse(422, 'VALIDATION_FAILED', 'text must not be empty');
      }
      if (text.length > 8000) {
        return errorResponse(422, 'MESSAGE_TOO_LONG', 'Message text is too long', {
          details: { max_length: 8000 },
        });
      }
      if (
        candidate.version !== undefined &&
        candidate.version !== null &&
        (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version))
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'version must be an integer');
      }

      db.editRequests.push({
        chatId: chat.summary.id,
        messageId: message.id,
        body: { text, version: candidate.version ?? null },
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceEditError) {
        const forced = db.forceEditError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (typeof candidate.version === 'number' && candidate.version !== message.version) {
        return errorResponse(409, 'VERSION_CONFLICT', 'Message was changed on another device', {
          details: { current_version: message.version },
        });
      }

      message.text = text;
      message.edited_at = new Date().toISOString();
      message.version += 1;
      publishMockMessageUpdated(db, message);
      return HttpResponse.json(presentMessage(chat, message), { status: 200 });
    }),

    http.delete(`${API}/chats/:chatId/messages/:messageId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const message = chat.messages.find((item) => item.id === String(params.messageId));
      if (!message) return errorResponse(404, 'NOT_FOUND', 'Message not found');

      const url = new URL(request.url);
      const rawScope = url.searchParams.get('scope');
      const scope = rawScope ?? 'me';
      if (scope !== 'me' && scope !== 'all') {
        return errorResponse(400, 'VALIDATION_FAILED', 'scope must be me or all');
      }

      db.deleteRequests.push({
        chatId: chat.summary.id,
        messageId: message.id,
        scope,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceDeleteError) {
        const forced = db.forceDeleteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      if (scope === 'me') {
        // Per-user marker: idempotent and invisible to other participants.
        chat.hiddenMessageIds.add(message.id);
        return new HttpResponse(null, { status: 204 });
      }

      if (message.sender_id !== db.session.user.id) {
        return errorResponse(403, 'FORBIDDEN', 'Only the author can delete for everyone');
      }
      if (message.deleted_at) return new HttpResponse(null, { status: 204 });

      const deletedAt = new Date().toISOString();
      message.deleted_at = deletedAt;
      message.text = null;
      message.edited_at = null;
      message.reactions = [];
      message.attachments = [];
      message.sticker = undefined;
      message.sticker_id = null;
      message.crypto = null;
      for (const attachment of db.attachments.values()) {
        if (attachment.messageId === message.id) attachment.messageId = null;
      }
      publishMockMessageDeleted(db, chat.summary.id, message.id, deletedAt, db.session.user.id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/chats/:chatId/read`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const chat = db.chats[String(params.chatId)];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');

      const body = await readJson(request);
      const lastSeq =
        body !== null && typeof body === 'object'
          ? (body as { last_seq?: unknown }).last_seq
          : undefined;

      if (typeof lastSeq !== 'number' || !Number.isInteger(lastSeq) || lastSeq < 0) {
        return errorResponse(422, 'VALIDATION_FAILED', 'last_seq must be a non-negative integer');
      }
      if (lastSeq > chat.summary.last_seq) {
        return errorResponse(422, 'SEQ_OUT_OF_RANGE', 'last_seq is ahead of the chat', {
          details: { last_seq: chat.summary.last_seq },
        });
      }

      db.readReceipts[chat.summary.id] = lastSeq;
      chat.summary.unread_count = 0;
      return new HttpResponse(null, { status: 204 });
    }),

    /* E6-F notifications ------------------------------------------------ */

    http.get(`${API}/notifications`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.notificationsDelayMs > 0) await delay(db.notificationsDelayMs);

      if (db.forceNotificationsError) {
        const forced = db.forceNotificationsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (db.failNextNotifications > 0) {
        db.failNextNotifications -= 1;
        return errorResponse(500, 'INTERNAL', 'Notifications are temporarily unavailable');
      }

      const url = new URL(request.url);
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 30 : Number.parseInt(limitRaw, 10);
      if (
        limitRaw !== null &&
        (!/^\d+$/.test(limitRaw) || !Number.isFinite(limit) || limit < 1 || limit > 100)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be between 1 and 100');
      }

      const cursorRaw = url.searchParams.get('cursor');
      const cursor = cursorRaw ? decodeNotificationCursor(cursorRaw) : null;
      if (cursorRaw && !cursor) {
        return errorResponse(400, 'INVALID_CURSOR', 'Notification cursor is invalid');
      }

      db.notificationListRequests.push({ cursor: cursorRaw, limit });

      const mine = db.notifications
        .filter((notification) => notification.user_id === db.me.user.id)
        .sort(
          (left, right) =>
            right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
        );
      const filtered = cursor
        ? mine.filter(
            (notification) =>
              notification.created_at < cursor.created_at ||
              (notification.created_at === cursor.created_at && notification.id < cursor.id),
          )
        : mine;
      const pageItems = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const last = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && last ? encodeNotificationCursor(last) : null;

      return HttpResponse.json({
        items: pageItems.map((notification) => notificationDto(notification)),
        page: { next_cursor: nextCursor, has_more: hasMore },
        unread_count: mine.filter((notification) => !notification.read).length,
      });
    }),

    http.post(`${API}/notifications/read`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.notificationsDelayMs > 0) await delay(db.notificationsDelayMs);

      if (db.forceNotificationReadError) {
        const forced = db.forceNotificationReadError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (db.failNextNotificationRead > 0) {
        db.failNextNotificationRead -= 1;
        return errorResponse(500, 'INTERNAL', 'Could not mark notifications as read');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Read body must be an object');
      }
      const candidate = body as { ids?: unknown; all?: unknown };
      const all = candidate.all === true;
      const ids = candidate.ids;

      if (!all && !Array.isArray(ids)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Either ids or all is required');
      }
      if (Array.isArray(ids)) {
        if (ids.length > 100) {
          return errorResponse(422, 'VALIDATION_FAILED', 'At most 100 ids are allowed');
        }
        for (const id of ids) {
          if (typeof id !== 'string' || !UUID_RE.test(id)) {
            return errorResponse(422, 'VALIDATION_FAILED', 'Notification ids must be UUIDs');
          }
        }
      }

      if (all) {
        for (const notification of db.notifications) {
          if (notification.user_id === db.me.user.id) notification.read = true;
        }
      } else if (Array.isArray(ids)) {
        const requested = new Set(ids);
        for (const notification of db.notifications) {
          if (notification.user_id === db.me.user.id && requested.has(notification.id)) {
            notification.read = true;
          }
        }
      }

      const record: ReadNotificationsRequest = all
        ? { all: true }
        : { all: false, ids: ids as string[] };
      db.notificationReadRequests.push({
        body: record,
        idempotencyKey: request.headers.get('idempotency-key'),
      });

      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/notification-preferences`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.notificationsDelayMs > 0) await delay(db.notificationsDelayMs);

      if (db.forceNotificationPrefsError) {
        const forced = db.forceNotificationPrefsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (db.failNextNotificationPrefs > 0) {
        db.failNextNotificationPrefs -= 1;
        return errorResponse(500, 'INTERNAL', 'Could not load notification preferences');
      }

      return HttpResponse.json({ items: db.notificationPreferences });
    }),

    http.patch(`${API}/notification-preferences`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.notificationsDelayMs > 0) await delay(db.notificationsDelayMs);

      if (db.forceNotificationPrefsError) {
        const forced = db.forceNotificationPrefsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (db.failNextNotificationPrefs > 0) {
        db.failNextNotificationPrefs -= 1;
        return errorResponse(500, 'INTERNAL', 'Could not save notification preference');
      }

      const body = await readJson(request);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return errorResponse(422, 'VALIDATION_FAILED', 'Preference body must be an object');
      }
      const candidate = body as Record<string, unknown>;
      const type = candidate.type;
      const channel = candidate.channel;
      const mode = candidate.mode;
      if (type !== 'MESSAGE' && type !== 'MENTION' && type !== 'SYSTEM') {
        return errorResponse(422, 'VALIDATION_FAILED', 'type is invalid');
      }
      if (channel !== 'IN_APP' && channel !== 'EMAIL') {
        return errorResponse(422, 'VALIDATION_FAILED', 'channel is invalid');
      }
      if (mode !== 'ALL' && mode !== 'MENTIONS' && mode !== 'MUTE') {
        return errorResponse(422, 'VALIDATION_FAILED', 'mode is invalid');
      }

      let chatId: string | null = null;
      if (candidate.chat_id !== undefined && candidate.chat_id !== null) {
        if (typeof candidate.chat_id !== 'string' || !UUID_RE.test(candidate.chat_id)) {
          return errorResponse(422, 'VALIDATION_FAILED', 'chat_id must be a UUID');
        }
        if (!db.chats[candidate.chat_id]) {
          return errorResponse(403, 'FORBIDDEN', 'Chat is not available to this user');
        }
        chatId = candidate.chat_id;
      }

      const preference: NotificationPreference = { chat_id: chatId, type, channel, mode };
      const idempotencyKey = request.headers.get('idempotency-key');
      const bodyHash = canonicalJson(preference);

      if (idempotencyKey) {
        const replay = db.notificationPreferenceIdempotency.get(idempotencyKey);
        if (replay) {
          if (replay.bodyHash !== bodyHash) {
            return errorResponse(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency key was reused with another body',
            );
          }
          return HttpResponse.json(replay.preference);
        }
      }

      const index = db.notificationPreferences.findIndex(
        (item) =>
          (item.chat_id ?? null) === chatId && item.type === type && item.channel === channel,
      );
      if (index >= 0) {
        db.notificationPreferences[index] = preference;
      } else {
        db.notificationPreferences.push(preference);
      }

      if (idempotencyKey) {
        db.notificationPreferenceIdempotency.set(idempotencyKey, {
          bodyHash,
          preference,
        });
      }
      db.notificationPreferencePatches.push({
        body: preference as NotificationPreferencePatch,
        idempotencyKey,
      });

      return HttpResponse.json(preference);
    }),

    http.get(`${API}/sync`, ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const workspaceId = new URL(request.url).searchParams.get('workspace_id');
      if (!workspaceId) {
        return errorResponse(400, 'VALIDATION_FAILED', 'workspace_id is required');
      }
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }

      const response: SyncResponse = {
        server_time: db.serverTime(),
        chats: Object.values(db.chats)
          .filter((chat) => chat.workspaceId === workspace.id)
          .map((chat) => ({
            chat_id: chat.summary.id,
            last_seq: chat.summary.last_seq,
            unread_count: chat.summary.unread_count,
          })),
      };
      return HttpResponse.json(response);
    }),

    http.post(`${API}/realtime/ticket`, ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;

      const expiresAt = Date.now() + 30_000;
      const ticket = `mock-ws-${newUuid()}`;
      db.realtimeTickets.set(ticket, {
        deviceId: request.headers.get('x-device-id'),
        expiresAt,
        used: false,
      });
      const response: RealtimeTicket = {
        ticket,
        expires_at: new Date(expiresAt).toISOString(),
        ws_url: 'ws://localhost:8081/ws',
      };
      return HttpResponse.json(response);
    }),
  ];
}

function parseSeq(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export { MOCK_ACCESS_TOKEN };
