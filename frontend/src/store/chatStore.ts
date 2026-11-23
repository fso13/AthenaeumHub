import type { ChatApi, ImageUploadOptions, ListMessagesQuery } from '../api/endpoints';
import { ApiError, isApiError, toApiError } from '../api/problem';
import type {
  AddChatMemberRequest,
  AddWorkspaceMemberRequest,
  ApiAttachment,
  ApiMessage,
  AssignableMemberRole,
  AuthUser,
  BlockedUser,
  ChangeChatMemberRoleRequest,
  ChangeWorkspaceMemberRoleRequest,
  Chat,
  ChatAvatarRequest,
  ChatCoverRequest,
  ChatCreateRequest,
  ChatInvite,
  ChatInviteCreateRequest,
  ChatInviteCreated,
  ChatMember,
  ChatMemberRole,
  ChatMembersResponse,
  ChatPermissionKey,
  ChatPermissionRole,
  ChatPermissions,
  ChatPermissionsUpdate,
  ChatPin,
  ChatRolePermissions,
  ChatSummary,
  ChatUpdateRequest,
  ChatVisibility,
  Device,
  FileItem,
  InviteAcceptResult,
  MediaImage,
  MeResponse,
  MeUser,
  Mention,
  MessageCreateBody,
  MessageDeleteScope,
  MessageEdit,
  MessageSearchHit,
  Notification,
  NotificationPreference,
  NotificationPreferencePatch,
  Poll,
  ProfileSession,
  ProfileUpdate,
  ReactionSummary,
  Session,
  StickerRef,
  SyncResponse,
  Task,
  ThreadSummary,
  WorkspaceLimits,
  WorkspaceMember,
  WorkspaceMemberPage,
  WorkspaceInviteAcceptance,
  WorkspaceInvitePreview,
  WorkspaceSummary,
} from '../api/types';
import { createFilesStore, type FilesStore } from './filesStore';
import { createPluginsStore, type PluginsStore } from '../plugins/store';
import { createPluginActionsStore, type PluginActionsStore } from '../plugins/actionsStore';
import { createStickersStore, type StickersStore } from '../stickers/store';
import { createOpsStore, type OpsStore } from '../ops/store';
import { createSecurityStore, type SecurityStore } from '../security/securityStore';
import { createAvatarStore, type AvatarStore } from '../avatars/avatarStore';
import {
  createProfileWorkspaceStore,
  type ProfileWorkspaceStore,
} from '../profile/profileWorkspaceStore';
import {
  createWorkspaceOverviewStore,
  type WorkspaceOverviewStore,
} from '../workspace/overviewStore';
import { createBotsStore, type BotsStore } from '../bots/botsStore';
import { createRoomsStore, type RoomsStore } from '../rooms/roomsStore';
import {
  clearDeviceWorkspaceId,
  readDeviceWorkspaceId,
  writeDeviceWorkspaceId,
} from '../workspace/deviceWorkspace';
import { getDeviceId, getSession, setSession } from '../auth/session';
import { setRuntimeDeviceId } from '../auth/runtime';
import {
  clearPendingDeviceKey,
  clearPendingWorkspaceKey,
  getPendingDeviceKey,
  getPendingWorkspaceKey,
  setPendingDeviceKey,
  setPendingWorkspaceKey,
} from '../auth/storage';
import type { AppConfig } from '../config/env';
import { maxSeq, mergeMessages, minSeq } from '../domain/messages';
import { sumUnread } from '../domain/unread';
import { newUuid } from '../lib/ids';
import { isE2eeEnabled } from '../e2ee/app/flag';
import { readChatModePin } from '../e2ee/device/modePin';
import {
  createE2eeBridge,
  type E2eeBridge,
  type E2eeChatInput,
  type E2eeDeviceTransport,
  type E2eeRetryReconcileResult,
  type E2eeRetryStatus,
} from '../e2ee/app/chatBridge';
import {
  createE2eeState,
  createIdleE2eeChatState,
  type E2eeBlockReason,
  type E2eeChatState,
  type E2eeLocalCopyView,
  type E2eeResetProgress,
  type E2eeState,
} from '../e2ee/app/types';
import { getE2eeStorage } from '../e2ee/storage/runtime';
import { isE2eeError } from '../e2ee/errors';
import type { WireCryptoEnvelope } from '../e2ee/api/deviceKeys';
import type { OutboxEntry, OutboxSendResult } from '../e2ee/outbox/types';
import type { SessionResetBody } from '../e2ee/session/reset';
import { CallController } from '../calls/CallController';
import type { CallRingtone } from '../calls/ringtone';
import { idleCallState, type CallState } from '../calls/types';
import {
  RealtimeClient,
  type RealtimeFailure,
  type RealtimeFailureKind,
  type RealtimeStatus,
} from '../realtime/RealtimeClient';
import type {
  CallSignalFrame,
  CallUnavailableFrame,
  ErrorFrame,
  EventFrame,
  PresenceFrame,
  PresenceStatus,
  ResumeGapFrame,
  SubscribedFrame,
  TypingFrame,
} from '../realtime/protocol';
import { resolveRealtimeUrl, type SocketFactory } from '../realtime/socket';

export type OutgoingStatus = 'sending' | 'failed';

export interface OutgoingMessage {
  clientMessageId: string;
  /**
   * Reused on every retry of the same logical message (contract §7.3).
   * The server never returns client_message_id, so correlation is local.
   */
  idempotencyKey: string;
  /** E5: STICKER messages carry exactly one sticker and no text/attachments. */
  kind: 'TEXT' | 'STICKER';
  text: string;
  sticker: StickerRef | null;
  replyToId: string | null;
  /** Ready managed attachments; empty for a text-only message. */
  attachments: ApiAttachment[];
  /**
   * #83: explicit mention ids derived from the final text. Server-validated;
   * the client never invents recipients and E2EE rows never carry them.
   */
  mentions?: string[];
  mentionAll?: boolean;
  createdAt: number;
  status: OutgoingStatus;
  error: ApiError | null;
  attempts: number;
  /**
   * E7-F5: this row was produced by the E2EE pipeline. Retries replay the exact
   * stored envelope bytes from the F4 outbox instead of re-encrypting.
   */
  e2ee?: boolean;
  /** E2EE control message (SESSION_RESET): never rendered as a chat message. */
  control?: boolean;
  retryOfClientMessageId?: string | null;
  coverageWarning?: 'PEER_DEVICE_UNCOVERED' | 'SELF_DEVICE_UNCOVERED' | null;
  /**
   * D1-FE3: root of the flat thread this outgoing reply belongs to. `null` /
   * `undefined` means the main feed. The row lives in the thread outbox.
   */
  threadRootId?: string | null;
}

/** Decrypted view for one E2EE message; keyed by `ApiMessage.id`. */
export interface E2eeMessageView {
  readonly status: 'decrypted' | 'unavailable' | 'control' | 'error' | 'superseded';
  readonly text: string | null;
  readonly replyToId: string | null;
  readonly code?: string;
}

/** #61–#63: last failed message action, rendered next to the affected row. */
export type MessageActionKind = 'reaction' | 'edit' | 'delete';

export interface MessageActionError {
  kind: MessageActionKind;
  messageId: string;
  /** Present for reaction failures only. */
  emoji?: string;
  error: ApiError;
}

export interface ChatSlice {
  chatId: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  messages: ApiMessage[];
  outbox: OutgoingMessage[];
  hasMore: boolean;
  beforeSeq: number | null;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
  error: ApiError | null;
  readSeq: number;
  unread: number;
  lastSeq: number;
  /** Per-user read receipts from WS (`message.receipt` is not replayed). */
  receipts: Record<string, number>;
  /** E7-F5: decrypted/control/unavailable views, keyed by server message id. */
  e2ee: Record<string, E2eeMessageView>;
  /** #61: `${messageId}:${emoji}` with an in-flight idempotent POST/DELETE. */
  pendingReactions: string[];
  /** #62/#63: message ids with an in-flight edit or delete. */
  pendingMessageIds: string[];
  /** Last failed action of this chat; cleared by the next action on the row. */
  actionError: MessageActionError | null;
}

