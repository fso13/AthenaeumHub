import { delay, http, HttpResponse } from 'msw';
import type {
  AdminAuditEvent,
  AdminAuditExport,
  AdminAuditPage,
  AdminChat,
  AdminChatPage,
  AdminOverview,
  AdminPluginPackage,
  AdminSession,
  AdminSessionPage,
  AdminSettings,
  AdminStorage,
  AdminStorageTotals,
  AdminUser,
  AdminUserPage,
  ApiAttachment,
  ApiErrorBody,
  ApiMessage,
  AuthLoginRequest,
  BlockedUser,
  Bot,
  BotCommand,
  BotDelivery,
  ChatBot,
  AuthRegisterRequest,
  AuthSession,
  Chat,
  ChatInvite,
  ChatMember,
  ChatMembersResponse,
  ChatPermissions,
  ChatPin,
  ChatPluginState,
  CreateWorkspaceRequest,
  DeviceRegistration,
  DlpEventPage,
  DlpPolicy,
  DlpPolicyList,
  DlpScope,
  FileItem,
  Mention,
  MessageCreateBody,
  Notification,
  NotificationPreference,
  NotificationPreferencePatch,
  Plugin,
  Poll,
  PreflightDecision,
  PreflightFile,
  ReadNotificationsRequest,
  ReactionSummary,
  RealtimeTicket,
  Room,
  StickerRef,
  SyncResponse,
  Task,
  ThreadSummary,
  TranslationProviderSettings,
  TranslationProviderTest,
  UploadInitRequest,
  UploadSession,
  WorkspaceAuditEvent,
  WorkspaceAuditPage,
  WorkspaceMember,
  WorkspaceMemberPage,
  WorkspaceOverview,
  TwoFactorStatus,
  WorkspaceInvite,
  WorkspacePermissionEntry,
  WorkspacePermissionMatrix,
  WorkspaceSecurity,
  WorkspaceSessionPage,
  WorkspaceSessionRevokeAll,
  InviteAcceptResult,
  WorkspaceRole,
  WorkspaceSummary,
} from '../api/types';
import { sha256Bytes } from '../files/hash';
import { readId3Tags } from '../files/id3';
import { mediaKindForFile } from '../files/media';
import { newUuid } from '../lib/ids';
import { validateTranslationUrl } from '../ops/translation';
import { pluginUnavailableReason } from '../plugins/model';
import { isSafePluginAssetPath } from '../plugins/assets';
import {
  allCatalogPlugins,
  countActiveChatsForUser,
  countActiveChatsInWorkspace,
  createDefaultWorkspacePermissions,
  createMockPluginCatalog,
  createMockTwoFactor,
  insertMockBotMessage,
  insertMockPluginMessage,
  type ChatRecord,
  type MockBotDeliveryRecord,
  type MockBotRecord,
  type MockChatBotRecord,
  type MockAuthUserRecord,
  type MockDb,
  type MockPluginAssetRecord,
  type MockRoomRecord,
  type MockUpload,
  type MockWorkspaceInviteRecord,
} from './db';
import {
  IDS,
  MOCK_ACCESS_TOKEN,
  MOCK_DEMO_EMAIL,
  MOCK_EMAIL_CODE,
  MOCK_RECOVERY_CODES,
  MOCK_TOTP_CODE,
  MOCK_TOTP_SECRET,
  messageId,
} from './fixtures';
import { parseMockManifest, readStoredZip } from './pluginPackage';
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

const PLUGIN_ASSET_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};

function pluginAssetMime(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return PLUGIN_ASSET_TYPES[extension] ?? 'application/octet-stream';
}

interface MultipartFilePart {
  fileName: string;
  bytes: Uint8Array;
}

/**
 * Minimal multipart reader for the mock. Node's `Request.formData()` uses the
 * undici File brand, which clashes with jsdom's File in the Vitest environment;
 * the actual browser path still sends a standards-compliant multipart body.
 */
async function readMultipartFile(request: Request): Promise<MultipartFilePart | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  // A true 1:1 byte string; `TextDecoder('latin1')` maps 0x80..0x9f through
  // windows-1252 and would corrupt binary ZIP bytes.
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  for (const part of raw.split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const disposition = /content-disposition:([^\r\n]+)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    if (name !== 'file') continue;
    const fileName = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? 'package.zip';
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    return { fileName, bytes: Uint8Array.from(body, (char) => char.charCodeAt(0)) };
  }
  return null;
}

/** #97 mock cover extracted by the "server"; bytes never come from the client. */
export interface MockServerMedia {
  media: NonNullable<FileItem['media']>;
  artwork: { mime: string; bytes: Uint8Array } | null;
}

/**
 * #97: in-mock stand-in for the backend audio extractor. The real server parses
 * ID3v2/M4A itself; the mock reuses the bounded client parser so a FilesPage
 * upload can observe the same "server extracted tags + authenticated artwork"
 * response shape (`metadata_source=SERVER`, `artwork_url` = artwork endpoint).
 * Non-audio media keeps only its kind, exactly like the backend.
 */
async function extractServerMedia(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  attachmentId: string,
  origin: string,
): Promise<MockServerMedia | null> {
  const kind = mediaKindForFile({ name: filename, type: mime });
  if (kind === null) return null;
  if (kind !== 'AUDIO') {
    return { media: { kind, metadata_source: 'SERVER' }, artwork: null };
  }

  let tags: {
    title?: string;
    artist?: string;
    album?: string;
    year?: string;
    genre?: string;
    durationMs?: number;
  } = {};
  let artwork: { mime: string; bytes: Uint8Array } | null = null;
  try {
    const bytesCopy = new Uint8Array(bytes).buffer as ArrayBuffer;
    const parsed = await readId3Tags(
      new File([bytesCopy], filename, { type: mime || 'audio/mpeg' }),
    );
    if (parsed.status === 'ok') {
      tags = parsed.tags;
      artwork = parsed.artwork;
    }
  } catch {
    // A malformed tag is still an AUDIO/SERVER row without tags.
  }

  const media: NonNullable<FileItem['media']> = { kind: 'AUDIO', metadata_source: 'SERVER' };
  if (tags.title) media.title = tags.title;
  if (tags.artist) media.artist = tags.artist;
  if (tags.album) media.album = tags.album;
  if (tags.year) media.year = tags.year;
  if (tags.genre) media.genre = tags.genre;
  if (typeof tags.durationMs === 'number' && tags.durationMs > 0) {
    media.duration_ms = tags.durationMs;
  }
  if (artwork) {
    media.artwork_url = `${origin}/api/v1/attachments/${attachmentId}/artwork`;
  }
  return { media, artwork };
}

interface MultipartFormPart {
  fileName: string;
  contentType: string | null;
  bytes: Uint8Array;
}

interface MultipartFormBody {
  file: MultipartFormPart | null;
  fields: Record<string, string>;
}

/**
 * #93: parse one multipart request into the `file` part plus plain text fields
 * (currently `chat_id`). Mirrors `readMultipartFile` byte handling so a binary
 * image is never decoded as UTF-8.
 */
async function readMultipartForm(request: Request): Promise<MultipartFormBody | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const fields: Record<string, string> = {};
  let file: MultipartFormPart | null = null;
  for (const part of raw.split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const disposition = /content-disposition:([^\r\n]+)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const fileName = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (fileName !== undefined) {
      if (name === 'file') {
        const partContentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
        file = {
          fileName: fileName || 'image',
          contentType: partContentType ?? null,
          bytes: Uint8Array.from(body, (char) => char.charCodeAt(0)),
        };
      }
      continue;
    }
    fields[name] = body;
  }
  return { file, fields };
}

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

/* ------------------------------------------------------------------------- */
/* #105 rooms: ACTIVE list, metadata mutations and 30 s TTL presence.         */
/* ------------------------------------------------------------------------- */

/** Mirrors `RoomPresencePolicy.TTL` in the backend. */
const ROOM_PRESENCE_TTL_MS = 30_000;

function roomParticipants(record: MockRoomRecord) {
  if (record.status !== 'ACTIVE') return [];
  const now = Date.now();
  return record.participants.filter((participant) => {
    const seen = Date.parse(participant.last_seen_at);
    return Number.isFinite(seen) && now - seen <= ROOM_PRESENCE_TTL_MS;
  });
}

/** The contract projection: TTL-filtered peers, server-computed count/flags. */
function presentRoom(db: MockDb, record: MockRoomRecord): Room {
  const participants = roomParticipants(record);
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    chat_id: record.chatId,
    name: record.name,
    // #107: server-side room metadata; joins use it for the call `video` flag.
    media_mode: record.mediaMode,
    created_by: record.createdBy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    status: record.status,
    participants,
    participant_count: participants.length,
    my_present: participants.some((participant) => participant.user_id === db.me.user.id),
  };
}

function findMockRoom(db: MockDb, roomId: string): MockRoomRecord | null {
  return db.rooms.find((room) => room.id === roomId) ?? null;
}

/* #106: seeded rooms have a backing GROUP channel outside `db.chats`. */
function findRoomByChatId(db: MockDb, chatId: string): MockRoomRecord | null {
  return db.rooms.find((room) => room.chatId === chatId) ?? null;
}

/** Chat OWNER/ADMIN equivalent for a room avatar: creator or workspace manager. */
function canManageRoomChat(db: MockDb, room: MockRoomRecord): boolean {
  if (room.createdBy === db.me.user.id) return true;
  const workspace = findMockWorkspace(db, room.workspaceId);
  return workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
}

function roomChatAvatarId(db: MockDb, room: MockRoomRecord): string | null {
  return db.roomChatAvatars.get(room.chatId) ?? null;
}

/** Minimal `Chat` projection returned by the existing avatar setter. */
function roomChatResponseOf(db: MockDb, room: MockRoomRecord): Chat {
  const workspace = findMockWorkspace(db, room.workspaceId);
  return {
    id: room.chatId,
    type: 'GROUP',
    security_mode: workspace?.security_mode ?? 'MANAGED',
    visibility: 'PUBLIC',
    peer_id: null,
    peer_has_e2ee_capable_devices: false,
    name: room.name,
    description: null,
    last_seq: 0,
    unread_count: 0,
    created_at: room.createdAt,
    cover_file_id: null,
    avatar_file_id: roomChatAvatarId(db, room),
    read_only: false,
    join_policy: 'OPEN',
    archived: false,
  };
}

/* ------------------------------------------------------------------------- */
/* P0-4 (#82): avatar, TOTP authenticator, workspace settings/invites          */
/* ------------------------------------------------------------------------- */

const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 300;
const TWO_FACTOR_MAX_ATTEMPTS = 5;

/** #101 DLP surface/size contract mirrors used by the CRUD mocks. */
const DLP_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const DLP_SCOPES: ReadonlySet<string> = new Set(['ALL', 'TEXT', 'ATTACHMENT', 'PLUGIN']);

function readDlpScope(raw: unknown): DlpScope | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toUpperCase();
  return DLP_SCOPES.has(normalized) ? (normalized as DlpScope) : null;
}