/** Matches `ReactionCreate.emoji`: 1..32 code points, no HTML/space/control. */
export function isReactionEmoji(value: string): boolean {
  const codePoints = Array.from(value);
  if (codePoints.length < 1 || codePoints.length > 32) return false;
  if (/[\s<>"'`&]/.test(value)) return false;
  return codePoints.every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

/** D1-FE3: why a thread panel cannot load or accept replies. */
export type ThreadUnavailable = 'deleted' | 'not_found' | null;

/**
 * D1-FE3: replies of one flat thread (max depth 1), keyed by
 * `${chatId}:${rootId}`. Roots stay in `ChatSlice.messages`; replies never do.
 */
export interface ThreadSlice {
  chatId: string;
  rootId: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  replies: ApiMessage[];
  outbox: OutgoingMessage[];
  hasMore: boolean;
  beforeSeq: number | null;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
  error: ApiError | null;
  /**
   * Server said the root is deleted/missing (`THREAD_ROOT_DELETED` /
   * `THREAD_ROOT_NOT_FOUND` / `404`). Kept separate from `status` so already
   * loaded replies stay visible while the composer is honestly disabled.
   */
  unavailable: ThreadUnavailable;
  /** Max seq observed in this thread; dedupes replay/live/REST deliveries. */
  lastSeq: number;
}

export interface ActiveThread {
  chatId: string;
  rootId: string;
}

export function threadKey(chatId: string, rootId: string): string {
  return `${chatId}:${rootId}`;
}

export function createEmptyThreadSlice(chatId: string, rootId: string): ThreadSlice {
  return {
    chatId,
    rootId,
    status: 'idle',
    replies: [],
    outbox: [],
    hasMore: false,
    beforeSeq: null,
    loadMoreStatus: 'idle',
    loadMoreError: null,
    error: null,
    unavailable: null,
    lastSeq: 0,
  };
}

export interface TypingEntry {
  userId: string;
  displayName: string | null;
  expiresAt: number;
}

export interface PresenceEntry {
  status: PresenceStatus;
  lastSeenAt: string | null;
}

export interface RealtimeIssue {
  kind: RealtimeFailureKind;
  message: string;
  code?: string;
  status?: number;
}

export type OnboardingStatus = 'idle' | 'submitting' | 'error';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** E6-F: server state for `/notifications` plus optimistic read bookkeeping. */
export interface NotificationsState {
  items: Notification[];
  status: LoadStatus;
  error: ApiError | null;
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
  /** Ids with an in-flight POST /notifications/read. */
  readPendingIds: string[];
  readAllPending: boolean;
  readError: ApiError | null;
  lastLoadedAt: number | null;
}

/**
 * #83: server-side message search. The query is applied by the server; the UI
 * only debounces input and appends opaque cursor pages.
 */
export interface MessageSearchState {
  /** Normalized query actually sent to the server (`''` = idle). */
  query: string;
  /** `chat_id` scope or `null` for the whole workspace. */
  chatId: string | null;
  status: LoadStatus;
  items: MessageSearchHit[];
  error: ApiError | null;
  hasMore: boolean;
  nextCursor: string | null;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
  /** Monotonic request token; stale responses never overwrite a new query. */
  seq: number;
}

/**
 * #83: `GET /me/mentions` inbox. Metadata only (no message text); ids and the
 * read marker come from the server, the badge is derived from `unread_count`.
 */
export interface MentionsState {
  items: Mention[];
  status: LoadStatus;
  error: ApiError | null;
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
  /** Server `unread` filter applied to the current chain. */
  unreadOnly: boolean;
  readPendingIds: string[];
  readAllPending: boolean;
  readError: ApiError | null;
}

/** E6-F: `/notification-preferences` server state. */
export interface NotificationPreferencesState {
  items: NotificationPreference[];
  status: LoadStatus;
  error: ApiError | null;
  saving: boolean;
  saveError: ApiError | null;
}

/**
 * E10-F: active member directory for the DIRECT peer picker. Pages are
 * appended in server order and de-duplicated by `user_id`; a search change
 * starts a new cursor chain and drops the stale in-flight response.
 */
export interface WorkspaceMembersState {
  items: WorkspaceMember[];
  /** Normalized literal search over `display_name` (max 80). */
  query: string;
  status: LoadStatus;
  error: ApiError | null;
  nextCursor: string | null;
  hasMore: boolean;
  loadMoreStatus: 'idle' | 'loading' | 'error';
  loadMoreError: ApiError | null;
}

export function createEmptyWorkspaceMembersState(): WorkspaceMembersState {
  return {
    items: [],
    query: '',
    status: 'idle',
    error: null,
    nextCursor: null,
    hasMore: false,
    loadMoreStatus: 'idle',
    loadMoreError: null,
  };
}

/**
 * E12-F (R-09): server-confirmed member mutations. There is deliberately no
 * optimistic row state: a row changes only after `201`/`200`/`204`, and every
 * failure keeps the previous row plus the API error for a translated message.
 */
export interface WorkspaceMemberAdminState {
  addStatus: 'idle' | 'adding' | 'error';
  addError: ApiError | null;
  /** `user_id` with an in-flight `PATCH`; the row stays disabled meanwhile. */
  rolePendingUserId: string | null;
  roleError: { userId: string; error: ApiError } | null;
  /** `user_id` with an in-flight `DELETE`. */
  removePendingUserId: string | null;
  removeError: { userId: string; error: ApiError } | null;
}

export function createEmptyWorkspaceMemberAdminState(): WorkspaceMemberAdminState {
  return {
    addStatus: 'idle',
    addError: null,
    rolePendingUserId: null,
    roleError: null,
    removePendingUserId: null,
    removeError: null,
  };
}

/**
 * D1-FE5 chat settings. There is no optimistic chat update: the dialog keeps
 * the typed draft while the `PATCH` is in flight, and `chats`/`ChatHeader` only
 * change after the server returns the full `Chat`.
 */
export interface ChatSettingsState {
  chatId: string | null;
  status: 'idle' | 'saving' | 'saved' | 'error';
  error: ApiError | null;
}

export function createEmptyChatSettingsState(): ChatSettingsState {
  return { chatId: null, status: 'idle', error: null };
}

/**
 * #79 channel membership. Rows come from `GET /chats/{chatId}/members` and
 * every mutation replaces state only after the server response; there is no
 * optimistic role/row change. Errors are kept next to the affected row so a
 * `409 LAST_OWNER` or `403 ROLE_CHANGE_FORBIDDEN` is explained honestly.
 */
export interface ChatMembersState {
  chatId: string | null;
  status: LoadStatus;
  items: ChatMember[];
  error: ApiError | null;
  addStatus: 'idle' | 'adding' | 'error';
  addError: ApiError | null;
  rolePendingUserId: string | null;
  roleError: { userId: string; error: ApiError } | null;
  removePendingUserId: string | null;
  removeError: { userId: string; error: ApiError } | null;
  leaveStatus: 'idle' | 'leaving' | 'error';
  leaveError: ApiError | null;
}

export function createEmptyChatMembersState(): ChatMembersState {
  return {
    chatId: null,
    status: 'idle',
    items: [],
    error: null,
    addStatus: 'idle',
    addError: null,
    rolePendingUserId: null,
    roleError: null,
    removePendingUserId: null,
    removeError: null,
    leaveStatus: 'idle',
    leaveError: null,
  };
}

/**
 * #79 invite links. `created` holds the one-time raw token and is cleared only
 * when the dialog closes (the server cannot return it again). The list keeps
 * server-computed statuses (`ACTIVE`/`EXPIRED`/`EXHAUSTED`/`REVOKED`).
 */
export interface ChatInvitesState {
  chatId: string | null;
  status: LoadStatus;
  error: ApiError | null;
  items: ChatInvite[];
  created: ChatInviteCreated | null;
  createStatus: 'idle' | 'creating' | 'error';
  createError: ApiError | null;
  revokePendingId: string | null;
  revokeError: { inviteId: string; error: ApiError } | null;
}

export function createEmptyChatInvitesState(): ChatInvitesState {
  return {
    chatId: null,
    status: 'idle',
    error: null,
    items: [],
    created: null,
    createStatus: 'idle',
    createError: null,
    revokePendingId: null,
    revokeError: null,
  };
}

/** #79 self-service blocks (`GET /me/blocked` has no display name/email). */
export interface BlockedUsersState {
  status: LoadStatus;
  items: BlockedUser[];
  error: ApiError | null;
  pendingUserId: string | null;
  actionError: { userId: string; error: ApiError } | null;
}

export function createEmptyBlockedUsersState(): BlockedUsersState {
  return {
    status: 'idle',
    items: [],
    error: null,
    pendingUserId: null,
    actionError: null,
  };
}

/** #79 invite-accept screen state (`POST /invites/{token}/accept`). */
export interface InviteAcceptState {
  token: string | null;
  status: 'idle' | 'accepting' | 'accepted' | 'error';
  result: InviteAcceptResult | null;
  error: ApiError | null;
}

export function createEmptyInviteAcceptState(): InviteAcceptState {
  return { token: null, status: 'idle', result: null, error: null };
}

/* ------------------------------------------------------------------------- */
/* P0-2 (#80): channel cover, rights matrix, pins, archive, deletion         */
/* ------------------------------------------------------------------------- */

/** The six configurable rights, in the contract/wire order. */
export const CHAT_PERMISSION_KEYS: readonly ChatPermissionKey[] = [
  'post_messages',
  'invite_members',
  'create_polls',
  'start_calls',
  'pin_messages',
  'change_info',
];

/** Roles shown in the matrix; OWNER is fixed and never editable. */
export const CHAT_PERMISSION_ROLES: readonly ChatPermissionRole[] = [
  'OWNER',
  'ADMIN',
  'MODERATOR',
  'MEMBER',
  'GUEST',
];

const ALL_RIGHTS: ChatRolePermissions = {
  post_messages: true,
  invite_members: true,
  create_polls: true,
  start_calls: true,
  pin_messages: true,
  change_info: true,
};

/** Built-in default matrix (SYSTEM-ANALYSIS §10.3 + product decisions). */
export function defaultChatPermissions(): ChatPermissions {
  return {
    owner: { ...ALL_RIGHTS },
    admin: { ...ALL_RIGHTS },
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

function rolePermissions(
  matrix: ChatPermissions | null,
  role: ChatPermissionRole,
): ChatRolePermissions {
  const key = role.toLowerCase() as Lowercase<ChatPermissionRole>;
  return matrix?.[key] ?? defaultChatPermissions()[key] ?? {};
}

/** Effective right of a role (OWNER is always allowed, matrix may be absent). */
export function chatPermissionAllowed(
  matrix: ChatPermissions | null,
  role: ChatPermissionRole | ChatMemberRole | null | undefined,
  permission: ChatPermissionKey,
): boolean {
  if (!role) return false;
  if (role === 'OWNER') return true;
  return rolePermissions(matrix, role)[permission] === true;
}

/** #80 rights matrix: loaded per chat; the server response is authoritative. */
export interface ChatPermissionsState {
  chatId: string | null;
  status: LoadStatus;
  matrix: ChatPermissions | null;
  error: ApiError | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveError: ApiError | null;
}

export function createEmptyChatPermissionsState(): ChatPermissionsState {
  return {
    chatId: null,
    status: 'idle',
    matrix: null,
    error: null,
    saveStatus: 'idle',
    saveError: null,
  };
}

/** #80 cover editor: existing chat images are candidates (no upload endpoint). */
export interface ChatCoverState {
  chatId: string | null;
  /** Candidate image metadata from `GET /files?chat_id&kind=IMAGE`. */
  imagesStatus: LoadStatus;
  images: FileItem[];
  imagesError: ApiError | null;
  actionStatus: 'idle' | 'saving' | 'removing' | 'saved' | 'error';
  actionError: ApiError | null;
}

export function createEmptyChatCoverState(): ChatCoverState {
  return {
    chatId: null,
    imagesStatus: 'idle',
    images: [],
    imagesError: null,
    actionStatus: 'idle',
    actionError: null,
  };
}

/**
 * Channel icon/avatar editor state. Candidate images are shared with the cover
 * picker (`chatCover.images`): the avatar is an existing image of the same chat,
 * so there is no second file-center read and no upload pipeline.
 */
export interface ChatAvatarState {
  chatId: string | null;
  actionStatus: 'idle' | 'saving' | 'removing' | 'saved' | 'error';
  actionError: ApiError | null;
}

export function createEmptyChatAvatarState(): ChatAvatarState {
  return { chatId: null, actionStatus: 'idle', actionError: null };
}

/** #80 pinned messages (metadata only) plus per-message pending/error state. */
export interface ChatPinsState {
  chatId: string | null;
  status: LoadStatus;
  items: ChatPin[];
  error: ApiError | null;
  pendingMessageId: string | null;
  actionError: { messageId: string; error: ApiError } | null;
  /** `409 CHAT_PIN_LIMIT`: the server's 50-pin cap was reached. */
  limitReached: boolean;
}

export function createEmptyChatPinsState(): ChatPinsState {
  return {
    chatId: null,
    status: 'idle',
    items: [],
    error: null,
    pendingMessageId: null,
    actionError: null,
    limitReached: false,
  };
}

/** #80 user-local archive action state (never shared with other members). */
export interface ChatArchiveState {
  chatId: string | null;
  status: 'idle' | 'archiving' | 'unarchiving' | 'error';
  error: ApiError | null;
}

export function createEmptyChatArchiveState(): ChatArchiveState {
  return { chatId: null, status: 'idle', error: null };
}

/** #80 soft deletion by the ACTIVE chat OWNER. */
export interface ChatDeletionState {
  chatId: string | null;
  status: 'idle' | 'deleting' | 'error';
  error: ApiError | null;
}

export function createEmptyChatDeletionState(): ChatDeletionState {
  return { chatId: null, status: 'idle', error: null };
}

/**
 * #99 workspace lifecycle (self-leave / OWNER soft delete).
 *
 * The mutation is workspace-scoped, not chat-scoped: a successful call removes
 * every workspace row from the local read model. `error` is kept so the confirm
 * dialog can show an honest `409 LAST_OWNER` / `403` instead of pretending the
 * action succeeded.
 */
export interface WorkspaceLifecycleState {
  workspaceId: string | null;
  action: 'leave' | 'delete' | null;
  status: 'idle' | 'leaving' | 'deleting' | 'error';
  error: ApiError | null;
}

export function createEmptyWorkspaceLifecycleState(): WorkspaceLifecycleState {
  return { workspaceId: null, action: null, status: 'idle', error: null };
}

/** #80 archived list (`GET /chats?archived=true`), separate from the main list. */
export interface ArchivedChatsState {
  workspaceId: string | null;
  status: LoadStatus;
  items: ChatSummary[];
  error: ApiError | null;
  pendingChatId: string | null;
  actionError: { chatId: string; error: ApiError } | null;
}

export function createEmptyArchivedChatsState(): ArchivedChatsState {
  return {
    workspaceId: null,
    status: 'idle',
    items: [],
    error: null,
    pendingChatId: null,
    actionError: null,
  };
}

/** D1-FE5 profile device projection (`GET /devices`, no keys rendered). */
export interface DevicesState {
  items: Device[];
  status: LoadStatus;
  error: ApiError | null;
}

export function createEmptyDevicesState(): DevicesState {
  return { items: [], status: 'idle', error: null };
}

/** #72: result of a partial `PATCH /me` (the server response is authoritative). */
export interface ProfileUpdateResult {
  user: AuthUser | null;
  error: ApiError | null;
}

/** #72: result of `GET /me/sessions`; the component owns the list state. */
export interface ProfileSessionsResult {
  sessions: ProfileSession[];
  error: ApiError | null;
}

export interface AppState {
  sessionStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Dev-profile session (F-01). Null in password/Auth BFF mode. */
  session: Session | null;
  sessionError: ApiError | null;
  /** Auth BFF profile from GET /me; null in dev mode. */
  user: MeUser | null;
  me: MeResponse | null;
  device: Device | null;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceSummary | null;
  /**
   * D1-FE1: last known sum of `ChatSummary.unread_count` per workspace. The
   * active workspace is always recomputed from `chats`; inactive workspaces
   * keep the summary loaded by the rail (no per-workspace unread endpoint yet).
   */
  workspaceUnread: Record<string, number>;
  onboardingRequired: boolean;
  onboardingStatus: OnboardingStatus;
  onboardingError: ApiError | null;
  /** The last protected call returned 401 even after refresh. */
  authExpired: boolean;
  chats: ChatSummary[];
  activeChatId: string | null;
  slices: Record<string, ChatSlice>;
  /** D1-FE3: cached flat-thread replies keyed by `threadKey(chatId, rootId)`. */
  threads: Record<string, ThreadSlice>;
  /** D1-FE3: currently open thread panel, `null` when closed. */
  activeThread: ActiveThread | null;
  online: boolean;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError: ApiError | null;
  lastSyncedAt: string | null;
  rateLimitUntil: number | null;
  realtimeStatus: RealtimeStatus;
  realtimeIssue: RealtimeIssue | null;
  /** Ephemeral typing peers keyed by chat; TTL-cleaned, never persisted. */
  typing: Record<string, TypingEntry[]>;
  /** Ephemeral presence keyed by user; TTL-cleaned, never persisted. */
  presence: Record<string, PresenceEntry>;
  /** §9 1:1 audio/video call state; media streams are in-memory only. */
  call: CallState;
  /** E6-F: bell badge, panel list and read state. */
  notifications: NotificationsState;
  /** E6-F: preferences loaded lazily by the settings dialog. */
  notificationPreferences: NotificationPreferencesState;
  /** E7-F5: E2EE feature/device/chat state (empty when the flag is off). */
  e2ee: E2eeState;
  /** E8/R-01: `GET /workspaces/{id}/limits` chat counters for the create dialog. */
  chatLimits: WorkspaceLimits | null;
  chatLimitsStatus: LoadStatus;
  chatLimitsError: ApiError | null;
  chatCreateStatus: 'idle' | 'creating' | 'error';
  chatCreateError: ApiError | null;
  /** E10-F: DIRECT peer picker source (`GET /workspaces/{id}/members`). */
  workspaceMembers: WorkspaceMembersState;
  /** E12-F: add/role/remove feedback; rows change only on server success. */
  workspaceMemberAdmin: WorkspaceMemberAdminState;
  /** D1-FE5: server-confirmed `PATCH /chats/{chatId}` state. */
  chatSettings: ChatSettingsState;
  /** #79: chat-scoped participant directory and mutation feedback. */
  chatMembers: ChatMembersState;
  /** #79: chat-scoped invite links plus the one-time created token. */
  chatInvites: ChatInvitesState;
  /** #79: own blocked users. */
  blockedUsers: BlockedUsersState;
  /** #79: `/invite/:token` accept outcome. */
  inviteAccept: InviteAcceptState;
  /** P0-2 (#80): effective rights matrix for the settings dialog/MessageActions. */
  chatPermissions: ChatPermissionsState;
  /** P0-2 (#80): cover editor (existing chat images only). */
  chatCover: ChatCoverState;
  /** Channel icon/avatar editor (same existing chat images as the cover). */
  chatAvatar: ChatAvatarState;
  /** P0-2 (#80): pinned-message metadata. */
  chatPins: ChatPinsState;
  /** P0-2 (#80): archive/unarchive feedback for the settings danger zone. */
  chatArchive: ChatArchiveState;
  /** P0-2 (#80): OWNER-only soft delete state. */
  chatDeletion: ChatDeletionState;
  /** #99: workspace self-leave / OWNER soft-delete feedback. */
  workspaceLifecycle: WorkspaceLifecycleState;
  /** P0-2 (#80): caller-local archived chats, kept out of the main list. */
  archivedChats: ArchivedChatsState;
  /** D1-FE5: `GET /devices` for the profile modal. */
  devices: DevicesState;
  /** #83: server-side search results and cursor state. */
  messageSearch: MessageSearchState;
  /** #83: mention inbox and its unread badge. */
  mentions: MentionsState;
}

export interface ChatStoreDeps {
  api: ChatApi;
  config: AppConfig;
  now?: () => number;
  createId?: () => string;
  /** Test/mock adapter; production uses the browser WebSocket factory. */
  socketFactory?: SocketFactory;
  /** E7-F5: device API used by the real E2EE bridge (required when flag is on). */
  e2eeDevice?: E2eeDeviceTransport;
  /** Test seam: inject a prepared bridge (bypasses flag/transport wiring). */
  e2eeBridge?: E2eeBridge | null;
  /** Test seam for the feature flag; defaults to `VITE_E2EE_ENABLED`. */
  e2eeEnabled?: boolean;
  /** Test seam: getUserMedia for calls (defaults to navigator.mediaDevices). */
  callMediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  /** Test seam: RTCPeerConnection factory for calls. */
  callCreatePeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** #77: test seam for ringback/ringtone (defaults to a WebAudio loop). */
  callRingtone?: CallRingtone;
}

const MAX_TEXT_LENGTH = 8000;
const MAX_AUTO_RETRIES = 3;
const MAX_CATCH_UP_PAGES = 10;
/**
 * E7-F8 P1-01: an already received message can no longer be opened after its
 * session is gone (R-15 completion, §5.7 loser deletion, TTL/GC). These codes
 * must try the sealed incoming local copy before rendering an error or sending
 * another SESSION_RESET. `KEY_CHANGE_DETECTED` is included so history that was
 * already decrypted before a TOFU key change stays visible (§7.5 «старые
 * сообщения остаются»); a *new* row under the changed key has no sealed copy
 * and still renders as a blocking error until the user accepts it. The send
 * guard and §7.5 acceptance ceremony are not weakened by restoring old copies.
 */
const E2EE_COPY_RESTORE_CODES: ReadonlySet<string> = new Set([
  'NO_SESSION',
  'KEY_HANDSHAKE_INVALID',
  'SPK_DELETED',
  'DECRYPT_FAILED',
  'KEY_CHANGE_DETECTED',
]);
/**
 * G4f P1-01: the notification DTO has no `message_id`, so an R-15 replacement
 * notification can only be matched to its message by the server clock. The
 * backend creates it immediately after the message commits; this tight window
 * plus a uniqueness guard avoids touching an unrelated notification. Zero or
 * multiple candidates leave the notification untouched (documented limitation).
 */
const RETRY_NOTIFICATION_MATCH_MS = 250;
/** Contract default for GET /notifications; the panel loads one page at a time. */
const NOTIFICATIONS_PAGE_SIZE = 30;
/** #83: server search page size (contract max 50; keeps first paint small). */
const SEARCH_PAGE_SIZE = 20;
/** #83: mention inbox page size (contract default 30). */
const MENTIONS_PAGE_SIZE = 30;
/** Contract default (and cap-sane size) for the member picker. */
const MEMBER_PAGE_SIZE = 50;
/** Contract `query` maxLength for `GET /workspaces/{id}/members`. */
const MEMBER_QUERY_MAX_LENGTH = 80;
/** Contract `AddWorkspaceMemberRequest.email` maxLength and format. */
const MEMBER_EMAIL_MAX_LENGTH = 254;
const MEMBER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E12-F: `OWNER` is never assignable through the member UI. */
export function isAssignableMemberRole(role: string): role is AssignableMemberRole {
  return role === 'ADMIN' || role === 'MEMBER' || role === 'GUEST';
}

/* ------------------------------------------------------------------------- */
/* #79 channel roles                                                         */
/* ------------------------------------------------------------------------- */

/** Channel-level manager roles; workspace roles do not grant chat rights. */
export function isChatManagerRole(role: ChatMemberRole | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * Roles the actor may assign, mirroring the backend contract:
 * OWNER assigns any channel role; ADMIN never assigns OWNER/ADMIN.
 */
export function assignableChatRoles(
  actorRole: ChatMemberRole | null | undefined,
): ChatMemberRole[] {
  if (actorRole === 'OWNER') return ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST'];
  if (actorRole === 'ADMIN') return ['MODERATOR', 'MEMBER', 'GUEST'];
  return [];
}

/** ADMIN cannot touch OWNER/ADMIN rows; nobody changes their own role. */
export function canManageChatMember(
  actorRole: ChatMemberRole | null | undefined,
  actorId: string | null,
  target: Pick<ChatMember, 'user_id' | 'role'>,
): boolean {
  if (!isChatManagerRole(actorRole) || actorId === null || target.user_id === actorId) {
    return false;
  }
  if (actorRole === 'ADMIN') return target.role !== 'OWNER' && target.role !== 'ADMIN';
  return true;
}

/** Server rules for add/PATCH: OWNER only through add/PATCH, never via invites. */
export function isChatRole(value: string): value is ChatMemberRole {
  return (
    value === 'OWNER' ||
    value === 'ADMIN' ||
    value === 'MODERATOR' ||
    value === 'MEMBER' ||
    value === 'GUEST'
  );
}

/** Stable server order (`display_name ASC, user_id ASC`). */
function sortChatMembers(items: ChatMember[]): ChatMember[] {
  return [...items].sort(
    (left, right) =>
      left.display_name.localeCompare(right.display_name, 'ru') ||
      left.user_id.localeCompare(right.user_id),
  );
}

/** Replace/insert one server-returned row without inventing fields. */
function upsertChatMember(items: ChatMember[], member: ChatMember): ChatMember[] {
  const next = items.filter((item) => item.user_id !== member.user_id);
  next.push(member);
  return sortChatMembers(next);
}

export function createEmptyMessageSearchState(): MessageSearchState {
  return {
    query: '',
    chatId: null,
    status: 'idle',
    items: [],
    error: null,
    hasMore: false,
    nextCursor: null,
    loadMoreStatus: 'idle',
    loadMoreError: null,
    seq: 0,
  };
}

export function createEmptyMentionsState(): MentionsState {
  return {
    items: [],
    status: 'idle',
    error: null,
    unreadCount: 0,
    hasMore: false,
    nextCursor: null,
    loadMoreStatus: 'idle',
    loadMoreError: null,
    unreadOnly: false,
    readPendingIds: [],
    readAllPending: false,
    readError: null,
  };
}

export function createEmptyNotificationsState(): NotificationsState {
  return {
    items: [],
    status: 'idle',
    error: null,
    unreadCount: 0,
    hasMore: false,
    nextCursor: null,
    loadMoreStatus: 'idle',
    loadMoreError: null,
    readPendingIds: [],
    readAllPending: false,
    readError: null,
    lastLoadedAt: null,
  };
}

export function createEmptyNotificationPreferencesState(): NotificationPreferencesState {
  return {
    items: [],
    status: 'idle',
    error: null,
    saving: false,
    saveError: null,
  };
}

export function createEmptySlice(chatId: string, unread = 0): ChatSlice {
  return {
    chatId,
    status: 'idle',
    messages: [],
    outbox: [],
    hasMore: false,
    beforeSeq: null,
    loadMoreStatus: 'idle',
    loadMoreError: null,
    error: null,
    readSeq: 0,
    unread,
    lastSeq: 0,
    receipts: {},
    e2ee: {},
    pendingReactions: [],
    pendingMessageIds: [],
    actionError: null,
  };
}

/** `POST /workspaces/{id}/chats` returns `Chat`, not `ChatSummary`. */
export function toChatSummary(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    name: chat.name ?? null,
    description: chat.description ?? null,
    type: chat.type,
    security_mode: chat.security_mode,
    visibility: chat.visibility ?? null,
    peer_id: chat.peer_id ?? null,
    peer_has_e2ee_capable_devices: chat.peer_has_e2ee_capable_devices ?? false,
    last_message_at: null,
    unread_count: chat.unread_count,
    last_seq: chat.last_seq,
    cover_file_id: chat.cover_file_id ?? null,
    avatar_file_id: chat.avatar_file_id ?? null,
    read_only: chat.read_only ?? false,
    join_policy: chat.join_policy ?? null,
    archived: chat.archived ?? false,
  };
}

/**
 * `PATCH /chats/{chatId}` returns `Chat`, which has no `last_message_at`.
 * Keep the list preview timestamp from the previous summary instead of
 * dropping it on every settings save.
 */
function chatSummaryFromChat(chat: Chat, previous: ChatSummary | undefined): ChatSummary {
  return {
    ...(previous ?? toChatSummary(chat)),
    id: chat.id,
    name: chat.name ?? null,
    description: chat.description ?? null,
    type: chat.type,
    security_mode: chat.security_mode,
    visibility: chat.visibility ?? previous?.visibility ?? null,
    peer_has_e2ee_capable_devices:
      chat.peer_has_e2ee_capable_devices ?? previous?.peer_has_e2ee_capable_devices ?? false,
    last_message_at: previous?.last_message_at ?? null,
    unread_count: chat.unread_count,
    last_seq: chat.last_seq,
    cover_file_id: chat.cover_file_id ?? previous?.cover_file_id ?? null,
    avatar_file_id: chat.avatar_file_id ?? previous?.avatar_file_id ?? null,
    read_only: chat.read_only ?? previous?.read_only ?? false,
    join_policy: chat.join_policy ?? previous?.join_policy ?? null,
    archived: chat.archived ?? previous?.archived ?? false,
  };
}

/**
 * #78: logical payload for `POST /workspaces/{id}/chats`.
 *
 * GROUP defaults to PUBLIC (all current and future workspace members); PRIVATE
 * requires 1..100 selected ACTIVE workspace member ids, the creator is added by
 * the server and must not be listed. DIRECT is unchanged and never carries
 * visibility or members.
 */
export type ChatCreateInput =
  | {
      type: 'GROUP';
      name: string;
      visibility?: ChatVisibility;
      memberIds?: string[];
    }
  | { type: 'DIRECT'; peerId: string };

const MAX_CHAT_MEMBERS = 100;

export class ChatStore {
  private readonly api: ChatApi;
  private readonly config: AppConfig;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly e2eeEnabled: boolean;
  private readonly e2eeBridge: E2eeBridge | null;
  private e2eeInitPromise: Promise<void> | null = null;
  private readonly e2eeDecrypting = new Set<string>();
  private readonly e2eeResetInFlight = new Set<string>();
  /**
   * E7-F6 R-15 UX: failed reset windows kept for an explicit retry. Metadata
   * only (failed session id / chain / anchor), never plaintext.
   */
  private readonly pendingResets = new Map<
    string,
    { readonly reset: SessionResetBody; readonly senderDeviceId: string }
  >();
  /**
   * G4e #30: single-flight durable outbox drain. Only one pass may run in this
   * realm; the bridge's outbox lock serialises tabs as well.
   */
  private e2eeDrainInFlight: Promise<void> | null = null;
  private e2eeDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly e2eeResumeInFlight = new Set<string>();
  /** E4-F upload queue + workspace limits; ephemeral client state. */
  readonly files: FilesStore;
  /** E5-F sticker catalog, favorites and local recent list. */
  readonly stickers: StickersStore;
  /** D1.1 (#69): built-in plugin catalog and per-chat state. */
  readonly plugins: PluginsStore;
  /** D1.1 (#76): real poll/task/translation actions on managed chats. */
  readonly pluginActions: PluginActionsStore;
  /** E8: setup status and platform-admin settings/overview. */
  readonly ops: OpsStore;
  /** P0-3 (#81): workspace DLP, audit, sessions and security settings. */
  readonly security: SecurityStore;
  /** P0-4 (#82): profile avatar, TOTP setup and workspace settings/invites. */
  readonly profile: ProfileWorkspaceStore;
  /** #84: workspace dashboard aggregates for the Overview page. */
  readonly workspaceOverview: WorkspaceOverviewStore;
  /** #96: workspace bots (one-time token in memory) and chat installations. */
  readonly bots: BotsStore;
  /** Per-id chat/workspace avatar bytes (object URLs, cleared on change). */
  readonly avatars: AvatarStore;
  /** #105: workspace rooms list + TTL presence + mesh-call bridge. */
  readonly rooms: RoomsStore;

  private state: AppState;
  private listeners = new Set<() => void>();
  private bootstrapPromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly readKeys = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly realtime: RealtimeClient | null;
  /** §9 call engine; owns getUserMedia/RTCPeerConnection and all media cleanup. */
  private readonly calls: CallController;
  private readonly seenEventIds: string[] = [];
  private readonly seenEventIdSet = new Set<string>();
  private readonly gapInFlight = new Set<string>();
  private notificationsPromise: Promise<void> | null = null;
  private preferencesPromise: Promise<void> | null = null;
  private chatLimitsPromise: Promise<void> | null = null;
  /**
   * #99: invalidates the chat-list read of a workspace that was just left or
   * deleted, so a late response cannot resurrect its chats/session-scoped rows.
   */
  private workspaceGeneration = 0;
  /** D1-FE1: workspaces whose chat list was read only for the unread badge. */
  private readonly unreadWorkspaceRequests = new Set<string>();
  /** E10-F: member directory race guards (search chain + load-more). */
  private membersToken = 0;
  private membersInFlight: Promise<void> | null = null;
  private membersLoadMoreInFlight = false;
  /** #79: chat-scoped member/invite reads are invalidated by generation. */
  private chatMembersToken = 0;
  private chatMembersInFlight: Promise<void> | null = null;
  private chatInvitesToken = 0;
  private chatInvitesInFlight: Promise<void> | null = null;
  /** P0-2 (#80): generation guards for the matrix, cover candidates and pins. */
  private chatPermissionsToken = 0;
  private chatPermissionsInFlight: Promise<void> | null = null;
  private chatCoverToken = 0;
  private chatCoverInFlight: Promise<void> | null = null;
  private chatPinsToken = 0;
  private chatPinsInFlight: Promise<void> | null = null;
  private archivedChatsToken = 0;
  private archivedChatsInFlight: Promise<void> | null = null;
  private blockedUsersInFlight: Promise<void> | null = null;
  private inviteAcceptInFlight: Promise<boolean> | null = null;
  /** D1-FE5: dedupes profile device reads; reset on workspace switch. */
  private devicesInFlight: Promise<void> | null = null;
  /** #72: dedupes the profile-modal `/me` read. */
  private profileInFlight: Promise<void> | null = null;
  /** Guards a single-read rollback that races with a successful read-all. */
  private notificationReadGeneration = 0;
  /** Invalidates in-flight notification responses across logout/workspace switch. */
  private notificationEpoch = 0;
  /** #83: invalidates in-flight mention inbox responses on workspace switch. */
  private mentionEpoch = 0;
  /**
   * G4f P1-01: R-15 replacements that were hidden as duplicates and whose
   * unread contribution/notification must be suppressed. Keys are derived from
   * sealed copy markers, so the same suppression is rebuilt after a reload.
   */
  private readonly suppressedRetryKeys = new Set<string>();
  /** Replacement message times whose server notification should be hidden. */
  private readonly suppressedNotificationTimes = new Map<string, number>();
  private disposed = false;

  constructor(deps: ChatStoreDeps) {
    this.api = deps.api;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.createId = deps.createId ?? newUuid;
    this.e2eeEnabled =
      deps.e2eeEnabled !== undefined
        ? deps.e2eeEnabled
        : deps.e2eeBridge
          ? true
          : deps.e2eeDevice !== undefined && isE2eeEnabled();
    this.e2eeBridge =
      deps.e2eeBridge !== undefined
        ? deps.e2eeBridge
        : this.e2eeEnabled && deps.e2eeDevice
          ? createE2eeBridge({
              storage: getE2eeStorage(),
              transport: deps.e2eeDevice,
              now: () => this.now(),
            })
          : null;
    this.state = {
      sessionStatus: 'idle',
      session: null,
      sessionError: null,
      user: null,
      me: null,
      device: null,
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspace: null,
      workspaceUnread: {},
      onboardingRequired: false,
      onboardingStatus: 'idle',
      onboardingError: null,
      authExpired: false,
      chats: [],
      activeChatId: null,
      slices: {},
      threads: {},
      activeThread: null,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: null,
      rateLimitUntil: null,
      realtimeStatus: 'idle',
      realtimeIssue: null,
      typing: {},
      presence: {},
      call: idleCallState(),
      notifications: createEmptyNotificationsState(),
      notificationPreferences: createEmptyNotificationPreferencesState(),
      messageSearch: createEmptyMessageSearchState(),
      mentions: createEmptyMentionsState(),
      e2ee: createE2eeState(this.e2eeEnabled && this.e2eeBridge !== null),
      chatLimits: null,
      chatLimitsStatus: 'idle',
      chatLimitsError: null,
      chatCreateStatus: 'idle',
      chatCreateError: null,
      workspaceMembers: createEmptyWorkspaceMembersState(),
      workspaceMemberAdmin: createEmptyWorkspaceMemberAdminState(),
      chatSettings: createEmptyChatSettingsState(),
      chatMembers: createEmptyChatMembersState(),
      chatInvites: createEmptyChatInvitesState(),
      blockedUsers: createEmptyBlockedUsersState(),
      inviteAccept: createEmptyInviteAcceptState(),
      chatPermissions: createEmptyChatPermissionsState(),
      chatCover: createEmptyChatCoverState(),
      chatAvatar: createEmptyChatAvatarState(),
      chatPins: createEmptyChatPinsState(),
      chatArchive: createEmptyChatArchiveState(),
      chatDeletion: createEmptyChatDeletionState(),
      workspaceLifecycle: createEmptyWorkspaceLifecycleState(),
      archivedChats: createEmptyArchivedChatsState(),
      devices: createEmptyDevicesState(),
    };

    this.ops = createOpsStore({ api: deps.api });
    this.security = createSecurityStore({ api: deps.api });
    this.profile = createProfileWorkspaceStore({
      api: deps.api,
      onWorkspaceUpdated: (workspace) => {
        this.applyWorkspaceSummary(workspace);
        // A new logo id means new bytes: drop the old URL and resolve once.
        this.avatars.invalidateWorkspace(workspace.id);
        if (workspace.logo_file_id) {
          void this.avatars.ensureWorkspace(workspace.id, workspace.logo_file_id);
        }
      },
      onProfileUpdated: (user) => this.applyProfileUser(user),
      onWorkspaceLogoCleared: (workspaceId) => {
        this.clearWorkspaceLogo(workspaceId);
        this.avatars.invalidateWorkspace(workspaceId);
      },
    });

    this.avatars = createAvatarStore({ api: deps.api });
    this.workspaceOverview = createWorkspaceOverviewStore({ api: deps.api });
    this.bots = createBotsStore({ api: deps.api });

    this.files = createFilesStore({
      api: deps.api,
      config: deps.config,
    });

    this.stickers = createStickersStore({ api: deps.api });

    this.plugins = createPluginsStore({ api: deps.api });
    this.pluginActions = createPluginActionsStore({
      api: deps.api,
      // #95: poll/task responses carry the new aggregate. The embedded
      // projection in the feed message is replaced in place (never appended),
      // so the card and the timeline stay one row.
      onPollChanged: (chatId, poll) => this.applyEmbeddedPoll(chatId, poll),
      onTaskChanged: (chatId, task) => this.applyEmbeddedTask(chatId, task),
    });

    this.realtime =
      deps.config.realtimeEnabled && this.config.realtimeEnabled
        ? new RealtimeClient({
            createTicket: () => this.api.createRealtimeTicket(),
            getSubscriptions: () => this.realtimeSubscriptions(),
            socketFactory: deps.socketFactory,
            resolveUrl: (ticketWsUrl) => resolveRealtimeUrl(ticketWsUrl, this.config.wsUrl),
            enabled: this.config.realtimeEnabled,
            maxReconnectPerHour: this.config.realtimeMaxPerHour,
            defaultHeartbeatMs: this.config.realtimeHeartbeatMs,
            timeoutMs: this.config.realtimeTimeoutMs,
            callbacks: {
              onStatus: (status) => this.handleRealtimeStatus(status),
              onFailure: (failure) => this.handleRealtimeFailure(failure),
              onServerError: (frame) => this.handleRealtimeServerError(frame),
              onRevoked: (reason) => this.handleRealtimeRevoked(reason),
              onSubscribed: (frame) => this.handleSubscribed(frame),
              onEvent: (frame) => this.handleRealtimeEvent(frame),
              onGap: (frame) => void this.handleResumeGap(frame),
              onTyping: (frame) => this.handleTyping(frame),
              onPresence: (frame) => this.handlePresence(frame),
              onCallSignal: (frame) => this.handleCallSignal(frame),
              onCallUnavailable: (frame) => this.handleCallUnavailable(frame),
              onBeforeReconnect: () => this.syncForReconnect(),
            },
          })
        : null;

    this.calls = new CallController({
      sendSignal: (chatId, payload) => this.realtime?.sendCallSignal(chatId, payload) ?? false,
      onChange: (call) => {
        this.patch({ call });
      },
      createId: () => this.createId(),
      iceServers: this.config.webrtcIceServers,
      now: () => this.now(),
      mediaDevices: deps.callMediaDevices,
      createPeerConnection: deps.callCreatePeerConnection,
      ringtone: deps.callRingtone,
    });

    // #105: rooms reuse the same mesh call engine; the bridge keeps the media
    // lifecycle inside this store (no second CallController).
    this.rooms = createRoomsStore({
      api: deps.api,
      getSelfId: () => this.viewerId(),
      calls: {
        startConference: (chatId, peers, video, callId) =>
          this.startRoomConference(chatId, peers, video, callId),
        activeCallChatId: () => this.calls.getState().chatId,
        endCallForChat: (chatId) => {
          if (this.calls.getState().chatId === chatId) this.calls.hangup();
        },
      },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AppState => this.state;

  dispose(): void {
    this.disposed = true;
    this.realtime?.stop();
    this.calls.dispose();
    this.files.dispose();
    this.stickers.dispose();
    this.plugins.dispose();
    this.pluginActions.dispose();
    this.ops.dispose();
    this.security.dispose();
    this.profile.dispose();
    this.avatars.dispose();
    this.workspaceOverview.dispose();
    this.bots.dispose();
    this.rooms.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  getActiveSlice(): ChatSlice | null {
    const { activeChatId, slices } = this.state;
    return activeChatId ? (slices[activeChatId] ?? null) : null;
  }

  private emit(next: AppState): void {
    if (this.disposed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<AppState>): void {
    this.emit({ ...this.state, ...patch });
  }

  private patchSlice(chatId: string, patch: Partial<ChatSlice>): void {
    const current = this.state.slices[chatId];
    if (!current) return;
    this.patch({
      slices: {
        ...this.state.slices,
        [chatId]: { ...current, ...patch },
      },
    });
  }

  /** D1-FE3: patch one cached thread without touching the main slice. */
  private patchThread(key: string, patch: Partial<ThreadSlice>): void {
    const current = this.state.threads[key];
    if (!current) return;
    this.patch({
      threads: {
        ...this.state.threads,
        [key]: { ...current, ...patch },
      },
    });
  }

  private threadFor(chatId: string, rootId: string): ThreadSlice | null {
    return this.state.threads[threadKey(chatId, rootId)] ?? null;
  }

  private handleRateLimit(error: ApiError): void {
    if (error.status !== 429) return;
    const seconds = error.retryAfterSeconds ?? 5;
    this.patch({ rateLimitUntil: this.now() + seconds * 1000 });
  }

  private handleFailure(error: ApiError): void {
    this.handleRateLimit(error);
    if (error.status === 401) {
      this.realtime?.stop();
      this.patch({
        authExpired: true,
        sessionError: error,
        sessionStatus: 'error',
      });
    }
  }

  private updateChatSummary(chatId: string, patch: Partial<ChatSummary>): void {
    const chats = this.state.chats.map((chat) =>
      chat.id === chatId ? { ...chat, ...patch } : chat,
    );
    this.patch({ chats, workspaceUnread: this.withActiveWorkspaceUnread(chats) });
  }

  /** D1-FE1: keep the active workspace badge in sync with its chat list. */
  private withActiveWorkspaceUnread(chats: ChatSummary[]): Record<string, number> {
    const activeWorkspaceId = this.state.activeWorkspaceId;
    if (activeWorkspaceId === null) return this.state.workspaceUnread;
    return { ...this.state.workspaceUnread, [activeWorkspaceId]: sumUnread(chats) };
  }

  /**
   * D1-FE3: a late REST `201` must not move the chat tail backwards when a live
   * frame with a higher seq (e.g. a thread reply) was already applied.
   */
  private updateChatTail(chatId: string, message: ApiMessage): void {
    const current = this.chatLastSeq(chatId);
    this.updateChatSummary(chatId, {
      last_seq: Math.max(current, message.seq),
      ...(message.seq >= current ? { last_message_at: message.created_at } : {}),
      unread_count: 0,
    });
  }

  async bootstrap(): Promise<void> {
    const ready =
      this.state.sessionStatus === 'ready' &&
      (this.state.activeChatId !== null || this.state.onboardingRequired);
    if (ready) return;
    if (this.bootstrapPromise) return this.bootstrapPromise;

    this.bootstrapPromise = (
      this.config.authMode === 'password' ? this.runPasswordBootstrap() : this.runDevBootstrap()
    ).finally(() => {
      this.bootstrapPromise = null;
    });
    return this.bootstrapPromise;
  }

  /** F-01 path: POST /dev/session -> workspace chats -> history. */
  private async runDevBootstrap(): Promise<void> {
    this.patch({ sessionStatus: 'loading', sessionError: null, authExpired: false });
    try {
      const existing = getSession();
      const session = existing ?? (await this.api.bootstrapDevSession());
      await this.initializeE2ee(session.user.id);
      this.stickers.setOwner(session.user.id);
      this.files.setWorkspace(session.workspace.id, null);
      this.workspaceOverview.setWorkspace(session.workspace.id);
      const chatList = await this.api.listChats(session.workspace.id);
      const chats = chatList.items;
      const activeChatId =
        chats.find((chat) => chat.id === session.chat.id)?.id ?? chats[0]?.id ?? null;

      const slices = { ...this.state.slices };
      for (const chat of chats) {
        slices[chat.id] ??= createEmptySlice(chat.id, chat.unread_count);
      }

      this.emit({
        ...this.state,
        session,
        sessionStatus: 'ready',
        sessionError: null,
        chats,
        slices,
        activeChatId,
      });

      // E6: bell badge and list are loaded with the first paint, in parallel
      // with history so notifications never block the chat.
      void this.loadNotifications();
      void this.loadNotificationPreferences();
      // #83: mention badge is part of the first paint; failures stay quiet.
      void this.refreshMentions();
      void this.loadChatLimits();

      if (activeChatId) {
        await this.loadChat(activeChatId);
        if (this.state.slices[activeChatId]?.status === 'ready') {
          // Fill last_synced_at and unread counters before the first paint.
          await this.sync();
        }
        this.startRealtime();
      }
    } catch (error) {
      this.failBootstrap(error);
    }
  }

  /**
   * Auth BFF (password) path: device -> /me -> default workspace -> chats.
   * An empty workspace list is a valid state and opens onboarding.
   */
  private async runPasswordBootstrap(): Promise<void> {
    this.patch({
      sessionStatus: 'loading',
      sessionError: null,
      onboardingError: null,
      authExpired: false,
    });
    try {
      const me = await this.api.getMe();
      let device: Device;
      if (this.e2eeBridge !== null) {
        // Keyed registration needs the authenticated user id (owner-scoped
        // identity/K_storage) and produces this browser's device id.
        await this.initializeE2ee(me.user.id);
        const keyedDeviceId = this.state.e2ee.deviceId;
        if (keyedDeviceId === null) {
          throw new ApiError({
            source: 'client',
            status: 0,
            code: 'E2EE_DEVICE_UNAVAILABLE',
            message: 'E2EE device registration failed',
          });
        }
        device = this.state.device ?? {
          id: keyedDeviceId,
          platform: 'WEB',
          created_at: new Date(this.now()).toISOString(),
        };
      } else {
        device = await this.ensureDevice();
      }
      this.patch({ device, me, user: me.user, workspaces: me.workspaces });
      this.stickers.setOwner(me.user.id);

      if (me.workspaces.length === 0) {
        this.patch({
          sessionStatus: 'ready',
          sessionError: null,
          onboardingRequired: true,
          onboardingStatus: 'idle',
          activeWorkspaceId: null,
          activeWorkspace: null,
          workspaceUnread: {},
          chats: [],
          slices: {},
          threads: {},
          activeThread: null,
          activeChatId: null,
        });
        return;
      }

      const workspace = this.pickWorkspace(me);
      await this.activateWorkspace(workspace);
    } catch (error) {
      this.failBootstrap(error);
    }
  }

  private failBootstrap(error: unknown): void {
    const apiError = toApiError(error);
    this.handleFailure(apiError);
    this.patch({
      sessionStatus: 'error',
      sessionError: apiError,
      authExpired: apiError.status === 401,
    });
  }

  private pickWorkspace(me: MeResponse): WorkspaceSummary {
    // Per-device selection (R-02) is only a hint: the server has already
    // filtered `me.workspaces` by membership, so an unknown/forged id falls
    // back to the server default instead of leaking anything.
    const storedId = readDeviceWorkspaceId();
    const stored = storedId
      ? me.workspaces.find((workspace) => workspace.id === storedId)
      : undefined;
    if (stored) return stored;
    const preferred = me.workspaces.find((workspace) => workspace.id === me.default_workspace_id);
    return preferred ?? me.workspaces[0]!;
  }

  /** Workspace for chat calls: dev mode has no `activeWorkspace` projection. */
  private currentWorkspaceId(): string | null {
    return this.state.activeWorkspaceId ?? this.state.session?.workspace.id ?? null;
  }

  private async ensureDevice(): Promise<Device> {
    const existingId = getDeviceId();
    if (existingId) {
      return {
        id: existingId,
        platform: 'WEB',
        created_at: new Date(this.now()).toISOString(),
      };
    }

    let idempotencyKey = getPendingDeviceKey();
    if (!idempotencyKey) {
      idempotencyKey = this.createId();
      setPendingDeviceKey(idempotencyKey);
    }

    const device = await this.api.registerDevice(
      {
        name: this.config.deviceName.slice(0, 80) || 'Сова — браузер',
        platform: 'WEB',
        app_version: this.config.appVersion.slice(0, 40),
      },
      idempotencyKey,
    );
    clearPendingDeviceKey();
    setRuntimeDeviceId(device.id);
    return device;
  }

  private async activateWorkspace(workspace: WorkspaceSummary): Promise<void> {
    const generation = ++this.workspaceGeneration;
    this.realtime?.stop();
    this.calls.stop();
    this.notificationEpoch += 1;
    this.mentionEpoch += 1;
    this.chatMembersToken += 1;
    this.chatMembersInFlight = null;
    this.chatInvitesToken += 1;
    this.chatInvitesInFlight = null;
    this.chatPermissionsToken += 1;
    this.chatPermissionsInFlight = null;
    this.chatCoverToken += 1;
    this.chatCoverInFlight = null;
    this.chatPinsToken += 1;
    this.chatPinsInFlight = null;
    this.archivedChatsToken += 1;
    this.archivedChatsInFlight = null;
    this.blockedUsersInFlight = null;
    this.inviteAcceptInFlight = null;
    writeDeviceWorkspaceId(workspace.id);
    this.files.setWorkspace(workspace.id, workspace.role ?? null);
    this.workspaceOverview.setWorkspace(workspace.id);
    // #105: room rows and any local presence belong to the outgoing workspace.
    this.rooms.setWorkspace(workspace.id);
    this.security.reset();
    this.profile.reset();
    this.avatars.reset();
    // #96: bot rows and any one-time token belong to the outgoing workspace.
    this.bots.reset();
    // D1-FE1: keep the outgoing workspace badge truthful after `chats` is
    // cleared; the value is the same sum the server just gave us.
    const previousWorkspaceId = this.state.activeWorkspaceId;
    // #99: a workspace that was just left/deleted is no longer in the list, so
    // its last badge must not be written back into `workspaceUnread`.
    const previousStillKnown =
      previousWorkspaceId !== null &&
      this.state.workspaces.some((item) => item.id === previousWorkspaceId);
    const previousUnread = previousStillKnown ? sumUnread(this.state.chats) : null;
    const workspaceUnread =
      previousWorkspaceId === null || previousUnread === null
        ? this.state.workspaceUnread
        : { ...this.state.workspaceUnread, [previousWorkspaceId]: previousUnread };
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.seenEventIds.length = 0;
    this.seenEventIdSet.clear();
    this.gapInFlight.clear();
    this.patch({
      activeWorkspaceId: workspace.id,
      activeWorkspace: workspace,
      workspaceUnread,
      sessionStatus: 'loading',
      sessionError: null,
      authExpired: false,
      onboardingRequired: false,
      chats: [],
      slices: {},
      threads: {},
      activeThread: null,
      activeChatId: null,
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: null,
      realtimeStatus: 'idle',
      realtimeIssue: null,
      typing: {},
      presence: {},
      call: idleCallState(),
      notifications: createEmptyNotificationsState(),
      notificationPreferences: createEmptyNotificationPreferencesState(),
      messageSearch: createEmptyMessageSearchState(),
      mentions: createEmptyMentionsState(),
      e2ee: { ...this.state.e2ee, chats: {} },
      chatLimits: null,
      chatLimitsStatus: 'loading',
      chatLimitsError: null,
      chatCreateStatus: 'idle',
      chatCreateError: null,
      workspaceMembers: createEmptyWorkspaceMembersState(),
      workspaceMemberAdmin: createEmptyWorkspaceMemberAdminState(),
      chatSettings: createEmptyChatSettingsState(),
      chatMembers: createEmptyChatMembersState(),
      chatInvites: createEmptyChatInvitesState(),
      blockedUsers: createEmptyBlockedUsersState(),
      inviteAccept: createEmptyInviteAcceptState(),
      chatPermissions: createEmptyChatPermissionsState(),
      chatCover: createEmptyChatCoverState(),
      chatAvatar: createEmptyChatAvatarState(),
      chatPins: createEmptyChatPinsState(),
      chatArchive: createEmptyChatArchiveState(),
      chatDeletion: createEmptyChatDeletionState(),
      workspaceLifecycle: createEmptyWorkspaceLifecycleState(),
      archivedChats: createEmptyArchivedChatsState(),
      devices: createEmptyDevicesState(),
    });
    this.devicesInFlight = null;
    void this.loadChatLimits();

    try {
      const chatList = await this.api.listChats(workspace.id);
      // A later switch/removal superseded this activation; discard its read.
      if (generation !== this.workspaceGeneration) return;
      const chats = chatList.items;
      const slices: Record<string, ChatSlice> = {};
      for (const chat of chats) {
        slices[chat.id] = createEmptySlice(chat.id, chat.unread_count);
      }
      const activeChatId = chats[0]?.id ?? null;

      this.patch({
        sessionStatus: 'ready',
        sessionError: null,
        chats,
        slices,
        activeChatId,
        workspaceUnread: { ...workspaceUnread, [workspace.id]: sumUnread(chats) },
      });

      void this.loadNotifications();
      void this.loadNotificationPreferences();
      // #83: mention badge is part of the first paint; failures stay quiet.
      void this.refreshMentions();

      if (activeChatId) {
        await this.loadChat(activeChatId);
        if (this.state.slices[activeChatId]?.status === 'ready') {
          await this.sync();
        }
        this.startRealtime();
      }
    } catch (error) {
      if (generation !== this.workspaceGeneration) return;
      this.failBootstrap(error);
    }
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    if (workspaceId === this.state.activeWorkspaceId) return;
    const workspace = this.state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    await this.activateWorkspace(workspace);
  }

  /**
   * D1-FE1: the contract has no aggregate unread endpoint yet, so the rail
   * reads each inactive workspace's chat list once and sums
   * `ChatSummary.unread_count`. Failures are ignored: the badge simply stays
   * absent, while the active workspace is always computed from live chats.
   */
  async loadWorkspaceUnread(): Promise<void> {
    if (this.state.sessionStatus !== 'ready') return;
    const activeWorkspaceId =
      this.state.activeWorkspaceId ?? this.state.session?.workspace.id ?? null;
    const requests: Promise<void>[] = [];
    for (const workspace of this.state.workspaces) {
      if (workspace.id === activeWorkspaceId) continue;
      if (this.unreadWorkspaceRequests.has(workspace.id)) continue;
      this.unreadWorkspaceRequests.add(workspace.id);
      requests.push(
        this.api
          .listChats(workspace.id)
          .then((list) => {
            // A workspace switch/logout while the request was in flight must
            // not resurrect old badge state.
            if (this.state.sessionStatus !== 'ready') return;
            // #99: the workspace may have been left/deleted meanwhile.
            if (!this.state.workspaces.some((item) => item.id === workspace.id)) return;
            this.patch({
              workspaceUnread: {
                ...this.state.workspaceUnread,
                [workspace.id]: sumUnread(list.items),
              },
            });
          })
          .catch(() => {
            this.unreadWorkspaceRequests.delete(workspace.id);
          }),
      );
    }
    await Promise.all(requests);
  }

  /**
   * R-01: `GET /workspaces/{id}/limits` drives the `used/limit` counter. The
   * server remains the source of truth; this is only UI pre-check.
   */
  async loadChatLimits(force = false): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return;
    if (!force && (this.state.chatLimitsStatus === 'ready' || this.chatLimitsPromise !== null)) {
      return this.chatLimitsPromise ?? undefined;
    }
    if (this.chatLimitsPromise) return this.chatLimitsPromise;

    this.patch({ chatLimitsStatus: 'loading', chatLimitsError: null });
    this.chatLimitsPromise = (async () => {
      try {
        const limits = await this.api.getWorkspaceLimits(workspaceId);
        if (this.currentWorkspaceId() !== workspaceId) return;
        this.patch({ chatLimits: limits, chatLimitsStatus: 'ready', chatLimitsError: null });
      } catch (error) {
        if (this.currentWorkspaceId() !== workspaceId) return;
        this.patch({ chatLimitsStatus: 'error', chatLimitsError: toApiError(error) });
      } finally {
        if (this.currentWorkspaceId() === workspaceId) this.chatLimitsPromise = null;
      }
    })();
    return this.chatLimitsPromise;
  }

  /**
   * E10-F: `GET /workspaces/{id}/members` for the DIRECT peer picker.
   *
   * `query` is literal server-side search over `display_name`; `cursor` is
   * opaque and only echoed back. A changed query starts a new page chain and
   * invalidates the previous in-flight response (same generation guard as the
   * admin directory). The caller is included by the server and filtered by the
   * UI, so no client-side field invention is required.
   */
  loadWorkspaceMembers(options: { query?: string; force?: boolean } = {}): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return Promise.resolve();
    const query = (options.query ?? this.state.workspaceMembers.query)
      .trim()
      .slice(0, MEMBER_QUERY_MAX_LENGTH);
    const current = this.state.workspaceMembers;

    if (!options.force && this.membersInFlight && query === current.query) {
      return this.membersInFlight;
    }
    if (!options.force && query === current.query && current.status === 'ready') {
      return Promise.resolve();
    }

    const token = ++this.membersToken;
    this.patch({
      workspaceMembers: {
        ...createEmptyWorkspaceMembersState(),
        query,
        status: 'loading',
      },
    });

    const promise = (async () => {
      try {
        const page: WorkspaceMemberPage = await this.api.listWorkspaceMembers(workspaceId, {
          query: query || undefined,
          limit: MEMBER_PAGE_SIZE,
        });
        if (token !== this.membersToken || this.currentWorkspaceId() !== workspaceId) return;
        this.patch({
          workspaceMembers: {
            ...this.state.workspaceMembers,
            items: page.items,
            nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
            hasMore: page.has_more,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.membersToken || this.currentWorkspaceId() !== workspaceId) return;
        this.patch({
          workspaceMembers: {
            ...this.state.workspaceMembers,
            status: 'error',
            error: toApiError(error),
          },
        });
      } finally {
        if (token === this.membersToken) this.membersInFlight = null;
      }
    })();
    this.membersInFlight = promise;
    return promise;
  }

  /** New search chain for the member picker; the UI debounces the input. */
  searchWorkspaceMembers(rawQuery: string): void {
    const query = rawQuery.trim().slice(0, MEMBER_QUERY_MAX_LENGTH);
    const current = this.state.workspaceMembers;
    if (query === current.query) {
      if (current.status === 'idle') void this.loadWorkspaceMembers({ query });
      return;
    }
    this.membersToken += 1;
    this.membersInFlight = null;
    this.membersLoadMoreInFlight = false;
    this.patch({
      workspaceMembers: {
        ...createEmptyWorkspaceMembersState(),
        query,
        status: 'idle',
      },
    });
    void this.loadWorkspaceMembers({ query, force: true });
  }

  /** Append the next member page; keeps the already loaded rows visible. */
  async loadMoreWorkspaceMembers(): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    const current = this.state.workspaceMembers;
    if (!workspaceId || !current.hasMore || !current.nextCursor) return;
    if (this.membersLoadMoreInFlight || current.loadMoreStatus === 'loading') return;

    const token = this.membersToken;
    this.membersLoadMoreInFlight = true;
    this.patch({
      workspaceMembers: {
        ...current,
        loadMoreStatus: 'loading',
        loadMoreError: null,
      },
    });

    try {
      const page = await this.api.listWorkspaceMembers(workspaceId, {
        query: current.query || undefined,
        cursor: current.nextCursor,
        limit: MEMBER_PAGE_SIZE,
      });
      if (token !== this.membersToken || this.currentWorkspaceId() !== workspaceId) return;
      const latest = this.state.workspaceMembers;
      const seen = new Set(latest.items.map((member) => member.user_id));
      const items = [...latest.items];
      for (const member of page.items) {
        if (seen.has(member.user_id)) continue;
        seen.add(member.user_id);
        items.push(member);
      }
      this.patch({
        workspaceMembers: {
          ...latest,
          items,
          nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
          hasMore: page.has_more,
          loadMoreStatus: 'idle',
          loadMoreError: null,
        },
      });
    } catch (error) {
      if (token !== this.membersToken || this.currentWorkspaceId() !== workspaceId) return;
      this.patch({
        workspaceMembers: {
          ...this.state.workspaceMembers,
          loadMoreStatus: 'error',
          loadMoreError: toApiError(error),
        },
      });
    } finally {
      if (token === this.membersToken) this.membersLoadMoreInFlight = false;
    }
  }

  /** Drop cached picker rows (dialog open/close or workspace switch). */
  clearWorkspaceMembers(): void {
    this.membersToken += 1;
    this.membersInFlight = null;
    this.membersLoadMoreInFlight = false;
    if (
      this.state.workspaceMembers.status !== 'idle' ||
      this.state.workspaceMembers.items.length > 0 ||
      this.state.workspaceMembers.query !== ''
    ) {
      this.patch({ workspaceMembers: createEmptyWorkspaceMembersState() });
    }
  }

  /**
   * E12-F (FR-WS-4/5): add an existing user by email. The server decides
   * whether the actor may manage members and which role is allowed; the client
   * only validates the obvious email shape before the request. The list is
   * re-read from the server after `201`, so no invented/optimistic row appears.
   */
  async addWorkspaceMember(rawEmail: string, role: AssignableMemberRole): Promise<boolean> {
    const admin = this.state.workspaceMemberAdmin;
    if (admin.addStatus === 'adding') return false;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) {
      this.patch({
        workspaceMemberAdmin: {
          ...admin,
          addStatus: 'error',
          addError: ApiError.client(
            'WORKSPACE_REQUIRED',
            'No active workspace for member management',
            409,
          ),
        },
      });
      return false;
    }

    const email = rawEmail.trim();
    if (!email || email.length > MEMBER_EMAIL_MAX_LENGTH || !MEMBER_EMAIL_RE.test(email)) {
      this.patch({
        workspaceMemberAdmin: {
          ...admin,
          addStatus: 'error',
          addError: ApiError.client('VALIDATION_FAILED', 'A valid email is required', 422, {
            field: 'email',
            max_length: MEMBER_EMAIL_MAX_LENGTH,
          }),
        },
      });
      return false;
    }
    if ((role as string) === 'OWNER') {
      this.patch({
        workspaceMemberAdmin: {
          ...admin,
          addStatus: 'error',
          addError: ApiError.client('ROLE_CHANGE_FORBIDDEN', 'OWNER cannot be assigned', 403, {
            field: 'role',
          }),
        },
      });
      return false;
    }

    const body: AddWorkspaceMemberRequest = { email, role };
    this.patch({
      workspaceMemberAdmin: { ...admin, addStatus: 'adding', addError: null },
    });

    try {
      await this.api.addWorkspaceMember(workspaceId, body);
      if (this.currentWorkspaceId() !== workspaceId) {
        this.patch({
          workspaceMemberAdmin: {
            ...this.state.workspaceMemberAdmin,
            addStatus: 'idle',
            addError: null,
          },
        });
        return false;
      }
      // Server order is `display_name ASC, user_id ASC`; a full first page is
      // cheaper to trust than inserting a row locally. `adding` stays set until
      // the refresh settles, so the form cannot double-submit the same email.
      await this.loadWorkspaceMembers({
        query: this.state.workspaceMembers.query,
        force: true,
      });
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          addStatus: 'idle',
          addError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          addStatus: 'error',
          addError: apiError,
        },
      });
      return false;
    }
  }

  /**
   * E12-F (FR-WS-6): change a role. The updated row comes from the `200`
   * response (server-confirmed) and is placed at the same position; a failure
   * leaves the row and its role untouched.
   */
  async changeWorkspaceMemberRole(userId: string, role: AssignableMemberRole): Promise<boolean> {
    const admin = this.state.workspaceMemberAdmin;
    if (admin.rolePendingUserId !== null) return false;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;
    if ((role as string) === 'OWNER' || !isAssignableMemberRole(role)) {
      this.patch({
        workspaceMemberAdmin: {
          ...admin,
          roleError: {
            userId,
            error: ApiError.client('ROLE_CHANGE_FORBIDDEN', 'OWNER cannot be assigned', 403, {
              field: 'role',
            }),
          },
        },
      });
      return false;
    }

    const body: ChangeWorkspaceMemberRoleRequest = { role };
    this.patch({
      workspaceMemberAdmin: {
        ...admin,
        rolePendingUserId: userId,
        roleError: null,
      },
    });

    try {
      const updated = await this.api.changeWorkspaceMemberRole(workspaceId, userId, body);
      if (this.currentWorkspaceId() !== workspaceId) {
        this.patch({
          workspaceMemberAdmin: {
            ...this.state.workspaceMemberAdmin,
            rolePendingUserId: null,
            roleError: null,
          },
        });
        return false;
      }
      const items = this.state.workspaceMembers.items.map((member) =>
        member.user_id === updated.user_id ? updated : member,
      );
      this.patch({
        workspaceMembers: { ...this.state.workspaceMembers, items },
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          rolePendingUserId: null,
          roleError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          rolePendingUserId: null,
          roleError: { userId, error: apiError },
        },
      });
      return false;
    }
  }

  /**
   * E12-F (FR-WS-6): soft removal after an explicit confirmation. `204` is
   * followed by a server refresh; an error keeps the row exactly as it was.
   */
  async removeWorkspaceMember(userId: string): Promise<boolean> {
    const admin = this.state.workspaceMemberAdmin;
    if (admin.removePendingUserId !== null) return false;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;

    this.patch({
      workspaceMemberAdmin: {
        ...admin,
        removePendingUserId: userId,
        removeError: null,
      },
    });

    try {
      await this.api.removeWorkspaceMember(workspaceId, userId);
      if (this.currentWorkspaceId() !== workspaceId) {
        this.patch({
          workspaceMemberAdmin: {
            ...this.state.workspaceMemberAdmin,
            removePendingUserId: null,
            removeError: null,
          },
        });
        return false;
      }
      // Keep the DELETE "pending" until the server list is re-read: a second
      // confirm click must not fire a duplicate delete.
      await this.loadWorkspaceMembers({
        query: this.state.workspaceMembers.query,
        force: true,
      });
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          removePendingUserId: null,
          removeError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        workspaceMemberAdmin: {
          ...this.state.workspaceMemberAdmin,
          removePendingUserId: null,
          removeError: { userId, error: apiError },
        },
      });
      return false;
    }
  }

  /** Drop add/role/remove feedback when the members dialog opens or closes. */
  clearWorkspaceMemberAdmin(): void {
    const admin = this.state.workspaceMemberAdmin;
    if (
      admin.addStatus !== 'idle' ||
      admin.addError !== null ||
      admin.rolePendingUserId !== null ||
      admin.roleError !== null ||
      admin.removePendingUserId !== null ||
      admin.removeError !== null
    ) {
      this.patch({ workspaceMemberAdmin: createEmptyWorkspaceMemberAdminState() });
    }
  }

  clearChatSettings(): void {
    const settings = this.state.chatSettings;
    if (settings.chatId !== null || settings.status !== 'idle' || settings.error !== null) {
      this.patch({ chatSettings: createEmptyChatSettingsState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* #79: channel members                                               */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /chats/{chatId}/members`. One chat at a time is cached; a response
   * for another chat is dropped by the generation guard. Load-more does not
   * exist: the contract returns the complete ACTIVE participant list.
   */
  loadChatMembers(chatId: string, force = false): Promise<void> {
    const current = this.state.chatMembers;
    if (!force && current.chatId === chatId) {
      if (current.status === 'ready') return Promise.resolve();
      if (current.status === 'loading' && this.chatMembersInFlight) {
        return this.chatMembersInFlight;
      }
    }
    const token = ++this.chatMembersToken;
    this.patch({
      chatMembers: { ...createEmptyChatMembersState(), chatId, status: 'loading' },
    });
    const promise = (async () => {
      try {
        const response: ChatMembersResponse = await this.api.listChatMembers(chatId);
        if (token !== this.chatMembersToken || this.state.chatMembers.chatId !== chatId) return;
        this.patch({
          chatMembers: {
            ...this.state.chatMembers,
            items: sortChatMembers(response.members),
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.chatMembersToken || this.state.chatMembers.chatId !== chatId) return;
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          chatMembers: {
            ...this.state.chatMembers,
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.chatMembersToken) this.chatMembersInFlight = null;
      }
    })();
    this.chatMembersInFlight = promise;
    return promise;
  }

  /**
   * `POST /chats/{chatId}/members`. The server response is authoritative (a
   * repeat add keeps the existing role); no row is created before it arrives.
   */
  async addChatMember(chatId: string, userId: string, role: ChatMemberRole): Promise<boolean> {
    if (this.state.chatMembers.addStatus === 'adding') return false;
    const body: AddChatMemberRequest = { user_id: userId, role };
    this.patch({
      chatMembers: {
        ...this.state.chatMembers,
        chatId,
        addStatus: 'adding',
        addError: null,
      },
    });
    try {
      const member = await this.api.addChatMember(chatId, body);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          items: upsertChatMember(this.state.chatMembers.items, member),
          status: 'ready',
          error: null,
          addStatus: 'idle',
          addError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          addStatus: 'error',
          addError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `PATCH /chats/{chatId}/members/{userId}` (OWNER/ADMIN ceiling is server-side). */
  async changeChatMemberRole(
    chatId: string,
    userId: string,
    role: ChatMemberRole,
  ): Promise<boolean> {
    if (this.state.chatMembers.rolePendingUserId !== null) return false;
    const body: ChangeChatMemberRoleRequest = { role };
    this.patch({
      chatMembers: {
        ...this.state.chatMembers,
        chatId,
        rolePendingUserId: userId,
        roleError: null,
      },
    });
    try {
      const member = await this.api.changeChatMemberRole(chatId, userId, body);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          items: upsertChatMember(this.state.chatMembers.items, member),
          status: 'ready',
          error: null,
          rolePendingUserId: null,
          roleError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          rolePendingUserId: null,
          roleError: { userId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /chats/{chatId}/members/{userId}` (soft removal; no row loss on error). */
  async removeChatMember(chatId: string, userId: string): Promise<boolean> {
    if (this.state.chatMembers.removePendingUserId !== null) return false;
    this.patch({
      chatMembers: {
        ...this.state.chatMembers,
        chatId,
        removePendingUserId: userId,
        removeError: null,
      },
    });
    try {
      await this.api.removeChatMember(chatId, userId);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          items: this.state.chatMembers.items.filter((item) => item.user_id !== userId),
          status: 'ready',
          error: null,
          removePendingUserId: null,
          removeError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatMembers.chatId !== chatId) return false;
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          removePendingUserId: null,
          removeError: { userId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /**
   * `POST /chats/{chatId}/leave`. On `204` the channel disappears from the
   * local list immediately (the server removed the ACTIVE participant row);
   * the next chat becomes active. Failures keep the chat and return the error.
   */
  async leaveChat(chatId: string): Promise<boolean> {
    if (this.state.chatMembers.leaveStatus === 'leaving') return false;
    this.patch({
      chatMembers: {
        ...this.state.chatMembers,
        chatId,
        leaveStatus: 'leaving',
        leaveError: null,
      },
    });
    try {
      await this.api.leaveChat(chatId);
      const chats = this.state.chats.filter((chat) => chat.id !== chatId);
      const slices = { ...this.state.slices };
      delete slices[chatId];
      const activeChatId =
        this.state.activeChatId === chatId ? (chats[0]?.id ?? null) : this.state.activeChatId;
      const activeThread =
        this.state.activeThread?.chatId === chatId ? null : this.state.activeThread;
      this.patch({
        chats,
        slices,
        activeChatId,
        activeThread,
        workspaceUnread: this.withActiveWorkspaceUnread(chats),
        chatMembers: createEmptyChatMembersState(),
        chatInvites: createEmptyChatInvitesState(),
        chatPermissions: createEmptyChatPermissionsState(),
        chatPins: createEmptyChatPinsState(),
        chatCover: createEmptyChatCoverState(),
        chatAvatar: createEmptyChatAvatarState(),
        chatArchive: createEmptyChatArchiveState(),
        chatDeletion: createEmptyChatDeletionState(),
      });
      if (activeChatId) {
        void this.loadChat(activeChatId);
        this.updateRealtimeSubscriptions();
      }
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        chatMembers: {
          ...this.state.chatMembers,
          leaveStatus: 'error',
          leaveError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** Drop cached channel rows/feedback when the dialog opens, closes or switches. */
  clearChatMembers(): void {
    this.chatMembersToken += 1;
    this.chatMembersInFlight = null;
    const current = this.state.chatMembers;
    if (
      current.chatId !== null ||
      current.status !== 'idle' ||
      current.items.length > 0 ||
      current.error !== null ||
      current.addStatus !== 'idle' ||
      current.rolePendingUserId !== null ||
      current.roleError !== null ||
      current.removePendingUserId !== null ||
      current.removeError !== null ||
      current.leaveStatus !== 'idle' ||
      current.leaveError !== null
    ) {
      this.patch({ chatMembers: createEmptyChatMembersState() });
    }
  }

  /** #96: drop installed-bot rows when chat settings closes/switches. */
  clearChatBots(): void {
    this.bots.clearChatBots();
  }

  /* ------------------------------------------------------------------ */
  /* #79: invite links                                                  */
  /* ------------------------------------------------------------------ */
  /** `GET /chats/{chatId}/invites` (OWNER/ADMIN metadata list, no tokens). */
  loadChatInvites(chatId: string, force = false): Promise<void> {
    const current = this.state.chatInvites;
    if (!force && current.chatId === chatId) {
      if (current.status === 'ready') return Promise.resolve();
      if (current.status === 'loading' && this.chatInvitesInFlight) {
        return this.chatInvitesInFlight;
      }
    }
    const token = ++this.chatInvitesToken;
    this.patch({
      chatInvites: {
        ...createEmptyChatInvitesState(),
        chatId,
        status: 'loading',
        // The one-time token survives a list refresh until the dialog closes.
        created: current.chatId === chatId ? current.created : null,
      },
    });
    const promise = (async () => {
      try {
        const list = await this.api.listChatInvites(chatId);
        if (token !== this.chatInvitesToken || this.state.chatInvites.chatId !== chatId) return;
        this.patch({
          chatInvites: {
            ...this.state.chatInvites,
            items: list.items,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.chatInvitesToken || this.state.chatInvites.chatId !== chatId) return;
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          chatInvites: {
            ...this.state.chatInvites,
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.chatInvitesToken) this.chatInvitesInFlight = null;
      }
    })();
    this.chatInvitesInFlight = promise;
    return promise;
  }

  /**
   * `POST /chats/{chatId}/invites`. The raw token is returned exactly once and
   * kept in `created` until the dialog closes; it is never put in the list.
   */
  async createChatInvite(chatId: string, body: ChatInviteCreateRequest): Promise<boolean> {
    if (this.state.chatInvites.createStatus === 'creating') return false;
    this.patch({
      chatInvites: {
        ...this.state.chatInvites,
        chatId,
        createStatus: 'creating',
        createError: null,
      },
    });
    try {
      const created = await this.api.createChatInvite(chatId, body);
      if (this.state.chatInvites.chatId !== chatId) return false;
      const invite: ChatInvite = {
        id: created.id,
        role: created.role,
        status: created.status,
        used_count: created.used_count,
        max_uses: created.max_uses,
        expires_at: created.expires_at,
        created_at: created.created_at,
        ...(created.created_by ? { created_by: created.created_by } : {}),
      };
      this.patch({
        chatInvites: {
          ...this.state.chatInvites,
          items: [invite, ...this.state.chatInvites.items.filter((item) => item.id !== invite.id)],
          created,
          createStatus: 'idle',
          createError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatInvites.chatId !== chatId) return false;
      this.patch({
        chatInvites: {
          ...this.state.chatInvites,
          createStatus: 'error',
          createError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /**
   * `DELETE /chats/{chatId}/invites/{inviteId}` (soft revoke, idempotent
   * `204`). The row is marked `REVOKED` only after that success; the raw token
   * of an already created invite is never shown again.
   */
  async revokeChatInvite(chatId: string, inviteId: string): Promise<boolean> {
    if (this.state.chatInvites.revokePendingId !== null) return false;
    this.patch({
      chatInvites: {
        ...this.state.chatInvites,
        chatId,
        revokePendingId: inviteId,
        revokeError: null,
      },
    });
    try {
      await this.api.revokeChatInvite(chatId, inviteId);
      if (this.state.chatInvites.chatId !== chatId) return false;
      this.patch({
        chatInvites: {
          ...this.state.chatInvites,
          items: this.state.chatInvites.items.map((item) =>
            item.id === inviteId ? { ...item, status: 'REVOKED' } : item,
          ),
          revokePendingId: null,
          revokeError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatInvites.chatId !== chatId) return false;
      this.patch({
        chatInvites: {
          ...this.state.chatInvites,
          revokePendingId: null,
          revokeError: { inviteId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatInvites(): void {
    this.chatInvitesToken += 1;
    this.chatInvitesInFlight = null;
    const current = this.state.chatInvites;
    if (
      current.chatId !== null ||
      current.status !== 'idle' ||
      current.items.length > 0 ||
      current.created !== null ||
      current.error !== null ||
      current.createStatus !== 'idle' ||
      current.createError !== null ||
      current.revokePendingId !== null ||
      current.revokeError !== null
    ) {
      this.patch({ chatInvites: createEmptyChatInvitesState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* P0-2 (#80): channel cover                                          */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /files?chat_id=…&kind=IMAGE` (file center). The cover is an existing
   * managed image of this chat; there is no upload endpoint in this flow. Only
   * CLEAN/SKIPPED rows are offered because the server rejects anything else.
   */
  loadChatCoverImages(chatId: string, force = false): Promise<void> {
    const current = this.state.chatCover;
    if (!force && current.chatId === chatId) {
      if (current.imagesStatus === 'ready') return Promise.resolve();
      if (current.imagesStatus === 'loading' && this.chatCoverInFlight) {
        return this.chatCoverInFlight;
      }
    }
    const token = ++this.chatCoverToken;
    this.patch({
      chatCover: {
        ...createEmptyChatCoverState(),
        chatId,
        imagesStatus: 'loading',
        images: current.chatId === chatId ? current.images : [],
        actionStatus: current.chatId === chatId ? current.actionStatus : 'idle',
        actionError: current.chatId === chatId ? current.actionError : null,
      },
    });
    const promise = (async () => {
      try {
        const page = await this.api.listFiles({ chatId, kind: 'IMAGE', limit: 50 });
        if (token !== this.chatCoverToken || this.state.chatCover.chatId !== chatId) return;
        this.patch({
          chatCover: {
            ...this.state.chatCover,
            images: page.items.filter(
              (item) => item.scan_status === 'CLEAN' || item.scan_status === 'SKIPPED',
            ),
            imagesStatus: 'ready',
            imagesError: null,
          },
        });
      } catch (error) {
        if (token !== this.chatCoverToken || this.state.chatCover.chatId !== chatId) return;
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          chatCover: {
            ...this.state.chatCover,
            images: [],
            imagesStatus: 'error',
            imagesError: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.chatCoverToken) this.chatCoverInFlight = null;
      }
    })();
    this.chatCoverInFlight = promise;
    return promise;
  }

  /** `POST /chats/{chatId}/cover`; the returned `Chat` is authoritative. */
  async setChatCover(chatId: string, fileId: string): Promise<boolean> {
    if (this.state.chatCover.actionStatus === 'saving') return false;
    this.patch({
      chatCover: {
        ...this.state.chatCover,
        chatId,
        actionStatus: 'saving',
        actionError: null,
      },
    });
    const body: ChatCoverRequest = { file_id: fileId };
    try {
      const updated = await this.api.setChatCover(chatId, body);
      this.applyChatSummary(updated);
      if (this.state.chatCover.chatId !== chatId) return false;
      this.patch({
        chatCover: {
          ...this.state.chatCover,
          actionStatus: 'saved',
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatCover.chatId !== chatId) return false;
      this.patch({
        chatCover: {
          ...this.state.chatCover,
          actionStatus: 'error',
          actionError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /chats/{chatId}/cover` (idempotent; the attachment stays). */
  async removeChatCover(chatId: string): Promise<boolean> {
    if (this.state.chatCover.actionStatus === 'removing') return false;
    this.patch({
      chatCover: {
        ...this.state.chatCover,
        chatId,
        actionStatus: 'removing',
        actionError: null,
      },
    });
    try {
      await this.api.deleteChatCover(chatId);
      if (this.state.chatCover.chatId !== chatId) return false;
      const chats = this.state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, cover_file_id: null } : chat,
      );
      this.patch({
        chats,
        chatCover: {
          ...this.state.chatCover,
          actionStatus: 'saved',
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatCover.chatId !== chatId) return false;
      this.patch({
        chatCover: {
          ...this.state.chatCover,
          actionStatus: 'error',
          actionError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatCover(): void {
    this.chatCoverToken += 1;
    this.chatCoverInFlight = null;
    const current = this.state.chatCover;
    if (
      current.chatId !== null ||
      current.imagesStatus !== 'idle' ||
      current.images.length > 0 ||
      current.imagesError !== null ||
      current.actionStatus !== 'idle' ||
      current.actionError !== null
    ) {
      this.patch({ chatCover: createEmptyChatCoverState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Channel icon/avatar                                                */
  /* ------------------------------------------------------------------ */

  /** `POST /chats/{chatId}/avatar`; the returned `Chat` is authoritative. */
  async setChatAvatar(chatId: string, fileId: string): Promise<boolean> {
    if (this.state.chatAvatar.actionStatus === 'saving') return false;
    this.patch({
      chatAvatar: {
        ...this.state.chatAvatar,
        chatId,
        actionStatus: 'saving',
        actionError: null,
      },
    });
    const body: ChatAvatarRequest = { file_id: fileId };
    try {
      const updated = await this.api.setChatAvatar(chatId, body);
      this.applyChatSummary(updated);
      // The bytes changed: drop the old object URL and fetch the new one once.
      this.avatars.invalidateChat(chatId);
      if (updated.avatar_file_id) void this.avatars.ensureChat(chatId);
      if (this.state.chatAvatar.chatId !== chatId) return false;
      this.patch({
        chatAvatar: {
          ...this.state.chatAvatar,
          actionStatus: 'saved',
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatAvatar.chatId !== chatId) return false;
      this.patch({
        chatAvatar: {
          ...this.state.chatAvatar,
          actionStatus: 'error',
          actionError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /chats/{chatId}/avatar` (idempotent; the attachment stays). */
  async removeChatAvatar(chatId: string): Promise<boolean> {
    if (this.state.chatAvatar.actionStatus === 'removing') return false;
    this.patch({
      chatAvatar: {
        ...this.state.chatAvatar,
        chatId,
        actionStatus: 'removing',
        actionError: null,
      },
    });
    try {
      await this.api.deleteChatAvatar(chatId);
      if (this.state.chatAvatar.chatId !== chatId) return false;
      const clear = (chat: ChatSummary) =>
        chat.id === chatId ? { ...chat, avatar_file_id: null } : chat;
      this.patch({
        chats: this.state.chats.map(clear),
        archivedChats: {
          ...this.state.archivedChats,
          items: this.state.archivedChats.items.map(clear),
        },
      });
      this.avatars.invalidateChat(chatId);
      this.patch({
        chatAvatar: {
          ...this.state.chatAvatar,
          actionStatus: 'saved',
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatAvatar.chatId !== chatId) return false;
      this.patch({
        chatAvatar: {
          ...this.state.chatAvatar,
          actionStatus: 'error',
          actionError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatAvatar(): void {
    const current = this.state.chatAvatar;
    if (
      current.chatId !== null ||
      current.actionStatus !== 'idle' ||
      current.actionError !== null
    ) {
      this.patch({ chatAvatar: createEmptyChatAvatarState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* P0-2 (#80): rights matrix                                          */
  /* ------------------------------------------------------------------ */

  /** `GET /chats/{chatId}/permissions` (any ACTIVE GROUP participant). */
  loadChatPermissions(chatId: string, force = false): Promise<void> {
    const current = this.state.chatPermissions;
    if (!force && current.chatId === chatId) {
      if (current.status === 'ready') return Promise.resolve();
      if (current.status === 'loading' && this.chatPermissionsInFlight) {
        return this.chatPermissionsInFlight;
      }
    }
    const token = ++this.chatPermissionsToken;
    this.patch({
      chatPermissions: {
        ...createEmptyChatPermissionsState(),
        chatId,
        status: 'loading',
      },
    });
    const promise = (async () => {
      try {
        const matrix = await this.api.getChatPermissions(chatId);
        if (token !== this.chatPermissionsToken || this.state.chatPermissions.chatId !== chatId) {
          return;
        }
        this.patch({
          chatPermissions: {
            ...this.state.chatPermissions,
            matrix,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.chatPermissionsToken || this.state.chatPermissions.chatId !== chatId) {
          return;
        }
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          chatPermissions: {
            ...this.state.chatPermissions,
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.chatPermissionsToken) this.chatPermissionsInFlight = null;
      }
    })();
    this.chatPermissionsInFlight = promise;
    return promise;
  }

  /** `PATCH /chats/{chatId}/permissions`; only changed roles are sent. */
  async saveChatPermissions(chatId: string, patch: ChatPermissionsUpdate): Promise<boolean> {
    if (this.state.chatPermissions.saveStatus === 'saving') return false;
    if (Object.keys(patch).length === 0) {
      this.patch({
        chatPermissions: {
          ...this.state.chatPermissions,
          chatId,
          saveStatus: 'error',
          saveError: ApiError.client(
            'VALIDATION_FAILED',
            'At least one role right is required',
            422,
            { reason: 'empty_patch' },
          ),
        },
      });
      return false;
    }
    this.patch({
      chatPermissions: {
        ...this.state.chatPermissions,
        chatId,
        saveStatus: 'saving',
        saveError: null,
      },
    });
    try {
      const matrix = await this.api.updateChatPermissions(chatId, patch);
      if (this.state.chatPermissions.chatId !== chatId) return false;
      this.patch({
        chatPermissions: {
          ...this.state.chatPermissions,
          matrix,
          status: 'ready',
          error: null,
          saveStatus: 'saved',
          saveError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatPermissions.chatId !== chatId) return false;
      this.patch({
        chatPermissions: {
          ...this.state.chatPermissions,
          saveStatus: 'error',
          saveError: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatPermissions(): void {
    this.chatPermissionsToken += 1;
    this.chatPermissionsInFlight = null;
    const current = this.state.chatPermissions;
    if (
      current.chatId !== null ||
      current.status !== 'idle' ||
      current.matrix !== null ||
      current.error !== null ||
      current.saveStatus !== 'idle' ||
      current.saveError !== null
    ) {
      this.patch({ chatPermissions: createEmptyChatPermissionsState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* P0-2 (#80): pinned messages                                       */
  /* ------------------------------------------------------------------ */

  /** `GET /chats/{chatId}/pins` (metadata only, newest first). */
  loadChatPins(chatId: string, force = false): Promise<void> {
    const current = this.state.chatPins;
    if (!force && current.chatId === chatId) {
      if (current.status === 'ready') return Promise.resolve();
      if (current.status === 'loading' && this.chatPinsInFlight) return this.chatPinsInFlight;
    }
    const token = ++this.chatPinsToken;
    this.patch({
      chatPins: {
        ...createEmptyChatPinsState(),
        chatId,
        status: 'loading',
      },
    });
    const promise = (async () => {
      try {
        const list = await this.api.listChatPins(chatId);
        if (token !== this.chatPinsToken || this.state.chatPins.chatId !== chatId) return;
        this.patch({
          chatPins: {
            ...this.state.chatPins,
            items: list.items,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.chatPinsToken || this.state.chatPins.chatId !== chatId) return;
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          chatPins: {
            ...this.state.chatPins,
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.chatPinsToken) this.chatPinsInFlight = null;
      }
    })();
    this.chatPinsInFlight = promise;
    return promise;
  }

  /** `POST /chats/{chatId}/pins` (`409 CHAT_PIN_LIMIT` is kept honestly). */
  async pinMessage(chatId: string, messageId: string): Promise<boolean> {
    if (this.state.chatPins.pendingMessageId !== null) return false;
    this.patch({
      chatPins: {
        ...this.state.chatPins,
        chatId,
        pendingMessageId: messageId,
        actionError: null,
        limitReached: false,
      },
    });
    try {
      const pin = await this.api.pinChatMessage(chatId, messageId);
      if (this.state.chatPins.chatId !== chatId) return false;
      this.patch({
        chatPins: {
          ...this.state.chatPins,
          items: [
            pin,
            ...this.state.chatPins.items.filter((item) => item.message_id !== messageId),
          ],
          status: 'ready',
          error: null,
          pendingMessageId: null,
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatPins.chatId !== chatId) return false;
      this.patch({
        chatPins: {
          ...this.state.chatPins,
          pendingMessageId: null,
          actionError: { messageId, error: apiError },
          limitReached: apiError.code === 'CHAT_PIN_LIMIT',
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /chats/{chatId}/pins/{messageId}` (idempotent `204`). */
  async unpinMessage(chatId: string, messageId: string): Promise<boolean> {
    if (this.state.chatPins.pendingMessageId !== null) return false;
    this.patch({
      chatPins: {
        ...this.state.chatPins,
        chatId,
        pendingMessageId: messageId,
        actionError: null,
        limitReached: false,
      },
    });
    try {
      await this.api.unpinChatMessage(chatId, messageId);
      if (this.state.chatPins.chatId !== chatId) return false;
      this.patch({
        chatPins: {
          ...this.state.chatPins,
          items: this.state.chatPins.items.filter((item) => item.message_id !== messageId),
          status: 'ready',
          error: null,
          pendingMessageId: null,
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.state.chatPins.chatId !== chatId) return false;
      this.patch({
        chatPins: {
          ...this.state.chatPins,
          pendingMessageId: null,
          actionError: { messageId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatPins(): void {
    this.chatPinsToken += 1;
    this.chatPinsInFlight = null;
    const current = this.state.chatPins;
    if (
      current.chatId !== null ||
      current.status !== 'idle' ||
      current.items.length > 0 ||
      current.error !== null ||
      current.pendingMessageId !== null ||
      current.actionError !== null ||
      current.limitReached
    ) {
      this.patch({ chatPins: createEmptyChatPinsState() });
    }
  }

  /* ------------------------------------------------------------------ */
  /* P0-2 (#80): archive, unarchive and soft delete                     */
  /* ------------------------------------------------------------------ */

  /** `POST /chats/{chatId}/archive` (user-local; DIRECT included). */
  async archiveChat(chatId: string): Promise<boolean> {
    if (this.state.chatArchive.status === 'archiving') return false;
    const workspaceId = this.currentWorkspaceId();
    const previous = this.state.chats.find((chat) => chat.id === chatId) ?? null;
    this.patch({
      chatArchive: { chatId, status: 'archiving', error: null },
      chatDeletion: createEmptyChatDeletionState(),
    });
    try {
      await this.api.archiveChat(chatId);
      if (previous && this.state.archivedChats.status === 'ready') {
        this.patch({
          archivedChats: {
            ...this.state.archivedChats,
            items: [
              { ...previous, archived: true },
              ...this.state.archivedChats.items.filter((chat) => chat.id !== chatId),
            ],
          },
        });
      }
      if (workspaceId) await this.reloadChatsForWorkspace(workspaceId);
      this.patch({
        chatArchive: { chatId, status: 'idle', error: null },
        chatCover: createEmptyChatCoverState(),
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        chatArchive: { chatId, status: 'error', error: apiError },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `POST /chats/{chatId}/unarchive` (user-local, idempotent). */
  async unarchiveChat(chatId: string): Promise<boolean> {
    if (this.state.chatArchive.status === 'unarchiving') return false;
    const workspaceId = this.state.archivedChats.workspaceId ?? this.currentWorkspaceId();
    this.patch({
      chatArchive: { chatId, status: 'unarchiving', error: null },
      archivedChats: {
        ...this.state.archivedChats,
        pendingChatId: chatId,
        actionError: null,
      },
    });
    try {
      await this.api.unarchiveChat(chatId);
      this.patch({
        archivedChats: {
          ...this.state.archivedChats,
          items: this.state.archivedChats.items.filter((chat) => chat.id !== chatId),
          pendingChatId: null,
          actionError: null,
        },
        chatArchive: { chatId, status: 'idle', error: null },
      });
      if (workspaceId) await this.reloadChatsForWorkspace(workspaceId);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        chatArchive: { chatId, status: 'error', error: apiError },
        archivedChats: {
          ...this.state.archivedChats,
          pendingChatId: null,
          actionError: { chatId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `GET /workspaces/{id}/chats?archived=true` (separate from the main list). */
  loadArchivedChats(force = false): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return Promise.resolve();
    const current = this.state.archivedChats;
    if (!force && current.workspaceId === workspaceId) {
      if (current.status === 'ready') return Promise.resolve();
      if (current.status === 'loading' && this.archivedChatsInFlight) {
        return this.archivedChatsInFlight;
      }
    }
    const token = ++this.archivedChatsToken;
    this.patch({
      archivedChats: {
        ...createEmptyArchivedChatsState(),
        workspaceId,
        status: 'loading',
      },
    });
    const promise = (async () => {
      try {
        const list = await this.api.listChats(workspaceId, true);
        if (token !== this.archivedChatsToken) return;
        if (this.currentWorkspaceId() !== workspaceId) return;
        this.patch({
          archivedChats: {
            ...this.state.archivedChats,
            items: list.items,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (token !== this.archivedChatsToken) return;
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          archivedChats: {
            ...this.state.archivedChats,
            items: [],
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        if (token === this.archivedChatsToken) this.archivedChatsInFlight = null;
      }
    })();
    this.archivedChatsInFlight = promise;
    return promise;
  }

  /** `DELETE /chats/{chatId}`: ACTIVE chat OWNER only, soft delete. */
  async deleteOwnChat(chatId: string): Promise<boolean> {
    if (this.state.chatDeletion.status === 'deleting') return false;
    const workspaceId = this.currentWorkspaceId();
    this.patch({
      chatDeletion: { chatId, status: 'deleting', error: null },
      chatArchive: createEmptyChatArchiveState(),
    });
    try {
      await this.api.deleteOwnChat(chatId);
      const chats = this.state.chats.filter((chat) => chat.id !== chatId);
      const slices = { ...this.state.slices };
      delete slices[chatId];
      const activeChatId =
        this.state.activeChatId === chatId ? (chats[0]?.id ?? null) : this.state.activeChatId;
      const activeThread =
        this.state.activeThread?.chatId === chatId ? null : this.state.activeThread;
      this.patch({
        chats,
        slices,
        activeChatId,
        activeThread,
        workspaceUnread: this.withActiveWorkspaceUnread(chats),
        chatMembers: createEmptyChatMembersState(),
        chatInvites: createEmptyChatInvitesState(),
        chatPermissions: createEmptyChatPermissionsState(),
        chatPins: createEmptyChatPinsState(),
        chatCover: createEmptyChatCoverState(),
        chatAvatar: createEmptyChatAvatarState(),
        chatDeletion: { chatId, status: 'idle', error: null },
        archivedChats: {
          ...this.state.archivedChats,
          items: this.state.archivedChats.items.filter((chat) => chat.id !== chatId),
        },
      });
      if (workspaceId) void this.reloadChatsForWorkspace(workspaceId);
      if (activeChatId && this.state.activeChatId === activeChatId) {
        void this.loadChat(activeChatId);
        this.updateRealtimeSubscriptions();
      }
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        chatDeletion: { chatId, status: 'error', error: apiError },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  clearChatArchive(): void {
    const archive = this.state.chatArchive;
    if (archive.chatId !== null || archive.status !== 'idle' || archive.error !== null) {
      this.patch({ chatArchive: createEmptyChatArchiveState() });
    }
    const deletion = this.state.chatDeletion;
    if (deletion.chatId !== null || deletion.status !== 'idle' || deletion.error !== null) {
      this.patch({ chatDeletion: createEmptyChatDeletionState() });
    }
  }

  /**
   * Viewer role in a GROUP chat, derived from the loaded member directory.
   * `null` means "not loaded yet" (the server still enforces everything).
   */
  chatActorRole(chatId: string): ChatMemberRole | null {
    const members = this.state.chatMembers;
    if (members.chatId !== chatId) return null;
    const viewerId = this.viewerId();
    if (!viewerId) return null;
    return members.items.find((member) => member.user_id === viewerId)?.role ?? null;
  }

  /** `pin_messages` right for the viewer (OWNER/ADMIN always allowed). */
  canPinMessages(chatId: string): boolean {
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat || chat.type !== 'GROUP' || chat.security_mode === 'E2EE') return false;
    const role = this.chatActorRole(chatId);
    if (role === null) return false;
    if (isChatManagerRole(role)) return true;
    const matrix =
      this.state.chatPermissions.chatId === chatId ? this.state.chatPermissions.matrix : null;
    return chatPermissionAllowed(matrix, role, 'pin_messages');
  }

  /**
   * Read-only channel: server denies send/poll to every role except OWNER/ADMIN
   * (`403 CHAT_READ_ONLY`). Unknown role keeps the server as the authority.
   */
  canPostInChat(chatId: string): boolean {
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat?.read_only) return true;
    const role = this.chatActorRole(chatId);
    if (role === null) return true;
    return role === 'OWNER' || role === 'ADMIN';
  }

  /** Apply a server-returned full `Chat` to the list and archived rows. */
  private applyChatSummary(updated: Chat): void {
    const patch: Partial<AppState> = {
      chats: this.state.chats.map((chat) =>
        chat.id === updated.id ? chatSummaryFromChat(updated, chat) : chat,
      ),
      archivedChats: {
        ...this.state.archivedChats,
        items: this.state.archivedChats.items.map((chat) =>
          chat.id === updated.id ? chatSummaryFromChat(updated, chat) : chat,
        ),
      },
    };
    this.patch(patch);
  }

  /* ------------------------------------------------------------------ */
  /* #79: self-service blocks                                           */
  /* ------------------------------------------------------------------ */

  /** `GET /me/blocked` (own rows only; no display name/email in the contract). */
  async loadBlockedUsers(force = false): Promise<void> {
    if (!force && this.state.blockedUsers.status === 'ready') return;
    if (this.blockedUsersInFlight) return this.blockedUsersInFlight;
    this.patch({
      blockedUsers: { ...this.state.blockedUsers, status: 'loading', error: null },
    });
    this.blockedUsersInFlight = (async () => {
      try {
        const list = await this.api.listBlockedUsers();
        this.patch({
          blockedUsers: {
            ...this.state.blockedUsers,
            items: list.items,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          blockedUsers: {
            ...this.state.blockedUsers,
            status: 'error',
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        this.blockedUsersInFlight = null;
      }
    })();
    return this.blockedUsersInFlight;
  }

  /** `POST /users/{userId}/block` (idempotent; re-reads the list on success). */
  async blockUser(userId: string): Promise<boolean> {
    if (this.state.blockedUsers.pendingUserId !== null) return false;
    this.patch({
      blockedUsers: {
        ...this.state.blockedUsers,
        pendingUserId: userId,
        actionError: null,
      },
    });
    try {
      await this.api.blockUser(userId);
      this.patch({
        blockedUsers: {
          ...this.state.blockedUsers,
          pendingUserId: null,
          actionError: null,
        },
      });
      // Do not invent `blocked_at`: the server list is the source of truth.
      if (this.state.blockedUsers.status === 'ready') {
        await this.loadBlockedUsers(true);
      }
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        blockedUsers: {
          ...this.state.blockedUsers,
          pendingUserId: null,
          actionError: { userId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /users/{userId}/block` (idempotent; the row disappears on `204`). */
  async unblockUser(userId: string): Promise<boolean> {
    if (this.state.blockedUsers.pendingUserId !== null) return false;
    this.patch({
      blockedUsers: {
        ...this.state.blockedUsers,
        pendingUserId: userId,
        actionError: null,
      },
    });
    try {
      await this.api.unblockUser(userId);
      this.patch({
        blockedUsers: {
          ...this.state.blockedUsers,
          items: this.state.blockedUsers.items.filter((item) => item.user_id !== userId),
          pendingUserId: null,
          actionError: null,
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        blockedUsers: {
          ...this.state.blockedUsers,
          pendingUserId: null,
          actionError: { userId, error: apiError },
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* #79: invite accept route                                           */
  /* ------------------------------------------------------------------ */

  /**
   * `POST /invites/{token}/accept`. The server is idempotent for an existing
   * ACTIVE member (`already_member=true`, no use consumed) and maps expired,
   * revoked and exhausted links to `410` with distinct codes; every outcome is
   * kept in `inviteAccept` so the page can explain it honestly.
   */
  acceptChatInvite(token: string): Promise<boolean> {
    if (this.inviteAcceptInFlight) return this.inviteAcceptInFlight;
    const current = this.state.inviteAccept;
    if (current.status === 'accepted' && current.result !== null && current.token === token) {
      return Promise.resolve(true);
    }
    this.patch({
      inviteAccept: { token, status: 'accepting', result: null, error: null },
    });
    const promise = (async () => {
      try {
        const result = await this.api.acceptChatInvite(token);
        this.patch({
          inviteAccept: { token, status: 'accepted', result, error: null },
        });
        return true;
      } catch (error) {
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          inviteAccept: {
            token,
            status: 'error',
            result: null,
            error: apiError,
          },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
        return false;
      } finally {
        this.inviteAcceptInFlight = null;
      }
    })();
    this.inviteAcceptInFlight = promise;
    return promise;
  }

  /** Reload the active workspace chat list and open the accepted channel. */
  async openInviteTarget(result: InviteAcceptResult): Promise<boolean> {
    if (result.workspace_id !== this.state.activeWorkspaceId) {
      await this.selectWorkspace(result.workspace_id);
    } else {
      await this.reloadChatsForWorkspace(result.workspace_id);
    }
    if (!this.state.slices[result.chat_id]) return false;
    await this.setActiveChat(result.chat_id);
    return true;
  }

  resetInviteAccept(): void {
    if (this.inviteAcceptInFlight) return;
    const current = this.state.inviteAccept;
    if (current.status !== 'idle' || current.token !== null || current.error !== null) {
      this.patch({ inviteAccept: createEmptyInviteAcceptState() });
    }
  }

  /** Merge a fresh chat list without dropping already loaded message slices. */
  private async reloadChatsForWorkspace(workspaceId: string): Promise<void> {
    try {
      const list = await this.api.listChats(workspaceId);
      if (this.currentWorkspaceId() !== workspaceId) return;
      const chats = list.items;
      const slices = { ...this.state.slices };
      for (const chat of chats) {
        slices[chat.id] ??= createEmptySlice(chat.id, chat.unread_count);
      }
      for (const id of Object.keys(slices)) {
        if (!chats.some((chat) => chat.id === id)) delete slices[id];
      }
      const activeChatId =
        this.state.activeChatId !== null &&
        chats.some((chat) => chat.id === this.state.activeChatId)
          ? this.state.activeChatId
          : (chats[0]?.id ?? null);
      this.patch({
        chats,
        slices,
        activeChatId,
        workspaceUnread: this.withActiveWorkspaceUnread(chats),
      });
    } catch (error) {
      this.handleFailure(toApiError(error));
    }
  }

  /**
   * D1-FE5: `PATCH /chats/{chatId}`. The server is the only source of truth:
   * no optimistic chat/header update, and the list is re-read after a `200` so
   * a concurrent rename by another OWNER/ADMIN cannot leave a stale sidebar.
   */
  async saveChatSettings(chatId: string, patch: ChatUpdateRequest): Promise<boolean> {
    if (this.state.chatSettings.status === 'saving') return false;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) {
      this.patch({
        chatSettings: {
          chatId,
          status: 'error',
          error: ApiError.client('WORKSPACE_REQUIRED', 'No active workspace', 409),
        },
      });
      return false;
    }
    const body: ChatUpdateRequest = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.cover_file_id !== undefined) body.cover_file_id = patch.cover_file_id;
    if (patch.read_only !== undefined) body.read_only = patch.read_only;
    if (patch.visibility !== undefined) body.visibility = patch.visibility;
    if (patch.join_policy !== undefined) body.join_policy = patch.join_policy;
    if (patch.rights !== undefined) body.rights = patch.rights;
    if (Object.keys(body).length === 0) {
      this.patch({
        chatSettings: {
          chatId,
          status: 'error',
          error: ApiError.client(
            'VALIDATION_FAILED',
            'At least one chat setting is required',
            422,
            { reason: 'empty_patch' },
          ),
        },
      });
      return false;
    }

    this.patch({ chatSettings: { chatId, status: 'saving', error: null } });
    try {
      const updated = await this.api.updateChat(chatId, body);
      if (this.currentWorkspaceId() !== workspaceId) {
        this.patch({ chatSettings: createEmptyChatSettingsState() });
        return false;
      }
      let chats = this.state.chats.map((chat) =>
        chat.id === chatId ? chatSummaryFromChat(updated, chat) : chat,
      );
      // The response is already authoritative; the extra read is best-effort
      // and keeps `last_message_at`/description consistent with the server.
      try {
        const list = await this.api.listChats(workspaceId);
        if (this.currentWorkspaceId() === workspaceId) {
          chats = list.items.some((chat) => chat.id === chatId)
            ? list.items
            : chats.map((chat) => (chat.id === chatId ? chatSummaryFromChat(updated, chat) : chat));
        }
      } catch {
        // Keep the server-confirmed summary.
      }
      this.patch({
        chats,
        workspaceUnread: this.withActiveWorkspaceUnread(chats),
        chatSettings: { chatId, status: 'saved', error: null },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        chatSettings: { chatId, status: 'error', error: apiError },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** #72: load `/me` once for the profile modal (dev sessions lack bio/email). */
  async loadProfile(force = false): Promise<void> {
    if (!force && this.state.me) return;
    if (this.profileInFlight) return this.profileInFlight;
    this.profileInFlight = (async () => {
      try {
        const me = await this.api.getMe();
        this.patch({ me, user: me.user });
      } catch (error) {
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        if (apiError.status === 401) {
          this.patch({ authExpired: true });
        }
      } finally {
        this.profileInFlight = null;
      }
    })();
    return this.profileInFlight;
  }

  /**
   * #72: partial profile update. Only changed fields are sent; the returned
   * `AuthUser` replaces `me.user`/`user` so every surface reads server state.
   * No local optimistic patch is applied on failure.
   */
  async updateProfile(patch: ProfileUpdate): Promise<ProfileUpdateResult> {
    try {
      const user = await this.api.updateMe(patch);
      this.patch({
        user,
        me: this.state.me ? { ...this.state.me, user } : this.state.me,
      });
      return { user, error: null };
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      return { user: null, error: apiError };
    }
  }

  /** #72: Keycloak sessions of the caller (server owns `current`). */
  async listMySessions(): Promise<ProfileSessionsResult> {
    try {
      const response = await this.api.listMySessions();
      return { sessions: response.sessions, error: null };
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      return { sessions: [], error: apiError };
    }
  }

  /**
   * #72: revoke one own session. `null` means the server returned `204`; the
   * caller re-reads the list instead of removing the row optimistically.
   */
  async revokeMySession(sessionId: string): Promise<ApiError | null> {
    try {
      await this.api.revokeMySession(sessionId);
      return null;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      return apiError;
    }
  }

  /** D1-FE5 profile: one deduped `GET /devices` read (no keys are rendered). */
  async loadDevices(force = false): Promise<void> {
    if (!force && this.state.devices.status === 'ready') return;
    if (this.devicesInFlight) return this.devicesInFlight;
    this.patch({ devices: { ...this.state.devices, status: 'loading', error: null } });
    this.devicesInFlight = (async () => {
      try {
        const list = await this.api.listDevices();
        this.patch({ devices: { items: list.items, status: 'ready', error: null } });
      } catch (error) {
        const apiError = toApiError(error);
        this.handleFailure(apiError);
        this.patch({
          devices: { items: this.state.devices.items, status: 'error', error: apiError },
          authExpired: apiError.status === 401 ? true : this.state.authExpired,
        });
      } finally {
        this.devicesInFlight = null;
      }
    })();
    return this.devicesInFlight;
  }

  async createChat(
    nameOrRequest: string | ChatCreateInput,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (this.state.chatCreateStatus === 'creating') return false;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) {
      this.patch({
        chatCreateStatus: 'error',
        chatCreateError: ApiError.client(
          'WORKSPACE_REQUIRED',
          'No active workspace for chat creation',
          409,
        ),
      });
      return false;
    }
    const request: ChatCreateInput =
      typeof nameOrRequest === 'string' ? { type: 'GROUP', name: nameOrRequest } : nameOrRequest;
    let body: ChatCreateRequest;
    if (request.type === 'GROUP') {
      const trimmed = request.name.trim();
      if (trimmed.length === 0 || trimmed.length > 120) {
        this.patch({
          chatCreateStatus: 'error',
          chatCreateError: ApiError.client(
            'VALIDATION_FAILED',
            'Chat name must be 1..120 characters',
            422,
            { field: 'name', max_length: 120 },
          ),
        });
        return false;
      }
      const visibility: ChatVisibility = request.visibility ?? 'PUBLIC';
      if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE') {
        this.patch({
          chatCreateStatus: 'error',
          chatCreateError: ApiError.client(
            'VALIDATION_FAILED',
            'visibility must be PUBLIC or PRIVATE',
            422,
            { field: 'visibility' },
          ),
        });
        return false;
      }
      // The creator is added as OWNER by the server and must not be listed.
      // Sorting keeps the serialized body stable for the same logical set, so
      // an idempotent retry hashes identically regardless of click order.
      const viewerId = this.viewerId();
      const memberIds = [...new Set(request.memberIds ?? [])]
        .filter((memberId) => memberId !== viewerId)
        .sort();
      if (
        visibility === 'PRIVATE' &&
        (memberIds.length === 0 || memberIds.length > MAX_CHAT_MEMBERS)
      ) {
        this.patch({
          chatCreateStatus: 'error',
          chatCreateError: ApiError.client(
            'VALIDATION_FAILED',
            `member_ids must contain 1..${MAX_CHAT_MEMBERS} selected workspace members`,
            422,
            { field: 'member_ids', min_items: 1, max_items: MAX_CHAT_MEMBERS },
          ),
        });
        return false;
      }
      // Contract `additionalProperties: false`: GROUP sends name/visibility and
      // `member_ids` only for PRIVATE. PUBLIC never lists members.
      body =
        visibility === 'PRIVATE'
          ? { type: 'GROUP', name: trimmed, visibility, member_ids: memberIds }
          : { type: 'GROUP', name: trimmed, visibility };
    } else {
      const peerId = request.peerId.trim();
      if (peerId.length === 0 || peerId === this.viewerId()) {
        this.patch({
          chatCreateStatus: 'error',
          chatCreateError: ApiError.client(
            'VALIDATION_FAILED',
            'peer_id must reference another active workspace member',
            400,
            { field: 'peer_id' },
          ),
        });
        return false;
      }
      // Contract `additionalProperties: false`: DIRECT sends peer_id, no name.
      body = { type: 'DIRECT', peer_id: peerId };
    }

    this.patch({ chatCreateStatus: 'creating', chatCreateError: null });
    try {
      const created = await this.api.createChat(
        workspaceId,
        body,
        idempotencyKey || this.createId(),
      );
      // A workspace switch while the request was in flight must not insert the
      // old workspace's chat into the new workspace UI.
      if (this.currentWorkspaceId() !== workspaceId) {
        this.patch({ chatCreateStatus: 'idle', chatCreateError: null });
        return false;
      }
      let chats = this.state.chats.some((chat) => chat.id === created.id)
        ? this.state.chats.map((chat) => (chat.id === created.id ? toChatSummary(created) : chat))
        : [...this.state.chats, toChatSummary(created)];
      try {
        const list = await this.api.listChats(workspaceId);
        if (this.currentWorkspaceId() === workspaceId) {
          chats = list.items.some((chat) => chat.id === created.id)
            ? list.items
            : [...list.items, toChatSummary(created)];
        }
      } catch {
        // The create succeeded; keep the returned chat if the list refresh
        // failed, so the user still lands in the new chat.
      }
      const slices = { ...this.state.slices };
      for (const chat of chats) {
        slices[chat.id] ??= createEmptySlice(chat.id, chat.unread_count);
      }
      this.patch({
        chats,
        slices,
        workspaceUnread: this.withActiveWorkspaceUnread(chats),
        chatCreateStatus: 'idle',
        chatCreateError: null,
      });
      await this.setActiveChat(created.id);
      void this.loadChatLimits(true);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (this.currentWorkspaceId() !== workspaceId) return false;
      this.patch({
        chatCreateStatus: 'error',
        chatCreateError: apiError,
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      if (apiError.status === 409 && apiError.code === 'CHAT_LIMIT_REACHED') {
        void this.loadChatLimits(true);
      }
      return false;
    }
  }

  clearChatCreateError(): void {
    if (this.state.chatCreateError || this.state.chatCreateStatus === 'error') {
      this.patch({ chatCreateStatus: 'idle', chatCreateError: null });
    }
  }

  /* ------------------------------------------------------------------ */
  /* P0-4 (#82): profile/workspace server rows                         */
  /* ------------------------------------------------------------------ */

  /** #93: device image upload (multipart); the caller applies the file_id. */
  uploadImage(file: File, options: ImageUploadOptions = {}): Promise<MediaImage> {
    return this.api.uploadImage(file, options);
  }

  /**
   * #100 anonymous preview. It is a display-only read and deliberately does
   * not touch store state or trigger a bootstrap, so it can run before login.
   * The token stays in the URL/call stack and is never persisted here.
   */
  async previewWorkspaceInvite(
    token: string,
  ): Promise<{ preview: WorkspaceInvitePreview | null; error: ApiError | null }> {
    try {
      return { preview: await this.api.previewWorkspaceInvite(token), error: null };
    } catch (error) {
      return { preview: null, error: toApiError(error) };
    }
  }

  /**
   * P0-4 (#82): accept a workspace invite link. The server enforces
   * expiry/usage/revocation atomically and answers an existing ACTIVE member
   * idempotently (`already_member=true`, no use consumed). On success `/me`
   * is re-read and the joined workspace is opened.
   */
  async acceptWorkspaceInvite(
    token: string,
  ): Promise<{ acceptance: WorkspaceInviteAcceptance | null; error: ApiError | null }> {
    try {
      const acceptance = await this.api.acceptWorkspaceInvite(token);
      await this.loadProfile(true);
      if (this.state.workspaces.some((workspace) => workspace.id === acceptance.workspace_id)) {
        await this.selectWorkspace(acceptance.workspace_id);
      }
      return { acceptance, error: null };
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      return { acceptance: null, error: apiError };
    }
  }

  /**
   * Replace the workspace list row and the active projection with the server
   * response (PATCH/avatar return `WorkspaceSummary`). The server stays the
   * only source of truth: nothing is patched optimistically.
   */
  applyWorkspaceSummary(workspace: WorkspaceSummary): void {
    const known = this.state.workspaces.some((item) => item.id === workspace.id);
    const workspaces = known
      ? this.state.workspaces.map((item) => (item.id === workspace.id ? workspace : item))
      : [...this.state.workspaces, workspace];
    this.patch({
      workspaces,
      activeWorkspace:
        this.state.activeWorkspaceId === workspace.id ? workspace : this.state.activeWorkspace,
    });
  }

  /**
   * P0-4: `POST /me/avatar` returns `AuthUser`; `DELETE` returns `204`, so
   * `null` only clears `avatar_url` on the already-known profile row.
   */
  applyProfileUser(user: AuthUser | null): void {
    const current = this.state.user;
    const meUser = this.state.me?.user ?? null;
    if (user) {
      this.patch({
        user,
        me: this.state.me ? { ...this.state.me, user } : this.state.me,
      });
      return;
    }
    if (!current && !meUser) return;
    this.patch({
      user: current ? { ...current, avatar_url: null } : current,
      me: this.state.me
        ? { ...this.state.me, user: { ...this.state.me.user, avatar_url: null } }
        : this.state.me,
    });
  }

  /** P0-4: workspace-logo `DELETE` is a `204`; clear the known row's logo id. */
  clearWorkspaceLogo(workspaceId: string): void {
    const workspaces = this.state.workspaces.map((item) =>
      item.id === workspaceId ? { ...item, logo_file_id: null } : item,
    );
    const activeWorkspace =
      this.state.activeWorkspace?.id === workspaceId
        ? { ...this.state.activeWorkspace, logo_file_id: null }
        : this.state.activeWorkspace;
    this.patch({ workspaces, activeWorkspace });
  }

  /* ------------------------------------------------------------------ */
  /* #99: workspace self-leave and OWNER soft delete                     */
  /* ------------------------------------------------------------------ */

  /**
   * `DELETE /workspaces/{id}/members/me`.
   *
   * The server is the only source of truth: on `204` every workspace-scoped
   * row is dropped, the authoritative `/me` list is read again, and the next
   * workspace is activated (or onboarding opens when none is left). A `409
   * LAST_OWNER` / `403` keeps the workspace and is returned to the dialog.
   */
  async leaveWorkspace(workspaceId: string): Promise<boolean> {
    if (this.isWorkspaceLifecycleBusy()) return false;
    if (!this.state.workspaces.some((item) => item.id === workspaceId)) return false;
    this.patch({
      workspaceLifecycle: {
        workspaceId,
        action: 'leave',
        status: 'leaving',
        error: null,
      },
    });
    try {
      await this.api.leaveWorkspace(workspaceId);
      await this.completeWorkspaceRemoval(workspaceId);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        workspaceLifecycle: {
          workspaceId,
          action: 'leave',
          status: 'error',
          error: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** `DELETE /workspaces/{id}` (ACTIVE OWNER only, idempotent soft delete). */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    if (this.isWorkspaceLifecycleBusy()) return false;
    if (!this.state.workspaces.some((item) => item.id === workspaceId)) return false;
    this.patch({
      workspaceLifecycle: {
        workspaceId,
        action: 'delete',
        status: 'deleting',
        error: null,
      },
    });
    try {
      await this.api.deleteWorkspace(workspaceId);
      await this.completeWorkspaceRemoval(workspaceId);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        workspaceLifecycle: {
          workspaceId,
          action: 'delete',
          status: 'error',
          error: apiError,
        },
        authExpired: apiError.status === 401 ? true : this.state.authExpired,
      });
      return false;
    }
  }

  /** Clears the confirm-dialog feedback without touching workspace data. */
  clearWorkspaceLifecycle(): void {
    const current = this.state.workspaceLifecycle;
    if (
      current.workspaceId === null &&
      current.action === null &&
      current.status === 'idle' &&
      current.error === null
    ) {
      return;
    }
    this.patch({ workspaceLifecycle: createEmptyWorkspaceLifecycleState() });
  }

  private isWorkspaceLifecycleBusy(): boolean {
    const status = this.state.workspaceLifecycle.status;
    return status === 'leaving' || status === 'deleting';
  }

  /**
   * Applies a successful leave/delete: drop the workspace row and every
   * workspace-scoped projection, re-read `/me` (the contract removes the row
   * there), then switch to the next workspace or open onboarding.
   *
   * A failed `/me` read never turns a successful `204` into an error: the local
   * list is already consistent, and `/me` is refreshed on the next bootstrap.
   */
  private async completeWorkspaceRemoval(workspaceId: string): Promise<void> {
    // Any chat-list read for the removed workspace is now stale.
    this.workspaceGeneration += 1;
    const wasActive = this.currentWorkspaceId() === workspaceId;
    let workspaces = this.state.workspaces.filter((item) => item.id !== workspaceId);
    let me = this.state.me;

    try {
      const fresh = await this.api.getMe();
      workspaces = fresh.workspaces.filter((item) => item.id !== workspaceId);
      me = {
        ...fresh,
        workspaces,
        default_workspace_id: workspaces.some((item) => item.id === fresh.default_workspace_id)
          ? fresh.default_workspace_id
          : (workspaces[0]?.id ?? null),
      };
    } catch {
      // The mutation itself succeeded; keep the locally filtered, consistent
      // view instead of surfacing a misleading failure.
      if (me) {
        const currentMe = me;
        me = {
          ...currentMe,
          workspaces,
          default_workspace_id: workspaces.some(
            (item) => item.id === currentMe.default_workspace_id,
          )
            ? currentMe.default_workspace_id
            : (workspaces[0]?.id ?? null),
        };
      }
    }

    const workspaceUnread = { ...this.state.workspaceUnread };
    delete workspaceUnread[workspaceId];
    this.unreadWorkspaceRequests.delete(workspaceId);
    this.patch({
      me,
      user: me?.user ?? this.state.user,
      workspaces,
      workspaceUnread,
      workspaceLifecycle: createEmptyWorkspaceLifecycleState(),
    });

    if (!wasActive) return;

    const next = workspaces[0] ?? null;
    if (next) {
      await this.activateWorkspace(next);
      return;
    }
    this.enterWorkspaceOnboarding();
  }

  /**
   * Last-workspace removal: there is no workspace left to activate, so the
   * authenticated shell is replaced by onboarding. Every workspace-bound store
   * is reset and the realtime socket is stopped before the patch, so no stale
   * subscription can call the now-forbidden API.
   */
  private enterWorkspaceOnboarding(): void {
    this.workspaceGeneration += 1;
    this.realtime?.stop();
    this.calls.stop();
    this.notificationEpoch += 1;
    this.mentionEpoch += 1;
    this.chatMembersToken += 1;
    this.chatMembersInFlight = null;
    this.chatInvitesToken += 1;
    this.chatInvitesInFlight = null;
    this.chatPermissionsToken += 1;
    this.chatPermissionsInFlight = null;
    this.chatCoverToken += 1;
    this.chatCoverInFlight = null;
    this.chatPinsToken += 1;
    this.chatPinsInFlight = null;
    this.archivedChatsToken += 1;
    this.archivedChatsInFlight = null;
    this.membersToken += 1;
    this.membersInFlight = null;
    this.membersLoadMoreInFlight = false;
    this.blockedUsersInFlight = null;
    this.inviteAcceptInFlight = null;
    this.devicesInFlight = null;
    this.chatLimitsPromise = null;
    this.unreadWorkspaceRequests.clear();
    this.files.reset();
    this.workspaceOverview.reset();
    this.security.reset();
    this.profile.reset();
    this.avatars.reset();
    this.bots.reset();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.seenEventIds.length = 0;
    this.seenEventIdSet.clear();
    this.gapInFlight.clear();
    clearDeviceWorkspaceId();
    this.patch({
      sessionStatus: 'ready',
      sessionError: null,
      onboardingRequired: true,
      onboardingStatus: 'idle',
      onboardingError: null,
      activeWorkspaceId: null,
      activeWorkspace: null,
      workspaceUnread: {},
      chats: [],
      activeChatId: null,
      slices: {},
      threads: {},
      activeThread: null,
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: null,
      realtimeStatus: 'idle',
      realtimeIssue: null,
      typing: {},
      presence: {},
      call: idleCallState(),
      notifications: createEmptyNotificationsState(),
      notificationPreferences: createEmptyNotificationPreferencesState(),
      messageSearch: createEmptyMessageSearchState(),
      mentions: createEmptyMentionsState(),
      e2ee: { ...this.state.e2ee, chats: {} },
      chatLimits: null,
      chatLimitsStatus: 'idle',
      chatLimitsError: null,
      chatCreateStatus: 'idle',
      chatCreateError: null,
      workspaceMembers: createEmptyWorkspaceMembersState(),
      workspaceMemberAdmin: createEmptyWorkspaceMemberAdminState(),
      chatSettings: createEmptyChatSettingsState(),
      chatMembers: createEmptyChatMembersState(),
      chatInvites: createEmptyChatInvitesState(),
      blockedUsers: createEmptyBlockedUsersState(),
      inviteAccept: createEmptyInviteAcceptState(),
      chatPermissions: createEmptyChatPermissionsState(),
      chatCover: createEmptyChatCoverState(),
      chatAvatar: createEmptyChatAvatarState(),
      chatPins: createEmptyChatPinsState(),
      chatArchive: createEmptyChatArchiveState(),
      chatDeletion: createEmptyChatDeletionState(),
      archivedChats: createEmptyArchivedChatsState(),
    });
    this.e2eeBridge?.invalidateChat();
    // E2EE retries are chat/workspace-scoped; the user no longer has a workspace
    // to resume them in, so drop them instead of retrying against a removed one.
    this.pendingResets.clear();
    this.e2eeResumeInFlight.clear();
    if (this.e2eeDrainTimer !== null) {
      clearTimeout(this.e2eeDrainTimer);
      this.e2eeDrainTimer = null;
    }
    this.e2eeDrainInFlight = null;
  }

  /** First-login onboarding: POST /workspaces then open the created chat. */
  async createWorkspace(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) return false;
    if (this.state.onboardingStatus === 'submitting') return false;

    this.patch({ onboardingStatus: 'submitting', onboardingError: null });
    try {
      let idempotencyKey = getPendingWorkspaceKey();
      if (!idempotencyKey) {
        idempotencyKey = this.createId();
        setPendingWorkspaceKey(idempotencyKey);
      }

      const created = await this.api.createWorkspace(
        { name: trimmed, security_mode: 'MANAGED' },
        idempotencyKey,
      );
      clearPendingWorkspaceKey();

      let me = await this.api.getMe();
      if (!me.workspaces.some((workspace) => workspace.id === created.id)) {
        me = {
          ...me,
          workspaces: [...me.workspaces, created],
          default_workspace_id: created.id,
        };
      }
      this.patch({
        me,
        user: me.user,
        workspaces: me.workspaces,
        onboardingStatus: 'idle',
        onboardingError: null,
      });

      const workspace = me.workspaces.find((item) => item.id === created.id) ?? created;
      await this.activateWorkspace(workspace);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        onboardingStatus: 'error',
        onboardingError: apiError,
        authExpired: apiError.status === 401,
      });
      return false;
    }
  }

  async retryBootstrap(): Promise<void> {
    this.patch({
      sessionStatus: 'idle',
      sessionError: null,
      authExpired: false,
      onboardingError: null,
      onboardingStatus: 'idle',
      activeChatId: null,
      onboardingRequired: false,
    });
    await this.bootstrap();
  }

  /** Drop all user-scoped state on logout or account switch. */
  reset(): void {
    this.workspaceGeneration += 1;
    this.realtime?.stop();
    this.calls.stop();
    this.notificationEpoch += 1;
    this.mentionEpoch += 1;
    this.files.reset();
    this.stickers.reset();
    this.plugins.reset();
    this.pluginActions.reset();
    this.ops.reset();
    this.security.reset();
    this.profile.reset();
    this.avatars.reset();
    this.workspaceOverview.reset();
    this.bots.reset();
    this.rooms.reset();
    this.chatLimitsPromise = null;
    this.unreadWorkspaceRequests.clear();
    this.membersToken += 1;
    this.membersInFlight = null;
    this.membersLoadMoreInFlight = false;
    this.chatMembersToken += 1;
    this.chatMembersInFlight = null;
    this.chatInvitesToken += 1;
    this.chatInvitesInFlight = null;
    this.chatPermissionsToken += 1;
    this.chatPermissionsInFlight = null;
    this.chatCoverToken += 1;
    this.chatCoverInFlight = null;
    this.chatPinsToken += 1;
    this.chatPinsInFlight = null;
    this.archivedChatsToken += 1;
    this.archivedChatsInFlight = null;
    this.blockedUsersInFlight = null;
    this.inviteAcceptInFlight = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.seenEventIds.length = 0;
    this.seenEventIdSet.clear();
    this.gapInFlight.clear();
    this.patch({
      sessionStatus: 'idle',
      session: null,
      sessionError: null,
      user: null,
      me: null,
      device: null,
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspace: null,
      workspaceUnread: {},
      onboardingRequired: false,
      onboardingStatus: 'idle',
      onboardingError: null,
      authExpired: false,
      chats: [],
      activeChatId: null,
      slices: {},
      threads: {},
      activeThread: null,
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: null,
      rateLimitUntil: null,
      realtimeStatus: 'idle',
      realtimeIssue: null,
      typing: {},
      presence: {},
      call: idleCallState(),
      notifications: createEmptyNotificationsState(),
      notificationPreferences: createEmptyNotificationPreferencesState(),
      messageSearch: createEmptyMessageSearchState(),
      mentions: createEmptyMentionsState(),
      e2ee: createE2eeState(this.e2eeEnabled && this.e2eeBridge !== null),
      chatLimits: null,
      chatLimitsStatus: 'idle',
      chatLimitsError: null,
      chatCreateStatus: 'idle',
      chatCreateError: null,
      workspaceMembers: createEmptyWorkspaceMembersState(),
      workspaceMemberAdmin: createEmptyWorkspaceMemberAdminState(),
      chatSettings: createEmptyChatSettingsState(),
      chatMembers: createEmptyChatMembersState(),
      chatInvites: createEmptyChatInvitesState(),
      blockedUsers: createEmptyBlockedUsersState(),
      inviteAccept: createEmptyInviteAcceptState(),
      chatPermissions: createEmptyChatPermissionsState(),
      chatCover: createEmptyChatCoverState(),
      chatAvatar: createEmptyChatAvatarState(),
      chatPins: createEmptyChatPinsState(),
      chatArchive: createEmptyChatArchiveState(),
      chatDeletion: createEmptyChatDeletionState(),
      workspaceLifecycle: createEmptyWorkspaceLifecycleState(),
      archivedChats: createEmptyArchivedChatsState(),
      devices: createEmptyDevicesState(),
    });
    this.devicesInFlight = null;
    this.e2eeBridge?.invalidateChat();
    this.pendingResets.clear();
    this.e2eeResumeInFlight.clear();
    if (this.e2eeDrainTimer !== null) {
      clearTimeout(this.e2eeDrainTimer);
      this.e2eeDrainTimer = null;
    }
    this.e2eeDrainInFlight = null;
  }

  async setActiveChat(chatId: string): Promise<void> {
    if (!this.state.slices[chatId]) return;
    // D1-FE3: a thread belongs to one chat; switching chats closes the panel.
    this.patch({
      activeChatId: chatId,
      ...(this.state.activeThread?.chatId === chatId ? {} : { activeThread: null }),
    });
    this.updateRealtimeSubscriptions();
    const slice = this.state.slices[chatId];
    if (slice && (slice.status === 'idle' || slice.status === 'error')) {
      await this.loadChat(chatId);
      this.updateRealtimeSubscriptions();
      this.startRealtime();
    } else if (this.e2eeBridge !== null) {
      void this.loadPersistedE2eeMarker(chatId)
        .then(() => this.loadE2eeChat(chatId))
        .then(() => this.decryptE2eeSlice(chatId))
        .then(() => this.resumeE2eeRetries(chatId));
    } else {
      void this.loadPersistedE2eeMarker(chatId);
    }
  }

  async loadChat(chatId: string): Promise<void> {
    const slice = this.state.slices[chatId];
    if (!slice || slice.status === 'loading' || slice.status === 'ready') return;

    this.patchSlice(chatId, { status: 'loading', error: null });
    try {
      const page = await this.api.listMessages(chatId, {
        limit: this.config.historyPageSize,
      });
      const current = this.state.slices[chatId];
      if (!current) return;
      // D1-FE3: the main feed is roots only. The server already filters
      // replies; the extra filter keeps replay/REST races out of the channel.
      const roots = page.items.filter((message) => !message.thread_root_id);
      const messages = mergeMessages(current.messages, roots);
      // G4f P1-01: the contract has no `last_read_seq`, but `unread_count` is
      // exactly `last_seq - last_read_seq`. Reconstructing it before the first
      // decrypt lets the reload path prove that a hidden replacement is the
      // only unread row before issuing `POST /read` (no unrelated message is
      // ever marked read).
      const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
      const inferredReadSeq =
        summary === null ? 0 : Math.max(0, summary.last_seq - summary.unread_count);
      this.patchSlice(chatId, {
        status: 'ready',
        messages,
        hasMore: page.page.has_more,
        beforeSeq: minSeq(messages),
        // `ChatSummary.last_seq` includes thread replies, which are not in
        // `messages`; subscribe/ack must start after the true chat tail.
        lastSeq: Math.max(current.lastSeq, maxSeq(messages), this.chatLastSeq(chatId)),
        readSeq: Math.max(current.readSeq, inferredReadSeq),
        error: null,
        loadMoreStatus: 'idle',
        loadMoreError: null,
      });
      this.updateRealtimeSubscriptions();
      void this.loadPersistedE2eeMarker(chatId).then(() => {
        if (this.e2eeBridge !== null) {
          void this.loadE2eeChat(chatId)
            .then(() => this.decryptE2eeSlice(chatId))
            .then(() => this.resumeE2eeRetries(chatId));
        }
      });
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patchSlice(chatId, { status: 'error', error: apiError });
    }
  }

  /**
   * #95: fetch rows newer than the loaded tail without adding an optimistic
   * row. Used after a poll/task create when the live WS frame has not arrived
   * yet; `mergeMessages` dedupes by id, so a later WS copy is a no-op.
   */
  async refreshTail(chatId: string): Promise<void> {
    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready') return;
    try {
      await this.catchUp(chatId, slice.lastSeq);
    } catch {
      // Keep the last known feed. WS/replay or the next history read retries;
      // the created card is simply not focused if it cannot be fetched now.
    }
  }

  async retryHistory(chatId: string): Promise<void> {
    const slice = this.state.slices[chatId];
    if (!slice) return;
    this.patchSlice(chatId, { status: 'idle', error: null });
    await this.loadChat(chatId);
  }

  async loadMore(chatId: string): Promise<void> {
    const slice = this.state.slices[chatId];
    if (
      !slice ||
      slice.status !== 'ready' ||
      !slice.hasMore ||
      slice.loadMoreStatus === 'loading'
    ) {
      return;
    }
    if (slice.beforeSeq === null) {
      this.patchSlice(chatId, { hasMore: false });
      return;
    }

    this.patchSlice(chatId, { loadMoreStatus: 'loading', loadMoreError: null });
    try {
      const page = await this.api.listMessages(chatId, {
        beforeSeq: slice.beforeSeq,
        limit: this.config.historyPageSize,
      });
      const current = this.state.slices[chatId];
      if (!current) return;
      const roots = page.items.filter((message) => !message.thread_root_id);
      const messages = mergeMessages(current.messages, roots);
      this.patchSlice(chatId, {
        messages,
        hasMore: page.page.has_more,
        beforeSeq: minSeq(messages),
        // Older roots never move the live cursor backwards.
        lastSeq: Math.max(current.lastSeq, maxSeq(messages)),
        loadMoreStatus: 'idle',
        loadMoreError: null,
      });
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patchSlice(chatId, {
        loadMoreStatus: 'error',
        loadMoreError: apiError,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* #61–#63: reactions, edit and delete (managed-only metadata)         */
  /* ------------------------------------------------------------------ */

  private reactionKey(messageId: string, emoji: string): string {
    return `${messageId}:${emoji}`;
  }

  /**
   * Finds a message in the main feed or in any cached thread of the chat.
   * Thread replies are never stored in `ChatSlice.messages` (D1-FE3).
   */
  private findMessageLocation(
    chatId: string,
    messageId: string,
  ): { message: ApiMessage; threadRootId: string | null } | null {
    const main = this.state.slices[chatId]?.messages.find((message) => message.id === messageId);
    if (main) return { message: main, threadRootId: null };
    for (const thread of Object.values(this.state.threads)) {
      if (thread.chatId !== chatId) continue;
      const reply = thread.replies.find((message) => message.id === messageId);
      if (reply) return { message: reply, threadRootId: thread.rootId };
    }
    return null;
  }

  /**
   * Applies a pure update to one message wherever it lives. Returning `null`
   * removes the row (delete-for-me). Returns `true` when a row changed.
   */
  private updateMessageInChat(
    chatId: string,
    messageId: string,
    update: (message: ApiMessage) => ApiMessage | null,
  ): boolean {
    let changed = false;
    const slice = this.state.slices[chatId];
    if (slice) {
      const index = slice.messages.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        const next = update(slice.messages[index]!);
        const messages =
          next === null
            ? slice.messages.filter((message) => message.id !== messageId)
            : slice.messages.map((message) => (message.id === messageId ? next : message));
        this.patchSlice(chatId, {
          messages,
          ...(next === null ? { beforeSeq: minSeq(messages) } : {}),
        });
        if (
          next === null &&
          this.state.activeThread?.chatId === chatId &&
          this.state.activeThread.rootId === messageId
        ) {
          this.closeThread();
        }
        changed = true;
      }
    }
    for (const thread of Object.values(this.state.threads)) {
      if (thread.chatId !== chatId) continue;
      const index = thread.replies.findIndex((message) => message.id === messageId);
      if (index < 0) continue;
      const next = update(thread.replies[index]!);
      const replies =
        next === null
          ? thread.replies.filter((message) => message.id !== messageId)
          : thread.replies.map((message) => (message.id === messageId ? next : message));
      this.patchThread(threadKey(chatId, thread.rootId), {
        replies,
        ...(next === null ? { beforeSeq: minSeq(replies) } : {}),
      });
      changed = true;
    }
    return changed;
  }

  /**
   * #95: replace the poll embedded in the timeline message that references it.
   * The message id is not assumed: `poll_id` is the stable link and creation
   * responses also carry `message_id`.
   */
  private applyEmbeddedPoll(chatId: string, poll: Poll): void {
    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready') return;
    const message = slice.messages.find(
      (item) => item.poll_id === poll.id || (poll.message_id ? item.id === poll.message_id : false),
    );
    if (!message) return;
    this.updateMessageInChat(chatId, message.id, (current) =>
      current.type === 'POLL' ? { ...current, poll_id: poll.id, poll } : current,
    );
  }

  /** #95: same in-place replacement for a task; never a second feed row. */
  private applyEmbeddedTask(chatId: string, task: Task): void {
    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready') return;
    const message = slice.messages.find(
      (item) => item.task_id === task.id || (task.message_id ? item.id === task.message_id : false),
    );
    if (!message) return;
    this.updateMessageInChat(chatId, message.id, (current) =>
      current.type === 'TASK' ? { ...current, task_id: task.id, task } : current,
    );
  }

  /** Merges an authoritative server message (edit result or `message.updated`). */
  private mergeServerMessage(chatId: string, message: ApiMessage): void {
    if (message.chat_id !== chatId) return;
    const normalized: ApiMessage = { ...message, reactions: message.reactions ?? [] };
    if (this.updateMessageInChat(chatId, normalized.id, () => normalized)) return;
    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready' || normalized.thread_root_id) return;
    const messages = mergeMessages(slice.messages, [normalized]);
    this.patchSlice(chatId, { messages, beforeSeq: minSeq(messages) });
  }

  /** Removes the decrypted view together with a tombstone/removal. */
  private dropE2eeView(chatId: string, messageId: string): void {
    const slice = this.state.slices[chatId];
    if (!slice || !(messageId in slice.e2ee)) return;
    const e2ee = { ...slice.e2ee };
    delete e2ee[messageId];
    this.patchSlice(chatId, { e2ee });
  }

  private setActionError(chatId: string, value: MessageActionError): void {
    this.patchSlice(chatId, { actionError: value });
  }

  private clearActionErrorFor(chatId: string, messageId: string): void {
    const current = this.state.slices[chatId]?.actionError ?? null;
    if (current !== null && current.messageId === messageId) {
      this.patchSlice(chatId, { actionError: null });
    }
  }

  clearMessageActionError(chatId: string): void {
    if (this.state.slices[chatId]?.actionError) this.patchSlice(chatId, { actionError: null });
  }

  /** Applies one aggregate row to `message.reactions` (idempotent by emoji). */
  private applyReactionState(
    chatId: string,
    messageId: string,
    emoji: string,
    next: { count: number; me: boolean },
  ): void {
    this.updateMessageInChat(chatId, messageId, (message) => {
      if (message.deleted_at) return message;
      const reactions = [...(message.reactions ?? [])];
      const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
      const count = Math.max(0, Math.trunc(next.count));
      if (count === 0) {
        if (index < 0) return message;
        reactions.splice(index, 1);
      } else if (index >= 0) {
        reactions[index] = { emoji, count, me: next.me };
      } else {
        reactions.push({ emoji, count, me: next.me });
      }
      return { ...message, reactions };
    });
  }

  private reactionGuard(chatId: string, message: ApiMessage): ApiError | null {
    // Managed-only metadata: an E2EE chat must never send emoji/user_id.
    if (this.isE2eeChat(chatId)) {
      return ApiError.client(
        'E2EE_METADATA_FORBIDDEN',
        'Reactions are not available in an E2EE chat',
        422,
      );
    }
    if (message.deleted_at) {
      return ApiError.client('NOT_FOUND', 'Message is deleted', 404);
    }
    if (message.type === 'SYSTEM') {
      return ApiError.client(
        'MESSAGE_NOT_EDITABLE',
        'System messages do not accept reactions',
        422,
      );
    }
    return null;
  }

  /** Idempotent add; optimistically shows `me`/`count` and rolls back on error. */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
    return this.mutateReaction(chatId, messageId, emoji, 'add');
  }

  /** Idempotent remove — only the viewer's own reaction is removed server-side. */
  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
    return this.mutateReaction(chatId, messageId, emoji, 'remove');
  }

  async toggleReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
    const found = this.findMessageLocation(chatId, messageId);
    if (!found) return false;
    const mine = (found.message.reactions ?? []).some(
      (reaction) => reaction.emoji === emoji && reaction.me,
    );
    return mine
      ? this.removeReaction(chatId, messageId, emoji)
      : this.addReaction(chatId, messageId, emoji);
  }

  private async mutateReaction(
    chatId: string,
    messageId: string,
    emoji: string,
    mode: 'add' | 'remove',
  ): Promise<boolean> {
    const slice = this.state.slices[chatId];
    if (!slice) return false;
    const found = this.findMessageLocation(chatId, messageId);
    if (!found) return false;

    if (!isReactionEmoji(emoji)) {
      this.setActionError(chatId, {
        kind: 'reaction',
        messageId,
        emoji,
        error: ApiError.client('VALIDATION_FAILED', 'Invalid reaction emoji', 422),
      });
      return false;
    }

    const guard = this.reactionGuard(chatId, found.message);
    if (guard !== null) {
      this.setActionError(chatId, { kind: 'reaction', messageId, emoji, error: guard });
      return false;
    }

    const key = this.reactionKey(messageId, emoji);
    if (slice.pendingReactions.includes(key)) return false;

    const current = (found.message.reactions ?? []).find((reaction) => reaction.emoji === emoji);
    this.clearActionErrorFor(chatId, messageId);
    this.patchSlice(chatId, {
      pendingReactions: [...(this.state.slices[chatId]?.pendingReactions ?? []), key],
    });

    // Only the viewer's own row is optimistic: another user's reaction is
    // never guessed. A repeated add/remove is idempotent server-side.
    const optimistic: ReactionSummary | null =
      mode === 'add'
        ? current?.me
          ? null
          : { emoji, count: (current?.count ?? 0) + 1, me: true }
        : current?.me
          ? { emoji, count: Math.max(0, (current?.count ?? 1) - 1), me: false }
          : null;
    if (optimistic) this.applyReactionState(chatId, messageId, emoji, optimistic);

    try {
      if (mode === 'add') {
        const summary = await this.api.addReaction(chatId, messageId, emoji);
        const latest = this.findMessageLocation(chatId, messageId)?.message.reactions?.find(
          (reaction) => reaction.emoji === emoji,
        );
        // The server aggregate wins, but a concurrent WS increment must not be
        // rolled back by a response that was committed a moment earlier.
        this.applyReactionState(chatId, messageId, emoji, {
          count: Math.max(summary.count, latest?.count ?? 0),
          me: true,
        });
      } else {
        await this.api.removeReaction(chatId, messageId, emoji);
      }
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      if (optimistic) {
        this.applyReactionState(
          chatId,
          messageId,
          emoji,
          current ? { count: current.count, me: current.me } : { count: 0, me: false },
        );
      }
      this.setActionError(chatId, { kind: 'reaction', messageId, emoji, error: apiError });
      return false;
    } finally {
      const after = this.state.slices[chatId];
      if (after) {
        this.patchSlice(chatId, {
          pendingReactions: after.pendingReactions.filter((pending) => pending !== key),
        });
      }
    }
  }

  /**
   * #62: edit own managed TEXT. The optional `version` is the optimistic lock;
   * `409 VERSION_CONFLICT` keeps the draft in the dialog, re-reads the row and
   * reports the conflict instead of overwriting someone else's edit.
   */
  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    version: number | null = null,
  ): Promise<boolean> {
    const slice = this.state.slices[chatId];
    if (!slice) return false;
    const found = this.findMessageLocation(chatId, messageId);
    if (!found) return false;
    const message = found.message;

    const fail = (error: ApiError): false => {
      this.setActionError(chatId, { kind: 'edit', messageId, error });
      return false;
    };

    if (this.isE2eeChat(chatId)) {
      return fail(
        ApiError.client('E2EE_METADATA_FORBIDDEN', 'Editing is not available in an E2EE chat', 422),
      );
    }
    if (message.deleted_at) return fail(ApiError.client('NOT_FOUND', 'Message is deleted', 404));
    if (message.type !== 'TEXT') {
      return fail(ApiError.client('MESSAGE_NOT_EDITABLE', 'Only TEXT messages can be edited', 422));
    }
    if (message.sender_id !== this.viewerId()) {
      return fail(ApiError.client('FORBIDDEN', 'Only the author can edit this message', 403));
    }

    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_TEXT_LENGTH) {
      return fail(
        ApiError.client('VALIDATION_FAILED', 'Message text must be 1..8000 characters', 422),
      );
    }
    if (slice.pendingMessageIds.includes(messageId)) return false;

    this.clearActionErrorFor(chatId, messageId);
    this.patchSlice(chatId, {
      pendingMessageIds: [...(this.state.slices[chatId]?.pendingMessageIds ?? []), messageId],
    });
    try {
      const body: MessageEdit = { text: trimmed, ...(version !== null ? { version } : {}) };
      const updated = await this.api.editMessage(chatId, messageId, body);
      this.mergeServerMessage(chatId, updated);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      // The row is stale: fetch the current server copy so the next save (and
      // the visible text after closing the dialog) is based on reality.
      if (apiError.status === 409) {
        await this.refreshMessageFromServer(chatId, messageId, found.threadRootId);
      }
      return fail(apiError);
    } finally {
      const after = this.state.slices[chatId];
      if (after) {
        this.patchSlice(chatId, {
          pendingMessageIds: after.pendingMessageIds.filter((id) => id !== messageId),
        });
      }
    }
  }

  /** Re-reads one message page after a 409; failures are intentionally silent. */
  private async refreshMessageFromServer(
    chatId: string,
    messageId: string,
    threadRootId: string | null,
  ): Promise<void> {
    try {
      const page = await this.api.listMessages(chatId, {
        limit: this.config.historyPageSize,
        ...(threadRootId ? { threadRootId } : {}),
      });
      const fresh = page.items.find((message) => message.id === messageId);
      if (fresh) this.mergeServerMessage(chatId, fresh);
    } catch {
      // The action error already explains the conflict; a refresh failure must
      // not replace it or escalate into a global chat error.
    }
  }

  /**
   * #63: `scope=me` hides locally only after the server confirms the per-user
   * marker; `scope=all` is never optimistic and is author-only (403 otherwise).
   * A confirmed delete-for-all becomes a tombstone with all content cleared.
   */
  async deleteMessage(
    chatId: string,
    messageId: string,
    scope: MessageDeleteScope,
  ): Promise<boolean> {
    const slice = this.state.slices[chatId];
    if (!slice) return false;
    const found = this.findMessageLocation(chatId, messageId);
    if (!found) return false;
    const message = found.message;

    if (scope === 'all' && message.sender_id !== this.viewerId()) {
      this.setActionError(chatId, {
        kind: 'delete',
        messageId,
        error: ApiError.client('FORBIDDEN', 'Only the author can delete for everyone', 403),
      });
      return false;
    }
    if (slice.pendingMessageIds.includes(messageId)) return false;

    this.clearActionErrorFor(chatId, messageId);
    this.patchSlice(chatId, {
      pendingMessageIds: [...(this.state.slices[chatId]?.pendingMessageIds ?? []), messageId],
    });
    try {
      await this.api.deleteMessage(chatId, messageId, scope);
      if (scope === 'me') {
        this.updateMessageInChat(chatId, messageId, () => null);
        this.dropE2eeView(chatId, messageId);
      } else {
        this.applyTombstone(chatId, messageId, new Date().toISOString());
      }
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.setActionError(chatId, { kind: 'delete', messageId, error: apiError });
      return false;
    } finally {
      const after = this.state.slices[chatId];
      if (after) {
        this.patchSlice(chatId, {
          pendingMessageIds: after.pendingMessageIds.filter((id) => id !== messageId),
        });
      }
    }
  }

  private applyTombstone(chatId: string, messageId: string, deletedAt: string): void {
    this.updateMessageInChat(chatId, messageId, (message) => ({
      ...message,
      text: null,
      deleted_at: deletedAt,
      reactions: [],
      attachments: [],
      // The generated schema intersects StickerRef with `null`; `undefined`
      // clears the old object without inventing a contract field.
      sticker: undefined,
      sticker_id: null,
      crypto: null,
    }));
    this.dropE2eeView(chatId, messageId);
  }

  /* ------------------------------------------------------------------ */
  /* D1-FE3: flat threads (managed only)                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Threads are a managed-only feature: E2EE replies would require plaintext
   * metadata the server must never see. The UI renders an honest disabled
   * affordance instead of opening a panel.
   */
  threadsAvailable(chatId: string): boolean {
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat || chat.security_mode === 'E2EE') return false;
    return !this.isE2eeChat(chatId);
  }

  /**
   * Opens the thread panel and loads its first page. The root stays in the
   * main feed; replies are stored only in the thread slice, so opening the
   * panel never duplicates a row in the channel.
   */
  async openThread(chatId: string, rootId: string): Promise<boolean> {
    if (!this.threadsAvailable(chatId)) return false;
    const slice = this.state.slices[chatId];
    if (!slice) return false;
    const root = slice.messages.find((message) => message.id === rootId);
    // Depth is one: a reply can never be a thread root (contract 422).
    if (root?.thread_root_id) return false;

    const key = threadKey(chatId, rootId);
    if (!this.state.threads[key]) {
      this.patch({
        threads: {
          ...this.state.threads,
          [key]: createEmptyThreadSlice(chatId, rootId),
        },
      });
    }
    if (this.state.activeThread?.chatId === chatId && this.state.activeThread.rootId === rootId) {
      return true;
    }
    this.patch({ activeThread: { chatId, rootId } });
    await this.loadThread(chatId, rootId);
    return true;
  }

  closeThread(): void {
    if (this.state.activeThread === null) return;
    this.patch({ activeThread: null });
  }

  /** Loads (or retries) the newest page of thread replies. */
  async loadThread(chatId: string, rootId: string, force = false): Promise<void> {
    if (!this.threadsAvailable(chatId)) return;
    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key];
    if (!thread) return;
    if (!force && (thread.status === 'loading' || thread.status === 'ready')) return;

    this.patchThread(key, { status: 'loading', error: null, unavailable: null });
    try {
      const page = await this.api.listMessages(chatId, {
        threadRootId: rootId,
        limit: this.config.historyPageSize,
      });
      const current = this.state.threads[key];
      if (!current) return;
      const replies = mergeMessages(
        [],
        page.items.filter((message) => message.thread_root_id === rootId),
      );
      this.patchThread(key, {
        status: 'ready',
        replies,
        hasMore: page.page.has_more,
        beforeSeq: minSeq(replies),
        lastSeq: maxSeq(replies),
        error: null,
        unavailable: null,
        loadMoreStatus: 'idle',
        loadMoreError: null,
      });
      // Defence in depth: if a replay ever merged a reply into the channel,
      // remove it now that the server confirmed it belongs to this thread.
      this.removeRepliesFromMain(chatId, replies);
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      const unavailable = threadUnavailableFromError(apiError);
      this.patchThread(key, {
        status: 'error',
        error: apiError,
        unavailable,
      });
    }
  }

  async retryThread(chatId: string, rootId: string): Promise<void> {
    const thread = this.threadFor(chatId, rootId);
    if (!thread) return;
    this.patchThread(threadKey(chatId, rootId), {
      status: 'idle',
      error: null,
      unavailable: null,
    });
    await this.loadThread(chatId, rootId, true);
  }

  /** Older replies are prepended; the server pages by `before_seq`. */
  async loadMoreThread(chatId: string, rootId: string): Promise<void> {
    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key];
    if (
      !thread ||
      thread.status !== 'ready' ||
      !thread.hasMore ||
      thread.loadMoreStatus === 'loading'
    ) {
      return;
    }
    if (thread.beforeSeq === null) {
      this.patchThread(key, { hasMore: false });
      return;
    }

    this.patchThread(key, { loadMoreStatus: 'loading', loadMoreError: null });
    try {
      const page = await this.api.listMessages(chatId, {
        threadRootId: rootId,
        beforeSeq: thread.beforeSeq,
        limit: this.config.historyPageSize,
      });
      const current = this.state.threads[key];
      if (!current) return;
      const replies = mergeMessages(
        current.replies,
        page.items.filter((message) => message.thread_root_id === rootId),
      );
      this.patchThread(key, {
        replies,
        hasMore: page.page.has_more,
        beforeSeq: minSeq(replies),
        lastSeq: Math.max(current.lastSeq, maxSeq(replies)),
        loadMoreStatus: 'idle',
        loadMoreError: null,
      });
      this.removeRepliesFromMain(chatId, replies);
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patchThread(key, {
        loadMoreStatus: 'error',
        loadMoreError: apiError,
      });
    }
  }

  /**
   * Sends a reply through the same optimistic outbox/idempotency pipeline as a
   * channel message. The row is rendered in the thread panel only; the server
   * assigns `seq`/`id` (no invented server fields).
   */
  async sendThreadReply(
    chatId: string,
    rootId: string,
    text: string,
    mentionPayload: { mentions: readonly string[]; mention_all: boolean } | null = null,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TEXT_LENGTH) return false;
    if (!this.threadsAvailable(chatId)) return false;
    if (!this.state.online || this.isRateLimited()) return false;
    // Threads are managed-only; a temporarily unready E2EE device state must
    // not block a managed chat's thread composer.

    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key];
    if (!thread || thread.status !== 'ready' || thread.unavailable !== null) return false;

    const root = this.state.slices[chatId]?.messages.find((message) => message.id === rootId);
    if (root?.deleted_at) {
      this.patchThread(key, { unavailable: 'deleted' });
      return false;
    }

    const outgoing: OutgoingMessage = {
      clientMessageId: this.createId(),
      idempotencyKey: this.createId(),
      kind: 'TEXT',
      text: trimmed,
      sticker: null,
      replyToId: null,
      attachments: [],
      ...(mentionPayload && mentionPayload.mentions.length > 0
        ? { mentions: [...mentionPayload.mentions] }
        : {}),
      ...(mentionPayload?.mention_all ? { mentionAll: true } : {}),
      createdAt: this.now(),
      status: 'sending',
      error: null,
      attempts: 0,
      threadRootId: rootId,
    };

    this.patchThread(key, { outbox: [...thread.outbox, outgoing] });
    await this.attemptSend(chatId, outgoing.clientMessageId, rootId);
    return true;
  }

  async retryThreadReply(chatId: string, rootId: string, clientMessageId: string): Promise<void> {
    const thread = this.threadFor(chatId, rootId);
    const item = thread?.outbox.find((entry) => entry.clientMessageId === clientMessageId);
    if (!thread || !item || item.status !== 'failed') return;
    this.clearTimer(this.timerKey(chatId, clientMessageId));
    this.patchThreadOutgoing(chatId, rootId, clientMessageId, {
      status: 'sending',
      error: null,
    });
    await this.attemptSend(chatId, clientMessageId, rootId);
  }

  /** Removes a failed reply row and returns it so the draft can be restored. */
  discardThreadReply(
    chatId: string,
    rootId: string,
    clientMessageId: string,
  ): OutgoingMessage | null {
    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key];
    const item = thread?.outbox.find((entry) => entry.clientMessageId === clientMessageId);
    if (!thread || !item) return null;
    this.clearTimer(this.timerKey(chatId, clientMessageId));
    this.patchThread(key, {
      outbox: thread.outbox.filter((entry) => entry.clientMessageId !== clientMessageId),
    });
    return item;
  }

  /** Copies the server summary of a root into the cached channel row. */
  private bumpRootSummary(chatId: string, rootId: string, reply: ApiMessage): void {
    const slice = this.state.slices[chatId];
    if (!slice) return;
    // `ChatSummary.last_seq` also covers replies and is advanced by `/sync` and
    // by every applied event. If it already includes this seq, the row is a
    // replay/late delivery and the server summary already contains it: adding
    // one more would double count after reload. Live replies are always ahead.
    if (reply.seq <= this.chatLastSeq(chatId)) return;
    let changed = false;
    const messages = slice.messages.map((message) => {
      if (message.id !== rootId) return message;
      const previous = message.thread_summary ?? null;
      // A replay/out-of-order delivery must not decrease the counter.
      if (
        previous?.last_reply_at &&
        Date.parse(reply.created_at) < Date.parse(previous.last_reply_at)
      ) {
        return message;
      }
      const summary: ThreadSummary = {
        reply_count: (previous?.reply_count ?? 0) + 1,
        last_reply_at: reply.created_at,
        last_reply_author_id: reply.sender_id ?? null,
        last_reply_excerpt: threadExcerpt(reply),
      };
      changed = true;
      return { ...message, thread_summary: summary };
    });
    if (changed) this.patchSlice(chatId, { messages });
  }

  private removeRepliesFromMain(chatId: string, replies: readonly ApiMessage[]): void {
    if (replies.length === 0) return;
    const slice = this.state.slices[chatId];
    if (!slice) return;
    const replyIds = new Set(replies.map((reply) => reply.id));
    if (!slice.messages.some((message) => replyIds.has(message.id))) return;
    const messages = slice.messages.filter((message) => !replyIds.has(message.id));
    this.patchSlice(chatId, { messages, beforeSeq: minSeq(messages) });
  }

  private patchThreadOutgoing(
    chatId: string,
    rootId: string,
    clientMessageId: string,
    patch: Partial<OutgoingMessage>,
  ): void {
    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key];
    if (!thread) return;
    this.patchThread(key, {
      outbox: thread.outbox.map((entry) =>
        entry.clientMessageId === clientMessageId ? { ...entry, ...patch } : entry,
      ),
    });
  }

  /** Finds an outgoing row in the channel or in any cached thread of the chat. */
  private findOutgoing(
    chatId: string,
    clientMessageId: string,
  ): { item: OutgoingMessage; threadRootId: string | null } | null {
    const main = this.state.slices[chatId]?.outbox.find(
      (entry) => entry.clientMessageId === clientMessageId,
    );
    if (main) return { item: main, threadRootId: null };
    for (const thread of Object.values(this.state.threads)) {
      if (thread.chatId !== chatId) continue;
      const item = thread.outbox.find((entry) => entry.clientMessageId === clientMessageId);
      if (item) return { item, threadRootId: thread.rootId };
    }
    return null;
  }

  async send(
    chatId: string,
    text: string,
    replyToId: string | null = null,
    attachments: readonly ApiAttachment[] = [],
    mentionPayload: { mentions: readonly string[]; mention_all: boolean } | null = null,
  ): Promise<void> {
    const trimmed = text.trim();
    const readyAttachments = attachments.slice(0, 10);
    if (trimmed.length > MAX_TEXT_LENGTH) return;
    // E4: text is optional when at least one ready attachment is present.
    if (!trimmed && readyAttachments.length === 0) return;

    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready') return;

    const block = this.e2eeBlockReason(chatId);
    if (block !== null) {
      this.patchE2eeChat(chatId, { error: block });
      return;
    }
    if (this.state.e2ee.enabled && this.e2eeChatState(chatId).securityMode === 'E2EE') {
      if (readyAttachments.length > 0) {
        this.patchE2eeChat(chatId, { error: 'unsupported' });
        return;
      }
      await this.sendE2eeText(chatId, trimmed, replyToId);
      return;
    }

    const outgoing: OutgoingMessage = {
      clientMessageId: this.createId(),
      idempotencyKey: this.createId(),
      kind: 'TEXT',
      text: trimmed,
      sticker: null,
      replyToId,
      attachments: readyAttachments.map((attachment) => ({ ...attachment })),
      // E2EE rejects plaintext mention fields; that branch returned above.
      ...(mentionPayload && mentionPayload.mentions.length > 0
        ? { mentions: [...mentionPayload.mentions] }
        : {}),
      ...(mentionPayload?.mention_all ? { mentionAll: true } : {}),
      createdAt: this.now(),
      status: 'sending',
      error: null,
      attempts: 0,
    };

    this.patchSlice(chatId, { outbox: [...slice.outbox, outgoing] });
    await this.attemptSend(chatId, outgoing.clientMessageId);
  }

  /**
   * E5: send exactly one built-in sticker. The optimistic row renders the
   * image immediately; the REST response is merged by id/seq. Recent is
   * recorded locally (never server-side) on selection.
   */
  async sendSticker(
    chatId: string,
    sticker: StickerRef,
    replyToId: string | null = null,
  ): Promise<boolean> {
    const slice = this.state.slices[chatId];
    if (!slice || slice.status !== 'ready') return false;
    if (!this.state.online || this.isRateLimited()) return false;
    if (this.state.e2ee.enabled) {
      const block = this.e2eeBlockReason(chatId);
      const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
      if (block !== null && (chat?.security_mode === 'E2EE' || block !== 'not_ready')) {
        return false;
      }
      if (this.e2eeChatState(chatId).securityMode === 'E2EE') return false;
    }

    const outgoing: OutgoingMessage = {
      clientMessageId: this.createId(),
      idempotencyKey: this.createId(),
      kind: 'STICKER',
      text: '',
      sticker: { ...sticker },
      replyToId,
      attachments: [],
      createdAt: this.now(),
      status: 'sending',
      error: null,
      attempts: 0,
    };

    this.stickers.recordRecent(sticker);
    this.patchSlice(chatId, { outbox: [...slice.outbox, outgoing] });
    await this.attemptSend(chatId, outgoing.clientMessageId);
    return true;
  }

  private isRateLimited(): boolean {
    return this.state.rateLimitUntil !== null && this.state.rateLimitUntil > this.now();
  }

  /* ----------------------------------------------------------------------- */
  /* E7-F5: E2EE wire-up                                                      */
  /* ----------------------------------------------------------------------- */

  private patchE2ee(patch: Partial<E2eeState>): void {
    this.patch({ e2ee: { ...this.state.e2ee, ...patch } });
  }

  private e2eeChatState(chatId: string): E2eeChatState {
    return this.state.e2ee.chats[chatId] ?? createIdleE2eeChatState(chatId);
  }

  private patchE2eeChat(chatId: string, patch: Partial<E2eeChatState>): void {
    const current = this.e2eeChatState(chatId);
    this.patchE2ee({
      chats: { ...this.state.e2ee.chats, [chatId]: { ...current, ...patch } },
    });
  }

  /**
   * E7-F5G P2-33: the chat is E2EE if the server says so, a sealed local mode
   * pin says so, a downgrade was detected, or history already contains crypto
   * envelopes. The last two survive a server switch to MANAGED.
   */
  isE2eeChat(chatId: string): boolean {
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    const state = this.state.e2ee.chats[chatId] ?? null;
    const slice = this.state.slices[chatId] ?? null;
    if (chat?.security_mode === 'E2EE') return true;
    if (state?.securityMode === 'E2EE') return true;
    if (state?.modeAction === 'block_security_alert') return true;
    return (
      slice?.messages.some((message) => message.crypto !== undefined && message.crypto !== null) ??
      false
    );
  }

  /** Why E2EE refuses to send; `null` means the managed/E2EE path may proceed. */
  e2eeBlockReason(chatId: string): E2eeBlockReason | null {
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    const state = this.state.e2ee.chats[chatId] ?? null;
    if (!this.state.e2ee.enabled || this.e2eeBridge === null) {
      return this.isE2eeChat(chatId) ? 'flag_disabled' : null;
    }
    if (chat?.security_mode === 'E2EE' && state?.status !== 'ready') return 'not_ready';
    if (!state || state.status === 'idle' || state.status === 'loading') return 'not_ready';
    if (state.status === 'error') return 'not_ready';
    if (state.modeAction === 'block_security_alert') return 'mode_alert';
    if (state.modeAction === 'confirm_mode_required') return 'mode_confirm_required';
    if (state.keyChanges.length > 0) return 'key_change';
    if (state.securityMode === 'E2EE' && state.peerDeviceIds.length === 0) {
      return 'no_peer_devices';
    }
    return null;
  }

  /**
   * Reads the local sealed chat-mode pin even when the feature flag is off
   * (E7-F5G P2-33). A server that downgrades an E2EE chat to MANAGED must not
   * turn old plaintext into a rendering/sending path. The pin is read-only
   * metadata; missing storage/identity means "no marker", never a crash.
   */
  private async loadPersistedE2eeMarker(chatId: string): Promise<void> {
    if (this.e2eeChatState(chatId).securityMode === 'E2EE') return;
    try {
      const pin = await readChatModePin(getE2eeStorage(), chatId);
      if (pin?.mode === 'E2EE') {
        this.patchE2eeChat(chatId, { securityMode: 'E2EE' });
      }
    } catch {
      // No IndexedDB/identity on this profile: there is no local E2EE marker.
    }
  }

  /**
   * Registers (or reuses) the keyed device and opens the local E2EE account.
   * Runs only when the flag is on; failures are surfaced as E2EE state, never as
   * a plaintext fallback.
   */
  private async initializeE2ee(userId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    if (this.e2eeInitPromise) return this.e2eeInitPromise;
    this.pendingResets.clear();
    this.patchE2ee({ status: 'loading', error: null, userId, browserUnsupported: false });
    this.e2eeInitPromise = (async () => {
      try {
        const self = await this.e2eeBridge!.initialize({
          userId,
          name: this.config.deviceName.slice(0, 80) || 'Сова — браузер',
          appVersion: this.config.appVersion.slice(0, 40),
        });
        this.patchE2ee({
          status: 'ready',
          error: null,
          userId: self.userId,
          deviceId: self.deviceId,
          keyGeneration: self.keyGeneration,
          fingerprint: self.fingerprint,
        });
        // G4e #30: resume any durable retry window left by a previous page
        // (pending replacements are drained by their idempotency keys).
        void this.resumeE2eeRetries();
        // Every subsequent device-scoped request must use the keyed device id.
        // The Auth BFF session persists it via the auth storage module; the dev session is
        // in-memory only (AUTH-D-06) and is updated without touching storage.
        if (this.config.authMode === 'password') {
          setRuntimeDeviceId(self.deviceId);
        } else {
          const session = getSession();
          if (session !== null && session.device.id !== self.deviceId) {
            setSession({ ...session, device: { ...session.device, id: self.deviceId } });
          }
        }
        if (this.state.device?.id !== self.deviceId) {
          this.patch({
            device: this.state.device
              ? { ...this.state.device, id: self.deviceId }
              : {
                  id: self.deviceId,
                  platform: 'WEB',
                  created_at: new Date(this.now()).toISOString(),
                },
          });
        }
      } catch (error) {
        const code = e2eeErrorLabel(error);
        this.patchE2ee({
          status: 'error',
          error: code,
          // ADR-26 runtime floor: a browser without a byte-exact RFC 8032
          // Ed25519 must not silently get E2EE (WebKit/Safari).
          browserUnsupported: code === 'E2EE_UNSUPPORTED_BROWSER',
        });
      } finally {
        this.e2eeInitPromise = null;
      }
    })();
    return this.e2eeInitPromise;
  }

  /** Loads mode pin, chat keys, TOFU/key-change state and safety numbers. */
  async loadE2eeChat(chatId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    await this.loadPersistedE2eeMarker(chatId);
    if (this.state.e2ee.status !== 'ready') return;
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat) return;
    const current = this.e2eeChatState(chatId);
    if (current.status === 'loading') return;
    this.patchE2eeChat(chatId, { status: 'loading', error: null });
    const input: E2eeChatInput = {
      chatId,
      serverMode: chat.security_mode,
      peerHasE2eeCapableDevices: chat.peer_has_e2ee_capable_devices,
      workspaceMode: this.state.activeWorkspace?.security_mode ?? null,
      e2eeHistoryMarker: current.securityMode === 'E2EE' || chat.security_mode === 'E2EE',
    };
    try {
      const snapshot = await this.e2eeBridge.loadChat(input);
      const safetyNumbers: Record<string, string> = {};
      const verificationHashes: Record<string, string> = {};
      for (const entry of snapshot.safetyNumbers) {
        safetyNumbers[entry.deviceId] = entry.display;
        if (entry.verificationHash !== undefined) {
          verificationHashes[entry.deviceId] = entry.verificationHash;
        }
      }
      this.patchE2eeChat(chatId, {
        status: 'ready',
        error: null,
        securityMode: snapshot.securityMode,
        modeAction: snapshot.modeAction,
        evidence: snapshot.evidence,
        selfDeviceId: snapshot.selfDeviceId,
        devices: snapshot.devices,
        peerDeviceIds: snapshot.peerDeviceIds,
        keyChanges: snapshot.keyChanges,
        safetyNumbers,
        verificationHashes,
        verificationError: null,
        unavailableDeviceIds:
          snapshot.unavailableDeviceIds.length > 0
            ? snapshot.unavailableDeviceIds
            : current.unavailableDeviceIds,
        loadedAt: snapshot.loadedAt,
      });
    } catch (error) {
      this.patchE2eeChat(chatId, { status: 'error', error: e2eeErrorLabel(error) });
    }
  }

  async refreshE2eeChat(chatId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    this.e2eeBridge.invalidateChat(chatId);
    await this.loadE2eeChat(chatId);
    await this.decryptE2eeSlice(chatId);
  }

  /** Explicit "Принять новый ключ" after the warning is rendered. */
  async acceptKeyChange(chatId: string, userId: string, deviceId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    try {
      await this.e2eeBridge.acceptKeyChange(userId, deviceId);
      await this.loadE2eeChat(chatId);
      // P2-31: messages that arrived while the key-change block was active were
      // stored with a KEY_CHANGE_DETECTED view; drop only those views and retry
      // the slice now that the observed key is accepted. Other error views
      // (e.g. DECRYPT_FAILED) keep their reset semantics.
      const slice = this.state.slices[chatId];
      if (slice) {
        const e2ee = { ...slice.e2ee };
        let changed = false;
        for (const [messageId, view] of Object.entries(e2ee)) {
          if (view.status === 'error' && view.code === 'KEY_CHANGE_DETECTED') {
            delete e2ee[messageId];
            changed = true;
          }
        }
        if (changed) this.patchSlice(chatId, { e2ee });
      }
      await this.decryptE2eeSlice(chatId);
    } catch (error) {
      this.patchE2eeChat(chatId, { error: e2eeErrorLabel(error) });
    }
  }

  /**
   * P1-02: safety-number ceremony for one peer device. The bridge computes VH
   * v2 and attests it with `PUT /chats/{id}/keys/verification`; `verified` is
   * then read back from `DeviceKeyInfo.verified` (scoped to this verifier
   * device). Nothing is marked verified locally if the request fails.
   */
  async verifyE2eeDevice(
    chatId: string,
    deviceId: string,
    method: 'QR' | 'MANUAL' = 'MANUAL',
  ): Promise<boolean> {
    const bridge = this.e2eeBridge;
    if (bridge === null) return false;
    const current = this.e2eeChatState(chatId);
    if (current.verifyingDeviceId !== null) return false;
    if (current.keyChanges.some((change) => change.deviceId === deviceId)) {
      this.patchE2eeChat(chatId, { verificationError: 'KEY_CHANGE_DETECTED' });
      return false;
    }
    this.patchE2eeChat(chatId, { verifyingDeviceId: deviceId, verificationError: null });
    try {
      await bridge.verifyDevice(chatId, deviceId, method);
      await this.loadE2eeChat(chatId);
      return true;
    } catch (error) {
      const code = e2eeErrorLabel(error);
      this.patchE2eeChat(chatId, { verificationError: code });
      if (code === 'KEY_CHANGE_DETECTED') {
        // The target key generation moved: reload keys and show the warning;
        // the user must accept the new key and re-verify.
        await this.loadE2eeChat(chatId);
      }
      return false;
    } finally {
      this.patchE2eeChat(chatId, { verifyingDeviceId: null });
    }
  }

  /** Explicit confirmation of a genuinely managed chat (fresh-device flow). */
  async confirmManagedMode(chatId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    const state = this.e2eeChatState(chatId);
    if (state.evidence.length > 0) return;
    try {
      await this.e2eeBridge.confirmManagedMode(chatId, state.evidence);
      await this.loadE2eeChat(chatId);
    } catch (error) {
      this.patchE2eeChat(chatId, { error: e2eeErrorLabel(error) });
    }
  }

  /**
   * P1-01: resolves the sealed copy of an incoming row by
   * `(chat, direction, sender device, client_message_id, message.id)`.
   * A missing/tampered copy is not fatal: the caller falls back to the normal
   * error path. `message.id` binding rejects a replayed old client id under a
   * new server row (P2-04).
   */
  private async lookupIncomingCopy(
    chatId: string,
    message: ApiMessage,
    bridge: E2eeBridge,
  ): Promise<E2eeLocalCopyView | null> {
    const senderDeviceId = message.crypto?.sender_device_id;
    const clientMessageId = message.client_message_id;
    if (!senderDeviceId || !clientMessageId) return null;
    try {
      return await bridge.lookupIncomingLocalCopy(
        chatId,
        senderDeviceId,
        clientMessageId,
        message.id,
      );
    } catch {
      return null;
    }
  }

  /** Maps a sealed copy to a visible E2EE view; `null` means "no copy". */
  private copyView(copy: E2eeLocalCopyView | null): E2eeMessageView | null {
    if (copy === null) return null;
    if (copy.status === 'superseded') {
      // R-15 replaced this row; after reload the original must stay hidden.
      return { status: 'superseded', text: null, replyToId: null };
    }
    if (copy.contentType === 2) {
      // A restored SESSION_RESET control is never rendered as a message.
      return { status: 'control', text: null, replyToId: null };
    }
    return { status: 'decrypted', text: copy.text ?? '', replyToId: copy.replyToId };
  }

  /**
   * G4f P1-01: applies the v1.1 R-15 marker to one visible row.
   *
   * The durable sealed copy (not the in-memory receive outcome) is the source
   * of truth after a reload. If the original row is `decrypted`/`superseded`,
   * the replacement is hidden; otherwise the original failed/unavailable row is
   * hidden and the replacement is the one visible copy. A queued reset for the
   * superseded original is dropped: the replacement already delivered it.
   */
  private async resolveRetryDedupe(
    chatId: string,
    message: ApiMessage,
    retryOf: string | null,
    bridge: E2eeBridge,
    current: ChatSlice,
    views: Record<string, E2eeMessageView>,
    resets: Array<{ reset: SessionResetBody; messageId: string }>,
  ): Promise<{
    readonly active: boolean;
    readonly originalId: string | null;
    readonly replacementHidden: boolean;
  }> {
    if (retryOf === null || retryOf === message.client_message_id) {
      return { active: false, originalId: null, replacementHidden: false };
    }
    const original = current.messages.find(
      (candidate) => candidate.client_message_id === retryOf && candidate.id !== message.id,
    );
    if (original === undefined) {
      // Pagination may have dropped the original row; without it there is
      // nothing to compare, so the replacement stays visible.
      return { active: false, originalId: null, replacementHidden: false };
    }
    let originalView = views[original.id] ?? current.e2ee[original.id];
    if (originalView === undefined) {
      // The original may be processed later in this batch (or already have a
      // durable copy from before the reload). Resolve it from the sealed copy
      // instead of guessing from the server plaintext.
      const copy = await this.lookupIncomingCopy(chatId, original, bridge);
      const restored = this.copyView(copy);
      if (restored !== null) {
        originalView = restored;
        views[original.id] = restored;
      }
    }
    const originalDecrypted =
      originalView?.status === 'decrypted' || originalView?.status === 'superseded';
    if (originalDecrypted) {
      views[message.id] = { status: 'superseded', text: null, replyToId: null };
      return { active: true, originalId: original.id, replacementHidden: true };
    }
    views[original.id] = { status: 'superseded', text: null, replyToId: null };
    // The original is failed/unavailable; its placeholder may already have
    // queued a SESSION_RESET. It must not be sent for a delivered replacement.
    for (let index = resets.length - 1; index >= 0; index -= 1) {
      if (resets[index]?.messageId === original.id) resets.splice(index, 1);
    }
    return { active: true, originalId: original.id, replacementHidden: false };
  }

  /**
   * Suppresses the duplicate unread/notification contribution of a deduped
   * R-15 pair. The replacement is never counted as a second logical message.
   *
   * Unread is decremented only when this store counted the duplicate (hidden
   * replacement) or the original was also unread (a visible replacement must
   * keep exactly one unread row). `markRead` is called only when the hidden
   * replacement is the sole unread tail, so it cannot mark an unrelated
   * message read. Notification matching is bounded and uniqueness-checked.
   */
  private suppressRetryPair(
    chatId: string,
    message: ApiMessage,
    originalId: string | null,
    replacementHidden: boolean,
  ): void {
    if (originalId === null) return;
    const key = `${chatId}:${message.id}`;
    const first = !this.suppressedRetryKeys.has(key);
    if (first) this.suppressedRetryKeys.add(key);

    const slice = this.state.slices[chatId];
    if (slice === undefined) return;
    const original = slice.messages.find((candidate) => candidate.id === originalId) ?? null;
    const originalUnread = original !== null && slice.readSeq < original.seq;
    const suppressUnread = replacementHidden || originalUnread;

    if (first && suppressUnread) {
      const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
      this.patchSlice(chatId, { unread: Math.max(0, slice.unread - 1) });
      if (summary !== null) {
        this.updateChatSummary(chatId, {
          unread_count: Math.max(0, summary.unread_count - 1),
        });
      }
    }
    if (first && replacementHidden) {
      // Safe only when nothing else is unread: `last_read_seq` is a cursor, so
      // marking a gap would fake-read unrelated messages.
      const latest = this.state.slices[chatId];
      const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
      if (
        latest !== undefined &&
        summary !== null &&
        latest.unread === 0 &&
        summary.unread_count === 0 &&
        message.seq >= latest.lastSeq &&
        latest.readSeq >= message.seq - 1
      ) {
        void this.markRead(chatId, message.seq);
      }
    }
    this.scheduleNotificationSuppression(chatId, message.created_at);
  }

  /**
   * After a decrypt batch, advance the server read cursor only when every row
   * after `readSeq` that is still unread is a hidden duplicate. One `last_seq`
   * cursor cannot skip a gap, so anything else keeps the badge (and the
   * documented limitation) instead of fake-reading an unrelated message.
   */
  private markSuppressedTailReadIfSafe(chatId: string): void {
    const slice = this.state.slices[chatId];
    const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
    if (slice === undefined || summary === null) return;
    if (slice.unread !== 0 || summary.unread_count !== 0) return;
    if (slice.readSeq >= slice.lastSeq) return;
    const ordered = [...slice.messages].sort((left, right) => left.seq - right.seq);
    const tail = ordered[ordered.length - 1];
    if (tail === undefined || tail.seq < slice.lastSeq) return;
    // Do not infer a read across a hole in the loaded history.
    if (slice.hasMore && (slice.beforeSeq === null || slice.beforeSeq > slice.readSeq + 1)) {
      return;
    }
    for (const message of ordered) {
      if (message.seq <= slice.readSeq) continue;
      if (slice.e2ee[message.id]?.status !== 'superseded') return;
    }
    void this.markRead(chatId, tail.seq);
  }

  private scheduleNotificationSuppression(chatId: string, createdAt: string): void {
    const at = Date.parse(createdAt);
    if (!Number.isFinite(at)) return;
    const key = `${chatId}:${at}`;
    if (this.suppressedNotificationTimes.has(key)) return;
    this.suppressedNotificationTimes.set(key, at);
    void this.applyNotificationSuppressions();
  }

  /**
   * Hides the replacement's server notification from the panel. The DTO has no
   * `message_id` (only `chat_id` + `created_at`), so a match is accepted only
   * inside a tight server-clock window and only when exactly one candidate
   * exists. Ambiguous/no candidates are left untouched (documented PARTIAL:
   * the server notification row itself cannot be deleted through the API).
   */
  private async applyNotificationSuppressions(): Promise<void> {
    if (this.suppressedNotificationTimes.size === 0) return;
    const epoch = this.notificationEpoch;
    for (const [key, at] of this.suppressedNotificationTimes) {
      if (epoch !== this.notificationEpoch) return;
      const chatId = key.slice(0, key.lastIndexOf(':'));
      const candidates = this.state.notifications.items.filter((item) => {
        if (item.chat_id !== chatId) return false;
        const created = Date.parse(item.created_at);
        return (
          Number.isFinite(created) && created >= at && created <= at + RETRY_NOTIFICATION_MATCH_MS
        );
      });
      if (candidates.length !== 1) continue;
      const candidate = candidates[0]!;
      if (!candidate.read) {
        const marked = await this.markNotificationRead(candidate.id);
        if (!marked || epoch !== this.notificationEpoch) continue;
      }
      const latest = this.state.notifications;
      if (!latest.items.some((item) => item.id === candidate.id)) continue;
      this.patch({
        notifications: {
          ...latest,
          items: latest.items.filter((item) => item.id !== candidate.id),
        },
      });
    }
  }

  /**
   * Decrypts every pending E2EE message of one chat. Failures are isolated per
   * message; a control SESSION_RESET never reaches the visible list.
   */
  private async decryptE2eeSlice(chatId: string): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null || this.state.e2ee.status !== 'ready') return;
    if (this.e2eeDecrypting.has(chatId)) return;
    const slice = this.state.slices[chatId];
    const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
    if (!slice || !summary) return;
    const chatState = this.state.e2ee.chats[chatId];
    const looksE2ee =
      summary.security_mode === 'E2EE' || slice.messages.some((message) => message.crypto);
    if (!looksE2ee) return;
    if (chatState === undefined || chatState.status === 'idle') {
      await this.loadE2eeChat(chatId);
    }
    this.e2eeDecrypting.add(chatId);
    try {
      for (;;) {
        const current = this.state.slices[chatId];
        if (!current) return;
        const pending = current.messages.filter(
          (message) => current.e2ee[message.id] === undefined && message.type !== 'SYSTEM',
        );
        if (pending.length === 0) return;
        const views: Record<string, E2eeMessageView> = {};
        const resets: Array<{ reset: SessionResetBody; messageId: string }> = [];
        for (const message of pending) {
          const viewerId = this.viewerId();
          const mine = Boolean(viewerId && message.sender_id === viewerId);
          if (hasServerPlaintext(message)) {
            this.patchE2eeChat(chatId, { plaintextAlert: true });
          }
          if (message.crypto === undefined || message.crypto === null) {
            if (mine && message.client_message_id) {
              const copy = await bridge.lookupLocalCopy(chatId, message.client_message_id);
              views[message.id] = this.copyView(copy) ?? {
                status: 'unavailable',
                text: null,
                replyToId: null,
              };
            } else {
              views[message.id] = { status: 'unavailable', text: null, replyToId: null };
            }
            continue;
          }
          const outcome = await bridge.receive(chatId, {
            id: message.id,
            chatId,
            senderId: message.sender_id ?? null,
            senderDeviceId: message.crypto.sender_device_id,
            clientMessageId: message.client_message_id ?? null,
            createdAt: message.created_at,
            crypto: message.crypto,
          });
          if (outcome.kind === 'none') {
            // Already received on this device (e.g. history after reload): the
            // ratchet correctly rejects a second receive, so restore the sealed
            // incoming copy by (sender device, client_message_id, message.id)
            // instead of hiding a message that was decrypted before the reload.
            const copy = await this.lookupIncomingCopy(chatId, message, bridge);
            const view = this.copyView(copy) ?? {
              status: 'unavailable' as const,
              text: null,
              replyToId: null,
            };
            // G4f P1-01: the durable marker lives in the sealed copy, so the
            // reload path dedupes exactly like the live `message` outcome.
            const dedupe = await this.resolveRetryDedupe(
              chatId,
              message,
              copy?.retryOfClientMessageId ?? null,
              bridge,
              current,
              views,
              resets,
            );
            if (!dedupe.replacementHidden) views[message.id] = view;
            if (dedupe.active) {
              this.suppressRetryPair(chatId, message, dedupe.originalId, dedupe.replacementHidden);
            }
          } else if (outcome.kind === 'message') {
            // v1.1 L3b: a re-encrypted replacement carries the original
            // client_message_id inside the sealed TEXT. If the original was
            // already decrypted, hide the replacement instead of rendering a
            // duplicate; if the original was a failed placeholder, replace it.
            const view: E2eeMessageView = {
              status: 'decrypted',
              text: outcome.text,
              replyToId: outcome.replyToId,
            };
            const dedupe = await this.resolveRetryDedupe(
              chatId,
              message,
              outcome.retryOfClientMessageId ?? null,
              bridge,
              current,
              views,
              resets,
            );
            if (!dedupe.replacementHidden) views[message.id] = view;
            if (dedupe.active) {
              this.suppressRetryPair(chatId, message, dedupe.originalId, dedupe.replacementHidden);
            }
          } else if (outcome.kind === 'control') {
            views[message.id] = { status: 'control', text: null, replyToId: null };
            void this.handleIncomingReset(chatId, outcome.senderDeviceId, outcome.reset);
          } else {
            // P1-01: after the session that decrypted this row is gone (R-15
            // completion, §5.7 loser deletion, TTL/GC), `receive()` can only
            // answer NO_SESSION / KEY_HANDSHAKE_INVALID / SPK_DELETED /
            // DECRYPT_FAILED. The sealed incoming copy is the authoritative
            // local history: restore it before showing an error or sending
            // another reset (which could re-encrypt an already delivered
            // window at the sender).
            const restoredCopy = E2EE_COPY_RESTORE_CODES.has(outcome.code)
              ? await this.lookupIncomingCopy(chatId, message, bridge)
              : null;
            const restored = this.copyView(restoredCopy);
            if (restored !== null) {
              // G4f P1-01: a restored replacement copy carries the durable
              // marker even when `receive()` failed because the old session is
              // gone; dedupe before the error/reset path can win.
              const dedupe = await this.resolveRetryDedupe(
                chatId,
                message,
                restoredCopy?.retryOfClientMessageId ?? null,
                bridge,
                current,
                views,
                resets,
              );
              if (!dedupe.replacementHidden) views[message.id] = restored;
              if (dedupe.active) {
                this.suppressRetryPair(
                  chatId,
                  message,
                  dedupe.originalId,
                  dedupe.replacementHidden,
                );
              }
              continue;
            }
            views[message.id] = {
              status: 'error',
              text: null,
              replyToId: null,
              code: outcome.code,
            };
            if (outcome.reset !== null) {
              resets.push({ reset: outcome.reset, messageId: message.id });
            }
            if (outcome.code === 'KEY_CHANGE_DETECTED') {
              this.patchE2eeChat(chatId, { error: null });
              void this.loadE2eeChat(chatId);
            }
          }
        }
        const latest = this.state.slices[chatId];
        if (!latest) return;
        this.patchSlice(chatId, { e2ee: { ...latest.e2ee, ...views } });
        this.markSuppressedTailReadIfSafe(chatId);
        for (const reset of resets) {
          void this.sendResetControl(chatId, reset.reset);
        }
      }
    } finally {
      this.e2eeDecrypting.delete(chatId);
    }
  }

  /** Receiver-side R-15: a rate-limited, invisible control message. */
  private async sendResetControl(chatId: string, reset: SessionResetBody): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null) return;
    const key = `${chatId}:${reset.failedSessionId}`;
    if (this.e2eeResetInFlight.has(key)) return;
    if (!bridge.resetRateLimiter.allow(reset.failedSessionId)) return;
    this.e2eeResetInFlight.add(key);
    let clientMessageId: string | null = null;
    try {
      const prepared = await bridge.sendReset({ chatId, reset });
      clientMessageId = prepared.clientMessageId;
      const result = await this.api.sendMessage(
        chatId,
        {
          client_message_id: prepared.clientMessageId,
          type: 'TEXT',
          envelopes: [...prepared.envelopes],
        },
        prepared.idempotencyKey,
      );
      await bridge.confirmSent(prepared.clientMessageId, {
        serverMessageId: result.message.id,
        seq: result.message.seq,
        warning: prepared.coverageWarning,
      });
    } catch (error) {
      if (clientMessageId !== null) {
        try {
          await bridge.markFailed(clientMessageId, failureCode(error), {
            retryable: isApiError(error) ? error.isRetryable : false,
          });
        } catch {
          // The outbox row may not exist if prepare failed before the commit.
        }
      }
    } finally {
      this.e2eeResetInFlight.delete(key);
    }
  }

  private retryStateKey(chatId: string, failedSessionId: string): string {
    return `${chatId}:${failedSessionId}`;
  }

  /**
   * G4e #30: derives the explicit `retry_pending` UI state from durable
   * metadata, so a reload/chat switch shows the same pending count instead of
   * relying on in-memory `pendingResets`.
   */
  private applyRetryStatus(status: E2eeRetryStatus): void {
    const known =
      this.state.chats.some((chat) => chat.id === status.chatId) ||
      this.state.e2ee.chats[status.chatId] !== undefined;
    if (!known) return;
    // A durable retry intent can exist before its first replacement row was
    // committed (prepare failed) — it still needs the explicit retry state.
    const rows = status.pending + status.permanent;
    const count = rows > 0 ? rows : status.retries.length > 0 ? 1 : 0;
    const current = this.e2eeChatState(status.chatId);
    if (count === 0) {
      if (current.retryPendingCount !== 0 && current.resetProgress?.status !== 'completed') {
        this.patchE2eeChat(status.chatId, { retryPendingCount: 0, resetProgress: null });
      }
      return;
    }
    // A live in-process batch owns done/failed counters; only durable leftovers
    // are described here. Keep the richer in-memory failed counters when the
    // durable count already matches.
    if (current.resetProgress?.status === 'running') return;
    if (current.resetProgress?.status === 'failed' && current.retryPendingCount === count) {
      return;
    }
    this.patchE2eeChat(status.chatId, {
      retryPendingCount: count,
      resetProgress: {
        status: 'failed',
        total: count,
        done: 0,
        failed: status.permanent,
        remaining: status.pending,
        skipped: 0,
      },
    });
  }

  private async reconcileE2eeRetries(chatId?: string): Promise<E2eeRetryReconcileResult | null> {
    const bridge = this.e2eeBridge;
    if (bridge === null || this.state.e2ee.status !== 'ready') return null;
    try {
      const result = await bridge.reconcileRetryState(chatId);
      for (const status of result.statuses) {
        this.applyRetryStatus(status);
        await this.pruneSettledE2eeOutbox(status.chatId);
        for (const retry of status.retries) {
          this.pendingResets.set(this.retryStateKey(status.chatId, retry.reset.failedSessionId), {
            reset: retry.reset,
            senderDeviceId: retry.senderDeviceId,
          });
        }
      }
      return result;
    } catch {
      // Storage unavailable: the next load/chat switch reconciles again.
      return null;
    }
  }

  private scheduleE2eeDrain(nextAttemptAt: number | null): void {
    if (this.e2eeDrainTimer !== null) {
      clearTimeout(this.e2eeDrainTimer);
      this.e2eeDrainTimer = null;
    }
    if (nextAttemptAt === null || this.e2eeBridge === null) return;
    const delay = Math.max(0, nextAttemptAt - this.now());
    this.e2eeDrainTimer = setTimeout(
      () => {
        this.e2eeDrainTimer = null;
        void this.drainE2eeOutbox();
      },
      Math.min(delay, 60_000),
    );
  }

  /** Server-row lookup used to resolve an ambiguous POST before replaying it. */
  private async lookupAcceptedMessage(entry: OutboxEntry): Promise<OutboxSendResult | null> {
    try {
      const page = await this.api.listMessages(entry.chatId, { limit: 100 });
      const match = page.items.find(
        (message) => message.client_message_id === entry.clientMessageId,
      );
      if (match === undefined) return null;
      return { serverMessageId: match.id, seq: match.seq, warning: entry.warning };
    } catch {
      return null;
    }
  }

  private async sendStoredOutboxEntry(entry: OutboxEntry): Promise<OutboxSendResult> {
    if (entry.attempts > 0) {
      const existing = await this.lookupAcceptedMessage(entry);
      if (existing !== null) return existing;
    }
    const result = await this.api.sendMessage(
      entry.chatId,
      {
        client_message_id: entry.clientMessageId,
        type: 'TEXT',
        envelopes: [...entry.envelopes],
      },
      entry.idempotencyKey,
    );
    return {
      serverMessageId: result.message.id,
      seq: result.message.seq,
      warning: entry.warning,
    };
  }

  /**
   * Durable drain: replays pending/failed replacements with their exact sealed
   * bytes and `Idempotency-Key`, so an ambiguous POST is resolved server-side
   * instead of creating a second message. Single-flight here + the bridge's
   * outbox lock across tabs.
   */
  private async drainE2eeOutbox(
    chatId?: string,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null || this.state.e2ee.status !== 'ready') return;
    if (this.e2eeDrainInFlight !== null) return this.e2eeDrainInFlight;
    const run = (async () => {
      try {
        const result = await bridge.drainOutbox((entry) => this.sendStoredOutboxEntry(entry), {
          chatId,
          force: options.force === true,
          now: this.now(),
          classifyError: (error) => ({
            code: failureCode(error),
            retryable: isApiError(error) ? error.isRetryable : !isE2eeError(error),
            ...(isApiError(error) && error.retryAfterSeconds !== undefined
              ? { retryAfterMs: error.retryAfterSeconds * 1000 }
              : {}),
          }),
        });
        if (result.sent.length > 0 && chatId !== undefined) {
          await this.refreshDrainedMessages(chatId);
        }
      } catch {
        // Transport/storage hiccup: the persisted schedule drives the next pass.
      }
      const reconciled = await this.reconcileE2eeRetries(chatId);
      if (reconciled !== null) this.scheduleE2eeDrain(minNextRetry(reconciled.statuses));
    })();
    this.e2eeDrainInFlight = run.finally(() => {
      this.e2eeDrainInFlight = null;
    });
    return this.e2eeDrainInFlight;
  }

  /**
   * Removes optimistic rows whose durable row was settled by a drain/lookup
   * (e.g. an ambiguous POST that the server had already accepted). Without
   * this the UI would keep a "failed" bubble next to the delivered message.
   */
  private async pruneSettledE2eeOutbox(chatId: string): Promise<void> {
    const bridge = this.e2eeBridge;
    const slice = this.state.slices[chatId];
    if (bridge === null || !slice || slice.outbox.length === 0) return;
    const kept: OutgoingMessage[] = [];
    let changed = false;
    for (const item of slice.outbox) {
      if (!item.e2ee) {
        kept.push(item);
        continue;
      }
      try {
        const entry = await bridge.loadOutgoing(item.clientMessageId);
        if (entry !== null && (entry.status === 'sent' || entry.status === 'superseded')) {
          changed = true;
          continue;
        }
      } catch {
        // Keep the optimistic row; a later reconcile retries the read.
      }
      kept.push(item);
    }
    if (changed) {
      const latest = this.state.slices[chatId];
      if (latest) this.patchSlice(chatId, { outbox: kept });
    }
  }

  /** Merges a confirmed replacement into the open slice without re-decrypting. */
  private async refreshDrainedMessages(chatId: string): Promise<void> {
    const slice = this.state.slices[chatId];
    if (!slice) return;
    try {
      const page = await this.api.listMessages(chatId, {
        limit: this.config.historyPageSize,
      });
      const current = this.state.slices[chatId];
      if (!current) return;
      const roots = page.items.filter((message) => !message.thread_root_id);
      const messages = mergeMessages(current.messages, roots);
      this.patchSlice(chatId, {
        messages,
        lastSeq: Math.max(current.lastSeq, maxSeq(messages)),
        beforeSeq: minSeq(messages),
      });
      void this.decryptE2eeSlice(chatId);
    } catch {
      // The next sync/live frame fills the slice.
    }
  }

  /**
   * Idempotent load/chat-switch resume: reconciles durable state, drains what is
   * due, and re-drives a durable retry window whose replacements are all gone.
   */
  private async resumeE2eeRetries(chatId?: string): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null || this.state.e2ee.status !== 'ready') return;
    if (
      chatId !== undefined &&
      [...this.e2eeResetInFlight].some((inflight) => inflight.startsWith(`${chatId}:`))
    ) {
      // A live R-15 batch owns the outbox rows for this chat; draining the same
      // replacement concurrently would POST it twice (idempotent on the server,
      // but it would double the visible attempt counter and can race the batch).
      return;
    }
    const key = chatId ?? '*';
    if (this.e2eeResumeInFlight.has(key)) return;
    this.e2eeResumeInFlight.add(key);
    try {
      const reconciled = await this.reconcileE2eeRetries(chatId);
      if (reconciled === null) return;
      let statuses = reconciled.statuses;
      if (statuses.some((status) => status.pending > 0)) {
        await this.drainE2eeOutbox(chatId);
        const afterDrain = await this.reconcileE2eeRetries(chatId);
        if (afterDrain !== null) statuses = afterDrain.statuses;
      } else {
        this.scheduleE2eeDrain(minNextRetry(statuses));
      }
      const blocked = statuses.some((status) => status.pending > 0 || status.permanent > 0);
      if (blocked) return;
      for (const status of statuses) {
        if (!this.state.chats.some((chat) => chat.id === status.chatId)) continue;
        for (const retry of status.retries) {
          if (
            this.pendingResets.has(this.retryStateKey(status.chatId, retry.reset.failedSessionId))
          ) {
            continue;
          }
          await this.handleIncomingReset(status.chatId, retry.senderDeviceId, retry.reset);
        }
      }
    } finally {
      this.e2eeResumeInFlight.delete(key);
    }
  }

  /**
   * Sender-side R-15: after a reset, re-encrypt the undecryptable window in a
   * fresh session. Each message is a separate POST (§5.5); old rows become
   * `superseded` only after their replacement is accepted by the server.
   */
  private async handleIncomingReset(
    chatId: string,
    senderDeviceId: string,
    reset: SessionResetBody,
  ): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null) return;
    const key = `${chatId}:${reset.failedSessionId}`;
    if (this.e2eeResetInFlight.has(key)) return;
    this.e2eeResetInFlight.add(key);
    let started = false;
    let failed = 0;
    let done = 0;
    let total = 0;
    let remaining = 0;
    let skipped = 0;
    try {
      const outcome = await bridge.handleReset({ chatId, senderDeviceId, reset });
      if (outcome.status !== 'pending') {
        // A reset that can no longer be re-driven must not leave a dead retry
        // affordance in the UI. A `duplicate` keeps any live pending window.
        if (outcome.reason !== 'duplicate') {
          this.pendingResets.delete(key);
          this.patchE2eeChat(chatId, { resetProgress: null, retryPendingCount: 0 });
          try {
            await bridge.clearRetryState(chatId, reset.failedSessionId);
          } catch {
            // Durable cleanup is retried by the next reconcile.
          }
        }
        return;
      }
      started = true;
      remaining = outcome.remaining;
      skipped = outcome.skipped;
      total = outcome.candidates.length + outcome.remaining;
      this.pendingResets.set(key, { reset, senderDeviceId });
      // Persist the retry intent before the first replacement exists: a reload
      // must be able to show `retry_pending` and clean up the failed session.
      try {
        await bridge.saveRetryState({ chatId, senderDeviceId, reset });
      } catch {
        // The outbox rows remain the durable source of truth for the drain.
      }
      if (outcome.candidates.length === 0) {
        // G4e #30: exact replacement bytes are already durable; do not
        // re-encrypt. The worker below drains them by their idempotency keys.
        const pendingReplacements = outcome.pendingReplacements ?? 0;
        remaining = pendingReplacements;
        total = pendingReplacements;
        this.patchE2eeChat(chatId, {
          retryPendingCount: pendingReplacements,
          resetProgress: {
            status: 'failed',
            total,
            done: 0,
            failed: 0,
            remaining,
            skipped,
          },
        });
        void this.drainE2eeOutbox(chatId);
        return;
      }
      this.patchE2eeChat(chatId, {
        retryPendingCount: total,
        resetProgress: {
          status: 'running',
          total,
          done: 0,
          failed: 0,
          remaining,
          skipped,
        },
      });
      let first = true;
      // E7-F5G P2-30: after the first fresh-prekey retry, the remaining batch
      // reuses exactly those sessions. If one is gone the bridge creates a
      // fresh prekey session instead of falling back to an old live session.
      let reuseSessionIds: readonly string[] | undefined;
      for (const candidate of outcome.candidates) {
        let preparedId: string | null = null;
        try {
          const prepared = await bridge.sendText({
            chatId,
            text: candidate.text,
            replyToId: candidate.replyToId,
            retryOfClientMessageId: candidate.originalClientMessageId,
            freshPrekey: first,
            reuseSessionIds,
          });
          preparedId = prepared.clientMessageId;
          if (first) {
            reuseSessionIds = prepared.sessionIds;
          }
          this.patchE2eeChat(chatId, {
            coverageWarning: prepared.coverageWarning,
            unavailableDeviceIds: prepared.coverage.uncoveredDeviceIds,
          });
          try {
            await bridge.markAttempt(prepared.clientMessageId);
          } catch {
            // The durable row may already be terminal; the POST below is still
            // idempotent and `confirmSent` settles it.
          }
          const result = await this.api.sendMessage(
            chatId,
            {
              client_message_id: prepared.clientMessageId,
              type: 'TEXT',
              envelopes: [...prepared.envelopes],
            },
            prepared.idempotencyKey,
          );
          await bridge.confirmSent(prepared.clientMessageId, {
            serverMessageId: result.message.id,
            seq: result.message.seq,
            warning: prepared.coverageWarning,
          });
          // G4e #30: `confirmSent` already superseded the original in the same
          // transaction. This is a retry-safe no-op; a failure here must never
          // turn a delivered replacement into a "failed" batch item.
          try {
            await bridge.markSuperseded(candidate.originalClientMessageId);
          } catch {
            // Healed by the next reconcile (and already superseded atomically).
          }
          first = false;
          done += 1;
          this.patchE2eeChat(chatId, {
            resetProgress: {
              status: 'running',
              total,
              done,
              failed,
              remaining,
              skipped,
            },
          });
          this.applyE2eeSentMessage(chatId, result.message, candidate.text, candidate.replyToId);
          if (candidate.originalServerMessageId !== null) {
            const latest = this.state.slices[chatId];
            if (latest) {
              this.patchSlice(chatId, {
                e2ee: {
                  ...latest.e2ee,
                  [candidate.originalServerMessageId]: {
                    status: 'superseded',
                    text: null,
                    replyToId: null,
                  },
                },
              });
            }
          }
        } catch (error) {
          failed += 1;
          // The durable row is marked failed (retryable errors get a persisted
          // backoff). The worker or the explicit "retry" action re-drives the
          // window; there is no silent drop.
          if (preparedId !== null) {
            try {
              await bridge.markFailed(preparedId, failureCode(error), {
                retryable: isApiError(error) ? error.isRetryable : false,
              });
            } catch {
              // Missing/terminal row: the drain state stays authoritative.
            }
          }
          break;
        }
      }
      const unprocessed = outcome.candidates.length - done - failed;
      remaining = outcome.remaining + Math.max(0, unprocessed);
      const completed = failed === 0 && remaining === 0;
      const progress: E2eeResetProgress = {
        status: completed ? 'completed' : 'failed',
        total,
        done,
        failed,
        remaining,
        skipped,
      };
      if (completed) this.pendingResets.delete(key);
      this.patchE2eeChat(chatId, {
        retryPendingCount: completed ? 0 : failed + remaining,
        resetProgress: progress,
      });
      void this.loadNotifications({ silent: true });
    } finally {
      const completed = started && failed === 0 && remaining === 0;
      if (started) {
        // E7-F5G R-15: success deletes the failed session; a failed/partial
        // batch unmarks the reset so the next one can re-drive the window.
        try {
          await bridge.finishReset({
            chatId,
            reset,
            failedSessionId: reset.failedSessionId,
            status: completed ? 'completed' : 'failed',
          });
          if (completed) {
            await bridge.clearRetryState(chatId, reset.failedSessionId);
          }
        } catch {
          // The retry outcome itself is already reflected in the UI state.
        }
        if (!completed) {
          // Durable drain picks up the failed replacement with a persisted
          // backoff; the UI already shows the explicit retry-pending state.
          void this.reconcileE2eeRetries(chatId).then((reconciled) => {
            if (reconciled !== null) this.scheduleE2eeDrain(minNextRetry(reconciled.statuses));
          });
        }
      }
      this.e2eeResetInFlight.delete(key);
    }
  }

  /**
   * E7-F6 R-15 UX: explicit retry of a failed re-encryption window. The reset
   * body is retained in memory only after a failed/partial batch; a completed
   * reset is removed so the button can never re-send already replaced messages.
   */
  async retryPendingReset(chatId: string): Promise<void> {
    if (this.e2eeBridge === null) return;
    // G4e #30: drain exact pending replacement bytes first. Only when the
    // durable outbox is clean do we re-encrypt the remaining window; otherwise
    // the retry button could create a second copy of the same plaintext.
    await this.drainE2eeOutbox(chatId, { force: true });
    const prefix = `${chatId}:`;
    const pending = [...this.pendingResets.entries()].filter(([key]) => key.startsWith(prefix));
    if (pending.length === 0) {
      await this.resumeE2eeRetries(chatId);
      return;
    }
    this.patchE2eeChat(chatId, { resetProgress: null, retryPendingCount: 0 });
    for (const [, entry] of pending) {
      await this.handleIncomingReset(chatId, entry.senderDeviceId, entry.reset);
    }
  }

  private applyE2eeSentMessage(
    chatId: string,
    message: ApiMessage,
    text: string,
    replyToId: string | null,
  ): void {
    const current = this.state.slices[chatId];
    if (!current) return;
    const messages = mergeMessages(current.messages, [message]);
    this.patchSlice(chatId, {
      messages,
      e2ee: {
        ...current.e2ee,
        [message.id]: { status: 'decrypted', text, replyToId },
      },
      lastSeq: Math.max(current.lastSeq, message.seq),
      beforeSeq: minSeq(messages),
    });
    this.updateChatTail(chatId, message);
  }

  private async sendE2eeText(
    chatId: string,
    text: string,
    replyToId: string | null,
  ): Promise<void> {
    const bridge = this.e2eeBridge;
    const slice = this.state.slices[chatId];
    if (bridge === null || !slice) return;
    let prepared;
    try {
      prepared = await bridge.sendText({ chatId, text, replyToId });
    } catch (error) {
      this.patchE2eeChat(chatId, { error: e2eeErrorLabel(error) });
      if (isE2eeError(error) && error.code === 'KEY_CHANGE_DETECTED') {
        void this.loadE2eeChat(chatId);
      }
      return;
    }
    const outgoing: OutgoingMessage = {
      clientMessageId: prepared.clientMessageId,
      idempotencyKey: prepared.idempotencyKey,
      kind: 'TEXT',
      text,
      sticker: null,
      replyToId,
      attachments: [],
      createdAt: this.now(),
      status: 'sending',
      error: null,
      attempts: 0,
      e2ee: true,
      coverageWarning: prepared.coverageWarning,
    };
    const latest = this.state.slices[chatId];
    if (!latest) return;
    this.patchSlice(chatId, { outbox: [...latest.outbox, outgoing] });
    this.patchE2eeChat(chatId, {
      error: null,
      coverageWarning: prepared.coverageWarning,
      unavailableDeviceIds: prepared.coverage.uncoveredDeviceIds,
    });
    await this.attemptE2eeSend(chatId, outgoing.clientMessageId, prepared.envelopes);
  }

  private async attemptE2eeSend(
    chatId: string,
    clientMessageId: string,
    envelopes: readonly WireCryptoEnvelope[],
  ): Promise<void> {
    const key = this.timerKey(chatId, clientMessageId);
    if (this.inFlight.has(key)) return;
    const slice = this.state.slices[chatId];
    const item = slice?.outbox.find((entry) => entry.clientMessageId === clientMessageId);
    if (!slice || !item) return;
    this.inFlight.add(key);
    this.patchOutgoing(chatId, clientMessageId, {
      status: 'sending',
      error: null,
      attempts: item.attempts + 1,
    });
    try {
      await this.e2eeBridge?.markAttempt(clientMessageId);
    } catch {
      // Terminal/missing row: the POST is still idempotent; the drain state
      // (not this counter) decides whether a retry is allowed.
    }
    try {
      const result = await this.api.sendMessage(
        chatId,
        {
          client_message_id: clientMessageId,
          type: 'TEXT',
          envelopes: [...envelopes],
        },
        item.idempotencyKey,
      );
      await this.e2eeBridge?.confirmSent(clientMessageId, {
        serverMessageId: result.message.id,
        seq: result.message.seq,
        warning: item.coverageWarning ?? null,
      });
      const current = this.state.slices[chatId];
      if (!current) return;
      const messages = mergeMessages(current.messages, [result.message]);
      this.patchSlice(chatId, {
        messages,
        outbox: current.outbox.filter((entry) => entry.clientMessageId !== clientMessageId),
        e2ee: {
          ...current.e2ee,
          [result.message.id]: {
            status: 'decrypted',
            text: item.text,
            replyToId: item.replyToId,
          },
        },
        lastSeq: Math.max(current.lastSeq, result.message.seq),
        beforeSeq: minSeq(messages),
      });
      this.updateChatTail(chatId, result.message);
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      try {
        await this.e2eeBridge?.markFailed(clientMessageId, apiError.code, {
          retryable: apiError.isRetryable,
        });
      } catch {
        // Outbox row may already be gone; nothing else to do here.
      }
      this.patchOutgoing(chatId, clientMessageId, {
        status: 'failed',
        error: apiError,
      });
      // G4e #30: retryable failures are scheduled durably; a reload continues
      // the same backoff instead of losing the pending send.
      void this.reconcileE2eeRetries(chatId).then((reconciled) => {
        if (reconciled !== null) this.scheduleE2eeDrain(minNextRetry(reconciled.statuses));
      });
      if (apiError.code === 'KEY_CHANGED' || apiError.code === 'KEY_GENERATION_MISMATCH') {
        this.e2eeBridge?.invalidateChat(chatId);
        void this.loadE2eeChat(chatId);
      }
      if (
        apiError.status === 409 &&
        apiError.code === 'IDEMPOTENCY_IN_PROGRESS' &&
        item.attempts < MAX_AUTO_RETRIES
      ) {
        const delay = (apiError.retryAfterSeconds ?? 1) * 1000;
        const timer = setTimeout(() => {
          this.timers.delete(key);
          const latest = this.state.slices[chatId]?.outbox.find(
            (entry) => entry.clientMessageId === clientMessageId,
          );
          if (latest?.status === 'failed') void this.retry(chatId, clientMessageId);
        }, delay);
        this.timers.set(key, timer);
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async retryE2ee(chatId: string, clientMessageId: string): Promise<void> {
    const bridge = this.e2eeBridge;
    if (bridge === null) return;
    const entry = await bridge.loadOutgoing(clientMessageId);
    if (entry === null) {
      this.patchOutgoing(chatId, clientMessageId, {
        status: 'failed',
        error: ApiError.client('E2EE_UNAVAILABLE', 'E2EE outbox entry is missing'),
      });
      return;
    }
    this.patchOutgoing(chatId, clientMessageId, { status: 'sending', error: null });
    await this.attemptE2eeSend(chatId, clientMessageId, entry.envelopes);
  }

  async retry(chatId: string, clientMessageId: string): Promise<void> {
    const found = this.findOutgoing(chatId, clientMessageId);
    if (!found || found.item.status !== 'failed') return;

    this.clearTimer(this.timerKey(chatId, clientMessageId));
    if (found.threadRootId !== null) {
      this.patchThreadOutgoing(chatId, found.threadRootId, clientMessageId, {
        status: 'sending',
        error: null,
      });
    } else {
      this.patchOutgoing(chatId, clientMessageId, { status: 'sending', error: null });
    }
    if (found.item.e2ee) {
      await this.retryE2ee(chatId, clientMessageId);
      return;
    }
    await this.attemptSend(chatId, clientMessageId, found.threadRootId);
  }

  discardOutgoing(chatId: string, clientMessageId: string): OutgoingMessage | null {
    const slice = this.state.slices[chatId];
    const item = slice?.outbox.find((entry) => entry.clientMessageId === clientMessageId);
    if (!slice || !item) return null;

    this.clearTimer(this.timerKey(chatId, clientMessageId));
    this.patchSlice(chatId, {
      outbox: slice.outbox.filter((entry) => entry.clientMessageId !== clientMessageId),
    });
    return item;
  }

  private timerKey(chatId: string, clientMessageId: string): string {
    return `${chatId}:${clientMessageId}`;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private patchOutgoing(
    chatId: string,
    clientMessageId: string,
    patch: Partial<OutgoingMessage>,
  ): void {
    const slice = this.state.slices[chatId];
    if (!slice) return;
    this.patchSlice(chatId, {
      outbox: slice.outbox.map((entry) =>
        entry.clientMessageId === clientMessageId ? { ...entry, ...patch } : entry,
      ),
    });
  }

  private async attemptSend(
    chatId: string,
    clientMessageId: string,
    threadRootId: string | null = null,
  ): Promise<void> {
    const key = this.timerKey(chatId, clientMessageId);
    if (this.inFlight.has(key)) return;

    const slice = this.state.slices[chatId];
    const thread = threadRootId !== null ? this.threadFor(chatId, threadRootId) : null;
    const item =
      threadRootId !== null
        ? thread?.outbox.find((entry) => entry.clientMessageId === clientMessageId)
        : slice?.outbox.find((entry) => entry.clientMessageId === clientMessageId);
    if (!slice || !item) return;

    this.inFlight.add(key);
    if (threadRootId !== null) {
      this.patchThreadOutgoing(chatId, threadRootId, clientMessageId, {
        status: 'sending',
        error: null,
        attempts: item.attempts + 1,
      });
    } else {
      this.patchOutgoing(chatId, clientMessageId, {
        status: 'sending',
        error: null,
        attempts: item.attempts + 1,
      });
    }

    const body: MessageCreateBody =
      item.kind === 'STICKER' && item.sticker
        ? {
            client_message_id: item.clientMessageId,
            type: 'STICKER',
            sticker_id: item.sticker.id,
            ...(item.replyToId ? { reply_to_id: item.replyToId } : {}),
            ...(threadRootId !== null ? { thread_root_id: threadRootId } : {}),
          }
        : {
            client_message_id: item.clientMessageId,
            type: 'TEXT',
            // Contract: text is nullable; attachment_ids carry the payload.
            text: item.text.length > 0 ? item.text : null,
            ...(item.replyToId ? { reply_to_id: item.replyToId } : {}),
            ...(threadRootId !== null ? { thread_root_id: threadRootId } : {}),
            ...(item.attachments.length > 0
              ? { attachment_ids: item.attachments.map((attachment) => attachment.id) }
              : {}),
            // #83: explicit recipients only; the server re-validates chat
            // membership, @all role and duplicates.
            ...(item.mentions && item.mentions.length > 0 ? { mentions: item.mentions } : {}),
            ...(item.mentionAll ? { mention_all: true } : {}),
          };

    try {
      const result = await this.api.sendMessage(chatId, body, item.idempotencyKey);
      if (threadRootId !== null) {
        const currentThread = this.threadFor(chatId, threadRootId);
        const currentSlice = this.state.slices[chatId];
        if (!currentThread || !currentSlice) return;
        // A live WS frame may have delivered this reply first; in that case the
        // summary is already incremented and only the outbox row is settled.
        const known = currentThread.replies.some((reply) => reply.id === result.message.id);
        const replies = mergeMessages(currentThread.replies, [result.message]);
        this.patchThread(threadKey(chatId, threadRootId), {
          replies,
          outbox: currentThread.outbox.filter((entry) => entry.clientMessageId !== clientMessageId),
          lastSeq: Math.max(currentThread.lastSeq, result.message.seq),
          beforeSeq: minSeq(replies),
        });
        this.patchSlice(chatId, {
          lastSeq: Math.max(currentSlice.lastSeq, result.message.seq),
        });
        if (!known) this.bumpRootSummary(chatId, threadRootId, result.message);
      } else {
        const current = this.state.slices[chatId];
        if (!current) return;

        const messages = mergeMessages(current.messages, [result.message]);
        this.patchSlice(chatId, {
          messages,
          outbox: current.outbox.filter((entry) => entry.clientMessageId !== clientMessageId),
          lastSeq: Math.max(current.lastSeq, result.message.seq),
          beforeSeq: minSeq(messages),
        });
        this.files.markBound(item.attachments.map((attachment) => attachment.id));
      }
      this.updateChatTail(chatId, result.message);
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      const failed =
        threadRootId !== null
          ? this.threadFor(chatId, threadRootId)?.outbox.find(
              (entry) => entry.clientMessageId === clientMessageId,
            )
          : this.state.slices[chatId]?.outbox.find(
              (entry) => entry.clientMessageId === clientMessageId,
            );
      if (!failed) return;

      if (threadRootId !== null) {
        this.patchThreadOutgoing(chatId, threadRootId, clientMessageId, {
          status: 'failed',
          error: apiError,
        });
        const unavailable = threadUnavailableFromError(apiError);
        if (unavailable !== null) {
          this.patchThread(threadKey(chatId, threadRootId), { unavailable });
        }
      } else {
        this.patchOutgoing(chatId, clientMessageId, {
          status: 'failed',
          error: apiError,
        });
      }

      if (apiError.code === 'STICKER_PACK_DISABLED') {
        const packId =
          typeof apiError.details?.pack_id === 'string'
            ? apiError.details.pack_id
            : failed.sticker?.pack_id;
        if (packId) this.stickers.disablePack(packId);
      }

      if (
        apiError.status === 409 &&
        apiError.code === 'IDEMPOTENCY_IN_PROGRESS' &&
        failed.attempts < MAX_AUTO_RETRIES
      ) {
        const delay = (apiError.retryAfterSeconds ?? 1) * 1000;
        const timer = setTimeout(() => {
          this.timers.delete(key);
          const stillFailed =
            threadRootId !== null
              ? this.threadFor(chatId, threadRootId)?.outbox.find(
                  (entry) => entry.clientMessageId === clientMessageId,
                )
              : this.state.slices[chatId]?.outbox.find(
                  (entry) => entry.clientMessageId === clientMessageId,
                );
          if (stillFailed?.status === 'failed') void this.retry(chatId, clientMessageId);
        }, delay);
        this.timers.set(key, timer);
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  async markRead(chatId: string, lastSeq: number): Promise<void> {
    const slice = this.state.slices[chatId];
    if (
      !slice ||
      slice.status !== 'ready' ||
      !this.state.online ||
      lastSeq <= 0 ||
      lastSeq <= slice.readSeq
    ) {
      return;
    }

    const key = `${chatId}:${lastSeq}`;
    let idempotencyKey = this.readKeys.get(key);
    if (!idempotencyKey) {
      idempotencyKey = this.createId();
      this.readKeys.set(key, idempotencyKey);
    }

    try {
      await this.api.markRead(chatId, lastSeq, idempotencyKey);
      const current = this.state.slices[chatId];
      if (!current) return;
      this.patchSlice(chatId, { readSeq: Math.max(current.readSeq, lastSeq), unread: 0 });
      this.updateChatSummary(chatId, { unread_count: 0 });
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      // Read receipts are best-effort: never block the chat with a toast.
    }
  }

  /* ------------------------------------------------------------------ */
  /* #83: server-side message search                                      */
  /* ------------------------------------------------------------------ */

  /**
   * New search chain. The server owns matching, visibility, ordering and the
   * opaque cursor; a newer query invalidates in-flight responses by `seq`.
   */
  async searchMessages(rawQuery: string, chatId: string | null = null): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    const query = rawQuery.trim();
    if (!workspaceId || query.length === 0) {
      this.clearSearch();
      return;
    }

    const seq = this.state.messageSearch.seq + 1;
    this.patch({
      messageSearch: {
        ...createEmptyMessageSearchState(),
        query,
        chatId,
        status: 'loading',
        seq,
      },
    });

    try {
      const page = await this.api.searchMessages(workspaceId, {
        q: query,
        chatId: chatId ?? undefined,
        limit: SEARCH_PAGE_SIZE,
      });
      if (this.state.messageSearch.seq !== seq || this.currentWorkspaceId() !== workspaceId) {
        return;
      }
      this.patch({
        messageSearch: {
          ...this.state.messageSearch,
          items: page.items,
          status: 'ready',
          error: null,
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
        },
      });
    } catch (error) {
      if (this.state.messageSearch.seq !== seq) return;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        messageSearch: {
          ...this.state.messageSearch,
          items: [],
          status: 'error',
          error: apiError,
          hasMore: false,
          nextCursor: null,
        },
      });
    }
  }

  /** Append exactly one server cursor page of the current search chain. */
  async loadMoreSearchResults(): Promise<void> {
    const current = this.state.messageSearch;
    if (current.status !== 'ready' || current.loadMoreStatus === 'loading') return;
    if (!current.hasMore || current.nextCursor === null) return;
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return;

    const seq = current.seq;
    this.patch({
      messageSearch: { ...current, loadMoreStatus: 'loading', loadMoreError: null },
    });

    try {
      const page = await this.api.searchMessages(workspaceId, {
        q: current.query,
        chatId: current.chatId ?? undefined,
        cursor: current.nextCursor,
        limit: SEARCH_PAGE_SIZE,
      });
      const latest = this.state.messageSearch;
      if (latest.seq !== seq) return;
      const known = new Set(latest.items.map((item) => item.message_id));
      const appended = page.items.filter((item) => !known.has(item.message_id));
      this.patch({
        messageSearch: {
          ...latest,
          items: [...latest.items, ...appended],
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
          loadMoreStatus: 'idle',
          loadMoreError: null,
        },
      });
    } catch (error) {
      const latest = this.state.messageSearch;
      if (latest.seq !== seq) return;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        messageSearch: { ...latest, loadMoreStatus: 'error', loadMoreError: apiError },
      });
    }
  }

  /** Reset the search surface (empty query / closed panel). */
  clearSearch(): void {
    const next = createEmptyMessageSearchState();
    this.patch({ messageSearch: { ...next, seq: this.state.messageSearch.seq + 1 } });
  }

  /* ------------------------------------------------------------------ */
  /* #83: mention inbox (`/me/mentions`)                                  */
  /* ------------------------------------------------------------------ */

  /** Fresh `/me/mentions` chain; `unread_count` is workspace-wide. */
  async refreshMentions(options: { unreadOnly?: boolean } = {}): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId || this.state.sessionStatus !== 'ready') return;
    const unreadOnly = options.unreadOnly ?? this.state.mentions.unreadOnly;
    const epoch = ++this.mentionEpoch;
    this.patch({
      mentions: {
        ...createEmptyMentionsState(),
        unreadOnly,
        status: 'loading',
        unreadCount: this.state.mentions.unreadCount,
      },
    });

    try {
      const page = await this.api.listMentions({
        workspaceId,
        unread: unreadOnly || undefined,
        limit: MENTIONS_PAGE_SIZE,
      });
      if (epoch !== this.mentionEpoch) return;
      this.patch({
        mentions: {
          ...this.state.mentions,
          items: page.items,
          unreadCount: page.unread_count,
          status: 'ready',
          error: null,
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
        },
      });
    } catch (error) {
      if (epoch !== this.mentionEpoch) return;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        mentions: {
          ...this.state.mentions,
          items: [],
          status: 'error',
          error: apiError,
          hasMore: false,
          nextCursor: null,
        },
      });
    }
  }

  /** Switch the server `unread` filter; reloads the first page. */
  setMentionsUnreadOnly(unreadOnly: boolean): Promise<void> {
    return this.refreshMentions({ unreadOnly });
  }

  async loadMoreMentions(): Promise<void> {
    const current = this.state.mentions;
    if (current.status !== 'ready' || current.loadMoreStatus === 'loading') return;
    if (!current.hasMore || current.nextCursor === null) return;

    const epoch = this.mentionEpoch;
    this.patch({ mentions: { ...current, loadMoreStatus: 'loading', loadMoreError: null } });

    try {
      const page = await this.api.listMentions({
        cursor: current.nextCursor,
        unread: current.unreadOnly || undefined,
        limit: MENTIONS_PAGE_SIZE,
      });
      if (epoch !== this.mentionEpoch) return;
      const latest = this.state.mentions;
      const known = new Set(latest.items.map((item) => item.id));
      this.patch({
        mentions: {
          ...latest,
          items: [...latest.items, ...page.items.filter((item) => !known.has(item.id))],
          unreadCount: page.unread_count,
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
          loadMoreStatus: 'idle',
          loadMoreError: null,
        },
      });
    } catch (error) {
      if (epoch !== this.mentionEpoch) return;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        mentions: { ...this.state.mentions, loadMoreStatus: 'error', loadMoreError: apiError },
      });
    }
  }

  /** Optimistic mark-one with an honest rollback (the server is idempotent). */
  async markMentionRead(id: string): Promise<boolean> {
    const current = this.state.mentions;
    const item = current.items.find((entry) => entry.id === id);
    if (!item || item.read_at !== null) return true;
    if (current.readPendingIds.includes(id)) return true;

    const epoch = this.mentionEpoch;
    const readAt = new Date(this.now()).toISOString();
    this.patch({
      mentions: {
        ...current,
        items: current.items.map((entry) =>
          entry.id === id ? { ...entry, read_at: readAt } : entry,
        ),
        unreadCount: Math.max(0, current.unreadCount - 1),
        readPendingIds: [...current.readPendingIds, id],
        readError: null,
      },
    });

    try {
      await this.api.markMentionsRead({ ids: [id] }, this.createId());
      if (epoch !== this.mentionEpoch) return true;
      this.patch({
        mentions: {
          ...this.state.mentions,
          readPendingIds: this.state.mentions.readPendingIds.filter((entry) => entry !== id),
        },
      });
      return true;
    } catch (error) {
      if (epoch !== this.mentionEpoch) return true;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        mentions: {
          ...this.state.mentions,
          items: this.state.mentions.items.map((entry) =>
            entry.id === id ? { ...entry, read_at: null } : entry,
          ),
          unreadCount: this.state.mentions.unreadCount + 1,
          readPendingIds: this.state.mentions.readPendingIds.filter((entry) => entry !== id),
          readError: apiError,
        },
      });
      return false;
    }
  }

  /** Mark every mention of the current workspace read in one idempotent call. */
  async markAllMentionsRead(): Promise<boolean> {
    const current = this.state.mentions;
    if (current.readAllPending) return false;
    if (current.unreadCount === 0 && current.items.every((item) => item.read_at !== null)) {
      return true;
    }

    const epoch = this.mentionEpoch;
    const readAt = new Date(this.now()).toISOString();
    this.patch({
      mentions: {
        ...current,
        items: current.items.map((entry) =>
          entry.read_at === null ? { ...entry, read_at: readAt } : entry,
        ),
        unreadCount: 0,
        readAllPending: true,
        readError: null,
      },
    });

    try {
      await this.api.markMentionsRead({ all: true }, this.createId());
      if (epoch !== this.mentionEpoch) return true;
      this.patch({
        mentions: { ...this.state.mentions, readAllPending: false },
      });
      return true;
    } catch (error) {
      if (epoch !== this.mentionEpoch) return false;
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({
        mentions: {
          ...this.state.mentions,
          items: current.items,
          unreadCount: current.unreadCount,
          readAllPending: false,
          readError: apiError,
        },
      });
      return false;
    }
  }

  clearMentionReadError(): void {
    if (!this.state.mentions.readError) return;
    this.patch({ mentions: { ...this.state.mentions, readError: null } });
  }

  /* ------------------------------------------------------------------ */
  /* E6-F: notifications and preferences                                 */
  /* ------------------------------------------------------------------ */

  private canLoadNotifications(): boolean {
    return this.state.sessionStatus === 'ready' && !this.state.onboardingRequired;
  }

  /**
   * GET /notifications?limit=30. Called on bootstrap, after `message.created`
   * and after `/sync`; a shared promise collapses these triggers into one call.
   */
  async loadNotifications(options: { silent?: boolean } = {}): Promise<void> {
    if (!this.canLoadNotifications()) return;
    if (this.notificationsPromise) return this.notificationsPromise;

    const current = this.state.notifications;
    const epoch = this.notificationEpoch;
    const silent = options.silent === true && current.status === 'ready';
    this.patch({
      notifications: {
        ...current,
        status: silent ? current.status : 'loading',
        error: null,
      },
    });

    this.notificationsPromise = (async () => {
      try {
        const page = await this.api.listNotifications({ limit: NOTIFICATIONS_PAGE_SIZE });
        if (epoch !== this.notificationEpoch) return;
        const latest = this.state.notifications;
        this.patch({
          notifications: {
            ...latest,
            items: page.items,
            status: 'ready',
            error: null,
            unreadCount: page.unread_count,
            hasMore: page.page.has_more,
            nextCursor: page.page.next_cursor ?? null,
            loadMoreStatus: 'idle',
            loadMoreError: null,
            lastLoadedAt: this.now(),
          },
        });
        // G4f P1-01: a replacement notification may arrive before the E2EE
        // dedupe has run (or be re-fetched after a reload); apply any known
        // suppressions to the fresh page.
        void this.applyNotificationSuppressions();
      } catch (error) {
        const apiError = toApiError(error);
        if (epoch !== this.notificationEpoch) return;
        this.handleFailure(apiError);
        const latest = this.state.notifications;
        this.patch({
          notifications: {
            ...latest,
            status: latest.items.length > 0 ? 'ready' : 'error',
            error: apiError,
          },
        });
      } finally {
        this.notificationsPromise = null;
      }
    })();

    return this.notificationsPromise;
  }

  /** Foreground refresh for the panel; never shows a spinner over loaded rows. */
  refreshNotifications(): Promise<void> {
    return this.loadNotifications();
  }

  async loadMoreNotifications(): Promise<void> {
    const current = this.state.notifications;
    if (
      current.status !== 'ready' ||
      !current.hasMore ||
      current.nextCursor === null ||
      current.loadMoreStatus === 'loading'
    ) {
      return;
    }

    const epoch = this.notificationEpoch;
    this.patch({
      notifications: { ...current, loadMoreStatus: 'loading', loadMoreError: null },
    });

    try {
      const page = await this.api.listNotifications({
        cursor: current.nextCursor,
        limit: NOTIFICATIONS_PAGE_SIZE,
      });
      if (epoch !== this.notificationEpoch) return;
      const latest = this.state.notifications;
      const known = new Set(latest.items.map((item) => item.id));
      const appended = page.items.filter((item) => !known.has(item.id));
      this.patch({
        notifications: {
          ...latest,
          items: [...latest.items, ...appended],
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
          loadMoreStatus: 'idle',
          loadMoreError: null,
        },
      });
      void this.applyNotificationSuppressions();
    } catch (error) {
      const apiError = toApiError(error);
      if (epoch !== this.notificationEpoch) return;
      this.handleFailure(apiError);
      this.patch({
        notifications: {
          ...this.state.notifications,
          loadMoreStatus: 'error',
          loadMoreError: apiError,
        },
      });
    }
  }

  /** Optimistic read-one with rollback; returns false when the server rejects it. */
  async markNotificationRead(id: string): Promise<boolean> {
    const current = this.state.notifications;
    const item = current.items.find((entry) => entry.id === id);
    if (!item || item.read) return true;
    if (current.readPendingIds.includes(id)) return true;

    const generation = this.notificationReadGeneration;
    const epoch = this.notificationEpoch;
    this.patch({
      notifications: {
        ...current,
        items: current.items.map((entry) => (entry.id === id ? { ...entry, read: true } : entry)),
        unreadCount: Math.max(0, current.unreadCount - 1),
        readPendingIds: [...current.readPendingIds, id],
        readError: null,
      },
    });

    try {
      // One key per logical mutation; a user-initiated retry is a new action.
      await this.api.markNotificationsRead({ ids: [id], all: false }, this.createId());
      if (epoch !== this.notificationEpoch) return true;
      this.removeNotificationReadPending(id);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      if (epoch !== this.notificationEpoch) return false;
      this.handleFailure(apiError);
      this.removeNotificationReadPending(id);

      // A concurrent successful read-all is authoritative: do not resurrect
      // an unread badge from a late single-read failure.
      if (
        generation === this.notificationReadGeneration &&
        !this.state.notifications.readAllPending
      ) {
        const latest = this.state.notifications;
        this.patch({
          notifications: {
            ...latest,
            items: latest.items.map((entry) =>
              entry.id === id ? { ...entry, read: false } : entry,
            ),
            unreadCount: latest.unreadCount + 1,
            readError: apiError,
          },
        });
      } else {
        this.patch({
          notifications: { ...this.state.notifications, readError: apiError },
        });
      }
      return false;
    }
  }

  private removeNotificationReadPending(id: string): void {
    const latest = this.state.notifications;
    this.patch({
      notifications: {
        ...latest,
        readPendingIds: latest.readPendingIds.filter((entry) => entry !== id),
      },
    });
  }

  /** «Прочитать все»: one optimistic patch, full rollback on failure. */
  async markAllNotificationsRead(): Promise<boolean> {
    const current = this.state.notifications;
    if (current.readAllPending) return false;
    if (current.unreadCount === 0 && current.items.every((item) => item.read)) return true;

    const epoch = this.notificationEpoch;
    this.patch({
      notifications: {
        ...current,
        items: current.items.map((entry) => ({ ...entry, read: true })),
        unreadCount: 0,
        readAllPending: true,
        readError: null,
      },
    });

    try {
      await this.api.markNotificationsRead({ all: true }, this.createId());
      if (epoch !== this.notificationEpoch) return true;
      this.notificationReadGeneration += 1;
      this.patch({
        notifications: { ...this.state.notifications, readAllPending: false },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      if (epoch !== this.notificationEpoch) return false;
      this.handleFailure(apiError);
      this.patch({
        notifications: {
          ...this.state.notifications,
          items: current.items,
          unreadCount: current.unreadCount,
          readAllPending: false,
          readError: apiError,
        },
      });
      return false;
    }
  }

  clearNotificationReadError(): void {
    if (!this.state.notifications.readError) return;
    this.patch({
      notifications: { ...this.state.notifications, readError: null },
    });
  }

  async loadNotificationPreferences(options: { force?: boolean } = {}): Promise<void> {
    if (!this.canLoadNotifications()) return;
    if (this.preferencesPromise) return this.preferencesPromise;

    const current = this.state.notificationPreferences;
    if (current.status === 'ready' && options.force !== true) return;

    const epoch = this.notificationEpoch;
    this.patch({
      notificationPreferences: {
        ...current,
        status: 'loading',
        error: null,
      },
    });

    this.preferencesPromise = (async () => {
      try {
        const response = await this.api.getNotificationPreferences();
        if (epoch !== this.notificationEpoch) return;
        this.patch({
          notificationPreferences: {
            ...this.state.notificationPreferences,
            items: response.items,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        const apiError = toApiError(error);
        if (epoch !== this.notificationEpoch) return;
        this.handleFailure(apiError);
        this.patch({
          notificationPreferences: {
            ...this.state.notificationPreferences,
            status: 'error',
            error: apiError,
          },
        });
      } finally {
        this.preferencesPromise = null;
      }
    })();

    return this.preferencesPromise;
  }

  /**
   * PATCH /notification-preferences. The contract has no separate "create"
   * operation: the server upserts by (chat_id, type, channel).
   */
  async saveNotificationPreference(
    patch: NotificationPreferencePatch,
  ): Promise<NotificationPreference | null> {
    const current = this.state.notificationPreferences;
    if (current.saving) return null;

    const epoch = this.notificationEpoch;
    this.patch({
      notificationPreferences: { ...current, saving: true, saveError: null },
    });

    try {
      const saved = await this.api.updateNotificationPreference(patch, this.createId());
      if (epoch !== this.notificationEpoch) return null;
      const latest = this.state.notificationPreferences;
      const key = notificationPreferenceKey(saved);
      const items = latest.items.some((item) => notificationPreferenceKey(item) === key)
        ? latest.items.map((item) => (notificationPreferenceKey(item) === key ? saved : item))
        : [...latest.items, saved];
      this.patch({
        notificationPreferences: {
          ...latest,
          items,
          status: 'ready',
          saving: false,
          saveError: null,
        },
      });
      return saved;
    } catch (error) {
      const apiError = toApiError(error);
      if (epoch !== this.notificationEpoch) return null;
      this.handleFailure(apiError);
      this.patch({
        notificationPreferences: {
          ...this.state.notificationPreferences,
          saving: false,
          saveError: apiError,
        },
      });
      return null;
    }
  }

  clearPreferenceSaveError(): void {
    if (!this.state.notificationPreferences.saveError) return;
    this.patch({
      notificationPreferences: {
        ...this.state.notificationPreferences,
        saveError: null,
      },
    });
  }

  setOnline(online: boolean): void {
    if (this.state.online === online) return;
    this.patch({ online });
    if (!online) {
      this.realtime?.suspend();
      return;
    }
    if (this.realtime) {
      // Reconnect order: GET /sync → new ticket → subscribe(last_seq).
      this.realtime.resume();
    } else {
      void this.sync();
    }
  }

  /** Manual "reconnect" action from the banner; still goes through /sync. */
  reconnectRealtime(): void {
    if (!this.state.online) return;
    this.realtime?.reconnectNow();
  }

  /** Ephemeral typing signal; safe to call on every keystroke (server TTL 5 s). */
  sendTyping(chatId: string): void {
    if (!this.state.online) return;
    this.realtime?.sendTyping(chatId);
  }

  /* ---------------------------------------------------------------------- */
  /* §9 + #77 calls                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Start an outgoing 1:1 call. DIRECT only; GROUP uses `startGroupCall`.
   * Calls stay managed-only: E2EE chats never expose a call attempt.
   */
  startCall(chatId: string, video: boolean): void {
    if (this.state.call.phase !== 'idle') return;
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat || chat.type !== 'DIRECT') return;
    if (this.isE2eeChat(chatId)) return;
    if (this.state.realtimeStatus !== 'online') {
      this.patch({
        call: { ...idleCallState(), notice: { code: 'signaling_failed' } },
      });
      return;
    }
    this.calls.start(chatId, chat.peer_id ?? null, video);
  }

  /**
   * #77: start a GROUP mesh conference with the peers selected in the picker.
   * Returns false when the call cannot start (idle/live/managed/selection), so
   * the modal can stay open with an honest state instead of vanishing.
   */
  async listChatMembers(chatId: string): Promise<string[]> {
    const response = await this.api.listChatMembers(chatId);
    return response.user_ids;
  }

  startGroupCall(chatId: string, peerUserIds: readonly string[], video: boolean): boolean {
    if (this.state.call.phase !== 'idle') return false;
    const chat = this.state.chats.find((item) => item.id === chatId) ?? null;
    if (!chat || chat.type !== 'GROUP') return false;
    if (this.isE2eeChat(chatId)) return false;
    const selfId = this.viewerId();
    const peers = [...new Set(peerUserIds)].filter((id) => id.length > 0 && id !== selfId);
    if (peers.length === 0) return false;
    if (this.state.realtimeStatus !== 'online') {
      this.patch({
        call: { ...idleCallState(), notice: { code: 'signaling_failed' } },
      });
      return false;
    }
    this.calls.startConference(chatId, peers, video);
    return true;
  }

  /**
   * #105/#107: start the room mesh towards the peers that are already present.
   * The server keeps no call state; `chat_id` of the room is the existing
   * managed GROUP channel used by `call.signal`. `video` follows the room's
   * server-side `media_mode`, so an AUDIO room never requests a camera.
   * Returns false when the engine is already busy or the WebSocket is offline
   * (the page shows an honest note).
   */
  private startRoomConference(
    chatId: string,
    peerUserIds: readonly string[],
    video: boolean,
    callId?: string,
  ): boolean {
    if (this.state.call.phase !== 'idle') return false;
    if (this.state.realtimeStatus !== 'online') return false;
    const selfId = this.viewerId();
    const peers = [...new Set(peerUserIds)].filter((id) => id.length > 0 && id !== selfId);
    if (peers.length === 0) return false;
    this.calls.startConference(chatId, peers, video, callId);
    return true;
  }

  acceptIncomingCall(): void {
    this.calls.accept();
  }

  rejectIncomingCall(): void {
    this.calls.reject();
  }

  /** Explicit hangup; the overlay confirms before calling this for a live call. */
  endCall(): void {
    this.calls.hangup();
  }

  toggleCallMute(): void {
    this.calls.toggleMute();
  }

  toggleCallCamera(): void {
    this.calls.toggleCamera();
  }

  /** #107: live device switches and display capture for the active call. */
  switchCallMicrophone(deviceId: string): Promise<boolean> {
    return this.calls.switchMicrophone(deviceId);
  }

  switchCallCamera(deviceId: string): Promise<boolean> {
    return this.calls.switchCamera(deviceId);
  }

  startCallScreenShare(): Promise<boolean> {
    return this.calls.startScreenShare();
  }

  stopCallScreenShare(): Promise<boolean> {
    return this.calls.stopScreenShare();
  }

  dismissCallNotice(): void {
    this.calls.dismissNotice();
  }

  /** Why calls are unavailable in this chat, or null when they may start. */
  callDisabledReason(chatId: string | null): string | null {
    const chat = chatId ? (this.state.chats.find((item) => item.id === chatId) ?? null) : null;
    if (!chat) return 'calls.realtimeRequired';
    if (chat.type !== 'DIRECT' && chat.type !== 'GROUP') return 'calls.directOnly';
    if (this.isE2eeChat(chat.id)) return 'calls.e2eeUnavailable';
    if (this.state.realtimeStatus !== 'online') return 'calls.realtimeRequired';
    if (this.state.call.phase !== 'idle') return 'calls.alreadyActive';
    return null;
  }

  private handleCallSignal(frame: CallSignalFrame): void {
    // #77: GROUP relay is accepted only for conference frames; a legacy or
    // malformed GROUP frame must never create call UI. DIRECT stays unchanged.
    const chat = this.state.chats.find((item) => item.id === frame.chat_id) ?? null;
    if (chat && chat.type !== 'DIRECT' && frame.payload.conference !== true) return;
    this.calls.handleSignal(frame);
    // #105/#3: a room is a conference. If this tab is already present in the
    // room, a peer's conference offer is joined automatically instead of
    // ringing like a 1:1 call.
    queueMicrotask(() => {
      const call = this.calls.getState();
      if (call.phase !== 'incoming' || !call.conference) return;
      const rooms = this.rooms.getSnapshot();
      const room = rooms.items.find((item) => item.chat_id === frame.chat_id);
      if (!room || rooms.presenceRoomId !== room.id) return;
      this.calls.accept();
    });
  }

  private handleCallUnavailable(frame: CallUnavailableFrame): void {
    this.calls.handleUnavailable(frame.payload.call_id, frame.from_user_id ?? null);
  }

  async sync(): Promise<void> {
    const { activeWorkspaceId, session, online, sessionStatus, onboardingRequired } = this.state;
    const workspaceId = activeWorkspaceId ?? session?.workspace.id;
    if (!workspaceId || !online || sessionStatus !== 'ready' || onboardingRequired) return;
    if (this.syncPromise) return this.syncPromise;

    this.syncPromise = this.runSync(workspaceId).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runSync(workspaceId: string): Promise<void> {
    this.patch({ syncStatus: 'syncing', syncError: null });
    try {
      const response = await this.api.sync(workspaceId);
      const activeChatId = this.state.activeChatId;
      const active = activeChatId ? this.state.slices[activeChatId] : undefined;
      const remote = activeChatId
        ? response.chats.find((chat) => chat.chat_id === activeChatId)
        : undefined;

      if (
        activeChatId &&
        active &&
        remote &&
        active.lastSeq > 0 &&
        remote.last_seq > active.lastSeq
      ) {
        await this.catchUp(activeChatId, active.lastSeq);
      }

      this.applySync(response);
      this.patch({
        syncStatus: 'idle',
        syncError: null,
        lastSyncedAt: response.server_time,
      });
      // E6: every successful sync is a cheap refresh point for the bell. The
      // shared promise prevents overlap with the message.created trigger.
      void this.loadNotifications({ silent: true });
      this.updateRealtimeSubscriptions();
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({ syncStatus: 'error', syncError: apiError });
    }
  }

  private async catchUp(chatId: string, afterSeq: number): Promise<void> {
    let cursor = afterSeq;
    let mergedAny = false;

    for (let pageIndex = 0; pageIndex < MAX_CATCH_UP_PAGES; pageIndex += 1) {
      const query: ListMessagesQuery = { afterSeq: cursor, limit: 100 };
      const page = await this.api.listMessages(chatId, query);
      const current = this.state.slices[chatId];
      if (!current) return;

      // REST catch-up is roots-only by contract, but keep the channel clean if
      // a reply ever appears in the after_seq page.
      const roots = page.items.filter((message) => !message.thread_root_id);
      const messages = mergeMessages(current.messages, roots);
      if (page.items.length > 0) mergedAny = true;
      cursor = Math.max(cursor, maxSeq(page.items));
      this.patchSlice(chatId, {
        messages,
        lastSeq: Math.max(current.lastSeq, cursor),
        beforeSeq: minSeq(messages),
      });
      const newest = page.items[page.items.length - 1];
      if (newest) {
        this.updateChatSummary(chatId, {
          last_seq: Math.max(this.chatLastSeq(chatId), newest.seq),
          last_message_at: newest.created_at,
        });
      }

      if (!page.page.has_more || page.items.length === 0) break;
    }

    // P1-03: REST catch-up (runSync and resume.gap) merges messages without a
    // live frame, so it must also drive the E2EE pipeline. Otherwise a missed
    // encrypted SESSION_RESET and E2EE texts stay unprocessed until reload.
    // `decryptE2eeSlice` is idempotent and `e2eeDecrypting` guards re-entry.
    if (mergedAny && this.e2eeBridge !== null) {
      await this.decryptE2eeSlice(chatId);
    }
  }

  /* ------------------------------------------------------------------ */
  /* E3 realtime integration                                             */
  /* ------------------------------------------------------------------ */

  private startRealtime(): void {
    if (!this.realtime) return;
    if (
      this.state.sessionStatus !== 'ready' ||
      this.state.onboardingRequired ||
      !this.state.online
    ) {
      return;
    }
    this.realtime.start();
  }

  private realtimeSubscriptions(): { chat_id: string; last_seq: number }[] {
    const activeChatId = this.state.activeChatId;
    const subscriptions: { chat_id: string; last_seq: number }[] = [];
    for (const slice of Object.values(this.state.slices)) {
      if (slice.status !== 'ready') continue;
      subscriptions.push({ chat_id: slice.chatId, last_seq: slice.lastSeq });
    }
    // Active chat first; servers may impose an order/limit, and this keeps the
    // visible conversation in the first replay window.
    subscriptions.sort((a, b) => {
      if (a.chat_id === activeChatId) return -1;
      if (b.chat_id === activeChatId) return 1;
      return 0;
    });
    return subscriptions;
  }

  private updateRealtimeSubscriptions(): void {
    this.realtime?.updateSubscriptions();
  }

  private async syncForReconnect(): Promise<void> {
    if (
      this.state.sessionStatus !== 'ready' ||
      this.state.onboardingRequired ||
      !this.state.online
    ) {
      return;
    }
    await this.sync();
  }

  private handleRealtimeStatus(status: RealtimeStatus): void {
    this.patch({
      realtimeStatus: status,
      ...(status === 'online' ? { realtimeIssue: null } : {}),
    });
  }

  private handleRealtimeFailure(failure: RealtimeFailure): void {
    this.patch({
      realtimeIssue: {
        kind: failure.kind,
        message: failure.message,
        ...(failure.code ? { code: failure.code } : {}),
        ...(failure.status ? { status: failure.status } : {}),
      },
    });
  }

  private handleRealtimeServerError(frame: ErrorFrame): void {
    // §9.4: call-signal errors are recoverable and must only fail the active
    // call, never the WS or messaging. RATE_LIMITED/FORBIDDEN are shared with
    // other frames, so they are attributed to the call only when one is live.
    const callActive = this.state.call.phase !== 'idle';
    if (
      frame.code === 'CALL_NOT_SUPPORTED' ||
      frame.code === 'CALL_PAYLOAD_TOO_LARGE' ||
      (callActive &&
        (frame.code === 'RATE_LIMITED' ||
          frame.code === 'FORBIDDEN' ||
          frame.code === 'WS_FRAME_INVALID'))
    ) {
      this.calls.handleServerError(frame.code);
      // Do not surface a call-only rejection as a global realtime outage.
      return;
    }

    const kind: RealtimeFailureKind =
      frame.code === 'FORBIDDEN'
        ? 'forbidden'
        : frame.code === 'RATE_LIMITED'
          ? 'rate_limited'
          : 'protocol';
    this.patch({
      realtimeIssue: {
        kind,
        message: frame.message,
        code: frame.code,
        ...(frame.chat_id ? { status: 403 } : {}),
      },
    });
  }

  private handleRealtimeRevoked(reason: string): void {
    this.calls.stop();
    const error = ApiError.client('SESSION_REVOKED', reason || 'Realtime session was revoked', 403);
    this.patch({
      realtimeStatus: 'revoked',
      realtimeIssue: {
        kind: 'revoked',
        message: error.message,
        code: error.code,
        status: 403,
      },
      sessionStatus: 'error',
      sessionError: error,
      authExpired: true,
    });
  }

  private handleSubscribed(frame: SubscribedFrame): void {
    const rejected = frame.chats.filter((chat) => !chat.accepted);
    if (rejected.length === 0) return;
    const first = rejected[0];
    this.patch({
      realtimeIssue: {
        kind: 'forbidden',
        message: first?.reason
          ? `Live subscription rejected: ${first.reason}`
          : 'Live subscription rejected',
        code: first?.reason ?? 'FORBIDDEN',
        status: 403,
      },
    });
  }

  private rememberRealtimeEvent(eventId: string): boolean {
    if (this.seenEventIdSet.has(eventId)) return false;
    this.seenEventIdSet.add(eventId);
    this.seenEventIds.push(eventId);
    if (this.seenEventIds.length > 1_000) {
      const oldest = this.seenEventIds.shift();
      if (oldest) this.seenEventIdSet.delete(oldest);
    }
    return true;
  }

  private handleRealtimeEvent(frame: EventFrame): void {
    // Dedupe by event_id before interpreting the event; at-least-once replay
    // also relies on seq <= last_seq below.
    if (!this.rememberRealtimeEvent(frame.event_id)) return;

    if (frame.event === 'message.created') {
      this.applyMessageCreated(frame);
      // E6-D-04: no notification WS event in E6; fetch after the message event.
      void this.loadNotifications({ silent: true });
      return;
    }
    if (frame.event === 'message.receipt') {
      this.applyMessageReceipt(frame);
      return;
    }
    if (frame.event === 'message.updated') {
      this.applyMessageUpdated(frame);
      return;
    }
    if (frame.event === 'message.deleted') {
      this.applyMessageDeleted(frame);
      return;
    }
    if (frame.event === 'message.reaction.changed') {
      this.applyReactionChanged(frame);
      return;
    }
    if (frame.event === 'chat.keys.changed') {
      if (this.e2eeBridge !== null) {
        this.e2eeBridge.invalidateChat(frame.chat_id);
        void this.loadE2eeChat(frame.chat_id).then(() => this.decryptE2eeSlice(frame.chat_id));
      }
      return;
    }
    if (frame.event === 'device.list.changed') {
      this.e2eeBridge?.invalidateChat();
    }
    // chat.member.changed / chat.pin.changed are outside the E3-F slice.
  }

  private applyMessageCreated(frame: EventFrame): void {
    // ws-protocol §3 documents payload = Message object. Backend E3-B currently
    // serialises the Message fields directly in payload; accept both shapes so
    // live delivery does not depend on that envelope detail.
    const message = readApiMessage(frame.payload.message) ?? readApiMessage(frame.payload);
    if (!message || message.chat_id !== frame.chat_id) return;

    const slice = this.state.slices[message.chat_id];
    const summary = this.state.chats.find((chat) => chat.id === message.chat_id) ?? null;
    if (!slice || slice.status !== 'ready') {
      // Not loaded yet: keep the sidebar counter sane; history/sync fill the
      // slice later. No optimistic UI exists for such a chat.
      if (summary && message.seq > summary.last_seq) {
        this.updateChatSummary(message.chat_id, {
          last_seq: message.seq,
          last_message_at: message.created_at,
          unread_count: summary.unread_count + 1,
        });
      }
      return;
    }

    // Contract §5: ignore seq <= last_seq; duplicates are also dropped by id.
    if (message.seq <= slice.lastSeq) return;

    // D1-FE3: a reply belongs to its thread panel and to the root summary; it
    // must never appear in the channel feed.
    const threadRootId = message.thread_root_id ?? null;
    if (threadRootId !== null) {
      this.applyThreadReplyCreated(message, threadRootId);
      return;
    }

    const viewerId = this.viewerId();
    const mine = Boolean(viewerId && message.sender_id === viewerId);
    let outbox = slice.outbox;
    if (mine) {
      // Message DTO has no client_message_id; correlate the optimistic row by
      // kind + payload. The later REST 201 is deduped by id.
      const incomingAttachmentIds = (message.attachments ?? [])
        .map((attachment) => attachment.id)
        .sort()
        .join(',');
      const incomingStickerId = message.sticker_id ?? message.sticker?.id ?? null;
      const clientId = message.client_message_id ?? null;
      const match = outbox.find((entry) => {
        if (clientId !== null) return entry.clientMessageId === clientId;
        if ((entry.replyToId ?? null) !== (message.reply_to_id ?? null)) return false;
        if (entry.kind === 'STICKER') {
          return Boolean(incomingStickerId) && entry.sticker?.id === incomingStickerId;
        }
        return (
          entry.text === (message.text ?? '') &&
          entry.attachments
            .map((attachment) => attachment.id)
            .sort()
            .join(',') === incomingAttachmentIds
        );
      });
      if (match) {
        outbox = outbox.filter((entry) => entry.clientMessageId !== match.clientMessageId);
      }
    }

    const messages = mergeMessages(slice.messages, [message]);
    const visible = this.isActiveChatVisible(message.chat_id);
    const unread = mine || visible ? 0 : slice.unread + 1;

    this.patchSlice(message.chat_id, {
      messages,
      outbox,
      lastSeq: Math.max(slice.lastSeq, message.seq),
      beforeSeq: minSeq(messages),
      unread,
    });
    this.updateChatSummary(message.chat_id, {
      last_seq: Math.max(this.chatLastSeq(message.chat_id), message.seq),
      last_message_at: message.created_at,
      unread_count: mine || visible ? 0 : (summary?.unread_count ?? 0) + 1,
    });

    if (this.e2eeBridge !== null) void this.decryptE2eeSlice(message.chat_id);
    if (this.state.activeChatId === message.chat_id) {
      this.realtime?.sendAck(message.seq);
    }
  }

  /**
   * Live reply routing: append to the thread only, bump the cached root
   * summary and advance the chat tail (reply seq is part of the chat stream and
   * must be acknowledged / replayed correctly).
   */
  private applyThreadReplyCreated(message: ApiMessage, rootId: string): void {
    const chatId = message.chat_id;
    const slice = this.state.slices[chatId];
    const summary = this.state.chats.find((chat) => chat.id === chatId) ?? null;
    if (!slice || slice.status !== 'ready') {
      if (summary && message.seq > summary.last_seq) {
        this.updateChatSummary(chatId, {
          last_seq: message.seq,
          last_message_at: message.created_at,
          unread_count: summary.unread_count + 1,
        });
      }
      return;
    }

    const key = threadKey(chatId, rootId);
    const thread = this.state.threads[key] ?? null;
    const viewerId = this.viewerId();
    const mine = Boolean(viewerId && message.sender_id === viewerId);
    const known = thread?.replies.some((reply) => reply.id === message.id) ?? false;

    if (thread && thread.status === 'ready' && !known) {
      const replies = mergeMessages(thread.replies, [message]);
      const outbox = mine ? settleThreadOutbox(thread, message) : thread.outbox;
      this.patchThread(key, {
        replies,
        outbox,
        lastSeq: Math.max(thread.lastSeq, message.seq),
        beforeSeq: minSeq(replies),
      });
    }

    const visible = this.isActiveChatVisible(chatId);
    const unread = mine || visible ? 0 : slice.unread + 1;
    this.patchSlice(chatId, {
      lastSeq: Math.max(slice.lastSeq, message.seq),
      unread,
    });
    if (!known) this.bumpRootSummary(chatId, rootId, message);
    this.updateChatSummary(chatId, {
      last_seq: Math.max(this.chatLastSeq(chatId), message.seq),
      last_message_at: message.created_at,
      unread_count: mine || visible ? 0 : (summary?.unread_count ?? 0) + 1,
    });
    if (this.state.activeChatId === chatId) {
      this.realtime?.sendAck(message.seq);
    }
  }

  /**
   * #62 live event: the flat `Message` is authoritative for text, version,
   * `edited_at` and `reactions`. E2EE is never updated through plaintext
   * metadata (the backend must not emit this event for E2EE).
   */
  private applyMessageUpdated(frame: EventFrame): void {
    if (this.isE2eeChat(frame.chat_id)) return;
    const message = readApiMessage(frame.payload.message) ?? readApiMessage(frame.payload);
    if (!message || message.chat_id !== frame.chat_id) return;
    this.mergeServerMessage(frame.chat_id, message);
  }

  /**
   * #63 live tombstone (`scope=all` only; delete-for-me is local and never
   * published). The server owns `deleted_at`; the client clears content,
   * reactions, attachments and the decrypted view immediately.
   */
  private applyMessageDeleted(frame: EventFrame): void {
    const scope = frame.payload.scope;
    if (scope !== undefined && scope !== 'all') return;
    const messageId = frame.payload.message_id;
    if (typeof messageId !== 'string' || messageId.length === 0) return;
    const found = this.findMessageLocation(frame.chat_id, messageId);
    if (!found) return;
    const deletedAt =
      typeof frame.payload.deleted_at === 'string' &&
      !Number.isNaN(Date.parse(frame.payload.deleted_at))
        ? frame.payload.deleted_at
        : new Date().toISOString();
    this.applyTombstone(frame.chat_id, messageId, deletedAt);
  }

  /**
   * #61 live aggregate: `count` is the server total, so repeated/late frames are
   * idempotent. `me` follows the viewer's user id; other users' rows never
   * change the local `me` flag. A zero count removes the chip.
   */
  private applyReactionChanged(frame: EventFrame): void {
    if (this.isE2eeChat(frame.chat_id)) return;
    const messageId = frame.payload.message_id;
    const emoji = frame.payload.emoji;
    const action = frame.payload.action;
    if (typeof messageId !== 'string' || messageId.length === 0) return;
    if (typeof emoji !== 'string' || !isReactionEmoji(emoji)) return;
    if (action !== 'ADDED' && action !== 'REMOVED') return;

    const found = this.findMessageLocation(frame.chat_id, messageId);
    if (!found || found.message.deleted_at) return;
    const existing = (found.message.reactions ?? []).find((reaction) => reaction.emoji === emoji);
    const userId = typeof frame.payload.user_id === 'string' ? frame.payload.user_id : null;
    const self = userId !== null && userId === this.viewerId();
    const rawCount = frame.payload.count;
    const hasCount = typeof rawCount === 'number' && Number.isFinite(rawCount);
    const count =
      action === 'ADDED'
        ? Math.max(1, hasCount ? Math.floor(rawCount) : (existing?.count ?? 0) + 1)
        : Math.max(0, hasCount ? Math.floor(rawCount) : (existing?.count ?? 1) - 1);
    this.applyReactionState(frame.chat_id, messageId, emoji, {
      count,
      me: self ? action === 'ADDED' : (existing?.me ?? false),
    });
  }

  private applyMessageReceipt(frame: EventFrame): void {
    const userId = frame.payload.user_id;
    const lastReadSeq = frame.payload.last_read_seq;
    if (typeof userId !== 'string' || typeof lastReadSeq !== 'number') return;
    if (!Number.isFinite(lastReadSeq) || lastReadSeq < 0) return;

    const slice = this.state.slices[frame.chat_id];
    if (!slice) return;
    const current = slice.receipts[userId] ?? 0;
    if (lastReadSeq <= current) return;

    const receipts = { ...slice.receipts, [userId]: Math.floor(lastReadSeq) };
    const self = userId === this.viewerId();
    this.patchSlice(frame.chat_id, {
      receipts,
      ...(self ? { readSeq: Math.max(slice.readSeq, Math.floor(lastReadSeq)), unread: 0 } : {}),
    });
    if (self) {
      this.updateChatSummary(frame.chat_id, { unread_count: 0 });
    }
  }

  private handleTyping(frame: TypingFrame): void {
    const userId = frame.user_id;
    if (!userId || userId === this.viewerId()) return;
    const slice = this.state.slices[frame.chat_id];
    if (!slice) return;

    const now = this.now();
    const parsed = frame.expires_at ? Date.parse(frame.expires_at) : Number.NaN;
    const expiresAt = Math.max(
      now + 250,
      Number.isFinite(parsed) ? parsed : now + this.config.typingTtlMs,
    );
    const displayName = this.displayNameFor(frame.chat_id, userId);
    const current = (this.state.typing[frame.chat_id] ?? []).filter(
      (entry) => entry.userId !== userId,
    );
    this.patch({
      typing: {
        ...this.state.typing,
        [frame.chat_id]: [...current, { userId, displayName, expiresAt }],
      },
    });
    this.scheduleEphemeralCleanup(`typing:${frame.chat_id}:${userId}`, expiresAt - now, () =>
      this.removeTyping(frame.chat_id, userId, expiresAt),
    );
  }

  private removeTyping(chatId: string, userId: string, expiresAt: number): void {
    const current = this.state.typing[chatId];
    if (!current) return;
    const entry = current.find((item) => item.userId === userId);
    if (!entry || entry.expiresAt !== expiresAt) return;
    this.patch({
      typing: {
        ...this.state.typing,
        [chatId]: current.filter((item) => item.userId !== userId),
      },
    });
  }

  private handlePresence(frame: PresenceFrame): void {
    if (frame.user_id === this.viewerId()) return;
    this.calls.handlePresence(frame.user_id, frame.status === 'ONLINE');
    this.patch({
      presence: {
        ...this.state.presence,
        [frame.user_id]: {
          status: frame.status,
          lastSeenAt: frame.last_seen_at ?? null,
        },
      },
    });

    const key = `presence:${frame.user_id}`;
    this.clearTimer(key);
    if (frame.status !== 'OFFLINE') {
      this.scheduleEphemeralCleanup(key, this.config.presenceTtlMs, () => {
        const current = this.state.presence[frame.user_id];
        if (!current || current.status === 'OFFLINE') return;
        this.patch({
          presence: {
            ...this.state.presence,
            [frame.user_id]: { ...current, status: 'OFFLINE' },
          },
        });
      });
    }
  }

  private scheduleEphemeralCleanup(key: string, delayMs: number, run: () => void): void {
    this.clearTimer(key);
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        if (!this.disposed) run();
      },
      Math.max(0, delayMs),
    );
    this.timers.set(key, timer);
  }

  private async handleResumeGap(frame: ResumeGapFrame): Promise<void> {
    const slice = this.state.slices[frame.chat_id];
    if (!slice || slice.status !== 'ready') return;
    if (this.gapInFlight.has(frame.chat_id)) return;

    this.gapInFlight.add(frame.chat_id);
    try {
      // REST catch-up is authoritative for the gap; live frames that race with
      // it merge by seq/event_id without duplicates.
      await this.catchUp(frame.chat_id, slice.lastSeq);
    } catch (error) {
      const apiError = toApiError(error);
      this.handleFailure(apiError);
      this.patch({ syncStatus: 'error', syncError: apiError });
    } finally {
      this.gapInFlight.delete(frame.chat_id);
    }
  }

  private isActiveChatVisible(chatId: string): boolean {
    if (this.state.activeChatId !== chatId) return false;
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  }

  private viewerId(): string | null {
    return this.state.user?.id ?? this.state.session?.user.id ?? null;
  }

  private displayNameFor(chatId: string, userId: string): string | null {
    const messages = this.state.slices[chatId]?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.sender_id === userId && message.sender_display_name) {
        return message.sender_display_name;
      }
    }
    return null;
  }

  private chatLastSeq(chatId: string): number {
    return this.state.chats.find((chat) => chat.id === chatId)?.last_seq ?? 0;
  }

  private applySync(response: SyncResponse): void {
    const remoteByChat = new Map(response.chats.map((chat) => [chat.chat_id, chat]));
    const slices = { ...this.state.slices };

    for (const remote of response.chats) {
      const slice = slices[remote.chat_id];
      if (!slice) continue;
      // G4f P1-01: `unread_count` is `last_seq - last_read_seq`, so the server
      // read cursor is reconstructible without a contract change. Keep the
      // local cursor monotonic (a user read in this session is never undone).
      const inferredReadSeq = Math.max(0, remote.last_seq - remote.unread_count);
      const readSeq = Math.max(slice.readSeq, inferredReadSeq);
      slices[remote.chat_id] = {
        ...slice,
        readSeq,
        unread: readSeq >= remote.last_seq ? 0 : remote.unread_count,
      };
    }

    const activeChatId = this.state.activeChatId;
    const activeReadSeq = activeChatId ? (slices[activeChatId]?.readSeq ?? 0) : 0;

    const chats = this.state.chats.map((chat) => {
      const remote = remoteByChat.get(chat.id);
      if (!remote) return chat;
      return {
        ...chat,
        last_seq: remote.last_seq,
        unread_count:
          chat.id === activeChatId && activeReadSeq >= remote.last_seq ? 0 : remote.unread_count,
      };
    });

    this.patch({ slices, chats, workspaceUnread: this.withActiveWorkspaceUnread(chats) });
  }
}

function readApiMessage(value: unknown): ApiMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.chat_id !== 'string' || candidate.chat_id.length === 0) return null;
  if (typeof candidate.seq !== 'number' || !Number.isFinite(candidate.seq)) return null;
  if (typeof candidate.created_at !== 'string') return null;
  if (typeof candidate.version !== 'number') return null;
  if (
    candidate.type !== 'TEXT' &&
    candidate.type !== 'STICKER' &&
    candidate.type !== 'SYSTEM' &&
    candidate.type !== 'POLL' &&
    candidate.type !== 'TASK'
  ) {
    return null;
  }
  return value as ApiMessage;
}

/** `(chat_id, type, channel)` is the natural key of a preference row. */
export function notificationPreferenceKey(
  preference: Pick<NotificationPreference, 'chat_id' | 'type' | 'channel'>,
): string {
  return `${preference.chat_id ?? 'global'}|${preference.type}|${preference.channel}`;
}

export function rateLimitSecondsLeft(state: AppState, now: number): number {
  if (!state.rateLimitUntil) return 0;
  return Math.max(0, Math.ceil((state.rateLimitUntil - now) / 1000));
}

function e2eeErrorLabel(error: unknown): string {
  if (isE2eeError(error)) return error.code;
  return 'E2EE_UNAVAILABLE';
}

function failureCode(error: unknown): string {
  if (isE2eeError(error)) return error.code;
  if (isApiError(error)) return error.code;
  return 'UNKNOWN';
}

/** Earliest durable retry deadline across chats; `now` when a row is pending. */
function minNextRetry(statuses: readonly E2eeRetryStatus[]): number | null {
  return statuses.reduce<number | null>((next, status) => {
    if (status.pending === 0 || status.nextAttemptAt === null) return next;
    return next === null ? status.nextAttemptAt : Math.min(next, status.nextAttemptAt);
  }, null);
}

/** D1-FE3: soft-deleted roots cannot accept replies (contract `THREAD_ROOT_DELETED`). */
function threadUnavailableFromError(error: ApiError): ThreadUnavailable {
  if (error.code === 'THREAD_ROOT_DELETED') return 'deleted';
  if (error.code === 'THREAD_ROOT_NOT_FOUND' || error.status === 404) return 'not_found';
  return null;
}

/**
 * Local mirror of the server excerpt: whitespace-normalized, at most 160
 * Unicode code points (never split a surrogate pair), `null` for a sticker or
 * an attachment-only reply (the UI renders its own fallback).
 */
function threadExcerpt(message: ApiMessage): string | null {
  if (message.deleted_at) return null;
  if (message.type === 'STICKER' || message.sticker_id) return null;
  const normalized = (message.text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  const chars = Array.from(normalized);
  if (chars.length <= 160) return normalized;
  return `${chars.slice(0, 159).join('')}…`;
}

/** Removes the optimistic reply row when its own live `message.created` wins. */
function settleThreadOutbox(thread: ThreadSlice, message: ApiMessage): OutgoingMessage[] {
  const clientId = message.client_message_id ?? null;
  const text = message.text ?? '';
  return thread.outbox.filter((entry) => {
    if (clientId !== null) return entry.clientMessageId !== clientId;
    return !(entry.kind === 'TEXT' && entry.text === text);
  });
}

/** Server plaintext fields in an E2EE message are a security alert (§4.3 P2-13). */
function hasServerPlaintext(message: ApiMessage): boolean {
  if (typeof message.text === 'string' && message.text.length > 0) return true;
  if (typeof message.reply_to_id === 'string' && message.reply_to_id.length > 0) return true;
  if (message.sticker_id !== undefined && message.sticker_id !== null) return true;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return true;
  return false;
}

export function createChatStore(deps: ChatStoreDeps): ChatStore {
  return new ChatStore(deps);
}