function findMockWorkspace(db: MockDb, workspaceId: string): WorkspaceSummary | null {
  return db.me.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

/** Effective workspace right for the caller, from the stored matrix. */
function workspaceRight(db: MockDb, workspaceId: string, permission: string): boolean {
  const workspace = findMockWorkspace(db, workspaceId);
  if (!workspace) return false;
  if (workspace.role === 'OWNER') return true;
  if (workspace.role === 'GUEST') return false;
  const matrix =
    db.workspacePermissions[workspaceId] ?? createDefaultWorkspacePermissions(workspaceId);
  const row = matrix.roles.find((entry) => entry.role === workspace.role);
  return row ? row[permission as keyof typeof row] === true : false;
}

/**
 * #93: uploaded media images are standalone until a setter references them.
 * They are projected as a FileItem-shaped row for the shared validation; the
 * provenance fields are synthetic because this image has no message yet.
 */
function mediaImageAsFileItem(db: MockDb, fileId: string): FileItem | null {
  const media = db.mediaImages.get(fileId);
  if (!media) return null;
  return {
    id: media.id,
    filename: media.filename,
    size_bytes: media.size,
    mime_type: media.mime,
    scan_status: media.scanStatus,
    media: { kind: 'IMAGE', metadata_source: 'NONE' },
    chat_id: media.chatId ?? IDS.groupChat,
    chat_name: null,
    message_id: '00000000-0000-4000-8000-000000000000',
    created_at: media.createdAt,
  };
}

function imageFileView(db: MockDb, fileId: string): FileItem | null {
  return db.fileCenterItems.find((item) => item.id === fileId) ?? mediaImageAsFileItem(db, fileId);
}

/** Chat-scoped image lookup: file-center row or a #93 upload with `chat_id`. */
function chatImageFileView(db: MockDb, fileId: string, chatId: string): FileItem | null {
  const item = db.fileCenterItems.find((file) => file.id === fileId);
  if (item) return item.chat_id === chatId ? item : null;
  const media = db.mediaImages.get(fileId);
  if (!media || media.chatId !== chatId) return null;
  return mediaImageAsFileItem(db, fileId);
}

/** Shared avatar/logo gate: existing, image, scan-approved. */
function imageValidationError(
  file: FileItem | null,
  invalidCode: 'AVATAR_INVALID' | 'WORKSPACE_LOGO_INVALID',
): Response | null {
  if (!file) return errorResponse(404, 'NOT_FOUND', 'Attachment is not available');
  const mime = (file.mime_type ?? '').toLowerCase();
  const isImage = file.media?.kind === 'IMAGE' || mime.startsWith('image/');
  if (!isImage) return errorResponse(422, invalidCode, 'Attachment is not an image');
  if (file.scan_status === 'PENDING') {
    return errorResponse(409, 'ATTACHMENT_NOT_READY', 'Attachment scan is not finished');
  }
  if (file.scan_status === 'INFECTED') {
    return errorResponse(423, 'ATTACHMENT_QUARANTINED', 'Attachment is quarantined');
  }
  if (file.scan_status !== 'CLEAN' && file.scan_status !== 'SKIPPED') {
    return errorResponse(422, invalidCode, 'Attachment cannot be used as an image');
  }
  return null;
}

function twoFactorStatusView(db: MockDb): TwoFactorStatus {
  const remaining = [...db.twoFactor.recoveryCodes.values()].filter((used) => !used).length;
  const required = db.admin.require2fa;
  return {
    enabled: db.twoFactor.enabled,
    enabled_at: db.twoFactor.enabledAt,
    recovery_codes_remaining: remaining,
    required,
    enrollment_required: required && !db.twoFactor.enabled,
  };
}

/** Password re-auth stand-in: the mock user's own password. */
function verifyMockPassword(db: MockDb, password: string | null): boolean {
  if (!password) return false;
  return db.authUsers.some((user) => user.id === db.me.user.id && user.password === password);
}

function consumeRecoveryCode(db: MockDb, code: string): boolean {
  const normalized = code.trim().toUpperCase();
  for (const [stored, used] of db.twoFactor.recoveryCodes) {
    if (stored === normalized && !used) {
      db.twoFactor.recoveryCodes.set(stored, true);
      return true;
    }
  }
  return false;
}

function twoFactorCodeAccepted(db: MockDb, code: string | null): boolean {
  if (!code) return false;
  const normalized = code.trim();
  if (normalized === MOCK_TOTP_CODE) return true;
  const recovery = normalized.toUpperCase();
  return [...db.twoFactor.recoveryCodes.entries()].some(
    ([stored, used]) => stored === recovery && !used,
  );
}

function workspaceInviteView(invite: { token?: string } & WorkspaceInvite): WorkspaceInvite {
  const { token: _token, ...rest } = invite;
  return rest;
}

/**
 * #100 shared status guard for preview/accept: revoked, expired and exhausted
 * are distinct 410 codes and are never collapsed into 404.
 */
function workspaceInviteUnavailable(invite: MockWorkspaceInviteRecord): Response | null {
  if (invite.status === 'REVOKED') {
    return errorResponse(410, 'WORKSPACE_INVITE_REVOKED', 'Invite was revoked');
  }
  if (new Date(invite.expires_at).getTime() <= Date.now() || invite.status === 'EXPIRED') {
    return errorResponse(410, 'WORKSPACE_INVITE_EXPIRED', 'Invite expired');
  }
  if (
    invite.status === 'EXHAUSTED' ||
    (invite.max_uses !== null &&
      invite.max_uses !== undefined &&
      invite.used_count >= invite.max_uses)
  ) {
    return errorResponse(410, 'WORKSPACE_INVITE_EXHAUSTED', 'Invite is exhausted');
  }
  return null;
}

/** #100: an email-bound invite only accepts the invited account (case-insensitive). */
function workspaceInviteEmailMismatch(db: MockDb, invite: MockWorkspaceInviteRecord): boolean {
  if (!invite.email) return false;
  return invite.email.trim().toLowerCase() !== db.me.user.email.trim().toLowerCase();
}

/* ------------------------------------------------------------------------- */
/* #79: channel members, invites and blocks                                  */
/* ------------------------------------------------------------------------- */

function activeChatMembers(db: MockDb, chatId: string): ChatMember[] {
  return (db.chatMembers[chatId] ?? []).filter((member) => member.status === 'ACTIVE');
}

function chatActorMember(db: MockDb, chatId: string): ChatMember | null {
  return activeChatMembers(db, chatId).find((member) => member.user_id === db.me.user.id) ?? null;
}

function chatOwnerCount(db: MockDb, chatId: string): number {
  return activeChatMembers(db, chatId).filter((member) => member.role === 'OWNER').length;
}

function isManagerRole(role: ChatMember['role'] | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/* ------------------------------------------------------------------------- */
/* #96 bots                                                                  */
/* ------------------------------------------------------------------------- */

/** Backend bot management is role-gated, not driven by the permission matrix. */
function workspaceManager(db: MockDb, workspaceId: string): boolean {
  const workspace = findMockWorkspace(db, workspaceId);
  return workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
}

/** Contract `Bot` has no credential field; the mock keeps one only server-side. */
function botView(record: MockBotRecord): Bot {
  const {
    token: _token,
    signingSecret: _signingSecret,
    signing_secret: _oneTimeSecret,
    ...bot
  } = record;
  return bot;
}

/** Content-free delivery row: internal workspace/bot scoping stays server-side. */
function deliveryView(record: MockBotDeliveryRecord): BotDelivery {
  const { workspaceId: _workspaceId, botId: _botId, ...delivery } = record;
  return delivery;
}

/** `sova_whsec_<64 hex>`: mock-only raw secret, returned exactly once. */
function newSigningSecret(): string {
  const random = `${newUuid().replace(/-/g, '')}${newUuid().replace(/-/g, '')}`;
  return `sova_whsec_${random}`;
}

/**
 * #98 mock validation mirroring `BotEventsUrl`/`BotCommand`: https-only, no
 * userinfo/query/fragment, lowercase command names unique inside one bot.
 */
function isValidEventsUrl(value: string): boolean {
  if (value.length < 9 || value.length > 2048 || value !== value.trim()) return false;
  if (/\s/.test(value)) return false;
  if (Array.from(value).some((char) => char.charCodeAt(0) < 0x20)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function parseCommandList(value: unknown): BotCommand[] | string {
  if (!Array.isArray(value)) return 'commands must be an array';
  if (value.length > 50) return 'a bot can register at most 50 commands';
  const names = new Set<string>();
  const result: BotCommand[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'a command entry must be an object';
    const row = entry as Record<string, unknown>;
    const raw = typeof row.command === 'string' ? row.command.trim().toLowerCase() : '';
    const command = raw.startsWith('/') ? raw.slice(1) : raw;
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(command)) {
      return 'command must match [a-z0-9][a-z0-9_-]{0,31}';
    }
    if (names.has(command)) return 'command names must be unique';
    names.add(command);
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (description.length < 1 || description.length > 256) {
      return 'command description must be 1..256 characters';
    }
    result.push({ command, description });
  }
  return result;
}

/** Mock credential shape: `sova_bot_<workspace>_<bot>_<random>`. */
function newBotToken(workspaceId: string, botId: string): string {
  const random = `${newUuid().replace(/-/g, '')}${newUuid().replace(/-/g, '')}`;
  return `sova_bot_${workspaceId}_${botId}_${random}`;
}

function chatBotView(db: MockDb, install: MockChatBotRecord): ChatBot | null {
  const bot = db.bots.find(
    (item) => item.id === install.botId && item.workspace_id === install.workspaceId,
  );
  if (!bot) return null;
  return {
    chat_id: install.chatId,
    bot: botView(bot),
    enabled: install.enabled,
    installed_at: install.installedAt,
  };
}

function chatMemberStatusOf(chat: ChatRecord | undefined): 'GROUP' | 'DIRECT' | null {
  if (!chat) return null;
  return chat.summary.type === 'DIRECT' ? 'DIRECT' : 'GROUP';
}

function actorCanManage(actor: ChatMember | null): boolean {
  return actor !== null && isManagerRole(actor.role);
}

/* ------------------------------------------------------------------------- */
/* #80: channel settings, rights matrix, pins and archive                    */
/* ------------------------------------------------------------------------- */

/** Built-in P0-2 matrix (mirrors `ChatPermissionPolicy`). */
function defaultPermissionMatrix(): ChatPermissions {
  const all = {
    post_messages: true,
    invite_members: true,
    create_polls: true,
    start_calls: true,
    pin_messages: true,
    change_info: true,
  };
  return {
    owner: { ...all },
    admin: { ...all },
    moderator: {
      post_messages: true,
      invite_members: true,
      create_polls: true,
      start_calls: true,
      pin_messages: true,
      change_info: false,
    },
    member: {
      post_messages: true,
      invite_members: false,
      create_polls: true,
      start_calls: true,
      pin_messages: false,
      change_info: false,
    },
    guest: {
      post_messages: true,
      invite_members: false,
      create_polls: false,
      start_calls: false,
      pin_messages: false,
      change_info: false,
    },
  };
}

function matrixFor(db: MockDb, chatId: string): ChatPermissions {
  return db.chatPermissions[chatId] ?? defaultPermissionMatrix();
}

const PERMISSION_KEYS = [
  'post_messages',
  'invite_members',
  'create_polls',
  'start_calls',
  'pin_messages',
  'change_info',
] as const;

const EDITABLE_ROLES = ['admin', 'moderator', 'member', 'guest'] as const;

function roleAllowed(
  matrix: ChatPermissions,
  role: ChatMember['role'],
  permission: (typeof PERMISSION_KEYS)[number],
): boolean {
  if (role === 'OWNER') return true;
  const key = role.toLowerCase() as (typeof EDITABLE_ROLES)[number];
  return matrix[key]?.[permission] === true;
}

/** #80: `Chat` representation of a summary (all additive fields included). */
function chatResponseOf(summary: MockDb['chats'][string]['summary']): Chat {
  return {
    id: summary.id,
    type: summary.type,
    security_mode: summary.security_mode,
    visibility: summary.visibility ?? null,
    peer_id: summary.peer_id ?? null,
    peer_has_e2ee_capable_devices: summary.peer_has_e2ee_capable_devices ?? false,
    name: summary.name,
    description: summary.description ?? null,
    last_seq: summary.last_seq,
    unread_count: summary.unread_count,
    created_at: new Date().toISOString(),
    cover_file_id: summary.cover_file_id ?? null,
    avatar_file_id: summary.avatar_file_id ?? null,
    read_only: summary.read_only ?? false,
    join_policy: summary.join_policy ?? null,
    archived: summary.archived ?? false,
  };
}

/** Hide `expires_at`-driven status drift in the mock list (server computes it). */
function presentInvite(invite: ChatInvite): ChatInvite {
  if (invite.status === 'REVOKED' || invite.status === 'EXHAUSTED') return invite;
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { ...invite, status: 'EXPIRED' };
  }
  return invite;
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

/** #83: extensions the managed pipeline blocks outright (dangerous types). */
const WORKSPACE_DANGEROUS_EXTENSIONS = new Set([
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'sh',
  'js',
  'mjs',
  'html',
  'htm',
  'svg',
  'jar',
  'apk',
]);

/** Safe display name: 1..255, no separators/control/bidi characters. */
function validDisplayName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const name = raw.trim();
  if (name.length < 1 || name.length > 255 || name !== raw) return false;
  if (/[\\/]/.test(name)) return false;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  // Bidi overrides/isolates can visually spoof an extension.
  return !/[\u202a-\u202e\u2066-\u2069]/.test(name);
}

interface SnippetRange {
  start: number;
  end: number;
}

/**
 * #83 plain-text snippet (≤240) centered on the first match, with highlight
 * ranges in the snippet's own UTF-16 coordinates. No HTML is produced.
 */
function buildSearchSnippet(
  text: string,
  query: string,
): { snippet: string; highlights: SnippetRange[] } {
  const lowerText = text.toLocaleLowerCase('ru');
  const lowerQuery = query.toLocaleLowerCase('ru');
  const first = lowerText.indexOf(lowerQuery);
  const max = 240;
  let start = Math.max(0, first - 60);
  let end = Math.min(text.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  // Snap to code-point boundaries so a surrogate pair is never split.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end += 1;
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;

  const highlights: SnippetRange[] = [];
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerQuery, from);
    if (at < 0) break;
    const rangeStart = at - start + prefix.length;
    const rangeEnd = rangeStart + query.length;
    if (rangeEnd > 0 && rangeStart < snippet.length) {
      highlights.push({
        start: Math.max(0, rangeStart),
        end: Math.min(snippet.length, rangeEnd),
      });
    }
    from = at + Math.max(1, lowerQuery.length);
  }
  return { snippet, highlights };
}

/** #83: UTF-8-safe base64url (queries are Cyrillic, `btoa` alone would throw). */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Cursor bound to the workspace, `q`, `chat_id` (and the unread flag). */
function encodeCursor(prefix: string, offset: number, binding: string): string {
  return base64UrlEncode(`${prefix}:${offset}:${binding}`);
}

function decodeCursor(raw: string, prefix: string, binding: string): number | null {
  const decoded = base64UrlDecode(raw);
  if (decoded === null || !decoded.startsWith(`${prefix}:`)) return null;
  const rest = decoded.slice(prefix.length + 1);
  const separator = rest.indexOf(':');
  if (separator < 0) return null;
  const offset = Number(rest.slice(0, separator));
  const cursorBinding = rest.slice(separator + 1);
  if (!Number.isInteger(offset) || offset < 0) return null;
  if (cursorBinding !== binding) return null;
  return offset;
}

const encodeSearchCursor = (offset: number, query: string, chatId: string | null): string =>
  encodeCursor('msp1', offset, `${query}|${chatId ?? ''}`);

const decodeSearchCursor = (raw: string, query: string, chatId: string | null): number | null =>
  decodeCursor(raw, 'msp1', `${query}|${chatId ?? ''}`);

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
    memberIds: [],
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
    require_2fa: admin.require2fa,
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

/**
 * #103: simulate the browser's HttpOnly refresh cookie. The value is kept on the
 * mock DB rather than in JS-readable storage, mirroring the production cookie:
 * authApi.refresh()/logout() send no token in the body.
 */
function issueAuthSession(db: MockDb, user: MockAuthUserRecord): AuthSession {
  const now = Date.now();
  const accessToken = `mock-access-${newUuid()}`;
  const refreshToken = `mock-refresh-${newUuid()}`;
  db.authAccessTokens.set(accessToken, { userId: user.id, expiresAt: now + AUTH_ACCESS_TTL_MS });
  db.authRefreshTokens.set(refreshToken, { userId: user.id, expiresAt: now + AUTH_REFRESH_TTL_MS });
  db.authRefreshCookie = refreshToken;
  return {
    access_token: accessToken,
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

function refreshCookieHeader(db: MockDb): string {
  const value = db.authRefreshCookie ?? '';
  return `sova_refresh=${value}; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=1800`;
}

function clearedRefreshCookieHeader(): string {
  return 'sova_refresh=; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=0';
}

function authSessionResponse(db: MockDb, user: MockAuthUserRecord): Response {
  const session = issueAuthSession(db, user);
  return HttpResponse.json(session, {
    headers: { 'Set-Cookie': refreshCookieHeader(db) },
  });
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

/**
 * #84 workspace overview projection. Counts/bytes only plus at most five
 * content-free audit rows; no message text, attachments, filenames or IP.
 */
function workspaceOverviewView(db: MockDb, workspaceId: string): WorkspaceOverview {
  const members = db.workspaceMembers;
  const messages = Object.values(db.chats).flatMap((chat) => chat.messages);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentMessages = messages.filter(
    (message) => !message.deleted_at && Date.parse(message.created_at) >= dayAgo,
  );
  const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
  const isManager = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  return {
    members: {
      total: members.length,
      online: Math.min(2, members.length),
    },
    chats: Object.keys(db.chats).length,
    messages: {
      total: messages.length,
      last_24h: recentMessages.length,
    },
    files: {
      total: db.attachments.size,
      used_bytes: db.limits.usage.used,
      reserved_bytes: db.limits.usage.reserved,
    },
    dlp: {
      events_last_24h: db.security.dlpEvents.length,
    },
    storage: {
      used_bytes: db.limits.usage.used,
      quota_bytes: db.limits.usage.limit,
    },
    audit_recent: isManager ? sortSecurityEvents(db.security.auditEvents).slice(0, 5) : [],
    generated_at: db.serverTime(),
  };
}

/** Sorted, contract-shaped sessions of one local user (never another tenant). */
function adminSessionRowsFor(db: MockDb, userId: string): AdminSession[] {
  return db.adminSessions.sessions
    .filter((session) => session.user_id === userId)
    .sort(
      (left, right) =>
        right.last_seen_at.localeCompare(left.last_seen_at) || right.id.localeCompare(left.id),
    );
}

/**
 * #84 mock of `TranslationProviderUrl.normalize`: https only, absolute host,
 * no credentials/query/fragment/control characters and no dot segments.
 */
function normalizeTranslationUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return '';
  return validateTranslationUrl(value) === null ? value : null;
}

function translationSettingsView(db: MockDb): TranslationProviderSettings {
  return {
    enabled: db.translationAdmin.enabled,
    url: db.translationAdmin.url,
    provider: db.translationAdmin.provider,
  };
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

/* ------------------------------------------------------------------------- */
/* D1.1 (#76): poll/task/translate mock helpers                               */
/* ------------------------------------------------------------------------- */

/** Chat + workspace accessible to the single mock caller, or null (→ 404). */
function accessibleChat(
  db: MockDb,
  chatId: string,
): { chat: ChatRecord; workspace: WorkspaceSummary } | null {
  const chat = db.chats[chatId];
  if (!chat) return null;
  const workspace = db.me.workspaces.find((item) => item.id === chat.workspaceId);
  return workspace ? { chat, workspace } : null;
}

/**
 * Mirrors `PluginAvailabilityPolicy` + the per-chat switch: E2EE is always
 * unavailable, a catalog kill switch and a disabled chat toggle both reject.
 */
function pluginActionGate(db: MockDb, chat: ChatRecord, pluginId: string): Response | null {
  const plugin = db.pluginCatalog.find((item) => item.id === pluginId);
  if (!plugin) return errorResponse(404, 'PLUGIN_NOT_FOUND', 'Plugin not found');
  if (chat.summary.security_mode === 'E2EE') {
    return errorResponse(422, 'PLUGIN_NOT_AVAILABLE', 'Plugin is not available in an E2EE chat');
  }
  if (plugin.state === 'DISABLED') {
    return errorResponse(422, 'PLUGIN_NOT_ENABLED', 'Plugin is disabled in the catalog');
  }
  const enabled = db.chatPlugins.get(chat.summary.id)?.get(pluginId) ?? false;
  if (!enabled) {
    return errorResponse(422, 'PLUGIN_NOT_ENABLED', 'Plugin is not enabled in this chat');
  }
  return null;
}

/** Plain-text guard shared by poll questions/options and task titles. */
function plainTextIssue(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return 'must be a string';
  const trimmed = value.trim();
  if (trimmed.length < min) return `must be ${min}..${max} characters`;
  if (trimmed.length > max) return `must be ${min}..${max} characters`;
  if (/[<>]/.test(trimmed) || hasDisallowedControl(trimmed, NO_CONTROL)) {
    return 'must be plain text without HTML or control characters';
  }
  return null;
}

/** Poll DTO recomputed for the caller, never stored as a per-viewer row. */
function pollView(record: { poll: Poll; votes: Map<string, string> }, viewerId: string): Poll {
  const counts = new Map<string, number>();
  for (const optionId of record.votes.values()) {
    counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
  }
  return {
    ...record.poll,
    options: record.poll.options.map((option) => ({
      ...option,
      votes: counts.get(option.id) ?? 0,
    })),
    my_option_id: record.votes.get(viewerId) ?? null,
    total_votes: record.votes.size,
  };
}

function compareCreatedDesc(a: { created_at: string }, b: { created_at: string }): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Open first, then done; newest first inside each group (contract order). */
function compareTasks(a: Task, b: Task): number {
  const doneDelta = Number(a.done) - Number(b.done);
  if (doneDelta !== 0) return doneDelta;
  return compareCreatedDesc(a, b);
}

function mockTranslation(target: string, source: string): string {
  const normalized = source.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return `[${target}] ${normalized}`.slice(0, 8000);
}

/* ------------------------------------------------------------------------- */
/* P0-3 (#81): workspace DLP, audit/export, sessions and security settings    */
/* ------------------------------------------------------------------------- */

/**
 * OWNER/ADMIN guard for every #81 operation. Mirrors the backend: a foreign or
 * unknown workspace and a non-manager member are both `403` without disclosing
 * existence. The `X-Device-Id` header is required by the contract too.
 */
function workspaceManagerGuard(
  db: MockDb,
  request: Request,
  workspaceId: string,
): WorkspaceSummary | Response {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
  if (workspace.role !== 'OWNER' && workspace.role !== 'ADMIN') {
    return errorResponse(403, 'FORBIDDEN', 'Workspace manager role is required');
  }
  return workspace;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/** Opaque workspace-bound offset cursor used by the mock pages. */
function readOffsetCursor(
  cursor: string | null,
  scheme: string,
  workspaceId: string,
): number | null {
  if (cursor === null || cursor === '') return 0;
  const match = new RegExp(`^${scheme}:${workspaceId}:(\\d+)$`).exec(cursor);
  if (!match) return null;
  return Number(match[1]);
}

function offsetCursor(scheme: string, workspaceId: string, offset: number): string {
  return `${scheme}:${workspaceId}:${offset}`;
}

/** `limit` 1..100, default per operation; null means `400`. */
function readPageLimit(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return null;
  return parsed;
}

function appendSecurityAudit(
  db: MockDb,
  action: string,
  targetType: string | null,
  targetId: string | null,
): void {
  db.security.auditEvents.push({
    id: newUuid(),
    action,
    actor_id: db.me.user.id,
    target_type: targetType,
    target_id: targetId,
    created_at: db.serverTime(),
  });
}

function sortSecurityEvents<T extends { created_at: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
}

function csvCell(value: string | null | undefined): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with the five contract columns and CRLF rows. */
function auditCsv(rows: WorkspaceAuditEvent[]): string {
  const lines = ['created_at,action,actor_id,target_type,target_id'];
  for (const row of rows) {
    lines.push(
      [row.created_at, row.action, row.actor_id ?? '', row.target_type ?? '', row.target_id ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

function exportFilename(format: 'csv' | 'json'): string {
  return `workspace-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
}

/** Same filters as the audit page, shared by the export operation. */
function filterAuditRows(
  rows: WorkspaceAuditEvent[],
  query: {
    action?: string | null;
    actorId?: string | null;
    from?: string | null;
    to?: string | null;
  },
): WorkspaceAuditEvent[] {
  const needle = query.action?.trim() ?? '';
  const actor = query.actorId?.trim() ?? '';
  const from = query.from ? Date.parse(query.from) : null;
  const to = query.to ? Date.parse(query.to) : null;
  return sortSecurityEvents(
    rows.filter((row) => {
      if (needle && row.action !== needle) return false;
      if (actor && row.actor_id !== actor) return false;
      const at = Date.parse(row.created_at);
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;
      return true;
    }),
  );
}

/** Parse audit filter query and validate with the contract's 400 rules. */
function readAuditQuery(request: Request):
  | {
      action: string | null;
      actorId: string | null;
      from: string | null;
      to: string | null;
      cursor: string | null;
      limitRaw: string | null;
    }
  | Response {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const actorId = url.searchParams.get('actor_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (action !== null && action.length > 120) {
    return errorResponse(400, 'VALIDATION_FAILED', 'action is longer than 120', {
      details: { field: 'action' },
    });
  }
  if (actorId !== null && !UUID_RE.test(actorId)) {
    return errorResponse(400, 'VALIDATION_FAILED', 'actor_id must be a UUID', {
      details: { field: 'actor_id' },
    });
  }
  if (from !== null && Number.isNaN(Date.parse(from))) {
    return errorResponse(400, 'VALIDATION_FAILED', 'from is not a date', {
      details: { field: 'from' },
    });
  }
  if (to !== null && Number.isNaN(Date.parse(to))) {
    return errorResponse(400, 'VALIDATION_FAILED', 'to is not a date', {
      details: { field: 'to' },
    });
  }
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
    return errorResponse(400, 'VALIDATION_FAILED', 'from must not be after to', {
      details: { field: 'from' },
    });
  }
  return {
    action,
    actorId,
    from,
    to,
    cursor: url.searchParams.get('cursor'),
    limitRaw: url.searchParams.get('limit'),
  };
}

export function createHandlers(db: MockDb) {
  return [
    http.get(`${API}/link-preview`, ({ request }) => {
      const url = new URL(request.url).searchParams.get('url') ?? '';
      return HttpResponse.json({
        url,
        title: 'Example',
        description: null,
        image: null,
      });
    }),
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
      // #100: the token is stored with the pending verification and never
      // returned; the response shape is identical with or without it.
      const inviteToken = readStringField(body, 'invite_token');
      const payload: AuthRegisterRequest = {
        email: normalizeEmail(email),
        display_name: displayName,
        password,
        ...(inviteToken ? { invite_token: inviteToken } : {}),
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
        inviteToken: inviteToken ?? null,
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
      if (db.admin.require2fa) {
        // #91: verification cannot mint a session past the installation policy.
        const challenge = {
          id: newUuid(),
          userId: user.id,
          expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_SECONDS * 1000,
          attempts: TWO_FACTOR_MAX_ATTEMPTS,
          mode: 'ENROLL' as const,
          pendingSecret: null,
        };
        db.twoFactorChallenge = challenge;
        return HttpResponse.json(
          {
            challenge_id: challenge.id,
            expires_in: TWO_FACTOR_CHALLENGE_TTL_SECONDS,
            methods: [],
            mode: 'ENROLL',
            enrollment_required: true,
          },
          { status: 202 },
        );
      }
      return authSessionResponse(db, user);
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
      if (db.twoFactor.enabled || db.admin.require2fa) {
        // P0-4/#93: the password is valid but a second factor is required.
        // Tokens stay server-side until `POST /auth/2fa/verify` (TOTP) or
        // `POST /auth/2fa/enroll/verify` (mandatory enrollment) succeeds.
        const mode: 'TOTP' | 'ENROLL' = db.twoFactor.enabled ? 'TOTP' : 'ENROLL';
        const challenge = {
          id: newUuid(),
          userId: user.id,
          expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_SECONDS * 1000,
          attempts: TWO_FACTOR_MAX_ATTEMPTS,
          mode,
          pendingSecret: null,
        };
        db.twoFactorChallenge = challenge;
        db.twoFactorRequests.push({
          action: 'CHALLENGE',
          password: null,
          code: null,
          deviceId: request.headers.get('x-device-id'),
        });
        return HttpResponse.json(
          {
            challenge_id: challenge.id,
            expires_in: TWO_FACTOR_CHALLENGE_TTL_SECONDS,
            methods: mode === 'TOTP' ? ['TOTP', 'RECOVERY_CODE'] : [],
            mode,
            enrollment_required: mode === 'ENROLL',
          },
          { status: 202 },
        );
      }
      return authSessionResponse(db, user);
    }),

    /* P0-4 (#82): complete the login challenge with TOTP/recovery code. */
    http.post(`${API}/auth/2fa/verify`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const challengeId = readStringField(body, 'challenge_id');
      const code = readStringField(body, 'code');
      if (!challengeId || !code) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid two-factor payload');
      }
      const challenge = db.twoFactorChallenge;
      db.twoFactorLoginRequests.push({ challengeId, code });
      if (
        !challenge ||
        challenge.id !== challengeId ||
        challenge.mode !== 'TOTP' ||
        challenge.expiresAt <= Date.now() ||
        challenge.attempts <= 0
      ) {
        db.twoFactorChallenge = null;
        return errorResponse(
          401,
          'TWO_FACTOR_CHALLENGE_INVALID',
          'The two-factor challenge is invalid or expired',
        );
      }
      const normalized = code.trim().toUpperCase();
      const recoveryAccepted = consumeRecoveryCode(db, normalized);
      if (!recoveryAccepted && normalized !== MOCK_TOTP_CODE) {
        challenge.attempts -= 1;
        if (challenge.attempts <= 0) {
          db.twoFactorChallenge = null;
          return errorResponse(429, 'RATE_LIMITED', 'Too many invalid codes');
        }
        return errorResponse(422, 'TWO_FACTOR_CODE_INVALID', 'Invalid two-factor code');
      }
      const user = db.authUsers.find((candidate) => candidate.id === challenge.userId);
      db.twoFactorChallenge = null;
      if (!user) {
        return errorResponse(401, 'TWO_FACTOR_CHALLENGE_INVALID', 'Challenge user is gone');
      }
      return authSessionResponse(db, user);
    }),

    /* #93: mandatory TOTP enrollment during login (server-wide require_2fa). */
    http.post(`${API}/auth/2fa/enroll/start`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const challengeId = readStringField(body, 'challenge_id');
      if (!challengeId) {
        return errorResponse(400, 'VALIDATION_FAILED', 'challenge_id is required');
      }
      const challenge = db.twoFactorChallenge;
      db.twoFactorRequests.push({
        action: 'ENROLL_START',
        password: null,
        code: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (
        !challenge ||
        challenge.id !== challengeId ||
        challenge.mode !== 'ENROLL' ||
        challenge.expiresAt <= Date.now() ||
        challenge.attempts <= 0
      ) {
        db.twoFactorChallenge = null;
        return errorResponse(
          401,
          'TWO_FACTOR_CHALLENGE_INVALID',
          'The two-factor challenge is invalid or expired',
        );
      }
      if (db.twoFactor.enabled) {
        return errorResponse(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor is already enabled');
      }
      const secret = `${MOCK_TOTP_SECRET}${newUuid().slice(0, 4)}`;
      challenge.pendingSecret = secret;
      const uri = `otpauth://totp/Сова:${encodeURIComponent(MOCK_DEMO_EMAIL)}?secret=${secret}&issuer=Сова&algorithm=SHA1&digits=6&period=30`;
      return HttpResponse.json({
        secret,
        otpauth_uri: uri,
        qr_payload: uri,
        expires_in: Math.max(1, Math.ceil((challenge.expiresAt - Date.now()) / 1000)),
      });
    }),

    http.post(`${API}/auth/2fa/enroll/verify`, async ({ request }) => {
      const body = asRecord(await readJson(request));
      const challengeId = readStringField(body, 'challenge_id');
      const code = readStringField(body, 'code');
      if (!challengeId || !code) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Invalid two-factor payload');
      }
      const challenge = db.twoFactorChallenge;
      db.twoFactorRequests.push({
        action: 'ENROLL_VERIFY',
        password: null,
        code,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (
        !challenge ||
        challenge.id !== challengeId ||
        challenge.mode !== 'ENROLL' ||
        challenge.expiresAt <= Date.now() ||
        challenge.attempts <= 0
      ) {
        db.twoFactorChallenge = null;
        return errorResponse(
          401,
          'TWO_FACTOR_CHALLENGE_INVALID',
          'The two-factor challenge is invalid or expired',
        );
      }
      if (!challenge.pendingSecret) {
        return errorResponse(409, 'TWO_FACTOR_NOT_SETUP', 'Two-factor setup was not started');
      }
      if (code.trim() !== MOCK_TOTP_CODE) {
        challenge.attempts -= 1;
        if (challenge.attempts <= 0) {
          db.twoFactorChallenge = null;
          return errorResponse(429, 'RATE_LIMITED', 'Too many invalid codes');
        }
        return errorResponse(422, 'TWO_FACTOR_CODE_INVALID', 'Invalid authenticator code');
      }
      const user = db.authUsers.find((candidate) => candidate.id === challenge.userId);
      if (!user) {
        db.twoFactorChallenge = null;
        return errorResponse(401, 'TWO_FACTOR_CHALLENGE_INVALID', 'Challenge user is gone');
      }
      db.twoFactor.enabled = true;
      db.twoFactor.enabledAt = new Date().toISOString();
      db.twoFactor.secret = challenge.pendingSecret;
      db.twoFactor.pendingSecret = null;
      db.twoFactor.lastStep = 1;
      db.twoFactor.recoveryCodes = new Map(MOCK_RECOVERY_CODES.map((value) => [value, false]));
      db.twoFactorChallenge = null;
      // Contract: a bare `AuthSession`; codes are issued separately through
      // `POST /me/2fa/recovery-codes` with the held token + password.
      return authSessionResponse(db, user);
    }),

    http.post(`${API}/auth/refresh`, async () => {
      // #103: no body; the simulated HttpOnly cookie is the only credential.
      const refreshToken = db.authRefreshCookie;
      if (!refreshToken) {
        return errorResponse(401, 'INVALID_CREDENTIALS', 'Refresh cookie is missing');
      }
      db.authRefreshRequests.push(refreshToken);
      const record = db.authRefreshTokens.get(refreshToken);
      if (!record || record.expiresAt <= Date.now()) {
        return errorResponse(401, 'INVALID_CREDENTIALS', 'Refresh token is invalid');
      }
      const user = db.authUsers.find((candidate) => candidate.id === record.userId);
      if (!user) return errorResponse(401, 'INVALID_CREDENTIALS', 'Refresh token is invalid');
      // Rotation: the old refresh token is no longer usable; the response re-issues the cookie.
      db.authRefreshTokens.delete(refreshToken);
      return authSessionResponse(db, user);
    }),

    http.post(`${API}/auth/logout`, async () => {
      const refreshToken = db.authRefreshCookie;
      db.authLogoutRequests.push(refreshToken ?? '');
      if (refreshToken) db.authRefreshTokens.delete(refreshToken);
      db.authRefreshCookie = null;
      return new HttpResponse(null, {
        status: 204,
        headers: { 'Set-Cookie': clearedRefreshCookieHeader() },
      });
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

    /* P0-4 (#82): own avatar (existing CLEAN image; no upload pipeline). */
    http.post(`${API}/me/avatar`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      const fileId = readStringField(body, 'file_id');
      if (!fileId) return errorResponse(400, 'VALIDATION_FAILED', 'file_id is required');
      db.avatarRequests.push({ action: 'SET', fileId });
      if (db.forceAvatarError) {
        const forced = db.forceAvatarError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const file = imageFileView(db, fileId);
      const invalid = imageValidationError(file, 'AVATAR_INVALID');
      if (invalid) return invalid;
      db.profileAvatarFileId = fileId;
      db.me = {
        ...db.me,
        user: { ...db.me.user, avatar_url: '/api/v1/me/avatar' },
      };
      return HttpResponse.json(db.me.user);
    }),

    http.delete(`${API}/me/avatar`, ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      db.avatarRequests.push({ action: 'DELETE', fileId: null });
      if (db.forceAvatarError) {
        const forced = db.forceAvatarError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      db.profileAvatarFileId = null;
      db.me = { ...db.me, user: { ...db.me.user, avatar_url: null } };
      return new HttpResponse(null, { status: 204 });
    }),

    /*
     * The real endpoint answers `302 Location: <presigned>`; `fetch` follows it
     * and the browser only sees image bytes, so the mock serves the bytes with
     * a `200` (the client contract is a Blob either way).
     */
    http.get(`${API}/me/avatar`, ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      db.avatarRequests.push({ action: 'GET', fileId: db.profileAvatarFileId });
      if (!db.profileAvatarFileId) return errorResponse(404, 'NOT_FOUND', 'Avatar is not set');
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }),

    /* P0-4 (#82): TOTP authenticator (secret shown only by setup). */
    http.get(`${API}/me/2fa`, ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      db.twoFactorRequests.push({
        action: 'STATUS',
        password: null,
        code: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      return HttpResponse.json(twoFactorStatusView(db));
    }),

    http.post(`${API}/me/2fa/setup`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      const password = readStringField(body, 'password');
      db.twoFactorRequests.push({
        action: 'SETUP',
        password,
        code: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!verifyMockPassword(db, password)) {
        return errorResponse(403, 'REAUTH_FAILED', 'Password was not confirmed');
      }
      if (db.twoFactor.enabled) {
        return errorResponse(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor is already enabled');
      }
      db.twoFactor.pendingSecret = `${MOCK_TOTP_SECRET}${newUuid().slice(0, 4)}`;
      const uri = `otpauth://totp/Сова:${encodeURIComponent(MOCK_DEMO_EMAIL)}?secret=${db.twoFactor.pendingSecret}&issuer=Сова&algorithm=SHA1&digits=6&period=30`;
      return HttpResponse.json({
        secret: db.twoFactor.pendingSecret,
        otpauth_uri: uri,
        qr_payload: uri,
      });
    }),

    http.post(`${API}/me/2fa/verify`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      const code = readStringField(body, 'code');
      db.twoFactorRequests.push({
        action: 'VERIFY',
        password: null,
        code,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (db.twoFactor.enabled) {
        return errorResponse(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor is already enabled');
      }
      if (!db.twoFactor.pendingSecret) {
        return errorResponse(409, 'TWO_FACTOR_NOT_SETUP', 'Two-factor setup was not started');
      }
      if (code !== MOCK_TOTP_CODE) {
        return errorResponse(422, 'TWO_FACTOR_CODE_INVALID', 'Invalid authenticator code');
      }
      db.twoFactor.enabled = true;
      db.twoFactor.enabledAt = new Date().toISOString();
      db.twoFactor.secret = db.twoFactor.pendingSecret;
      db.twoFactor.pendingSecret = null;
      db.twoFactor.lastStep = 1;
      return HttpResponse.json(twoFactorStatusView(db));
    }),

    http.post(`${API}/me/2fa/recovery-codes`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      const password = readStringField(body, 'password');
      db.twoFactorRequests.push({
        action: 'RECOVERY',
        password,
        code: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!verifyMockPassword(db, password)) {
        return errorResponse(403, 'REAUTH_FAILED', 'Password was not confirmed');
      }
      if (!db.twoFactor.enabled) {
        return errorResponse(409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor is not enabled');
      }
      db.twoFactor.recoveryCodes = new Map(MOCK_RECOVERY_CODES.map((value) => [value, false]));
      return HttpResponse.json({
        codes: [...MOCK_RECOVERY_CODES],
        remaining: MOCK_RECOVERY_CODES.length,
      });
    }),

    http.delete(`${API}/me/2fa`, async ({ request }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const body = asRecord(await readJson(request));
      const password = readStringField(body, 'password');
      const code = readStringField(body, 'code');
      db.twoFactorRequests.push({
        action: 'DISABLE',
        password,
        code,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTwoFactorError) {
        const forced = db.forceTwoFactorError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!verifyMockPassword(db, password)) {
        return errorResponse(403, 'REAUTH_FAILED', 'Password was not confirmed');
      }
      if (!db.twoFactor.enabled) {
        return errorResponse(409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor is not enabled');
      }
      const accepted = twoFactorCodeAccepted(db, code);
      if (accepted) consumeRecoveryCode(db, code ?? '');
      if (!accepted) {
        return errorResponse(422, 'TWO_FACTOR_CODE_INVALID', 'Invalid authenticator code');
      }
      db.twoFactor = createMockTwoFactor();
      return new HttpResponse(null, { status: 204 });
    }),

    /*
     * #93: one-shot device image upload. A standalone image is created (no
     * message binding) and the returned id is applied by the existing avatar,
     * cover or logo setters. Bytes stay in memory only.
     */
    http.post(`${API}/media/images`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.mediaImageDelayMs > 0) await delay(db.mediaImageDelayMs);
      const form = await readMultipartForm(request);
      if (!form?.file) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Multipart part "file" is missing');
      }
      const chatId = form.fields.chat_id ?? null;
      db.mediaImageUploadRequests.push({
        filename: form.file.fileName,
        mime: form.file.contentType ?? '',
        size: form.file.bytes.byteLength,
        chatId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceMediaImageError) {
        const forced = db.forceMediaImageError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (form.file.bytes.byteLength === 0) {
        return errorResponse(422, 'IMAGE_INVALID', 'Image is empty');
      }
      if (form.file.bytes.byteLength > 5 * 1024 * 1024) {
        return errorResponse(413, 'IMAGE_TOO_LARGE', 'Image is larger than 5 MiB');
      }
      const declared = (form.file.contentType ?? '').toLowerCase();
      const filename = form.file.fileName.split(/[\\/]/).pop()?.slice(0, 180) ?? 'image';
      const extension = filename.split('.').pop()?.toLowerCase() ?? '';
      const byExtension: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };
      const mime =
        declared === 'image/png' || declared === 'image/jpeg' || declared === 'image/webp'
          ? declared
          : (byExtension[extension] ?? null);
      if (!mime) {
        return errorResponse(
          415,
          'IMAGE_TYPE_INVALID',
          'Only PNG, JPEG or WebP images are accepted',
        );
      }
      if (chatId !== null) {
        if (!UUID_RE.test(chatId) || (!db.chats[chatId] && !findRoomByChatId(db, chatId))) {
          return errorResponse(404, 'NOT_FOUND', 'Chat not found');
        }
      }
      const id = newUuid();
      db.mediaImages.set(id, {
        id,
        filename,
        mime,
        size: form.file.bytes.byteLength,
        scanStatus: 'CLEAN',
        chatId,
        createdAt: db.serverTime(),
      });
      // Contract `UploadedImage`: no filename/object key/EXIF.
      return HttpResponse.json(
        {
          file_id: id,
          width: 2,
          height: 2,
          mime,
          size: form.file.bytes.byteLength,
        },
        { status: 201 },
      );
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
      if (body.require_2fa !== undefined && body.require_2fa !== null) {
        if (typeof body.require_2fa !== 'boolean') {
          return errorResponse(422, 'VALIDATION_FAILED', 'require_2fa must be a boolean', {
            details: { field: 'require_2fa' },
          });
        }
        next.require2fa = body.require_2fa;
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

    /* #84: installation translation-provider configuration + health probe. */
    http.get(`${API}/admin/plugins/translate`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      db.translationAdmin.getRequests += 1;
      const forced = db.translationAdmin.forceGetError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      return HttpResponse.json(translationSettingsView(db));
    }),

    http.patch(`${API}/admin/plugins/translate`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const forced = db.translationAdmin.forceUpdateError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const allowed = ['enabled', 'url', 'provider'];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Unknown translation setting');
      }
      if (Object.keys(body).length === 0) {
        return errorResponse(400, 'VALIDATION_FAILED', 'At least one field is required');
      }
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'enabled must be a boolean', {
          details: { field: 'enabled' },
        });
      }
      if (body.provider !== undefined && typeof body.provider !== 'string') {
        return errorResponse(400, 'VALIDATION_FAILED', 'provider must be a string', {
          details: { field: 'provider' },
        });
      }
      const current = translationSettingsView(db);
      const requestedProvider =
        body.provider === undefined ? current.provider : body.provider.trim().toUpperCase();
      const nextProvider = requestedProvider === '' ? 'AUTO' : requestedProvider;
      if (!['AUTO', 'CUSTOM', 'LIBRETRANSLATE'].includes(nextProvider)) {
        return errorResponse(
          422,
          'TRANSLATION_PROVIDER_INVALID',
          'Translation provider must be AUTO, CUSTOM or LIBRETRANSLATE',
          { details: { field: 'provider' } },
        );
      }
      const nextEnabled = body.enabled === undefined ? current.enabled : body.enabled;
      let nextUrl = current.url;
      if (body.url !== undefined) {
        if (typeof body.url !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'url must be a string', {
            details: { field: 'url' },
          });
        }
        const normalized = normalizeTranslationUrl(body.url);
        if (normalized === null) {
          return errorResponse(
            422,
            'TRANSLATION_URL_INVALID',
            'Translation provider URL is invalid',
            {
              details: { field: 'url' },
            },
          );
        }
        nextUrl = normalized;
      }
      if (nextEnabled && nextUrl.length === 0) {
        return errorResponse(
          422,
          'TRANSLATION_URL_REQUIRED',
          'Translation provider URL is required when the provider is enabled',
          { details: { field: 'url' } },
        );
      }
      const changed =
        nextEnabled !== current.enabled ||
        nextUrl !== current.url ||
        nextProvider !== current.provider;
      if (changed) {
        db.translationAdmin.enabled = nextEnabled;
        db.translationAdmin.url = nextUrl;
        db.translationAdmin.provider = nextProvider as typeof current.provider;
        appendMockAudit(db, {
          action: 'admin.plugin.translate.updated',
          target_type: 'translation_provider',
          target_id: null,
        });
      }
      db.translationAdmin.updates.push({ body, changed });
      return HttpResponse.json(translationSettingsView(db));
    }),

    http.post(`${API}/admin/plugins/translate/test`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      db.translationAdmin.testRequests += 1;
      const forced = db.translationAdmin.forceTestError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const settings = translationSettingsView(db);
      let result: TranslationProviderTest;
      if (!settings.enabled || settings.url.length === 0) {
        result = { status: 'DISABLED', latency_ms: 0 };
      } else {
        result = {
          status: db.translationAdmin.testStatus,
          latency_ms: Math.max(0, Math.min(60_000, db.translationAdmin.testLatencyMs)),
        };
      }
      appendMockAudit(db, {
        action: 'admin.plugin.translate.tested',
        target_type: 'translation_provider',
        target_id: null,
      });
      return HttpResponse.json(result);
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

    /* #84: bounded platform-admin audit export (CSV/JSON Blob + headers). */
    http.get(`${API}/admin/audit/export`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const format = url.searchParams.get('format');
      const action = url.searchParams.get('action');
      if (format !== 'csv' && format !== 'json') {
        return errorResponse(400, 'VALIDATION_FAILED', 'format must be csv or json', {
          details: { field: 'format' },
        });
      }
      if (action !== null && action.length > 120) {
        return errorResponse(400, 'VALIDATION_FAILED', 'action is longer than 120');
      }
      const forced = db.adminDirectory.forceExportError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const rows = adminAuditRows(db).filter((event) => action === null || event.action === action);
      // The real endpoint hard-caps at 10 000 rows and reports truncation.
      const cap = Math.max(0, Math.min(10_000, db.adminDirectory.auditExportLimit));
      const items = rows.slice(0, cap);
      const truncated = rows.length > items.length;
      const filename = `admin-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      const headers: Record<string, string> = {
        'X-Export-Rows': String(items.length),
        'X-Export-Truncated': String(truncated),
        'Content-Disposition': `attachment; filename="${filename}"`,
      };
      db.adminDirectory.auditRequests.push({ action, cursor: null, limit: 0 });
      if (format === 'csv') {
        const lines = ['created_at,action,actor_id,actor_email,target_type,target_id'];
        for (const row of items) {
          lines.push(
            [
              row.created_at,
              row.action,
              row.actor_id ?? '',
              row.actor_email ?? '',
              row.target_type ?? '',
              row.target_id ?? '',
            ]
              .map(csvCell)
              .join(','),
          );
        }
        return new HttpResponse(`${lines.join('\n')}\n`, {
          status: 200,
          headers: { ...headers, 'Content-Type': 'text/csv; charset=UTF-8' },
        });
      }
      const body: AdminAuditExport = {
        items,
        exported_rows: items.length,
        truncated,
      };
      return HttpResponse.json(body, { status: 200, headers });
    }),

    /* #84: platform-admin Keycloak sessions of one local user. */
    http.get(`${API}/admin/sessions`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;

      const url = new URL(request.url);
      const userId = url.searchParams.get('user_id');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? '30');
      if (userId === null || !UUID_RE.test(userId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'user_id must be a UUID', {
          details: { field: 'user_id' },
        });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      // The cursor is bound to the selected user; replaying it for another
      // user is a 400, exactly like the backend.
      let offset = 0;
      if (cursor !== null) {
        const match = /^as:([0-9a-f-]{36}):(\d+)$/i.exec(cursor);
        if (!match || match[1] !== userId) {
          return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
        }
        offset = Number(match[2]);
      }
      db.adminSessions.listRequests.push({ userId, cursor, limit });
      if (db.adminSessions.delayMs > 0) await delay(db.adminSessions.delayMs);
      const forced = db.adminSessions.forceListError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!db.authUsers.some((user) => user.id === userId)) {
        return errorResponse(404, 'USER_NOT_FOUND', 'User has no identity');
      }
      const rows = adminSessionRowsFor(db, userId);
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + limit < rows.length;
      const page: AdminSessionPage = {
        items,
        next_cursor: hasMore ? `as:${userId}:${offset + limit}` : null,
        has_more: hasMore,
      };
      return HttpResponse.json(page);
    }),

    http.delete(`${API}/admin/sessions/:sessionId`, ({ request, params }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const forced = db.adminSessions.forceRevokeError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const sessionId = String(params.sessionId ?? '');
      db.adminSessions.revokeRequests.push(sessionId);
      // Idempotent: an unknown/already-revoked id is still 204.
      db.adminSessions.sessions = db.adminSessions.sessions.filter(
        (session) => session.id !== sessionId,
      );
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/admin/users/:userId/revoke-sessions`, ({ request, params }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const forced = db.adminSessions.forceRevokeAllError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const userId = String(params.userId ?? '');
      if (!UUID_RE.test(userId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'userId must be a UUID');
      }
      if (!db.authUsers.some((user) => user.id === userId)) {
        return errorResponse(404, 'USER_NOT_FOUND', 'User has no identity');
      }
      db.adminSessions.revokeAllRequests += 1;
      const removed = db.adminSessions.sessions.filter((session) => session.user_id === userId);
      db.adminSessions.sessions = db.adminSessions.sessions.filter(
        (session) => session.user_id !== userId,
      );
      return HttpResponse.json({
        revoked_sessions: removed.length,
        affected_users: removed.length > 0 ? 1 : 0,
      });
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
        items: allCatalogPlugins(db).map((plugin) => ({
          ...plugin,
          permissions: [...plugin.permissions],
          modes: [...plugin.modes],
        })),
      });
    }),

    /* ------------------------------------------------------------------ */
    /* D1.2 (#86): external ZIP packages (platform_admin)                 */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/admin/plugins`, ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      db.adminPluginListRequests += 1;
      if (db.forceAdminPluginPackagesError) {
        const forced = db.forceAdminPluginPackagesError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      return HttpResponse.json({
        items: db.pluginPackages.map((pkg) => ({
          ...pkg,
          permissions: [...pkg.permissions],
          modes: [...pkg.modes],
        })),
      });
    }),

    http.post(`${API}/admin/plugins`, async ({ request }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      if (db.pluginPackageInstallDelayMs > 0) await delay(db.pluginPackageInstallDelayMs);
      if (db.forceInstallPluginPackageError) {
        const forced = db.forceInstallPluginPackageError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const part = await readMultipartFile(request);
      if (!part) {
        return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', 'Multipart part "file" is missing');
      }
      const bytes = part.bytes;
      db.pluginPackageInstallRequests.push({
        fileName: part.fileName,
        size: bytes.byteLength,
        deviceId: request.headers.get('x-device-id'),
      });

      if (bytes.byteLength === 0) {
        return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', 'Archive is empty');
      }
      if (bytes.byteLength > 5 * 1024 * 1024) {
        return errorResponse(413, 'PLUGIN_PACKAGE_TOO_LARGE', 'Archive is larger than 5 MiB');
      }
      const archive = readStoredZip(bytes);
      if (archive.error === 'invalid-zip') {
        return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', 'File is not a valid ZIP archive');
      }
      if (archive.error === 'unsupported-compression') {
        return errorResponse(
          400,
          'PLUGIN_PACKAGE_INVALID',
          'Mock accepts stored ZIP entries only; build one with createMockPluginZip',
        );
      }
      if (archive.entries.size === 0 || archive.entries.size > 200) {
        return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', 'Archive has too many or no files');
      }
      let unpackedBytes = 0;
      for (const [path, data] of archive.entries) {
        if (!isSafePluginAssetPath(path)) {
          return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', `Unsafe path: ${path}`);
        }
        unpackedBytes += data.byteLength;
      }
      if (unpackedBytes > 10 * 1024 * 1024) {
        return errorResponse(
          400,
          'PLUGIN_PACKAGE_INVALID',
          'Unpacked archive is larger than 10 MiB',
        );
      }
      const manifestBytes = archive.entries.get('manifest.json');
      const manifest = manifestBytes ? parseMockManifest(manifestBytes) : null;
      if (!manifest) {
        return errorResponse(400, 'PLUGIN_PACKAGE_INVALID', 'manifest.json is missing or invalid');
      }
      if (!archive.entries.has(manifest.entry) || !manifest.entry.endsWith('.html')) {
        return errorResponse(
          400,
          'PLUGIN_PACKAGE_INVALID',
          'manifest.entry must be an existing .html file',
        );
      }
      if (createMockPluginCatalog().some((plugin) => plugin.id === manifest.id)) {
        return errorResponse(409, 'PLUGIN_ID_RESERVED', 'Plugin id is reserved by a built-in');
      }
      if (db.pluginPackages.some((pkg) => pkg.id === manifest.id)) {
        return errorResponse(
          409,
          'PLUGIN_ALREADY_INSTALLED',
          'Plugin package is already installed',
        );
      }

      const assets = new Map<string, MockPluginAssetRecord>();
      for (const [path, data] of archive.entries) {
        if (path === 'manifest.json') continue;
        assets.set(path, { contentType: pluginAssetMime(path), body: data });
      }
      const pkg: AdminPluginPackage = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        entry: manifest.entry,
        permissions: manifest.permissions as AdminPluginPackage['permissions'],
        modes: manifest.modes as AdminPluginPackage['modes'],
        size_bytes: bytes.byteLength,
        file_count: archive.entries.size,
        sha256: sha256Bytes(bytes),
        installed_at: new Date().toISOString(),
      };
      db.pluginPackages = [...db.pluginPackages, pkg];
      db.pluginPackageAssets.set(pkg.id, assets);
      return HttpResponse.json(pkg, { status: 201 });
    }),

    http.delete(`${API}/admin/plugins/:pluginId`, ({ request, params }) => {
      const forbidden = requirePlatformAdmin(db, request);
      if (forbidden) return forbidden;
      const pluginId = String(params.pluginId);
      db.pluginPackageUninstallRequests.push(pluginId);
      if (db.forceUninstallPluginPackageError) {
        const forced = db.forceUninstallPluginPackageError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!db.pluginPackages.some((pkg) => pkg.id === pluginId)) {
        return errorResponse(404, 'PLUGIN_NOT_FOUND', 'Plugin package not found');
      }
      db.pluginPackages = db.pluginPackages.filter((pkg) => pkg.id !== pluginId);
      db.pluginPackageAssets.delete(pluginId);
      db.chatPlugins.forEach((row) => row.delete(pluginId));
      return new HttpResponse(null, { status: 204 });
    }),

    /*
     * Static package assets require the bearer JWT and are looked up by the
     * exact stored path. A wildcard handler reads the pathname explicitly so
     * the `assets/...` suffix is preserved.
     */
    http.get(`${API}/plugins/:pluginId/assets/*`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const pluginId = String(params.pluginId);
      if (!db.pluginPackages.some((pkg) => pkg.id === pluginId)) {
        return errorResponse(404, 'PLUGIN_NOT_FOUND', 'Plugin package not found');
      }
      const url = new URL(request.url);
      const marker = `/plugins/${pluginId}/assets/`;
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex < 0) return errorResponse(404, 'NOT_FOUND', 'Asset not found');
      let assetPath: string;
      try {
        assetPath = decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
      } catch {
        return errorResponse(404, 'NOT_FOUND', 'Asset not found');
      }
      if (!isSafePluginAssetPath(assetPath))
        return errorResponse(404, 'NOT_FOUND', 'Asset not found');
      const asset = db.pluginPackageAssets.get(pluginId)?.get(assetPath);
      if (!asset) return errorResponse(404, 'NOT_FOUND', 'Asset not found');
      const isHtml = asset.contentType.startsWith('text/html');
      return new HttpResponse(asset.body, {
        headers: {
          'Content-Type': asset.contentType,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': isHtml
            ? "default-src 'none'; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts"
            : "default-src 'none'; connect-src 'none'; frame-ancestors 'self'",
          'Referrer-Policy': 'no-referrer',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      });
    }),

    /* #79: channel participants plus the legacy flat `user_ids` projection. */
    http.get(`${API}/chats/:chatId/members`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (db.chatMemberDelayMs > 0) await delay(db.chatMemberDelayMs);
      if (db.forceChatMemberListError) {
        const forced = db.forceChatMemberListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const members = activeChatMembers(db, chatId);
      const response: ChatMembersResponse = {
        user_ids: members.map((member) => member.user_id),
        members,
      };
      return HttpResponse.json(response);
    }),

    http.post(`${API}/chats/:chatId/members`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const userId = typeof body.user_id === 'string' ? body.user_id : '';
      const role = body.role ?? 'MEMBER';
      if (!UUID_RE.test(userId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'user_id is invalid', {
          details: { field: 'user_id' },
        });
      }
      if (
        role !== 'OWNER' &&
        role !== 'ADMIN' &&
        role !== 'MODERATOR' &&
        role !== 'MEMBER' &&
        role !== 'GUEST'
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
          details: { field: 'role' },
        });
      }
      db.chatMemberRequests.push({
        chatId,
        action: 'add',
        userId,
        role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatMemberAddError) {
        const forced = db.forceChatMemberAddError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no membership management',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      if (!actorCanManage(actor)) return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
      if (role === 'OWNER' && actor.role !== 'OWNER') {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'OWNER cannot be assigned');
      }
      if (actor.role === 'ADMIN' && role === 'ADMIN') {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role cannot be assigned');
      }
      const workspaceMember = db.workspaceMembers.find((member) => member.user_id === userId);
      if (!workspaceMember) return errorResponse(404, 'USER_NOT_FOUND', 'User not found');
      const rows = (db.chatMembers[chatId] ??= []);
      const existing = rows.find((member) => member.user_id === userId);
      if (existing?.status === 'ACTIVE') {
        return HttpResponse.json(existing, { status: 200 });
      }
      if (existing) {
        existing.role = role;
        existing.status = 'ACTIVE';
        existing.joined_at = new Date().toISOString();
        return HttpResponse.json(existing, { status: 201 });
      }
      const member: ChatMember = {
        user_id: userId,
        display_name: workspaceMember.display_name,
        role,
        status: 'ACTIVE',
        joined_at: new Date().toISOString(),
      };
      rows.push(member);
      return HttpResponse.json(member, { status: 201 });
    }),

    http.patch(`${API}/chats/:chatId/members/:userId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const userId = String(params.userId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const role = body.role;
      if (
        role !== 'OWNER' &&
        role !== 'ADMIN' &&
        role !== 'MODERATOR' &&
        role !== 'MEMBER' &&
        role !== 'GUEST'
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
          details: { field: 'role' },
        });
      }
      db.chatMemberRequests.push({
        chatId,
        action: 'role',
        userId,
        role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatMemberRoleError) {
        const forced = db.forceChatMemberRoleError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no membership management',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      if (!actorCanManage(actor)) {
        return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
      }
      const target = activeChatMembers(db, chatId).find((member) => member.user_id === userId);
      if (!target) return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (target.user_id === actor.user_id) {
        return errorResponse(409, 'SELF_ACTION_FORBIDDEN', 'Cannot change your own role');
      }
      if (actor.role === 'ADMIN' && (target.role === 'OWNER' || target.role === 'ADMIN')) {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role change forbidden');
      }
      if (actor.role === 'ADMIN' && (role === 'OWNER' || role === 'ADMIN')) {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role cannot be assigned');
      }
      if (target.role === 'OWNER' && role !== 'OWNER' && chatOwnerCount(db, chatId) <= 1) {
        return errorResponse(409, 'LAST_OWNER', 'Cannot demote the last owner');
      }
      if (target.role === role) return HttpResponse.json(target);
      target.role = role;
      return HttpResponse.json(target);
    }),

    http.delete(`${API}/chats/:chatId/members/:userId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const userId = String(params.userId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatMemberRequests.push({
        chatId,
        action: 'remove',
        userId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatMemberRemoveError) {
        const forced = db.forceChatMemberRemoveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no membership management',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      const target = activeChatMembers(db, chatId).find((member) => member.user_id === userId);
      if (!target) {
        if (userId === actor.user_id) return new HttpResponse(null, { status: 204 });
        return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
      }
      const isSelf = target.user_id === actor.user_id;
      if (!isSelf) {
        if (!actorCanManage(actor)) {
          return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
        }
        if (actor.role === 'ADMIN' && (target.role === 'OWNER' || target.role === 'ADMIN')) {
          return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Cannot remove this member');
        }
      }
      if (target.role === 'OWNER' && chatOwnerCount(db, chatId) <= 1) {
        return errorResponse(409, 'LAST_OWNER', 'Cannot remove the last owner');
      }
      target.status = 'REMOVED';
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/chats/:chatId/leave`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatMemberRequests.push({
        chatId,
        action: 'leave',
        userId: db.me.user.id,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatMemberLeaveError) {
        const forced = db.forceChatMemberLeaveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no membership management',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return new HttpResponse(null, { status: 204 });
      if (actor.role === 'OWNER' && chatOwnerCount(db, chatId) <= 1) {
        return errorResponse(409, 'LAST_OWNER', 'Cannot leave as the last owner');
      }
      actor.status = 'REMOVED';
      return new HttpResponse(null, { status: 204 });
    }),

    /* #79: invite links (metadata list; the token appears once on create). */
    http.get(`${API}/chats/:chatId/invites`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (db.forceChatInviteListError) {
        const forced = db.forceChatInviteListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no invite links',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      if (!actorCanManage(actor)) return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
      return HttpResponse.json({
        items: (db.chatInvites[chatId] ?? []).map(presentInvite),
      });
    }),

    http.post(`${API}/chats/:chatId/invites`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request)) ?? {};
      db.chatInviteRequests.push({
        chatId,
        action: 'create',
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatInviteCreateError) {
        const forced = db.forceChatInviteCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no invite links',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      if (!actorCanManage(actor)) return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
      const role = body.role ?? 'MEMBER';
      if (role !== 'ADMIN' && role !== 'MODERATOR' && role !== 'MEMBER' && role !== 'GUEST') {
        return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
          details: { field: 'role' },
        });
      }
      if (actor.role === 'ADMIN' && role === 'ADMIN') {
        return errorResponse(403, 'ROLE_CHANGE_FORBIDDEN', 'Role cannot be assigned');
      }
      const maxUses = body.max_uses;
      if (
        maxUses !== undefined &&
        maxUses !== null &&
        (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'max_uses is invalid', {
          details: { field: 'max_uses' },
        });
      }
      const expiresIn = body.expires_in_seconds ?? 604800;
      if (
        typeof expiresIn !== 'number' ||
        !Number.isInteger(expiresIn) ||
        expiresIn < 300 ||
        expiresIn > 2_592_000
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'expires_in_seconds is invalid', {
          details: { field: 'expires_in_seconds' },
        });
      }
      const now = new Date();
      const invite: ChatInvite = {
        id: newUuid(),
        role,
        status: 'ACTIVE',
        used_count: 0,
        max_uses: typeof maxUses === 'number' ? maxUses : null,
        expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        created_at: now.toISOString(),
        created_by: db.me.user.id,
      };
      (db.chatInvites[chatId] ??= []).unshift(invite);
      const token = newUuid().replace(/-/g, '');
      db.chatInviteTokens.set(token, { chatId, inviteId: invite.id });
      return HttpResponse.json({ ...invite, token }, { status: 201 });
    }),

    http.delete(`${API}/chats/:chatId/invites/:inviteId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const inviteId = String(params.inviteId);
      const chat = db.chats[chatId];
      if (!chat) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatInviteRequests.push({
        chatId,
        action: 'revoke',
        inviteId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatInviteRevokeError) {
        const forced = db.forceChatInviteRevokeError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (chatMemberStatusOf(chat) === 'DIRECT') {
        return errorResponse(
          422,
          'CHAT_MEMBERSHIP_UNSUPPORTED',
          'DIRECT chats have no invite links',
        );
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(403, 'FORBIDDEN', 'Not a chat member');
      if (!actorCanManage(actor)) return errorResponse(403, 'FORBIDDEN', 'Not a chat manager');
      const invite = (db.chatInvites[chatId] ?? []).find((item) => item.id === inviteId);
      if (!invite) return errorResponse(404, 'INVITE_NOT_FOUND', 'Invite not found');
      invite.status = 'REVOKED';
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/invites/:token/accept`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const token = String(params.token);
      const mapping = db.chatInviteTokens.get(token);
      const record = mapping
        ? (db.chatInvites[mapping.chatId] ?? []).find((item) => item.id === mapping.inviteId)
        : undefined;
      if (!mapping || !record) {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(404, 'INVITE_NOT_FOUND', 'Invite not found');
      }
      if (db.forceInviteAcceptError) {
        const forced = db.forceInviteAcceptError;
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const chat = db.chats[mapping.chatId];
      if (!chat) {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(404, 'INVITE_NOT_FOUND', 'Invite not found');
      }
      const workspaceMember = db.workspaceMembers.some(
        (member) => member.user_id === db.me.user.id,
      );
      if (!workspaceMember) {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }
      const existing = activeChatMembers(db, mapping.chatId).find(
        (member) => member.user_id === db.me.user.id,
      );
      if (existing) {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ALREADY_MEMBER',
        });
        const result: InviteAcceptResult = {
          invite_id: record.id,
          workspace_id: chat.workspaceId,
          chat_id: chat.summary.id,
          role: existing.role,
          already_member: true,
        };
        return HttpResponse.json(result);
      }
      const presented = presentInvite(record);
      if (presented.status === 'REVOKED') {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(410, 'INVITE_REVOKED', 'Invite was revoked');
      }
      if (presented.status === 'EXPIRED') {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(410, 'INVITE_EXPIRED', 'Invite expired');
      }
      if (presented.status === 'EXHAUSTED' || record.used_count >= (record.max_uses ?? Infinity)) {
        db.inviteAcceptRequests.push({
          token,
          deviceId: request.headers.get('x-device-id'),
          result: 'ERROR',
        });
        return errorResponse(410, 'INVITE_EXHAUSTED', 'Invite exhausted');
      }
      const rows = (db.chatMembers[mapping.chatId] ??= []);
      const row = rows.find((member) => member.user_id === db.me.user.id);
      if (row) {
        row.status = 'ACTIVE';
        row.role = record.role;
        row.joined_at = new Date().toISOString();
      } else {
        rows.push({
          user_id: db.me.user.id,
          display_name: db.me.user.display_name,
          role: record.role,
          status: 'ACTIVE',
          joined_at: new Date().toISOString(),
        });
      }
      record.used_count += 1;
      if (record.max_uses !== null && record.used_count >= record.max_uses) {
        record.status = 'EXHAUSTED';
      }
      db.inviteAcceptRequests.push({
        token,
        deviceId: request.headers.get('x-device-id'),
        result: 'OK',
      });
      const result: InviteAcceptResult = {
        invite_id: record.id,
        workspace_id: chat.workspaceId,
        chat_id: chat.summary.id,
        role: record.role,
        already_member: false,
      };
      return HttpResponse.json(result);
    }),

    /* #79: self-service blocks. */
    http.post(`${API}/users/:userId/block`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const userId = String(params.userId);
      db.blockRequests.push({
        userId,
        action: 'BLOCK',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceBlockError) {
        const forced = db.forceBlockError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (userId === db.me.user.id) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Cannot block yourself');
      }
      const known = db.memberUsers.some((user) => user.user_id === userId);
      if (!known) return errorResponse(404, 'USER_NOT_FOUND', 'User not found');
      if (!db.blockedUsers.some((user) => user.user_id === userId)) {
        db.blockedUsers.push({ user_id: userId, blocked_at: new Date().toISOString() });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${API}/users/:userId/block`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const userId = String(params.userId);
      db.blockRequests.push({
        userId,
        action: 'UNBLOCK',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceBlockError) {
        const forced = db.forceBlockError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (userId === db.me.user.id) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Cannot unblock yourself');
      }
      const known = db.memberUsers.some((user) => user.user_id === userId);
      if (!known) return errorResponse(404, 'USER_NOT_FOUND', 'User not found');
      db.blockedUsers = db.blockedUsers.filter((user) => user.user_id !== userId);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/me/blocked`, ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      if (db.forceBlockedListError) {
        const forced = db.forceBlockedListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const items: BlockedUser[] = [...db.blockedUsers].sort(
        (left, right) =>
          right.blocked_at.localeCompare(left.blocked_at) ||
          left.user_id.localeCompare(right.user_id),
      );
      return HttpResponse.json({ items });
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
      const items: ChatPluginState[] = allCatalogPlugins(db).map((plugin) => {
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

      const plugin: Plugin | undefined = allCatalogPlugins(db).find((item) => item.id === pluginId);
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

    /* ------------------------------------------------------------------ */
    /* D1.1 (#76): poll actions                                           */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/chats/:chatId/polls`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      db.pollRequests.push({
        chatId,
        action: 'list',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.pollRequests.length > 200) db.pollRequests.shift();
      if (db.forcePollListError) {
        const forced = db.forcePollListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'polls');
      if (gate) return gate;
      const items = [...db.polls.values()]
        .filter((record) => record.chatId === chatId)
        .map((record) => pollView(record, db.me.user.id))
        .sort(compareCreatedDesc);
      return HttpResponse.json({ items });
    }),

    http.post(`${API}/chats/:chatId/polls`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const body = asRecord(await readJson(request));
      db.pollRequests.push({
        chatId,
        action: 'create',
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forcePollCreateError) {
        const forced = db.forcePollCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'polls');
      if (gate) return gate;
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');

      const questionIssue = plainTextIssue(body.question, 1, 500);
      if (questionIssue) {
        return errorResponse(400, 'VALIDATION_FAILED', `question ${questionIssue}`, {
          details: { field: 'question' },
        });
      }
      const rawOptions = body.options;
      if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 10) {
        return errorResponse(400, 'VALIDATION_FAILED', 'options must contain 2..10 items', {
          details: { field: 'options' },
        });
      }
      const options: string[] = [];
      for (const [index, raw] of rawOptions.entries()) {
        const issue = plainTextIssue(raw, 1, 200);
        if (issue) {
          return errorResponse(400, 'VALIDATION_FAILED', `options[${index}] ${issue}`, {
            details: { field: `options[${index}]` },
          });
        }
        const text = (raw as string).trim();
        if (options.includes(text)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'options must be unique', {
            details: { field: 'options', index },
          });
        }
        options.push(text);
      }

      const createdAt = new Date().toISOString();
      const poll: Poll = {
        id: newUuid(),
        question: (body.question as string).trim(),
        options: options.map((text, position) => ({
          id: newUuid(),
          text,
          position,
          votes: 0,
        })),
        creator_id: db.me.user.id,
        closed: false,
        closed_at: null,
        created_at: createdAt,
        my_option_id: null,
        total_votes: 0,
      };
      const record = { chatId, poll, votes: new Map<string, string>() };
      db.polls.set(poll.id, record);
      // #95: the backend creates the POLL timeline message in the same
      // transaction; the response carries its id and WS fans it out.
      const view = pollView(record, db.me.user.id);
      const message = insertMockPluginMessage(db, chatId, { type: 'POLL', poll: view });
      publishMockMessageCreated(db, message);
      return HttpResponse.json({ ...view, message_id: message.id }, { status: 201 });
    }),

    http.patch(`${API}/chats/:chatId/polls/:pollId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const pollId = String(params.pollId);
      const body = asRecord(await readJson(request));
      db.pollRequests.push({
        chatId,
        action: 'close',
        pollId,
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forcePollMutationError) {
        const forced = db.forcePollMutationError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'polls');
      if (gate) return gate;
      const record = db.polls.get(pollId);
      if (!record || record.chatId !== chatId) {
        return errorResponse(404, 'NOT_FOUND', 'Poll not found');
      }
      if (!body || typeof body.closed !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'closed must be a boolean', {
          details: { field: 'closed' },
        });
      }
      if (body.closed !== true) {
        return errorResponse(422, 'POLL_STATE_INVALID', 'Only closing a poll is supported');
      }
      if (record.poll.creator_id !== db.me.user.id) {
        return errorResponse(403, 'FORBIDDEN', 'Only the poll creator can close it');
      }
      if (!record.poll.closed) {
        record.poll.closed = true;
        record.poll.closed_at = new Date().toISOString();
      }
      const closedView = pollView(record, db.me.user.id);
      const closedMessage = db.chats[chatId]?.messages.find((item) => item.poll_id === pollId);
      if (closedMessage) closedMessage.poll = closedView;
      return HttpResponse.json(closedView);
    }),

    http.post(`${API}/chats/:chatId/polls/:pollId/votes`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const pollId = String(params.pollId);
      const body = asRecord(await readJson(request));
      db.pollRequests.push({
        chatId,
        action: 'vote',
        pollId,
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forcePollMutationError) {
        const forced = db.forcePollMutationError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'polls');
      if (gate) return gate;
      const record = db.polls.get(pollId);
      if (!record || record.chatId !== chatId) {
        return errorResponse(404, 'NOT_FOUND', 'Poll not found');
      }
      if (record.poll.closed) {
        return errorResponse(422, 'POLL_CLOSED', 'The poll is closed');
      }
      const optionId = body?.option_id;
      if (
        typeof optionId !== 'string' ||
        !record.poll.options.some((option) => option.id === optionId)
      ) {
        return errorResponse(422, 'POLL_OPTION_INVALID', 'Option does not belong to this poll');
      }
      // One vote per user; a different option replaces the previous choice and
      // the aggregate is recomputed by `pollView`, never incremented here.
      record.votes.set(db.me.user.id, optionId);
      const votedView = pollView(record, db.me.user.id);
      // History/replay reflects the latest projection; no `message.updated`
      // frame is published (the contract does not rewrite plugin messages).
      const votedMessage = db.chats[chatId]?.messages.find((item) => item.poll_id === pollId);
      if (votedMessage) votedMessage.poll = votedView;
      return HttpResponse.json(votedView);
    }),

    /* ------------------------------------------------------------------ */
    /* D1.1 (#76): task actions                                           */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/chats/:chatId/tasks`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      db.taskRequests.push({
        chatId,
        action: 'list',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTaskListError) {
        const forced = db.forceTaskListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'tasks');
      if (gate) return gate;
      const items = [...db.tasks.values()]
        .filter((record) => record.chatId === chatId)
        .map((record) => record.task)
        .sort(compareTasks);
      return HttpResponse.json({ items });
    }),

    http.post(`${API}/chats/:chatId/tasks`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const body = asRecord(await readJson(request));
      db.taskRequests.push({
        chatId,
        action: 'create',
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTaskCreateError) {
        const forced = db.forceTaskCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'tasks');
      if (gate) return gate;
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');

      const titleIssue = plainTextIssue(body.title, 1, 500);
      if (titleIssue) {
        return errorResponse(400, 'VALIDATION_FAILED', `title ${titleIssue}`, {
          details: { field: 'title' },
        });
      }
      let assigneeId: string | null = null;
      if (body.assignee_id !== undefined && body.assignee_id !== null) {
        if (
          typeof body.assignee_id !== 'string' ||
          !db.workspaceMembers.some((member) => member.user_id === body.assignee_id)
        ) {
          return errorResponse(422, 'TASK_ASSIGNEE_INVALID', 'Assignee is not an active member');
        }
        assigneeId = body.assignee_id;
      }
      let dueAt: string | null = null;
      if (body.due_at !== undefined && body.due_at !== null) {
        if (typeof body.due_at !== 'string' || Number.isNaN(Date.parse(body.due_at))) {
          return errorResponse(400, 'VALIDATION_FAILED', 'due_at must be an ISO date-time', {
            details: { field: 'due_at' },
          });
        }
        dueAt = new Date(body.due_at).toISOString();
      }
      const task: Task = {
        id: newUuid(),
        title: (body.title as string).trim(),
        creator_id: db.me.user.id,
        assignee_id: assigneeId,
        due_at: dueAt,
        done: false,
        completed_by: null,
        completed_at: null,
        created_at: new Date().toISOString(),
      };
      db.tasks.set(task.id, { chatId, task });
      const message = insertMockPluginMessage(db, chatId, { type: 'TASK', task });
      publishMockMessageCreated(db, message);
      return HttpResponse.json({ ...task, message_id: message.id }, { status: 201 });
    }),

    http.patch(`${API}/chats/:chatId/tasks/:taskId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const taskId = String(params.taskId);
      const body = asRecord(await readJson(request));
      db.taskRequests.push({
        chatId,
        action: 'update',
        taskId,
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTaskUpdateError) {
        const forced = db.forceTaskUpdateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const gate = pluginActionGate(db, found.chat, 'tasks');
      if (gate) return gate;
      const record = db.tasks.get(taskId);
      if (!record || record.chatId !== chatId) {
        return errorResponse(404, 'NOT_FOUND', 'Task not found');
      }
      if (!body || typeof body.done !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'done must be a boolean', {
          details: { field: 'done' },
        });
      }
      const task = record.task;
      const isOwnerOrAdmin = found.workspace.role === 'OWNER' || found.workspace.role === 'ADMIN';
      if (
        task.creator_id !== db.me.user.id &&
        task.assignee_id !== db.me.user.id &&
        !isOwnerOrAdmin
      ) {
        return errorResponse(403, 'FORBIDDEN', 'Not allowed to change this task');
      }
      if (task.done !== body.done) {
        task.done = body.done;
        task.completed_by = body.done ? db.me.user.id : null;
        task.completed_at = body.done ? new Date().toISOString() : null;
      }
      const taskMessage = db.chats[chatId]?.messages.find((item) => item.task_id === taskId);
      if (taskMessage) taskMessage.task = task;
      return HttpResponse.json(task);
    }),

    /* ------------------------------------------------------------------ */
    /* D1.1 (#76): managed TEXT translation                               */
    /* ------------------------------------------------------------------ */

    http.post(`${API}/chats/:chatId/messages/:messageId/translate`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const messageId = String(params.messageId);
      const body = asRecord(await readJson(request));
      db.translationRequests.push({
        chatId,
        messageId,
        body: body ?? {},
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceTranslationError) {
        const forced = db.forceTranslationError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const found = accessibleChat(db, chatId);
      if (!found) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      // Translation may never read ciphertext; this wins over the plugin gate
      // so the caller gets the contract's E2EE code.
      if (found.chat.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'E2EE_METADATA_FORBIDDEN', 'E2EE messages cannot be translated');
      }
      const gate = pluginActionGate(db, found.chat, 'translate');
      if (gate) return gate;
      if (!db.translationAvailable) {
        return errorResponse(503, 'TRANSLATION_UNAVAILABLE', 'Translation provider unavailable', {
          retryAfterSeconds: 30,
        });
      }
      const target = body?.target;
      if (
        typeof target !== 'string' ||
        target.length < 2 ||
        target.length > 16 ||
        !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(target)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'target is not a supported language tag', {
          details: { field: 'target' },
        });
      }
      const message = visibleMessage(found.chat, messageId);
      if (!message) return errorResponse(404, 'NOT_FOUND', 'Message not found');
      if (message.deleted_at || message.type !== 'TEXT' || !message.text?.trim()) {
        return errorResponse(422, 'MESSAGE_NOT_TRANSLATABLE', 'Message is not translatable');
      }
      return HttpResponse.json({ text: mockTranslation(target, message.text) });
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

    /* P0-4 (#82): workspace settings (name/description/logo). */
    http.patch(`${API}/workspaces/:workspaceId`, async ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      db.workspaceSettingsRequests.push({
        workspaceId,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceWorkspaceSettingsError) {
        const forced = db.forceWorkspaceSettingsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const workspace = findMockWorkspace(db, workspaceId);
      if (!workspace) return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      if (!workspaceRight(db, workspaceId, 'manage_workspace')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_workspace is required');
      }
      const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
      if (!has('name') && !has('description') && !has('logo_file_id')) {
        return errorResponse(400, 'VALIDATION_FAILED', 'At least one field is required');
      }
      let name = workspace.name;
      let description = workspace.description ?? null;
      let logoFileId = workspace.logo_file_id ?? null;
      if (has('name')) {
        if (typeof body.name !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'name must be a string', {
            details: { field: 'name' },
          });
        }
        const normalized = body.name.trim();
        if (normalized.length === 0 || normalized.length > 120) {
          return errorResponse(400, 'VALIDATION_FAILED', 'name is out of bounds', {
            details: { field: 'name' },
          });
        }
        name = normalized;
      }
      if (has('description')) {
        const raw = body.description;
        if (raw !== null && typeof raw !== 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', 'description must be a string', {
            details: { field: 'description' },
          });
        }
        const normalized = typeof raw === 'string' ? raw.trim() : '';
        if (normalized.length > 500 || hasForbiddenControl(normalized, true)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'description is invalid', {
            details: { field: 'description' },
          });
        }
        description = normalized.length > 0 ? normalized : null;
      }
      if (has('logo_file_id')) {
        if (body.logo_file_id === null) {
          logoFileId = null;
        } else if (typeof body.logo_file_id === 'string') {
          const file = imageFileView(db, body.logo_file_id);
          const invalid = imageValidationError(file, 'WORKSPACE_LOGO_INVALID');
          if (invalid) return invalid;
          logoFileId = body.logo_file_id;
        } else {
          return errorResponse(400, 'VALIDATION_FAILED', 'logo_file_id must be a uuid or null');
        }
      }
      const updated: WorkspaceSummary = {
        ...workspace,
        name,
        description,
        logo_file_id: logoFileId,
      };
      db.me = {
        ...db.me,
        workspaces: db.me.workspaces.map((item) => (item.id === workspaceId ? updated : item)),
      };
      if (db.session.workspace.id === workspaceId) {
        db.session = { ...db.session, workspace: { ...db.session.workspace, name } };
      }
      return HttpResponse.json(updated);
    }),

    http.post(`${API}/workspaces/:workspaceId/avatar`, async ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const body = asRecord(await readJson(request));
      const fileId = readStringField(body, 'file_id');
      if (!fileId) return errorResponse(400, 'VALIDATION_FAILED', 'file_id is required');
      db.workspaceAvatarRequests.push({ workspaceId, action: 'SET', fileId });
      const workspace = findMockWorkspace(db, workspaceId);
      if (!workspace) return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      if (!workspaceRight(db, workspaceId, 'manage_workspace')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_workspace is required');
      }
      const invalid = imageValidationError(imageFileView(db, fileId), 'WORKSPACE_LOGO_INVALID');
      if (invalid) return invalid;
      const updated: WorkspaceSummary = { ...workspace, logo_file_id: fileId };
      db.me = {
        ...db.me,
        workspaces: db.me.workspaces.map((item) => (item.id === workspaceId ? updated : item)),
      };
      return HttpResponse.json(updated);
    }),

    http.delete(`${API}/workspaces/:workspaceId/avatar`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      db.workspaceAvatarRequests.push({ workspaceId, action: 'DELETE', fileId: null });
      const workspace = findMockWorkspace(db, workspaceId);
      if (!workspace) return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      if (!workspaceRight(db, workspaceId, 'manage_workspace')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_workspace is required');
      }
      const updated: WorkspaceSummary = { ...workspace, logo_file_id: null };
      db.me = {
        ...db.me,
        workspaces: db.me.workspaces.map((item) => (item.id === workspaceId ? updated : item)),
      };
      return new HttpResponse(null, { status: 204 });
    }),

    /* P0-4 (#82): workspace invite links (metadata only; token shown once). */
    http.get(`${API}/workspaces/:workspaceId/invites`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      db.workspaceInviteRequests.push({ workspaceId, action: 'LIST' });
      if (db.forceWorkspaceInviteError) {
        const forced = db.forceWorkspaceInviteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceRight(db, workspaceId, 'manage_invites')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_invites is required');
      }
      return HttpResponse.json({
        invites: db.workspaceInvites
          .filter((invite) => invite.status !== 'REVOKED')
          .map((invite) => workspaceInviteView(invite)),
      });
    }),

    http.post(`${API}/workspaces/:workspaceId/invites`, async ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const body = (asRecord(await readJson(request)) ?? {}) as Record<string, unknown>;
      const role = (readStringField(body, 'role') ?? 'MEMBER') as WorkspaceInvite['role'];
      db.workspaceInviteRequests.push({ workspaceId, action: 'CREATE', role });
      if (db.forceWorkspaceInviteError) {
        const forced = db.forceWorkspaceInviteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const workspace = findMockWorkspace(db, workspaceId);
      if (!workspace) return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      if (!workspaceRight(db, workspaceId, 'manage_invites')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_invites is required');
      }
      const allowedRoles =
        workspace.role === 'OWNER' ? ['ADMIN', 'MEMBER', 'GUEST'] : ['MEMBER', 'GUEST'];
      if (!allowedRoles.includes(role)) {
        return errorResponse(
          403,
          'WORKSPACE_INVITE_ROLE_FORBIDDEN',
          'The invited role exceeds the caller role',
        );
      }
      const maxUsesRaw = body.max_uses;
      const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (emailRaw.length > 0) {
        if (
          emailRaw.length < 3 ||
          emailRaw.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)
        ) {
          return errorResponse(400, 'VALIDATION_FAILED', 'email is invalid', {
            details: { field: 'email' },
          });
        }
        if (maxUsesRaw !== undefined && maxUsesRaw !== null && maxUsesRaw !== 1) {
          return errorResponse(
            400,
            'VALIDATION_FAILED',
            'An email invite is single-use; max_uses must be 1',
            { details: { field: 'max_uses' } },
          );
        }
      }
      const maxUses =
        emailRaw.length > 0
          ? 1
          : typeof maxUsesRaw === 'number' && Number.isFinite(maxUsesRaw)
            ? Math.min(1000, Math.max(1, Math.trunc(maxUsesRaw)))
            : null;
      const expiresIn =
        typeof body.expires_in_seconds === 'number' && Number.isFinite(body.expires_in_seconds)
          ? Math.min(2592000, Math.max(300, Math.trunc(body.expires_in_seconds)))
          : 604800;
      const token = `mock-workspace-invite-${newUuid()}`;
      const created: MockWorkspaceInviteRecord = {
        id: newUuid(),
        role,
        status: 'ACTIVE' as const,
        used_count: 0,
        max_uses: maxUses,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        created_at: new Date().toISOString(),
        created_by: db.me.user.id,
        email: emailRaw.length > 0 ? emailRaw : null,
        token,
      };
      db.workspaceInvites.push(created);
      return HttpResponse.json(
        {
          invite: workspaceInviteView(created),
          token,
          accept_url: `/api/v1/workspace-invites/${token}/accept`,
        },
        { status: 201 },
      );
    }),

    http.delete(`${API}/workspaces/:workspaceId/invites/:inviteId`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const inviteId = String(params.inviteId);
      db.workspaceInviteRequests.push({ workspaceId, action: 'REVOKE', inviteId });
      if (db.forceWorkspaceInviteError) {
        const forced = db.forceWorkspaceInviteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceRight(db, workspaceId, 'manage_invites')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_invites is required');
      }
      const invite = db.workspaceInvites.find((item) => item.id === inviteId);
      if (!invite) {
        return errorResponse(404, 'WORKSPACE_INVITE_NOT_FOUND', 'Invite was not found');
      }
      invite.status = 'REVOKED';
      return new HttpResponse(null, { status: 204 });
    }),

    /**
     * #100 public preview. It has no bearer guard and returns display metadata
     * only: no token, hash or invited address.
     */
    http.get(`${API}/workspace-invites/:token`, ({ params }) => {
      const token = String(params.token);
      db.workspaceInviteRequests.push({ workspaceId: IDS.workspace, action: 'PREVIEW' });
      const invite = db.workspaceInvites.find((item) => item.token === token);
      if (!invite) {
        return errorResponse(404, 'WORKSPACE_INVITE_NOT_FOUND', 'Invite was not found');
      }
      const unavailable = workspaceInviteUnavailable(invite);
      if (unavailable) return unavailable;
      const workspace = findMockWorkspace(db, IDS.workspace);
      return HttpResponse.json({
        workspace_name: workspace?.name ?? 'Workspace',
        workspace_slug: workspace?.slug ?? 'workspace',
        role: invite.role,
        email_bound: Boolean(invite.email),
        expires_at: invite.expires_at,
      });
    }),

    http.post(`${API}/workspace-invites/:token/accept`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const token = String(params.token);
      db.workspaceInviteRequests.push({ workspaceId: IDS.workspace, action: 'ACCEPT' });
      if (db.forceWorkspaceInviteError) {
        const forced = db.forceWorkspaceInviteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const invite = db.workspaceInvites.find((item) => item.token === token);
      if (!invite) {
        return errorResponse(404, 'WORKSPACE_INVITE_NOT_FOUND', 'Invite was not found');
      }
      const unavailable = workspaceInviteUnavailable(invite);
      if (unavailable) return unavailable;
      if (workspaceInviteEmailMismatch(db, invite)) {
        return errorResponse(
          403,
          'WORKSPACE_INVITE_EMAIL_MISMATCH',
          'The invite is bound to another email',
        );
      }
      const workspace = findMockWorkspace(db, IDS.workspace);
      return HttpResponse.json({
        workspace_id: IDS.workspace,
        name: workspace?.name ?? 'Workspace',
        slug: workspace?.slug ?? 'workspace',
        role: invite.role,
        already_member: workspace !== null,
      });
    }),

    /* P0-4 (#82): OWNER/ADMIN/MEMBER permission matrix. */
    http.get(`${API}/workspaces/:workspaceId/permissions`, ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      db.workspacePermissionRequests.push({
        workspaceId,
        body: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceWorkspacePermissionError) {
        const forced = db.forceWorkspacePermissionError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!findMockWorkspace(db, workspaceId)) {
        return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      }
      const matrix =
        db.workspacePermissions[workspaceId] ?? createDefaultWorkspacePermissions(workspaceId);
      return HttpResponse.json(matrix);
    }),

    http.patch(`${API}/workspaces/:workspaceId/permissions`, async ({ request, params }) => {
      const unauthorized = requireBearer(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const body = asRecord(await readJson(request));
      db.workspacePermissionRequests.push({
        workspaceId,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceWorkspacePermissionError) {
        const forced = db.forceWorkspacePermissionError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const workspace = findMockWorkspace(db, workspaceId);
      if (!workspace) return errorResponse(404, 'NOT_FOUND', 'Workspace is not available');
      if (!workspaceRight(db, workspaceId, 'manage_permissions')) {
        return errorResponse(403, 'FORBIDDEN', 'manage_permissions is required');
      }
      const entries = Array.isArray(body?.entries)
        ? (body?.entries as WorkspacePermissionEntry[])
        : null;
      if (!entries || entries.length === 0 || entries.length > 18) {
        return errorResponse(400, 'VALIDATION_FAILED', 'entries are required');
      }
      const current =
        db.workspacePermissions[workspaceId] ?? createDefaultWorkspacePermissions(workspaceId);
      const next: WorkspacePermissionMatrix = {
        ...current,
        roles: current.roles.map((row) => ({ ...row })),
      };
      for (const entry of entries) {
        if (
          !entry ||
          !['OWNER', 'ADMIN', 'MEMBER'].includes(entry.role) ||
          ![
            'manage_workspace',
            'manage_members',
            'manage_invites',
            'manage_permissions',
            'view_audit',
            'manage_security',
          ].includes(entry.permission) ||
          typeof entry.allowed !== 'boolean'
        ) {
          return errorResponse(400, 'VALIDATION_FAILED', 'Invalid permission entry');
        }
        const currentRow = current.roles.find((row) => row.role === entry.role);
        const nextRow = next.roles.find((row) => row.role === entry.role);
        if (!currentRow || !nextRow) {
          return errorResponse(400, 'VALIDATION_FAILED', 'Unknown role');
        }
        if (entry.role === 'OWNER' && currentRow[entry.permission] !== entry.allowed) {
          return errorResponse(
            422,
            'OWNER_PERMISSIONS_IMMUTABLE',
            'Owner permissions are immutable',
          );
        }
        if (workspace.role === 'ADMIN' && entry.role === 'ADMIN') {
          return errorResponse(
            403,
            'PERMISSION_CHANGE_FORBIDDEN',
            'An admin can only change member permissions',
          );
        }
        nextRow[entry.permission] = entry.allowed;
      }
      db.workspacePermissions[workspaceId] = next;
      return HttpResponse.json(next);
    }),

    /* ------------------------------------------------------------------ */
    /* #96 bots: workspace management, chat install and the bot send API  */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/workspaces/:workspaceId/bots`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      db.botRequests.push({
        action: 'list',
        workspaceId,
        chatId: null,
        botId: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotListError) {
        const forced = db.forceBotListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!findMockWorkspace(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }
      return HttpResponse.json({
        items: db.bots
          .filter((bot) => bot.workspace_id === workspaceId)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .map(botView),
      });
    }),

    http.post(`${API}/workspaces/:workspaceId/bots`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      db.botRequests.push({
        action: 'create',
        workspaceId,
        chatId: null,
        botId: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotCreateError) {
        const forced = db.forceBotCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceManager(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const scopes = Array.isArray(body.scopes) ? body.scopes : null;
      if (name.length < 1 || name.length > 80) {
        return errorResponse(422, 'VALIDATION_FAILED', 'name must be 1..80 characters', {
          details: { field: 'name' },
        });
      }
      if (!scopes || scopes.length !== 1 || scopes[0] !== 'chat.write') {
        return errorResponse(422, 'VALIDATION_FAILED', 'scopes must be exactly [chat.write]', {
          details: { field: 'scopes' },
        });
      }
      const now = new Date().toISOString();
      const bot: MockBotRecord = {
        id: newUuid(),
        workspace_id: workspaceId,
        name,
        avatar_file_id: null,
        scopes: ['chat.write'],
        status: 'ACTIVE',
        created_by: db.me.user.id,
        created_at: now,
        updated_at: now,
        token_rotated_at: null,
        events_url: null,
        events: [],
        events_enabled: false,
        has_signing_secret: false,
        signing_secret_created_at: null,
        commands: [],
        token: newBotToken(workspaceId, newUuid()),
        signingSecret: null,
      };
      db.bots = [bot, ...db.bots];
      return HttpResponse.json({ bot: botView(bot), token: bot.token }, { status: 201 });
    }),

    http.patch(`${API}/workspaces/:workspaceId/bots/:botId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'update',
        workspaceId,
        chatId: null,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotUpdateError) {
        const forced = db.forceBotUpdateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceManager(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
      }
      const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
      if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name.length < 1 || name.length > 80) {
          return errorResponse(422, 'VALIDATION_FAILED', 'name must be 1..80 characters', {
            details: { field: 'name' },
          });
        }
        bot.name = name;
      }
      if (body.scopes !== undefined) {
        const scopes = Array.isArray(body.scopes) ? body.scopes : null;
        if (!scopes || scopes.length !== 1 || scopes[0] !== 'chat.write') {
          return errorResponse(422, 'VALIDATION_FAILED', 'scopes must be exactly [chat.write]', {
            details: { field: 'scopes' },
          });
        }
        bot.scopes = ['chat.write'];
      }
      if (body.status !== undefined) {
        if (body.status !== 'ACTIVE' && body.status !== 'DISABLED') {
          return errorResponse(422, 'VALIDATION_FAILED', 'status must be ACTIVE or DISABLED', {
            details: { field: 'status' },
          });
        }
        bot.status = body.status;
      }
      if (body.events_url !== undefined && body.events_url !== null) {
        if (typeof body.events_url !== 'string') {
          return errorResponse(422, 'VALIDATION_FAILED', 'events_url must be a string', {
            details: { field: 'events_url' },
          });
        }
        const url = body.events_url.trim();
        if (url === '') {
          // Contract: a blank value clears the endpoint and disables delivery.
          bot.events_url = null;
          bot.events_enabled = false;
        } else {
          if (!isValidEventsUrl(url)) {
            return errorResponse(
              422,
              'BOT_EVENTS_URL_INVALID',
              'events_url must be an absolute https URL without userinfo/query/fragment',
              { details: { field: 'events_url' } },
            );
          }
          bot.events_url = url;
        }
      }
      if (body.events !== undefined && body.events !== null) {
        const allowed = new Set(['message.created', 'app_mention']);
        if (
          !Array.isArray(body.events) ||
          body.events.length > 2 ||
          body.events.some((event) => typeof event !== 'string' || !allowed.has(event)) ||
          new Set(body.events).size !== body.events.length
        ) {
          return errorResponse(
            422,
            'VALIDATION_FAILED',
            'events must be a subset of the two types',
            {
              details: { field: 'events' },
            },
          );
        }
        bot.events = [...body.events] as Bot['events'];
      }
      const eventsEnabled = body.events_enabled ?? body.enabled;
      if (eventsEnabled !== undefined) {
        if (typeof eventsEnabled !== 'boolean') {
          return errorResponse(422, 'VALIDATION_FAILED', 'events_enabled must be a boolean', {
            details: { field: 'events_enabled' },
          });
        }
        bot.events_enabled = eventsEnabled;
      }
      if (body.commands !== undefined && body.commands !== null) {
        const parsed = parseCommandList(body.commands);
        if (typeof parsed === 'string') {
          return errorResponse(400, 'VALIDATION_FAILED', parsed, {
            details: { field: 'commands' },
          });
        }
        bot.commands = parsed;
      }
      const now = new Date().toISOString();
      let revealedSecret: string | null = null;
      if (bot.events_url && bot.events_enabled && bot.signingSecret === null) {
        // Backend parity: the first active event configuration generates the
        // secret atomically and reveals it exactly once in this response.
        bot.signingSecret = newSigningSecret();
        bot.has_signing_secret = true;
        bot.signing_secret_created_at = now;
        revealedSecret = bot.signingSecret;
      }
      bot.updated_at = now;
      return HttpResponse.json({
        ...botView(bot),
        ...(revealedSecret !== null ? { signing_secret: revealedSecret } : {}),
      });
    }),

    http.delete(`${API}/workspaces/:workspaceId/bots/:botId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'disable',
        workspaceId,
        chatId: null,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotDisableError) {
        const forced = db.forceBotDisableError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceManager(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
      }
      const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
      if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
      if (bot.status !== 'DISABLED') {
        bot.status = 'DISABLED';
        bot.updated_at = new Date().toISOString();
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/workspaces/:workspaceId/bots/:botId/token`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'rotate',
        workspaceId,
        chatId: null,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotRotateError) {
        const forced = db.forceBotRotateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceManager(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
      }
      const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
      if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
      const now = new Date().toISOString();
      bot.token = newBotToken(workspaceId, botId);
      bot.token_rotated_at = now;
      bot.updated_at = now;
      return HttpResponse.json({ bot: botView(bot), token: bot.token });
    }),

    http.post(`${API}/workspaces/:workspaceId/bots/:botId/secret`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'rotateSecret',
        workspaceId,
        chatId: null,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotSecretError) {
        const forced = db.forceBotSecretError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (!workspaceManager(db, workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
      }
      const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
      if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
      const now = new Date().toISOString();
      bot.signingSecret = newSigningSecret();
      bot.has_signing_secret = true;
      bot.signing_secret_created_at = now;
      bot.updated_at = now;
      return HttpResponse.json({ bot: botView(bot), signing_secret: bot.signingSecret });
    }),

    http.get(
      `${API}/workspaces/:workspaceId/bots/:botId/deliveries`,
      async ({ request, params }) => {
        const unauthorized = requireAuth(request);
        if (unauthorized) return unauthorized;
        const workspaceId = String(params.workspaceId);
        const botId = String(params.botId);
        db.botRequests.push({
          action: 'deliveries',
          workspaceId,
          chatId: null,
          botId,
          deviceId: request.headers.get('x-device-id'),
        });
        if (db.botDelayMs > 0) await delay(db.botDelayMs);
        if (db.forceBotDeliveriesError) {
          const forced = db.forceBotDeliveriesError;
          return errorResponse(forced.status, forced.code, forced.message, {
            details: forced.details,
            retryAfterSeconds: forced.retryAfterSeconds,
          });
        }
        if (!workspaceManager(db, workspaceId)) {
          return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
        }
        const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
        if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
        const rawLimit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
        if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
          return errorResponse(400, 'VALIDATION_FAILED', 'limit must be 1..100');
        }
        return HttpResponse.json({
          items: db.botDeliveries
            .filter((delivery) => delivery.workspaceId === workspaceId && delivery.botId === botId)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .slice(0, rawLimit)
            .map(deliveryView),
        });
      },
    ),

    http.post(
      `${API}/workspaces/:workspaceId/bots/:botId/test-event`,
      async ({ request, params }) => {
        const unauthorized = requireAuth(request);
        if (unauthorized) return unauthorized;
        const workspaceId = String(params.workspaceId);
        const botId = String(params.botId);
        db.botRequests.push({
          action: 'testEvent',
          workspaceId,
          chatId: null,
          botId,
          deviceId: request.headers.get('x-device-id'),
        });
        if (db.botDelayMs > 0) await delay(db.botDelayMs);
        if (db.forceBotTestEventError) {
          const forced = db.forceBotTestEventError;
          return errorResponse(forced.status, forced.code, forced.message, {
            details: forced.details,
            retryAfterSeconds: forced.retryAfterSeconds,
          });
        }
        if (!workspaceManager(db, workspaceId)) {
          return errorResponse(403, 'FORBIDDEN', 'OWNER or ADMIN role is required');
        }
        const bot = db.bots.find((item) => item.id === botId && item.workspace_id === workspaceId);
        if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
        if (!bot.events_url || bot.signingSecret === null) {
          return errorResponse(
            422,
            'BOT_EVENTS_NOT_CONFIGURED',
            'events_url and signing secret are required',
          );
        }
        const now = new Date().toISOString();
        const deliveryId = newUuid();
        db.botDeliveries.push({
          id: deliveryId,
          workspaceId,
          botId,
          event_type: 'test',
          event_id: newUuid(),
          chat_id: null,
          status: 'PENDING',
          attempt_count: 0,
          next_attempt_at: now,
          last_status_code: null,
          last_error: null,
          created_at: now,
          updated_at: now,
          delivered_at: null,
        });
        return HttpResponse.json({ delivery_id: deliveryId }, { status: 202 });
      },
    ),

    http.get(`${API}/chats/:chatId/bots`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      db.botRequests.push({
        action: 'listChat',
        workspaceId: null,
        chatId,
        botId: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceChatBotListError) {
        const forced = db.forceChatBotListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const record = db.chats[chatId];
      const member = record ? chatActorMember(db, chatId) : null;
      if (!record || !member) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      return HttpResponse.json({
        items: db.chatBots
          .filter((install) => install.chatId === chatId)
          .map((install) => chatBotView(db, install))
          .filter((item): item is ChatBot => item !== null),
      });
    }),

    http.post(`${API}/chats/:chatId/bots`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      db.botRequests.push({
        action: 'install',
        workspaceId: null,
        chatId,
        botId: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceChatBotInstallError) {
        const forced = db.forceChatBotInstallError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const record = db.chats[chatId];
      const member = record ? chatActorMember(db, chatId) : null;
      if (!record || !member) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!isManagerRole(member.role)) {
        return errorResponse(403, 'FORBIDDEN', 'Chat OWNER or ADMIN role is required');
      }
      if (record.summary.type !== 'GROUP') {
        return errorResponse(422, 'BOT_E2EE_UNSUPPORTED', 'Bots are GROUP-only');
      }
      if (record.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'BOT_E2EE_UNSUPPORTED', 'Bots are not available in E2EE chats');
      }
      const body = asRecord(await readJson(request));
      const botId = body && typeof body.bot_id === 'string' ? body.bot_id : '';
      const bot = db.bots.find(
        (item) => item.id === botId && item.workspace_id === record.workspaceId,
      );
      if (!bot) return errorResponse(404, 'BOT_NOT_FOUND', 'Bot not found');
      if (bot.status !== 'ACTIVE') return errorResponse(422, 'BOT_DISABLED', 'Bot is disabled');
      let install = db.chatBots.find((item) => item.chatId === chatId && item.botId === botId);
      if (!install) {
        const now = new Date().toISOString();
        install = {
          chatId,
          botId,
          workspaceId: record.workspaceId,
          enabled: true,
          installedBy: db.me.user.id,
          installedAt: now,
          updatedAt: now,
        };
        db.chatBots.push(install);
      }
      return HttpResponse.json(chatBotView(db, install), { status: 201 });
    }),

    http.delete(`${API}/chats/:chatId/bots/:botId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'uninstall',
        workspaceId: null,
        chatId,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceChatBotUninstallError) {
        const forced = db.forceChatBotUninstallError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const record = db.chats[chatId];
      const member = record ? chatActorMember(db, chatId) : null;
      if (!record || !member) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!isManagerRole(member.role)) {
        return errorResponse(403, 'FORBIDDEN', 'Chat OWNER or ADMIN role is required');
      }
      db.chatBots = db.chatBots.filter(
        (install) => !(install.chatId === chatId && install.botId === botId),
      );
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/chats/:chatId/commands`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotCommandError) {
        const forced = db.forceBotCommandError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const record = db.chats[chatId];
      const member = record ? chatActorMember(db, chatId) : null;
      if (!record || !member) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (record.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'BOT_E2EE_UNSUPPORTED', 'Bots are not available in E2EE chats');
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const rawCommand = typeof body.command === 'string' ? body.command : '';
      const normalized = rawCommand.trim().toLowerCase();
      const command = normalized.startsWith('/') ? normalized.slice(1) : normalized;
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(command)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'command is invalid', {
          details: { field: 'command' },
        });
      }
      if (body.args !== undefined && typeof body.args !== 'string') {
        return errorResponse(400, 'VALIDATION_FAILED', 'args must be a string', {
          details: { field: 'args' },
        });
      }
      const args = typeof body.args === 'string' ? body.args.trim() : '';
      if (args.length > 2000) {
        return errorResponse(422, 'VALIDATION_FAILED', 'args must be at most 2000 characters', {
          details: { field: 'args', max_length: 2000 },
        });
      }
      // Installed + enabled + ACTIVE bots that register this command.
      const candidates = db.chatBots
        .filter((install) => install.chatId === chatId && install.enabled)
        .map((install) =>
          db.bots.find((bot) => bot.id === install.botId && bot.status === 'ACTIVE'),
        )
        .filter((bot): bot is MockBotRecord => bot !== undefined)
        .filter((bot) => (bot.commands ?? []).some((entry) => entry.command === command));
      if (candidates.length === 0) {
        return errorResponse(
          404,
          'BOT_COMMAND_NOT_FOUND',
          'No installed bot registers this command',
        );
      }
      if (candidates.length > 1) {
        return errorResponse(
          409,
          'BOT_COMMAND_AMBIGUOUS',
          'More than one installed bot registers this command',
        );
      }
      const bot = candidates[0]!;
      if (!bot.events_url || bot.signingSecret === null) {
        return errorResponse(
          422,
          'BOT_EVENTS_NOT_CONFIGURED',
          'events_url and signing secret are required',
        );
      }
      db.botRequests.push({
        action: 'command',
        workspaceId: record.workspaceId,
        chatId,
        botId: bot.id,
        deviceId: request.headers.get('x-device-id'),
        command,
        args,
      });
      const now = new Date().toISOString();
      const deliveryId = newUuid();
      db.botDeliveries.push({
        id: deliveryId,
        workspaceId: record.workspaceId,
        botId: bot.id,
        event_type: 'slash_command',
        event_id: newUuid(),
        chat_id: chatId,
        status: 'PENDING',
        attempt_count: 0,
        next_attempt_at: now,
        last_status_code: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        delivered_at: null,
      });
      // No chat message: the bot answers later via its one-time response URL.
      return HttpResponse.json({ delivery_id: deliveryId }, { status: 202 });
    }),

    http.post(`${API}/bots/:botId/messages`, async ({ request, params }) => {
      const botId = String(params.botId);
      db.botRequests.push({
        action: 'send',
        workspaceId: null,
        chatId: null,
        botId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.botDelayMs > 0) await delay(db.botDelayMs);
      if (db.forceBotSendError) {
        const forced = db.forceBotSendError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const authorization = request.headers.get('authorization') ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const bot = db.bots.find(
        (item) => item.id === botId && item.token === token && item.status === 'ACTIVE',
      );
      if (!bot) return errorResponse(401, 'UNAUTHENTICATED', 'Invalid bot credentials');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
      }
      const body = asRecord(await readJson(request));
      const chatId = body && typeof body.chat_id === 'string' ? body.chat_id : '';
      const text = body && typeof body.text === 'string' ? body.text : '';
      if (!chatId || text.trim().length === 0 || text.length > 8000) {
        return errorResponse(400, 'VALIDATION_FAILED', 'chat_id and text are required');
      }
      const record = db.chats[chatId];
      if (!record || record.workspaceId !== bot.workspace_id) {
        return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      }
      if (record.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'BOT_E2EE_UNSUPPORTED', 'Bots are not available in E2EE chats');
      }
      const install = db.chatBots.find(
        (item) => item.chatId === chatId && item.botId === botId && item.enabled,
      );
      if (!install) {
        return errorResponse(403, 'BOT_NOT_INSTALLED', 'Bot is not installed in this chat');
      }
      const bodyHash = `${chatId}\u0000${text}`;
      const replayKey = `${botId}:${idempotencyKey}`;
      const existing = db.botSendIdempotency.get(replayKey);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          return errorResponse(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was reused with another body',
          );
        }
        const message = record.messages.find((item) => item.id === existing.messageId);
        if (message) {
          return HttpResponse.json(presentMessage(record, message), {
            status: 201,
            headers: { 'Idempotent-Replay': 'true' },
          });
        }
      }
      const message = insertMockBotMessage(db, chatId, { id: bot.id, name: bot.name }, text);
      db.botSendIdempotency.set(replayKey, { bodyHash, messageId: message.id });
      publishMockMessageCreated(db, message);
      return HttpResponse.json(presentMessage(record, message), { status: 201 });
    }),

    http.get(`${API}/workspaces/:workspaceId/chats`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = db.me.workspaces.find((item) => item.id === String(params.workspaceId));
      if (!workspace) {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }
      // #80: `?archived=true` is the caller's personal archive only; absent or
      // `false` is the main list without archived chats.
      const archived = new URL(request.url).searchParams.get('archived') === 'true';
      return HttpResponse.json({
        items: Object.values(db.chats)
          .filter((chat) => chat.workspaceId === workspace.id)
          .filter((chat) => (chat.summary.archived ?? false) === archived)
          // #78: a PRIVATE channel appears only for the creator and the
          // selected members (single-user mock RLS).
          .filter(
            (chat) =>
              chat.summary.visibility !== 'PRIVATE' || chat.memberIds.includes(db.me.user.id),
          )
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

      const workspaceManager = workspace.role === 'OWNER' || workspace.role === 'ADMIN';
      const actor = chatActorMember(db, chatId);
      const hasName = body.name !== undefined && body.name !== null;
      const hasDescription = body.description !== undefined && body.description !== null;
      const hasCover = typeof body.cover_file_id === 'string';
      const hasReadOnly = body.read_only !== undefined && body.read_only !== null;
      const hasVisibility = body.visibility !== undefined && body.visibility !== null;
      const hasJoinPolicy = body.join_policy !== undefined && body.join_policy !== null;
      const hasRights = body.rights !== undefined && body.rights !== null;
      const hasStructural = hasCover || hasReadOnly || hasVisibility || hasJoinPolicy || hasRights;
      if (!hasName && !hasDescription && !hasStructural) {
        return errorResponse(422, 'VALIDATION_FAILED', 'At least one field is required', {
          details: { reason: 'empty_patch' },
        });
      }
      if ((hasName || hasDescription) && !workspaceManager) {
        // P0-2 (#80): a channel role with `change_info` may edit name/description.
        const changeInfo =
          actor !== null && roleAllowed(matrixFor(db, chatId), actor.role, 'change_info');
        if (!changeInfo) {
          return errorResponse(403, 'FORBIDDEN', 'Not a workspace owner/admin');
        }
      }
      if (hasStructural) {
        if (record.summary.type === 'DIRECT') {
          return errorResponse(
            422,
            'CHAT_MEMBERSHIP_UNSUPPORTED',
            'DIRECT chats have no channel settings',
          );
        }
        if (!actorCanManage(actor)) {
          return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
        }
      }
      if (record.summary.security_mode === 'E2EE' && (hasDescription || hasCover)) {
        return errorResponse(
          422,
          'CHAT_SETTINGS_E2EE_UNSUPPORTED',
          'Description and cover are not available in an E2EE chat',
        );
      }

      const next = { ...record.summary };
      if (hasReadOnly) {
        if (typeof body.read_only !== 'boolean') {
          return errorResponse(422, 'VALIDATION_FAILED', 'read_only must be a boolean', {
            details: { field: 'read_only' },
          });
        }
        next.read_only = body.read_only;
      }
      if (hasVisibility) {
        if (body.visibility !== 'PUBLIC' && body.visibility !== 'PRIVATE') {
          return errorResponse(422, 'VALIDATION_FAILED', 'visibility is invalid', {
            details: { field: 'visibility' },
          });
        }
        next.visibility = body.visibility;
        // Server rule: PUBLIC requires/forces OPEN.
        if (body.visibility === 'PUBLIC') next.join_policy = 'OPEN';
        else if (next.join_policy === 'OPEN') next.join_policy = 'INVITE_ONLY';
      }
      if (hasJoinPolicy) {
        if (
          body.join_policy !== 'OPEN' &&
          body.join_policy !== 'INVITE_ONLY' &&
          body.join_policy !== 'CLOSED'
        ) {
          return errorResponse(422, 'VALIDATION_FAILED', 'join_policy is invalid', {
            details: { field: 'join_policy' },
          });
        }
        if (next.visibility === 'PUBLIC' && body.join_policy !== 'OPEN') {
          return errorResponse(422, 'VALIDATION_FAILED', 'PUBLIC requires OPEN', {
            details: { field: 'join_policy' },
          });
        }
        next.join_policy = body.join_policy;
      }
      if (hasCover) {
        const file =
          typeof body.cover_file_id === 'string'
            ? chatImageFileView(db, body.cover_file_id, chatId)
            : null;
        if (!file) {
          return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
        }
        next.cover_file_id = file.id;
      }
      if (hasRights) {
        const rights = body.rights;
        if (rights === null || typeof rights !== 'object' || Array.isArray(rights)) {
          return errorResponse(422, 'VALIDATION_FAILED', 'rights must be an object', {
            details: { field: 'rights' },
          });
        }
        const recordRights = rights as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(recordRights, 'owner')) {
          return errorResponse(422, 'VALIDATION_FAILED', 'OWNER rights are fixed', {
            details: { reason: 'owner_permissions_fixed' },
          });
        }
        const roleKeys = Object.keys(recordRights);
        if (roleKeys.length === 0) {
          return errorResponse(422, 'VALIDATION_FAILED', 'rights must not be empty');
        }
        const matrix = { ...matrixFor(db, chatId) };
        for (const role of roleKeys) {
          if (!(EDITABLE_ROLES as readonly string[]).includes(role)) {
            return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
              details: { field: 'role' },
            });
          }
          const rolePatch = recordRights[role];
          if (rolePatch === null || typeof rolePatch !== 'object') {
            return errorResponse(422, 'VALIDATION_FAILED', 'role rights must be an object');
          }
          const key = role as (typeof EDITABLE_ROLES)[number];
          const current = { ...(matrix[key] ?? {}) };
          const values = rolePatch as Record<string, unknown>;
          let changed = 0;
          for (const permission of PERMISSION_KEYS) {
            const value = values[permission];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'boolean') {
              return errorResponse(422, 'VALIDATION_FAILED', 'right must be a boolean');
            }
            current[permission] = value;
            changed += 1;
          }
          if (changed === 0) {
            return errorResponse(422, 'VALIDATION_FAILED', 'role has no permission values');
          }
          matrix[key] = current;
        }
        db.chatPermissions[chatId] = matrix;
      }
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
      return HttpResponse.json(chatResponseOf(next));
    }),

    /* ------------------------------------------------------------------ */
    /* #80: cover, rights, archive, pins and OWNER deletion                */
    /* ------------------------------------------------------------------ */

    http.post(`${API}/chats/:chatId/cover`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const fileId = typeof body.file_id === 'string' ? body.file_id : null;
      db.chatCoverRequests.push({
        chatId,
        fileId,
        action: 'SET',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatCoverError) {
        const forced = db.forceChatCoverError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no cover');
      }
      if (record.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'CHAT_SETTINGS_E2EE_UNSUPPORTED', 'E2EE has no cover');
      }
      if (!actorCanManage(chatActorMember(db, chatId))) {
        return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
      }
      if (fileId === null) {
        return errorResponse(422, 'VALIDATION_FAILED', 'file_id is required', {
          details: { field: 'file_id' },
        });
      }
      const file = chatImageFileView(db, fileId, chatId);
      if (!file) {
        return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
      }
      const isImage = (file.mime_type ?? '').startsWith('image/');
      if (!isImage) return errorResponse(422, 'CHAT_COVER_INVALID', 'Attachment is not an image');
      if (file.scan_status !== 'CLEAN' && file.scan_status !== 'SKIPPED') {
        return errorResponse(
          file.scan_status === 'INFECTED' ? 423 : 409,
          file.scan_status === 'INFECTED' ? 'ATTACHMENT_QUARANTINED' : 'ATTACHMENT_NOT_READY',
          'Attachment is not cover-ready',
        );
      }
      record.summary = { ...record.summary, cover_file_id: file.id };
      return HttpResponse.json(chatResponseOf(record.summary));
    }),

    http.delete(`${API}/chats/:chatId/cover`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatCoverRequests.push({
        chatId,
        fileId: null,
        action: 'DELETE',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatCoverError) {
        const forced = db.forceChatCoverError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no cover');
      }
      if (!actorCanManage(chatActorMember(db, chatId))) {
        return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
      }
      record.summary = { ...record.summary, cover_file_id: null };
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/chats/:chatId/avatar`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      const room = record ? null : findRoomByChatId(db, chatId);
      if (!record && !room) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const fileId = typeof body.file_id === 'string' ? body.file_id : null;
      db.chatAvatarRequests.push({
        chatId,
        fileId,
        action: 'SET',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatAvatarError) {
        const forced = db.forceChatAvatarError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record) {
        if (record.summary.type === 'DIRECT') {
          return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no avatar');
        }
        if (record.summary.security_mode === 'E2EE') {
          return errorResponse(422, 'CHAT_SETTINGS_E2EE_UNSUPPORTED', 'E2EE has no avatar');
        }
        if (!actorCanManage(chatActorMember(db, chatId))) {
          return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
        }
      } else if (room) {
        const workspace = findMockWorkspace(db, room.workspaceId);
        if (workspace?.security_mode === 'E2EE') {
          return errorResponse(422, 'CHAT_SETTINGS_E2EE_UNSUPPORTED', 'E2EE has no avatar');
        }
        if (!canManageRoomChat(db, room)) {
          return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
        }
      }
      if (fileId === null) {
        return errorResponse(422, 'VALIDATION_FAILED', 'file_id is required', {
          details: { field: 'file_id' },
        });
      }
      const file = chatImageFileView(db, fileId, chatId);
      if (!file) {
        return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
      }
      const isImage = (file.mime_type ?? '').startsWith('image/');
      if (!isImage) return errorResponse(422, 'CHAT_AVATAR_INVALID', 'Attachment is not an image');
      if (file.scan_status !== 'CLEAN' && file.scan_status !== 'SKIPPED') {
        return errorResponse(
          file.scan_status === 'INFECTED' ? 423 : 409,
          file.scan_status === 'INFECTED' ? 'ATTACHMENT_QUARANTINED' : 'ATTACHMENT_NOT_READY',
          'Attachment is not avatar-ready',
        );
      }
      if (record) {
        record.summary = { ...record.summary, avatar_file_id: file.id };
        return HttpResponse.json(chatResponseOf(record.summary));
      }
      if (room) {
        db.roomChatAvatars.set(room.chatId, file.id);
        return HttpResponse.json(roomChatResponseOf(db, room));
      }
      return errorResponse(404, 'NOT_FOUND', 'Chat not found');
    }),

    http.delete(`${API}/chats/:chatId/avatar`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      const room = record ? null : findRoomByChatId(db, chatId);
      if (!record && !room) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatAvatarRequests.push({
        chatId,
        fileId: null,
        action: 'DELETE',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatAvatarError) {
        const forced = db.forceChatAvatarError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record) {
        if (record.summary.type === 'DIRECT') {
          return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no avatar');
        }
        if (!actorCanManage(chatActorMember(db, chatId))) {
          return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
        }
        record.summary = { ...record.summary, avatar_file_id: null };
      } else if (room) {
        if (!canManageRoomChat(db, room)) {
          return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
        }
        db.roomChatAvatars.delete(room.chatId);
      }
      return new HttpResponse(null, { status: 204 });
    }),

    /*
     * The real endpoint answers `302 Location: <presigned>`; `fetch` follows it
     * and the browser only sees image bytes, so the mock serves the bytes with
     * a `200` (the client contract is a Blob either way).
     */
    http.get(`${API}/users/:userId/avatar`, () =>
      HttpResponse.json({ code: 'NOT_FOUND', message: 'Avatar not found' }, { status: 404 }),
    ),
    http.get(`${API}/chats/:chatId/avatar`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      const room = record ? null : findRoomByChatId(db, chatId);
      if (!record && !room) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const avatarId = record
        ? (record.summary.avatar_file_id ?? null)
        : room
          ? roomChatAvatarId(db, room)
          : null;
      db.chatAvatarRequests.push({
        chatId,
        fileId: avatarId,
        action: 'GET',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatAvatarError) {
        const forced = db.forceChatAvatarError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record && (record.summary.type === 'DIRECT' || record.summary.security_mode === 'E2EE')) {
        return errorResponse(404, 'NOT_FOUND', 'Avatar is not set');
      }
      if (!avatarId) {
        return errorResponse(404, 'NOT_FOUND', 'Avatar is not set');
      }
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }),

    http.get(`${API}/chats/:chatId/permissions`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatPermissionsRequests.push({
        chatId,
        body: null,
        action: 'GET',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatPermissionsError) {
        const forced = db.forceChatPermissionsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no matrix');
      }
      if (!chatActorMember(db, chatId)) {
        return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      }
      return HttpResponse.json(matrixFor(db, chatId));
    }),

    http.patch(`${API}/chats/:chatId/permissions`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      db.chatPermissionsRequests.push({
        chatId,
        body,
        action: 'PATCH',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatPermissionsUpdateError) {
        const forced = db.forceChatPermissionsUpdateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no matrix');
      }
      if (!actorCanManage(chatActorMember(db, chatId))) {
        return errorResponse(403, 'FORBIDDEN', 'Not a channel owner/admin');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'owner')) {
        return errorResponse(422, 'VALIDATION_FAILED', 'OWNER rights are fixed', {
          details: { reason: 'owner_permissions_fixed' },
        });
      }
      const roleKeys = Object.keys(body);
      if (roleKeys.length === 0) {
        return errorResponse(422, 'VALIDATION_FAILED', 'At least one role is required');
      }
      const matrix = { ...matrixFor(db, chatId) };
      for (const role of roleKeys) {
        if (!(EDITABLE_ROLES as readonly string[]).includes(role)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'role is invalid', {
            details: { field: 'role' },
          });
        }
        const rolePatch = asRecord(body[role]);
        if (!rolePatch) {
          return errorResponse(422, 'VALIDATION_FAILED', 'role rights must be an object');
        }
        const key = role as (typeof EDITABLE_ROLES)[number];
        const current = { ...(matrix[key] ?? {}) };
        let changed = 0;
        for (const permission of PERMISSION_KEYS) {
          const value = rolePatch[permission];
          if (value === undefined || value === null) continue;
          if (typeof value !== 'boolean') {
            return errorResponse(422, 'VALIDATION_FAILED', 'right must be a boolean');
          }
          current[permission] = value;
          changed += 1;
        }
        if (changed === 0) {
          return errorResponse(422, 'VALIDATION_FAILED', 'role has no permission values');
        }
        matrix[key] = current;
      }
      db.chatPermissions[chatId] = matrix;
      return HttpResponse.json(matrix);
    }),

    http.post(`${API}/chats/:chatId/archive`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatArchiveRequests.push({
        chatId,
        action: 'ARCHIVE',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatArchiveError) {
        const forced = db.forceChatArchiveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      record.summary = { ...record.summary, archived: true };
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/chats/:chatId/unarchive`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatArchiveRequests.push({
        chatId,
        action: 'UNARCHIVE',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatArchiveError) {
        const forced = db.forceChatArchiveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      record.summary = { ...record.summary, archived: false };
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/chats/:chatId/pins`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatPinRequests.push({
        chatId,
        messageId: null,
        action: 'LIST',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatPinsError) {
        const forced = db.forceChatPinsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no pins');
      }
      // Deleted messages are hidden from the pin list.
      const items = (db.chatPins[chatId] ?? []).filter((pin) => {
        const message = record.messages.find((item) => item.id === pin.message_id);
        return !message || !message.deleted_at;
      });
      return HttpResponse.json({ items });
    }),

    http.post(`${API}/chats/:chatId/pins`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const messageIdValue = typeof body.message_id === 'string' ? body.message_id : null;
      db.chatPinRequests.push({
        chatId,
        messageId: messageIdValue,
        action: 'PIN',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatPinError) {
        const forced = db.forceChatPinError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no pins');
      }
      if (record.summary.security_mode === 'E2EE') {
        return errorResponse(422, 'E2EE_METADATA_FORBIDDEN', 'E2EE has no pins');
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!roleAllowed(matrixFor(db, chatId), actor.role, 'pin_messages')) {
        return errorResponse(403, 'CHAT_PERMISSION_DENIED', 'No pin_messages right');
      }
      const message = record.messages.find(
        (item) => item.id === messageIdValue && !item.deleted_at,
      );
      if (!message) return errorResponse(404, 'NOT_FOUND', 'Message not found');
      const pins = db.chatPins[chatId] ?? [];
      const existing = pins.find((pin) => pin.message_id === message.id);
      if (existing) return HttpResponse.json(existing, { status: 200 });
      if (pins.length >= 50) {
        return errorResponse(409, 'CHAT_PIN_LIMIT', 'Pin limit reached');
      }
      const pin: ChatPin = {
        chat_id: chatId,
        message_id: message.id,
        pinned_by: db.me.user.id,
        pinned_at: new Date().toISOString(),
      };
      db.chatPins[chatId] = [pin, ...pins];
      return HttpResponse.json(pin, { status: 201 });
    }),

    http.delete(`${API}/chats/:chatId/pins/:messageId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      const messageIdValue = String(params.messageId);
      db.chatPinRequests.push({
        chatId,
        messageId: messageIdValue,
        action: 'UNPIN',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatPinError) {
        const forced = db.forceChatPinError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT has no pins');
      }
      const actor = chatActorMember(db, chatId);
      if (!actor) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      if (!roleAllowed(matrixFor(db, chatId), actor.role, 'pin_messages')) {
        return errorResponse(403, 'CHAT_PERMISSION_DENIED', 'No pin_messages right');
      }
      db.chatPins[chatId] = (db.chatPins[chatId] ?? []).filter(
        (pin) => pin.message_id !== messageIdValue,
      );
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${API}/chats/:chatId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const chatId = String(params.chatId);
      const record = db.chats[chatId];
      if (!record) return errorResponse(404, 'NOT_FOUND', 'Chat not found');
      db.chatDeleteRequests.push({
        chatId,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceChatDeleteError) {
        const forced = db.forceChatDeleteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.summary.type === 'DIRECT') {
        return errorResponse(422, 'CHAT_MEMBERSHIP_UNSUPPORTED', 'DIRECT cannot be deleted');
      }
      const actor = chatActorMember(db, chatId);
      if (actor?.role !== 'OWNER') {
        return errorResponse(403, 'FORBIDDEN', 'Only the channel OWNER can delete');
      }
      delete db.chats[chatId];
      db.chatPins[chatId] = [];
      db.chatPermissions[chatId] = defaultPermissionMatrix();
      return new HttpResponse(null, { status: 204 });
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
     * #99: `DELETE /workspaces/{id}/members/me`. The literal `/me` route is
     * registered before the `:userId` template, mirroring the backend's
     * literal-first mapping. The sole OWNER is `409 LAST_OWNER`; the mock drops
     * the workspace row and its chats so `/me` and the chat list agree.
     */
    http.delete(`${API}/workspaces/:workspaceId/members/me`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      db.workspaceLifecycleRequests.push({
        workspaceId,
        action: 'LEAVE',
        role: workspace.role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceWorkspaceLeaveError) {
        const forced = db.forceWorkspaceLeaveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (workspace.role === 'OWNER') {
        return errorResponse(409, 'LAST_OWNER', 'The last owner cannot leave');
      }
      db.me.workspaces = db.me.workspaces.filter((item) => item.id !== workspaceId);
      db.me.default_workspace_id = db.me.workspaces[0]?.id ?? null;
      db.workspaceMembers = db.workspaceMembers.filter(
        (member) => member.user_id !== db.me.user.id,
      );
      for (const [chatId, record] of Object.entries(db.chats)) {
        if (record.workspaceId === workspaceId) delete db.chats[chatId];
      }
      return new HttpResponse(null, { status: 204 });
    }),

    /**
     * #99: `DELETE /workspaces/{id}`. OWNER-only soft delete; a non-owner gets
     * `403 WORKSPACE_PERMISSION_DENIED`. The mock removes the workspace row and
     * its chats (the real server keeps message rows for retention, but they are
     * unreachable and the client must not render them).
     */
    http.delete(`${API}/workspaces/:workspaceId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      db.workspaceLifecycleRequests.push({
        workspaceId,
        action: 'DELETE',
        role: workspace.role,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceWorkspaceDeleteError) {
        const forced = db.forceWorkspaceDeleteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (workspace.role !== 'OWNER') {
        return errorResponse(
          403,
          'WORKSPACE_PERMISSION_DENIED',
          'Only the workspace owner can delete it',
        );
      }
      db.me.workspaces = db.me.workspaces.filter((item) => item.id !== workspaceId);
      db.me.default_workspace_id = db.me.workspaces[0]?.id ?? null;
      db.workspaceMembers = db.workspaceMembers.filter(
        (member) => member.user_id !== db.me.user.id,
      );
      for (const [chatId, record] of Object.entries(db.chats)) {
        if (record.workspaceId === workspaceId) delete db.chats[chatId];
      }
      return new HttpResponse(null, { status: 204 });
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

      // #78 channel visibility. The mock mirrors the contract guards:
      // GROUP defaults to PUBLIC, PRIVATE needs 1..100 distinct ACTIVE
      // workspace members and never the creator. DIRECT stays unchanged and
      // rejects any visibility/member_ids field.
      const rawVisibility = body.visibility;
      if (
        rawVisibility !== undefined &&
        rawVisibility !== null &&
        rawVisibility !== 'PUBLIC' &&
        rawVisibility !== 'PRIVATE'
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'visibility must be PUBLIC or PRIVATE', {
          details: { field: 'visibility' },
        });
      }
      if (
        body.member_ids !== undefined &&
        body.member_ids !== null &&
        !Array.isArray(body.member_ids)
      ) {
        return errorResponse(422, 'VALIDATION_FAILED', 'member_ids must be an array', {
          details: { field: 'member_ids' },
        });
      }
      const requestedMemberIds = Array.isArray(body.member_ids) ? body.member_ids : [];
      if (type === 'DIRECT') {
        const hasVisibility = rawVisibility !== undefined && rawVisibility !== null;
        if (hasVisibility || requestedMemberIds.length > 0) {
          return errorResponse(
            422,
            'VALIDATION_FAILED',
            'visibility and member_ids are GROUP-only',
            { details: { field: hasVisibility ? 'visibility' : 'member_ids' } },
          );
        }
      }
      const visibility: 'PUBLIC' | 'PRIVATE' | null =
        type === 'GROUP' ? (rawVisibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC') : null;
      let privateMemberIds: string[] = [];
      if (visibility === 'PUBLIC' && requestedMemberIds.length > 0) {
        return errorResponse(422, 'VALIDATION_FAILED', 'PUBLIC cannot list member_ids', {
          details: { field: 'member_ids' },
        });
      }
      if (visibility === 'PRIVATE') {
        if (requestedMemberIds.length < 1 || requestedMemberIds.length > 100) {
          return errorResponse(422, 'VALIDATION_FAILED', 'member_ids must contain 1..100 ids', {
            details: { field: 'member_ids', min_items: 1, max_items: 100 },
          });
        }
        const unique = new Set<string>();
        for (const memberId of requestedMemberIds) {
          if (typeof memberId !== 'string' || unique.has(memberId)) {
            return errorResponse(422, 'VALIDATION_FAILED', 'member_ids must be distinct ids', {
              details: { field: 'member_ids' },
            });
          }
          if (memberId === db.me.user.id) {
            return errorResponse(422, 'VALIDATION_FAILED', 'creator must not be listed', {
              details: { field: 'member_ids' },
            });
          }
          if (!db.workspaceMembers.some((member) => member.user_id === memberId)) {
            return errorResponse(422, 'VALIDATION_FAILED', 'unknown workspace member', {
              details: { field: 'member_ids' },
            });
          }
          unique.add(memberId);
        }
        privateMemberIds = [...unique];
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
        visibility,
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
        sender_type: 'USER',
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
          visibility,
          peer_id: chat.peer_id ?? null,
          peer_has_e2ee_capable_devices: false,
          last_message_at: now,
          unread_count: 0,
          last_seq: 1,
        },
        workspaceId: workspace.id,
        /** #78: PRIVATE chats are listed only for the creator/selected members. */
        memberIds: visibility === 'PRIVATE' ? [db.me.user.id, ...privateMemberIds] : [],
        messages: [systemMessage],
        clientMessageIds: new Map(),
        hiddenMessageIds: new Set(),
      };
      db.chatRequests.set(idempotencyKey, { bodyHash, chat });
      db.chatCreateRequests.push({ idempotencyKey, body });
      return HttpResponse.json(chat, { status: 201 });
    }),

    /*
     * #105 rooms. The mock mirrors the backend: ACTIVE rooms only, 30 s TTL
     * presence, creator/OWNER(ADMIN) permissions and an honest 409 ROOM_CLOSED.
     * It never fabricates a participant: every row comes from `db.rooms`.
     */
    http.get(`${API}/workspaces/:workspaceId/rooms`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = findMockWorkspace(db, String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      db.roomListRequests.push({
        workspaceId: workspace.id,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.roomDelayMs > 0) await delay(db.roomDelayMs);
      if (db.forceRoomListError) {
        const forced = db.forceRoomListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const items = db.rooms
        .filter((room) => room.workspaceId === workspace.id && room.status === 'ACTIVE')
        .slice()
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            right.id.localeCompare(left.id),
        )
        .map((room) => presentRoom(db, room));
      return HttpResponse.json({ items });
    }),

    http.post(`${API}/workspaces/:workspaceId/rooms`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = findMockWorkspace(db, String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      db.roomRequests.push({
        action: 'create',
        workspaceId: workspace.id,
        roomId: null,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceRoomCreateError) {
        const forced = db.forceRoomCreateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (workspace.security_mode === 'E2EE') {
        return errorResponse(
          409,
          'E2EE_GROUP_NOT_SUPPORTED',
          'Rooms are not available in an E2EE workspace',
        );
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0 || [...name].length > 120) {
        return errorResponse(400, 'VALIDATION_FAILED', 'name must be 1..120 characters', {
          details: { field: 'name', max_length: 120 },
        });
      }
      const requestedMediaMode = body.media_mode;
      if (
        requestedMediaMode !== undefined &&
        requestedMediaMode !== 'AUDIO' &&
        requestedMediaMode !== 'VIDEO'
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'media_mode must be AUDIO|VIDEO', {
          details: { field: 'media_mode' },
        });
      }
      const mediaMode: 'AUDIO' | 'VIDEO' = requestedMediaMode === 'AUDIO' ? 'AUDIO' : 'VIDEO';
      const usedByUser = countActiveChatsForUser(db, workspace.id, db.me.user.id);
      if (usedByUser >= db.admin.maxChatsPerUser) {
        return errorResponse(409, 'CHAT_LIMIT_REACHED', 'Chat limit reached', {
          details: { scope: 'USER', limit: db.admin.maxChatsPerUser, used: usedByUser },
        });
      }
      const now = new Date().toISOString();
      const chatId = newUuid();
      const roomId = newUuid();
      // Backing managed GROUP channel: the existing call signaling needs a
      // chat id, so the mock creates the same PUBLIC/OPEN channel the backend does.
      const systemMessage: ApiMessage = {
        id: newUuid(),
        chat_id: chatId,
        seq: 1,
        type: 'SYSTEM',
        sender_type: 'USER',
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
          name,
          type: 'GROUP',
          security_mode: workspace.security_mode,
          visibility: 'PUBLIC',
          peer_id: null,
          peer_has_e2ee_capable_devices: false,
          last_message_at: now,
          unread_count: 0,
          last_seq: 1,
        },
        workspaceId: workspace.id,
        memberIds: [],
        messages: [systemMessage],
        clientMessageIds: new Map(),
        hiddenMessageIds: new Set(),
      };
      const record: MockRoomRecord = {
        id: roomId,
        workspaceId: workspace.id,
        chatId,
        name,
        mediaMode,
        createdBy: db.me.user.id,
        createdAt: now,
        updatedAt: now,
        status: 'ACTIVE',
        participants: [],
      };
      db.rooms.push(record);
      return HttpResponse.json(presentRoom(db, record), { status: 201 });
    }),

    http.get(`${API}/rooms/:roomId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const record = findMockRoom(db, String(params.roomId));
      if (!record || !findMockWorkspace(db, record.workspaceId)) {
        return errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found');
      }
      return HttpResponse.json(presentRoom(db, record));
    }),

    http.patch(`${API}/workspaces/:workspaceId/rooms/:roomId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = findMockWorkspace(db, String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      const record = findMockRoom(db, String(params.roomId));
      if (!record || record.workspaceId !== workspace.id) {
        return errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found');
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const hasName = body.name !== undefined;
      const hasMediaMode = body.media_mode !== undefined;
      db.roomRequests.push({
        action: hasMediaMode && !hasName ? 'media_mode' : 'rename',
        workspaceId: workspace.id,
        roomId: record.id,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceRoomUpdateError) {
        const forced = db.forceRoomUpdateError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const workspaceManager = workspace.role === 'OWNER' || workspace.role === 'ADMIN';
      if (record.createdBy !== db.me.user.id && !workspaceManager) {
        return errorResponse(403, 'FORBIDDEN', 'Not a room creator or workspace admin');
      }
      if (record.status === 'CLOSED') {
        return errorResponse(409, 'ROOM_CLOSED', 'Room is closed');
      }
      if (!hasName && !hasMediaMode) {
        return errorResponse(400, 'VALIDATION_FAILED', 'name or media_mode is required', {
          details: { fields: ['name', 'media_mode'] },
        });
      }
      let name: string | null = null;
      if (hasName) {
        name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name.length === 0 || [...name].length > 120) {
          return errorResponse(400, 'VALIDATION_FAILED', 'name must be 1..120 characters', {
            details: { field: 'name', max_length: 120 },
          });
        }
      }
      let mediaMode: 'AUDIO' | 'VIDEO' | null = null;
      if (hasMediaMode) {
        if (body.media_mode !== 'AUDIO' && body.media_mode !== 'VIDEO') {
          return errorResponse(400, 'VALIDATION_FAILED', 'media_mode must be AUDIO|VIDEO', {
            details: { field: 'media_mode' },
          });
        }
        mediaMode = body.media_mode;
      }
      if (name !== null) record.name = name;
      if (mediaMode !== null) record.mediaMode = mediaMode;
      record.updatedAt = new Date().toISOString();
      const chat = db.chats[record.chatId];
      if (chat && name !== null) chat.summary = { ...chat.summary, name };
      return HttpResponse.json(presentRoom(db, record));
    }),

    http.delete(`${API}/workspaces/:workspaceId/rooms/:roomId`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspace = findMockWorkspace(db, String(params.workspaceId));
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      const record = findMockRoom(db, String(params.roomId));
      if (!record || record.workspaceId !== workspace.id) {
        return errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found');
      }
      db.roomRequests.push({
        action: 'close',
        workspaceId: workspace.id,
        roomId: record.id,
        body: null,
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceRoomCloseError) {
        const forced = db.forceRoomCloseError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      // Soft close: only the creator or a workspace OWNER (ADMIN alone cannot).
      if (record.createdBy !== db.me.user.id && workspace.role !== 'OWNER') {
        return errorResponse(
          403,
          'FORBIDDEN',
          'Only the room creator or workspace OWNER can close',
        );
      }
      record.status = 'CLOSED';
      record.updatedAt = new Date().toISOString();
      record.participants = [];
      // #106: the backing channel and its avatar disappear together.
      db.roomChatAvatars.delete(record.chatId);
      // The backing channel is soft-deleted, so it leaves the chat list.
      delete db.chats[record.chatId];
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/rooms/:roomId/presence`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const record = findMockRoom(db, String(params.roomId));
      if (!record || !findMockWorkspace(db, record.workspaceId)) {
        return errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found');
      }
      db.roomPresenceRequests.push({
        roomId: record.id,
        action: 'join',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceRoomPresenceError) {
        const forced = db.forceRoomPresenceError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (record.status !== 'ACTIVE') {
        return errorResponse(409, 'ROOM_CLOSED', 'Room is closed');
      }
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const existing = record.participants.find(
        (participant) => participant.user_id === db.me.user.id,
      );
      if (existing) {
        const seen = Date.parse(existing.last_seen_at);
        // A heartbeat inside the TTL keeps `joined_at`; an expired session restarts it.
        if (!Number.isFinite(seen) || now - seen > ROOM_PRESENCE_TTL_MS) {
          existing.joined_at = nowIso;
        }
        existing.display_name = db.me.user.display_name;
        existing.last_seen_at = nowIso;
      } else {
        record.participants.push({
          user_id: db.me.user.id,
          display_name: db.me.user.display_name,
          joined_at: nowIso,
          last_seen_at: nowIso,
        });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${API}/rooms/:roomId/presence`, ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const record = findMockRoom(db, String(params.roomId));
      if (!record || !findMockWorkspace(db, record.workspaceId)) {
        return errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found');
      }
      db.roomPresenceRequests.push({
        roomId: record.id,
        action: 'leave',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.forceRoomPresenceError) {
        const forced = db.forceRoomPresenceError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      // Idempotent and allowed for a closed room (ephemeral cleanup only).
      record.participants = record.participants.filter(
        (participant) => participant.user_id !== db.me.user.id,
      );
      return new HttpResponse(null, { status: 204 });
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

    /* #84: workspace dashboard aggregates (any ACTIVE member). */
    http.get(`${API}/workspaces/:workspaceId/overview`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      db.workspaceOverview.requests.push({ workspaceId });
      if (db.workspaceOverview.delayMs > 0) await delay(db.workspaceOverview.delayMs);
      const forced = db.workspaceOverview.forceError;
      if (forced) {
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      return HttpResponse.json(
        db.workspaceOverview.override ?? workspaceOverviewView(db, workspaceId),
      );
    }),

    /* #83: global workspace file upload (managed pipeline, multipart). */
    http.post(`${API}/workspaces/:workspaceId/files`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      const workspace = db.me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);
      if (db.forceWorkspaceUploadError) {
        const forced = db.forceWorkspaceUploadError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }

      const form = await readMultipartForm(request);
      if (!form?.file) {
        return errorResponse(400, 'VALIDATION_FAILED', 'file part is required');
      }
      const filename = form.file.fileName;
      const size = form.file.bytes.byteLength;
      const mime = form.file.contentType ?? '';
      if (!validDisplayName(filename)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'filename is invalid', {
          details: { field: 'file' },
        });
      }
      if (size > db.limits.max_file_bytes) {
        return errorResponse(413, 'FILE_TOO_LARGE', 'File exceeds the tariff limit', {
          details: { max_file_bytes: db.limits.max_file_bytes },
        });
      }
      if (db.limits.usage.used + db.limits.usage.reserved + size > db.limits.storage_bytes) {
        return errorResponse(413, 'STORAGE_QUOTA_EXCEEDED', 'Workspace storage is full');
      }
      const extension = filename.split('.').pop()?.toLowerCase() ?? '';
      if (WORKSPACE_DANGEROUS_EXTENSIONS.has(extension)) {
        return errorResponse(422, 'DANGEROUS_TYPE_BLOCKED', 'File type is blocked', {
          details: { extension },
        });
      }

      const id = newUuid();
      const uploadId = newUuid();
      const created = new Date().toISOString();
      // #97: the backend parses AUDIO after storing it and returns the media
      // in the same 201; the file-center refresh then shows the tags.
      const extracted = await extractServerMedia(
        form.file.bytes,
        filename,
        mime,
        id,
        new URL(request.url).origin,
      );
      const item: FileItem = {
        id,
        filename,
        size_bytes: size,
        mime_type: mime || null,
        // The mock completes the AV step synchronously; production returns
        // PENDING here and the scan handler flips it to CLEAN/QUARANTINED.
        scan_status: 'CLEAN',
        chat_id: null,
        chat_name: null,
        message_id: null,
        created_at: created,
        ...(extracted ? { media: extracted.media } : {}),
      };
      db.fileCenterItems.unshift(item);
      db.limits.usage.used += size;
      db.fileUploadRequests.push({ workspaceId, filename, size, mime });
      if (extracted?.artwork) db.attachmentArtworks.set(id, extracted.artwork);
      db.uploads.set(uploadId, {
        id: uploadId,
        chatId: null,
        filename,
        size,
        mime,
        media: extracted?.media ?? null,
        declaredSha256: null,
        partSize: Math.max(1, size),
        totalParts: 1,
        received: new Map(),
        status: 'READY',
        expiresAt: Date.now() + 86_400_000,
        attachmentId: id,
        scanStatus: 'CLEAN',
        scanPollsRemaining: 0,
        finalizedSha256: '0'.repeat(64),
        createdAt: Date.now(),
        reservedReleased: true,
      });
      db.attachments.set(id, {
        ref: {
          id,
          filename,
          size_bytes: size,
          mime_type: mime || null,
          scan_status: 'CLEAN',
          ...(extracted ? { media: extracted.media } : {}),
        },
        uploadId,
        messageId: null,
      });
      return HttpResponse.json(item, { status: 201 });
    }),

    /* #83: owner-only display-name rename. */
    http.patch(`${API}/files/:fileId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);
      if (db.forceFileRenameError) {
        const forced = db.forceFileRenameError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
        });
      }
      const item = db.fileCenterItems.find((row) => row.id === String(params.fileId));
      if (!item) return errorResponse(404, 'NOT_FOUND', 'File not found');
      const body = await readJson(request);
      const name = (body as { name?: unknown } | null)?.name;
      if (!validDisplayName(name)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'name must be 1..255 characters', {
          details: { field: 'name' },
        });
      }
      item.filename = name;
      db.fileRenameRequests.push({ fileId: item.id, name, idempotencyKey });
      return HttpResponse.json(item);
    }),

    /* #83: soft delete (owner or workspace OWNER/ADMIN); repeat is 204. */
    http.delete(`${API}/files/:fileId`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);
      if (db.forceFileDeleteError) {
        const forced = db.forceFileDeleteError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
        });
      }
      const fileId = String(params.fileId);
      if (db.deletedFileIds.has(fileId)) return new HttpResponse(null, { status: 204 });
      const index = db.fileCenterItems.findIndex((row) => row.id === fileId);
      if (index < 0) return errorResponse(404, 'NOT_FOUND', 'File not found');
      const item = db.fileCenterItems[index]!;
      if (item.message_id !== null) {
        return errorResponse(409, 'CONFLICT', 'File is attached to a message', {
          details: { reason: 'attached_to_message' },
        });
      }
      db.fileCenterItems.splice(index, 1);
      db.deletedFileIds.add(fileId);
      db.fileDeleteRequests.push({ fileId, idempotencyKey });
      db.limits.usage.used = Math.max(0, db.limits.usage.used - item.size_bytes);
      const attachment = db.attachments.get(fileId);
      if (attachment) db.uploads.delete(attachment.uploadId);
      db.attachments.delete(fileId);
      return new HttpResponse(null, { status: 204 });
    }),

    /* #83: literal managed-text search with snippet + highlight ranges. */
    http.get(`${API}/workspaces/:workspaceId/search/messages`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const workspaceId = String(params.workspaceId);
      if (!db.me.workspaces.some((item) => item.id === workspaceId)) {
        return errorResponse(403, 'FORBIDDEN', 'Not a workspace member');
      }
      const url = new URL(request.url);
      const record: Record<string, string | null> = {};
      for (const key of ['q', 'chat_id', 'from', 'to', 'cursor', 'limit']) {
        record[key] = url.searchParams.get(key);
      }
      db.searchRequests.push(record);
      if (db.searchDelayMs > 0) await delay(db.searchDelayMs);
      if (db.forceSearchError) {
        const forced = db.forceSearchError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
        });
      }
      const q = record.q ?? '';
      if (q.length < 1 || q.length > 200) {
        return errorResponse(400, 'VALIDATION_FAILED', 'q must be 1..200 characters', {
          details: { field: 'q' },
        });
      }
      const chatId = record.chat_id ?? null;
      if (chatId !== null && !UUID_RE.test(chatId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'chat_id must be a UUID', {
          details: { field: 'chat_id' },
        });
      }
      const limitRaw = record.limit;
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be 1..50', {
          details: { field: 'limit' },
        });
      }
      let offset = 0;
      if (record.cursor) {
        const decoded = decodeSearchCursor(record.cursor, q, chatId);
        if (decoded === null) {
          return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid', {
            details: { field: 'cursor' },
          });
        }
        offset = decoded;
      }

      const needle = q.toLocaleLowerCase('ru');
      const hits: Array<{
        message_id: string;
        chat_id: string;
        chat_name: string | null;
        seq: number;
        sender_id: string | null;
        sender_display_name: string | null;
        snippet: string;
        highlights: SnippetRange[];
        created_at: string;
      }> = [];
      for (const chat of Object.values(db.chats)) {
        if (chat.workspaceId !== workspaceId) continue;
        if (chat.summary.security_mode !== 'MANAGED') continue;
        if (chatId !== null && chat.summary.id !== chatId) continue;
        for (const message of chat.messages) {
          if (message.deleted_at || chat.hiddenMessageIds.has(message.id)) continue;
          if (message.type !== 'TEXT' || !message.text) continue;
          if (!message.text.toLocaleLowerCase('ru').includes(needle)) continue;
          const { snippet, highlights } = buildSearchSnippet(message.text, q);
          hits.push({
            message_id: message.id,
            chat_id: chat.summary.id,
            chat_name: chat.summary.name ?? null,
            seq: message.seq,
            sender_id: message.sender_id ?? null,
            sender_display_name: message.sender_display_name ?? null,
            snippet,
            highlights,
            created_at: message.created_at,
          });
        }
      }
      hits.sort((left, right) => {
        const byDate = right.created_at.localeCompare(left.created_at);
        return byDate !== 0 ? byDate : right.message_id.localeCompare(left.message_id);
      });
      const pageItems = hits.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      const hasMore = nextOffset < hits.length;
      return HttpResponse.json({
        items: pageItems,
        page: {
          next_cursor: hasMore ? encodeSearchCursor(nextOffset, q, chatId) : null,
          has_more: hasMore,
        },
        query: q,
      });
    }),

    /* #83: mention inbox (metadata only) + unread counter. */
    http.get(`${API}/me/mentions`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const url = new URL(request.url);
      const record: Record<string, string | null> = {};
      for (const key of ['workspace_id', 'unread', 'cursor', 'limit']) {
        record[key] = url.searchParams.get(key);
      }
      db.mentionListRequests.push(record);
      if (db.forceMentionListError) {
        const forced = db.forceMentionListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
        });
      }
      const unreadOnly = record.unread === 'true';
      const limitRaw = record.limit;
      const limit = limitRaw === null ? 30 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be 1..100', {
          details: { field: 'limit' },
        });
      }
      const binding = `${unreadOnly ? 'unread' : 'all'}`;
      let offset = 0;
      if (record.cursor) {
        const decoded = decodeCursor(record.cursor, 'mp1', binding);
        if (decoded === null) {
          return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid', {
            details: { field: 'cursor' },
          });
        }
        offset = decoded;
      }
      const sorted = [...db.mentions].sort((left, right) => {
        const byDate = right.created_at.localeCompare(left.created_at);
        return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
      });
      const filtered = unreadOnly ? sorted.filter((item) => item.read_at === null) : sorted;
      const pageItems = filtered.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      const hasMore = nextOffset < filtered.length;
      return HttpResponse.json({
        items: pageItems,
        page: {
          next_cursor: hasMore ? encodeCursor('mp1', nextOffset, binding) : null,
          has_more: hasMore,
        },
        unread_count: db.mentions.filter((item) => item.read_at === null).length,
      });
    }),

    /* #83: mark mentions read; `ids` or `all`, one-shot `read_at` per row. */
    http.post(`${API}/me/mentions/read`, async ({ request }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Idempotency-Key header is required');
      }
      const body = await readJson(request);
      const candidate = (body ?? {}) as { ids?: unknown; all?: unknown };
      db.mentionReadRequests.push({
        body: candidate as Record<string, unknown>,
        idempotencyKey,
      });
      if (db.forceMentionReadError) {
        const forced = db.forceMentionReadError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
        });
      }
      const all = candidate.all === true;
      const ids = candidate.ids;
      if (!all && (!Array.isArray(ids) || ids.length === 0)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'ids or all is required', {
          details: { field: 'ids' },
        });
      }
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 200)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'ids must be an array of at most 200', {
          details: { field: 'ids' },
        });
      }
      const wanted = all ? null : new Set(ids as string[]);
      const readAt = new Date().toISOString();
      for (const mention of db.mentions) {
        if (wanted !== null && !wanted.has(mention.id)) continue;
        if (mention.read_at === null) mention.read_at = readAt;
      }
      return new HttpResponse(null, { status: 204 });
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
     * #97: authenticated cover bytes (`GET /attachments/{id}/artwork`). The
     * route requires the bearer/device pair like every other attachment call,
     * so a direct `<img src=artwork_url>` would get `401` — exactly the bug the
     * frontend must avoid by fetching through the API client.
     */
    http.get(`${API}/attachments/:attachmentId/artwork`, async ({ request, params }) => {
      const unauthorized = requireAuth(request);
      if (unauthorized) return unauthorized;
      const attachmentId = String(params.attachmentId);
      db.artworkRequests.push({ attachmentId, authorized: true });
      if (db.fileDelayMs > 0) await delay(db.fileDelayMs);

      if (db.forceArtworkError) {
        const forced = db.forceArtworkError;
        if (forced.once) db.forceArtworkError = null;
        return fileErrorResponse(
          forced.status,
          forced.code,
          forced.message,
          forced.details,
          forced.retryAfterSeconds,
        );
      }

      const attachment = db.attachments.get(attachmentId);
      if (!attachment) return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
      const upload = db.uploads.get(attachment.uploadId);
      if (!upload) return errorResponse(404, 'NOT_FOUND', 'Attachment not found');
      if (upload.status === 'EXPIRED' || upload.status === 'ABORTED') {
        return fileErrorResponse(410, 'ATTACHMENT_DELETED', 'Attachment was deleted');
      }
      if (upload.status === 'QUARANTINED' || attachment.ref.scan_status === 'INFECTED') {
        return fileErrorResponse(423, 'ATTACHMENT_QUARANTINED', 'Attachment is quarantined');
      }
      if (attachment.ref.scan_status !== 'CLEAN' || upload.status === 'SCANNING') {
        return fileErrorResponse(409, 'SCAN_PENDING', 'Attachment is still being scanned');
      }

      const artwork = db.attachmentArtworks.get(attachmentId);
      if (!artwork) return errorResponse(404, 'NOT_FOUND', 'Artwork not found');
      return new HttpResponse(artwork.bytes, {
        headers: {
          'Content-Type': artwork.mime,
          'Content-Length': String(artwork.bytes.byteLength),
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
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

      // P0-2 (#80): read-only blocks every role except chat OWNER/ADMIN.
      // An idempotent replay above still returns the stored message.
      if (chat.summary.read_only) {
        const actor = chatActorMember(db, chat.summary.id);
        if (actor && !isManagerRole(actor.role)) {
          return errorResponse(403, 'CHAT_READ_ONLY', 'The channel is read-only', {
            details: { chat_id: chat.summary.id },
          });
        }
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
      // #83: explicit mention payload, validated before `seq` allocation.
      let mentionIds: string[] = [];
      let mentionAll = false;

      if (candidate.type === 'STICKER') {
        const rawText = candidate.text;
        const rawAttachments = candidate.attachment_ids;
        const hasText = typeof rawText === 'string' && rawText.length > 0;
        const hasAttachments = Array.isArray(rawAttachments) && rawAttachments.length > 0;
        if (
          hasText ||
          hasAttachments ||
          (Array.isArray(candidate.mentions) && candidate.mentions.length > 0) ||
          candidate.mention_all === true ||
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

      // #83: mention ids are active participants of *this* chat (no existence
      // disclosure), `@all` is a chat-manager broadcast, E2EE forbids both.
      const rawMentions = candidate.mentions;
      if (rawMentions !== undefined && rawMentions !== null) {
        if (!Array.isArray(rawMentions)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'mentions must be an array', {
            details: { field: 'mentions' },
          });
        }
        if (rawMentions.length > 50) {
          return errorResponse(422, 'VALIDATION_FAILED', 'mentions must contain at most 50 ids', {
            details: { field: 'mentions', max_items: 50 },
          });
        }
      }
      if (candidate.mention_all !== undefined && typeof candidate.mention_all !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'mention_all must be a boolean', {
          details: { field: 'mention_all' },
        });
      }
      const wantsMentions =
        (Array.isArray(rawMentions) && rawMentions.length > 0) || candidate.mention_all === true;
      const isE2eeBody = Array.isArray(candidate.envelopes) && candidate.envelopes.length > 0;
      if (wantsMentions && isE2eeBody) {
        return errorResponse(
          422,
          'E2EE_PLAINTEXT_FORBIDDEN',
          'E2EE messages must not contain mentions',
          { details: { field: 'mentions' } },
        );
      }
      if (!isE2eeBody) {
        const participants = (db.chatMembers[chat.summary.id] ?? []).filter(
          (member) => member.status === 'ACTIVE',
        );
        const participantIds = new Set(participants.map((member) => member.user_id));
        const actor = chatActorMember(db, chat.summary.id);
        for (const [index, id] of (Array.isArray(rawMentions) ? rawMentions : []).entries()) {
          if (typeof id !== 'string' || !UUID_RE.test(id) || !participantIds.has(id)) {
            return errorResponse(
              422,
              'MENTION_INVALID',
              'A mentioned user is not an active chat participant',
              { details: { index } },
            );
          }
        }
        if (candidate.mention_all === true && !isManagerRole(actor?.role)) {
          return errorResponse(
            403,
            'MENTION_ALL_FORBIDDEN',
            'Only a chat OWNER/ADMIN may mention everyone',
          );
        }
        mentionIds = [...new Set((Array.isArray(rawMentions) ? rawMentions : []) as string[])];
        mentionAll = candidate.mention_all === true;
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
        sender_type: 'USER',
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
        mentions: mentionIds,
        mention_all: mentionAll,
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

      // #83: materialize the per-recipient inbox rows (`@all` includes every
      // active participant at send time; the author never notifies themselves).
      if (mentionIds.length > 0 || mentionAll) {
        const activeMembers = (db.chatMembers[chat.summary.id] ?? []).filter(
          (member) => member.status === 'ACTIVE',
        );
        const recipients = new Set<string>(mentionIds);
        if (mentionAll) {
          for (const member of activeMembers) recipients.add(member.user_id);
        }
        recipients.delete(db.session.user.id);
        const createdMentions: Mention[] = [...recipients].map(() => ({
          id: newUuid(),
          chat_id: chat.summary.id,
          chat_name: chat.summary.name ?? null,
          message_id: message.id,
          sender_id: message.sender_id ?? null,
          sender_display_name: message.sender_display_name ?? null,
          mention_all: mentionAll,
          read_at: null,
          created_at: created,
        }));
        db.mentions.unshift(...createdMentions);
      }

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

    /* ------------------------------------------------------------------ */
    /* P0-3 (#81): workspace DLP/audit/export/sessions/security settings  */
    /* ------------------------------------------------------------------ */

    http.get(`${API}/workspaces/:workspaceId/dlp/policies`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      db.security.policyRequests.push({
        action: 'list',
        deviceId: request.headers.get('x-device-id'),
      });
      if (db.security.forcePolicyListError) {
        const forced = db.security.forcePolicyListError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      // E2EE: the server has no plaintext, so the list is empty by contract.
      if (guard.security_mode === 'E2EE') {
        const empty: DlpPolicyList = { items: [] };
        return HttpResponse.json(empty);
      }
      const items = sortSecurityEvents(db.security.dlpPolicies);
      return HttpResponse.json({ items } satisfies DlpPolicyList);
    }),

    http.post(`${API}/workspaces/:workspaceId/dlp/policies`, async ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forcePolicyMutationError) {
        const forced = db.security.forcePolicyMutationError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (guard.security_mode === 'E2EE') {
        return errorResponse(
          422,
          'DLP_E2EE_UNSUPPORTED',
          'DLP policies are not available in an E2EE workspace',
        );
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      const allowed = [
        'name',
        'action',
        'pattern_type',
        'pattern',
        'scope',
        'max_file_size_bytes',
        'enabled',
      ];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Unknown DLP policy field');
      }
      const scope = body.scope === undefined ? 'ALL' : readDlpScope(body.scope);
      if (scope === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'scope is invalid', {
          details: { field: 'scope' },
        });
      }
      const rawMaxFileSize = body.max_file_size_bytes;
      if (
        rawMaxFileSize !== undefined &&
        (typeof rawMaxFileSize !== 'number' || !Number.isInteger(rawMaxFileSize))
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'max_file_size_bytes must be an integer', {
          details: { field: 'max_file_size_bytes' },
        });
      }
      const maxFileSizeBytes = rawMaxFileSize === undefined ? null : (rawMaxFileSize as number);
      if (
        maxFileSizeBytes !== null &&
        (maxFileSizeBytes < 1 || maxFileSizeBytes > DLP_MAX_FILE_SIZE_BYTES)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'max_file_size_bytes is out of bounds', {
          details: { field: 'max_file_size_bytes', max: DLP_MAX_FILE_SIZE_BYTES },
        });
      }
      if (maxFileSizeBytes !== null && scope !== 'ALL' && scope !== 'ATTACHMENT') {
        return errorResponse(
          400,
          'VALIDATION_FAILED',
          'max_file_size_bytes is supported only for an attachment rule',
          { details: { field: 'max_file_size_bytes', scope } },
        );
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 1 || name.length > 120 || hasForbiddenControl(name, false)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'name is invalid', {
          details: { field: 'name' },
        });
      }
      if (body.action !== 'WARN' && body.action !== 'BLOCK') {
        return errorResponse(400, 'VALIDATION_FAILED', 'action is invalid', {
          details: { field: 'action' },
        });
      }
      if (body.pattern_type !== 'KEYWORD' && body.pattern_type !== 'PATTERN') {
        return errorResponse(400, 'VALIDATION_FAILED', 'pattern_type is invalid', {
          details: { field: 'pattern_type' },
        });
      }
      const pattern = typeof body.pattern === 'string' ? body.pattern : '';
      if (
        pattern.length < 1 ||
        pattern.length > 200 ||
        hasForbiddenControl(pattern, false) ||
        (body.pattern_type === 'PATTERN' && (pattern.match(/\*/g)?.length ?? 0) > 20)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'pattern is invalid', {
          details: { field: 'pattern' },
        });
      }
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'enabled must be a boolean', {
          details: { field: 'enabled' },
        });
      }
      if (db.security.dlpPolicies.length >= 100) {
        return errorResponse(409, 'DLP_POLICY_LIMIT', 'DLP policy limit reached');
      }
      const normalized = name.toLowerCase();
      if (db.security.dlpPolicies.some((policy) => policy.name.toLowerCase() === normalized)) {
        return errorResponse(409, 'DLP_POLICY_NAME_TAKEN', 'DLP policy name is taken');
      }
      const now = db.serverTime();
      const policy: DlpPolicy = {
        id: newUuid(),
        name,
        action: body.action,
        pattern_type: body.pattern_type,
        pattern,
        scope,
        max_file_size_bytes: maxFileSizeBytes,
        enabled: body.enabled === undefined ? true : body.enabled,
        created_at: now,
        updated_at: now,
      };
      db.security.dlpPolicies.push(policy);
      db.security.policyRequests.push({
        action: 'create',
        policyId: policy.id,
        body,
        deviceId: request.headers.get('x-device-id'),
      });
      appendSecurityAudit(db, 'workspace.dlp.policy.created', 'dlp_policy', policy.id);
      return HttpResponse.json(policy, { status: 201 });
    }),

    http.patch(
      `${API}/workspaces/:workspaceId/dlp/policies/:policyId`,
      async ({ request, params }) => {
        const workspaceId = String(params.workspaceId);
        const guard = workspaceManagerGuard(db, request, workspaceId);
        if (isResponse(guard)) return guard;
        if (db.security.forcePolicyMutationError) {
          const forced = db.security.forcePolicyMutationError;
          return errorResponse(forced.status, forced.code, forced.message, {
            details: forced.details,
            retryAfterSeconds: forced.retryAfterSeconds,
          });
        }
        if (guard.security_mode === 'E2EE') {
          return errorResponse(
            422,
            'DLP_E2EE_UNSUPPORTED',
            'DLP policies are not available in an E2EE workspace',
          );
        }
        const policyId = String(params.policyId);
        const current = db.security.dlpPolicies.find((policy) => policy.id === policyId);
        if (!current) return errorResponse(404, 'NOT_FOUND', 'DLP policy not found');
        const body = asRecord(await readJson(request));
        if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
        const allowed = [
          'name',
          'action',
          'pattern_type',
          'pattern',
          'scope',
          'max_file_size_bytes',
          'enabled',
        ];
        if (Object.keys(body).some((key) => !allowed.includes(key))) {
          return errorResponse(400, 'VALIDATION_FAILED', 'Unknown DLP policy field');
        }
        if (Object.keys(body).length === 0) {
          return errorResponse(400, 'VALIDATION_FAILED', 'At least one field is required');
        }

        const nextName = typeof body.name === 'string' ? body.name.trim() : current.name;
        const nextAction = body.action === undefined ? current.action : body.action;
        const nextType = body.pattern_type === undefined ? current.pattern_type : body.pattern_type;
        const nextPattern = typeof body.pattern === 'string' ? body.pattern : current.pattern;
        const nextEnabled = body.enabled === undefined ? current.enabled : body.enabled;
        const nextScope = body.scope === undefined ? current.scope : readDlpScope(body.scope);
        if (nextScope === null) {
          return errorResponse(400, 'VALIDATION_FAILED', 'scope is invalid', {
            details: { field: 'scope' },
          });
        }
        let nextMaxFileSize = current.max_file_size_bytes;
        if (body.max_file_size_bytes !== undefined && body.max_file_size_bytes !== null) {
          if (
            typeof body.max_file_size_bytes !== 'number' ||
            !Number.isInteger(body.max_file_size_bytes)
          ) {
            return errorResponse(
              400,
              'VALIDATION_FAILED',
              'max_file_size_bytes must be an integer',
              { details: { field: 'max_file_size_bytes' } },
            );
          }
          nextMaxFileSize = body.max_file_size_bytes;
        }
        if (
          nextMaxFileSize !== null &&
          (nextMaxFileSize < 1 || nextMaxFileSize > DLP_MAX_FILE_SIZE_BYTES)
        ) {
          return errorResponse(400, 'VALIDATION_FAILED', 'max_file_size_bytes is out of bounds', {
            details: { field: 'max_file_size_bytes', max: DLP_MAX_FILE_SIZE_BYTES },
          });
        }
        if (nextMaxFileSize !== null && nextScope !== 'ALL' && nextScope !== 'ATTACHMENT') {
          return errorResponse(
            400,
            'VALIDATION_FAILED',
            'max_file_size_bytes is supported only for an attachment rule',
            { details: { field: 'max_file_size_bytes', scope: nextScope } },
          );
        }

        if (nextName.length < 1 || nextName.length > 120 || hasForbiddenControl(nextName, false)) {
          return errorResponse(400, 'VALIDATION_FAILED', 'name is invalid', {
            details: { field: 'name' },
          });
        }
        if (nextAction !== 'WARN' && nextAction !== 'BLOCK') {
          return errorResponse(400, 'VALIDATION_FAILED', 'action is invalid', {
            details: { field: 'action' },
          });
        }
        if (nextType !== 'KEYWORD' && nextType !== 'PATTERN') {
          return errorResponse(400, 'VALIDATION_FAILED', 'pattern_type is invalid', {
            details: { field: 'pattern_type' },
          });
        }
        if (
          nextPattern.length < 1 ||
          nextPattern.length > 200 ||
          hasForbiddenControl(nextPattern, false) ||
          (nextType === 'PATTERN' && (nextPattern.match(/\*/g)?.length ?? 0) > 20)
        ) {
          return errorResponse(400, 'VALIDATION_FAILED', 'pattern is invalid', {
            details: { field: 'pattern' },
          });
        }
        if (typeof nextEnabled !== 'boolean') {
          return errorResponse(400, 'VALIDATION_FAILED', 'enabled must be a boolean', {
            details: { field: 'enabled' },
          });
        }
        const normalized = nextName.toLowerCase();
        if (
          db.security.dlpPolicies.some(
            (policy) => policy.id !== policyId && policy.name.toLowerCase() === normalized,
          )
        ) {
          return errorResponse(409, 'DLP_POLICY_NAME_TAKEN', 'DLP policy name is taken');
        }

        const changed =
          nextName !== current.name ||
          nextAction !== current.action ||
          nextType !== current.pattern_type ||
          nextPattern !== current.pattern ||
          nextScope !== current.scope ||
          nextMaxFileSize !== current.max_file_size_bytes ||
          nextEnabled !== current.enabled;
        if (!changed) {
          db.security.policyRequests.push({
            action: 'update',
            policyId,
            body,
            deviceId: request.headers.get('x-device-id'),
          });
          return HttpResponse.json(current);
        }

        const updated: DlpPolicy = {
          ...current,
          name: nextName,
          action: nextAction,
          pattern_type: nextType,
          pattern: nextPattern,
          scope: nextScope,
          max_file_size_bytes: nextMaxFileSize,
          enabled: nextEnabled,
          updated_at: db.serverTime(),
        };
        db.security.dlpPolicies = db.security.dlpPolicies.map((policy) =>
          policy.id === policyId ? updated : policy,
        );
        db.security.policyRequests.push({
          action: 'update',
          policyId,
          body,
          deviceId: request.headers.get('x-device-id'),
        });
        appendSecurityAudit(db, 'workspace.dlp.policy.updated', 'dlp_policy', policyId);
        return HttpResponse.json(updated);
      },
    ),

    http.delete(`${API}/workspaces/:workspaceId/dlp/policies/:policyId`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forcePolicyMutationError) {
        const forced = db.security.forcePolicyMutationError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      if (guard.security_mode === 'E2EE') {
        return errorResponse(
          422,
          'DLP_E2EE_UNSUPPORTED',
          'DLP policies are not available in an E2EE workspace',
        );
      }
      const policyId = String(params.policyId);
      const policy = db.security.dlpPolicies.find((item) => item.id === policyId);
      if (!policy) return errorResponse(404, 'NOT_FOUND', 'DLP policy not found');
      db.security.dlpPolicies = db.security.dlpPolicies.filter((item) => item.id !== policyId);
      db.security.dlpEvents = db.security.dlpEvents.map((event) =>
        event.policy_id === policyId ? { ...event, policy_id: null } : event,
      );
      db.security.policyRequests.push({
        action: 'delete',
        policyId,
        deviceId: request.headers.get('x-device-id'),
      });
      appendSecurityAudit(db, 'workspace.dlp.policy.deleted', 'dlp_policy', policyId);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/workspaces/:workspaceId/dlp/events`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceEventError) {
        const forced = db.security.forceEventError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const url = new URL(request.url);
      const policyId = url.searchParams.get('policy_id');
      const action = url.searchParams.get('action');
      const cursor = url.searchParams.get('cursor');
      const limit = readPageLimit(url.searchParams.get('limit'), 30);
      if (policyId !== null && !UUID_RE.test(policyId)) {
        return errorResponse(400, 'VALIDATION_FAILED', 'policy_id must be a UUID', {
          details: { field: 'policy_id' },
        });
      }
      if (action !== null && action !== 'WARN' && action !== 'BLOCK') {
        return errorResponse(400, 'VALIDATION_FAILED', 'action is invalid', {
          details: { field: 'action' },
        });
      }
      if (limit === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = readOffsetCursor(cursor, 'dpe', workspaceId);
      if (offset === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
      }
      db.security.eventRequests.push({ policyId, action, cursor, limit });
      const rows =
        guard.security_mode === 'E2EE'
          ? []
          : sortSecurityEvents(db.security.dlpEvents).filter(
              (event) =>
                (policyId === null || event.policy_id === policyId) &&
                (action === null || event.action === action),
            );
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + limit < rows.length;
      const page: DlpEventPage = {
        items,
        next_cursor: hasMore ? offsetCursor('dpe', workspaceId, offset + limit) : null,
        has_more: hasMore,
      };
      return HttpResponse.json(page);
    }),

    http.get(`${API}/workspaces/:workspaceId/audit`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceAuditError) {
        const forced = db.security.forceAuditError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const query = readAuditQuery(request);
      if (isResponse(query)) return query;
      const limit = readPageLimit(query.limitRaw, 30);
      if (limit === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = readOffsetCursor(query.cursor, 'aud', workspaceId);
      if (offset === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
      }
      db.security.auditRequests.push({
        action: query.action,
        actorId: query.actorId,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit,
      });
      const rows = filterAuditRows(db.security.auditEvents, query);
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + limit < rows.length;
      const page: WorkspaceAuditPage = {
        items,
        next_cursor: hasMore ? offsetCursor('aud', workspaceId, offset + limit) : null,
        has_more: hasMore,
      };
      return HttpResponse.json(page);
    }),

    http.get(`${API}/workspaces/:workspaceId/audit/export`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceExportError) {
        const forced = db.security.forceExportError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const url = new URL(request.url);
      const format = url.searchParams.get('format');
      if (format !== 'csv' && format !== 'json') {
        return errorResponse(400, 'VALIDATION_FAILED', 'format must be csv or json', {
          details: { field: 'format' },
        });
      }
      const query = readAuditQuery(request);
      if (isResponse(query)) return query;
      db.security.exportRequests.push({
        format,
        action: query.action,
        actorId: query.actorId,
        from: query.from,
        to: query.to,
      });
      const rows = filterAuditRows(db.security.auditEvents, query);
      const cap = Math.max(0, db.security.auditExportLimit);
      const items = rows.slice(0, cap);
      const truncated = rows.length > cap;
      const headers: Record<string, string> = {
        'X-Export-Rows': String(items.length),
        'X-Export-Truncated': String(truncated),
        'Content-Disposition': `attachment; filename="${exportFilename(format)}"`,
      };
      appendSecurityAudit(db, 'workspace.audit.exported', null, null);
      if (format === 'csv') {
        return new HttpResponse(auditCsv(items), {
          status: 200,
          headers: { ...headers, 'Content-Type': 'text/csv; charset=UTF-8' },
        });
      }
      return HttpResponse.json(
        { items, exported_rows: items.length, truncated },
        { status: 200, headers },
      );
    }),

    http.get(`${API}/workspaces/:workspaceId/sessions`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceSessionsError) {
        const forced = db.security.forceSessionsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const limit = readPageLimit(url.searchParams.get('limit'), 50);
      if (limit === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'limit must be within 1..100');
      }
      const offset = readOffsetCursor(cursor, 'ses', workspaceId);
      if (offset === null) {
        return errorResponse(400, 'VALIDATION_FAILED', 'cursor is invalid');
      }
      db.security.sessionRequests.push({ cursor, limit });
      const rows = [...db.security.sessions].sort(
        (left, right) =>
          right.last_seen_at.localeCompare(left.last_seen_at) || right.id.localeCompare(left.id),
      );
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + limit < rows.length;
      const page: WorkspaceSessionPage = {
        items,
        next_cursor: hasMore ? offsetCursor('ses', workspaceId, offset + limit) : null,
        has_more: hasMore,
      };
      return HttpResponse.json(page);
    }),

    http.delete(`${API}/workspaces/:workspaceId/sessions/:sessionId`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceSessionRevokeError) {
        const forced = db.security.forceSessionRevokeError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const sessionId = String(params.sessionId);
      const session = db.security.sessions.find((item) => item.id === sessionId);
      if (!session) {
        return errorResponse(404, 'NOT_FOUND', 'Session not found');
      }
      db.security.sessions = db.security.sessions.filter((item) => item.id !== sessionId);
      db.security.sessionRevokeRequests.push(sessionId);
      appendSecurityAudit(db, 'workspace.session.revoked', 'user', session.user_id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/workspaces/:workspaceId/sessions/revoke-all`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceRevokeAllError) {
        const forced = db.security.forceRevokeAllError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      db.security.revokeAllRequests += 1;
      const current = db.security.sessions.find((session) => session.current);
      const removed = db.security.sessions.filter((session) => session !== current);
      db.security.sessions = current ? [current] : [];
      const affectedUsers = new Set(removed.map((session) => session.user_id));
      const response: WorkspaceSessionRevokeAll = {
        revoked_sessions: removed.length,
        affected_users: affectedUsers.size,
      };
      appendSecurityAudit(db, 'workspace.sessions.revoked_all', null, null);
      return HttpResponse.json(response);
    }),

    http.get(`${API}/workspaces/:workspaceId/security`, ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceSettingsError) {
        const forced = db.security.forceSettingsError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      db.security.settingsRequests += 1;
      return HttpResponse.json(db.security.settings satisfies WorkspaceSecurity);
    }),

    http.patch(`${API}/workspaces/:workspaceId/security`, async ({ request, params }) => {
      const workspaceId = String(params.workspaceId);
      const guard = workspaceManagerGuard(db, request, workspaceId);
      if (isResponse(guard)) return guard;
      if (db.security.forceSettingsSaveError) {
        const forced = db.security.forceSettingsSaveError;
        return errorResponse(forced.status, forced.code, forced.message, {
          details: forced.details,
          retryAfterSeconds: forced.retryAfterSeconds,
        });
      }
      const body = asRecord(await readJson(request));
      if (!body) return errorResponse(400, 'VALIDATION_FAILED', 'Body must be a JSON object');
      if (Object.prototype.hasOwnProperty.call(body, 'security_mode')) {
        return errorResponse(422, 'MODE_CHANGE_FORBIDDEN', 'security_mode is immutable');
      }
      const allowed = ['require_2fa', 'session_timeout_minutes', 'dlp_enabled', 'retention_days'];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        return errorResponse(400, 'VALIDATION_FAILED', 'Unknown security setting');
      }
      if (Object.keys(body).length === 0) {
        return errorResponse(400, 'VALIDATION_FAILED', 'At least one field is required');
      }
      if (body.require_2fa !== undefined && typeof body.require_2fa !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'require_2fa must be a boolean', {
          details: { field: 'require_2fa' },
        });
      }
      if (body.dlp_enabled !== undefined && typeof body.dlp_enabled !== 'boolean') {
        return errorResponse(400, 'VALIDATION_FAILED', 'dlp_enabled must be a boolean', {
          details: { field: 'dlp_enabled' },
        });
      }
      if (
        body.session_timeout_minutes !== undefined &&
        (!Number.isInteger(body.session_timeout_minutes) ||
          (body.session_timeout_minutes as number) < 15 ||
          (body.session_timeout_minutes as number) > 10_080)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'session_timeout_minutes is out of range', {
          details: { field: 'session_timeout_minutes' },
        });
      }
      if (
        body.retention_days !== undefined &&
        (!Number.isInteger(body.retention_days) ||
          (body.retention_days as number) < 1 ||
          (body.retention_days as number) > 3650)
      ) {
        return errorResponse(400, 'VALIDATION_FAILED', 'retention_days is out of range', {
          details: { field: 'retention_days' },
        });
      }
      if (body.dlp_enabled === true && guard.security_mode === 'E2EE') {
        return errorResponse(
          422,
          'DLP_E2EE_UNSUPPORTED',
          'DLP cannot be enabled in an E2EE workspace',
        );
      }
      const current = db.security.settings;
      const next: WorkspaceSecurity = {
        ...current,
        require_2fa: typeof body.require_2fa === 'boolean' ? body.require_2fa : current.require_2fa,
        session_timeout_minutes:
          typeof body.session_timeout_minutes === 'number'
            ? body.session_timeout_minutes
            : current.session_timeout_minutes,
        dlp_enabled: typeof body.dlp_enabled === 'boolean' ? body.dlp_enabled : current.dlp_enabled,
        retention_days:
          typeof body.retention_days === 'number' ? body.retention_days : current.retention_days,
      };
      db.security.settingsPatches.push(body);
      const changed =
        next.require_2fa !== current.require_2fa ||
        next.session_timeout_minutes !== current.session_timeout_minutes ||
        next.dlp_enabled !== current.dlp_enabled ||
        next.retention_days !== current.retention_days;
      if (!changed) return HttpResponse.json(current);
      next.updated_at = db.serverTime();
      db.security.settings = next;
      appendSecurityAudit(db, 'workspace.security.updated', 'workspace_security', workspaceId);
      return HttpResponse.json(next);
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
