import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  ChatJoinPolicy,
  ChatPermissionKey,
  ChatPermissionRole,
  ChatPermissions,
  ChatPermissionsUpdate,
  ChatRolePermissions,
  ChatRolePermissionsUpdate,
  ChatSummary,
  ChatUpdateRequest,
} from '../api/types';
import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { safeHttpUrl } from '../files/format';
import { t, type MessageKey } from '../i18n/ru';
import { useFilesStore, useChatState, useChatStore } from '../store/ChatProvider';
import {
  CHAT_PERMISSION_KEYS,
  CHAT_PERMISSION_ROLES,
  chatPermissionAllowed,
  defaultChatPermissions,
} from '../store/chatStore';
import { AdminConfirmDialog } from './admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from './admin/actionErrors';
import { ChatInvitesPanel } from './chat-settings/ChatInvitesPanel';
import { ChatMembersPanel } from './chat-settings/ChatMembersPanel';
import { blockErrorText, chatMembershipErrorText } from './chat-settings/errors';
import { CloseIcon, LockIcon } from './Icons';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

type TabId = 'main' | 'members' | 'rights' | 'privacy' | 'danger';

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Mirrors the server: trim, collapse internal runs of whitespace. */
function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Mirrors the server: CRLF -> LF, trim; empty clears to null. */
function normalizeDescription(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/** Server rule: control chars are rejected; description also allows LF/TAB. */
function hasDisallowedControl(value: string, allowed: ReadonlySet<number>): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !allowed.has(code)) return true;
  }
  return false;
}

const NAME_NO_CONTROL = new Set<number>();
const DESCRIPTION_CONTROL_ALLOWED = new Set<number>([0x09, 0x0a]);

function nameError(value: string): string | null {
  if (value.length === 0) return t('chatSettings.nameRequired');
  if (codePointLength(value) > NAME_MAX) return t('chatSettings.nameTooLong');
  if (value.includes('<') || value.includes('>') || hasDisallowedControl(value, NAME_NO_CONTROL)) {
    return t('chatSettings.nameInvalid');
  }
  return null;
}

function descriptionError(value: string): string | null {
  if (codePointLength(value) > DESCRIPTION_MAX) return t('chatSettings.descriptionTooLong');
  if (
    value.includes('<') ||
    value.includes('>') ||
    hasDisallowedControl(value, DESCRIPTION_CONTROL_ALLOWED)
  ) {
    return t('chatSettings.descriptionInvalid');
  }
  return null;
}

/**
 * D1-FE5 translated `PATCH /chats/{chatId}` failures. The server owns every
 * guard (workspace role, E2EE policy, validation); the UI only explains it.
 */
function chatSettingsErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatSettings.error.forbidden');
  if (error.status === 404) return t('chatSettings.error.notFound');
  if (error.status === 409) return t('chatSettings.error.conflict');
  if (error.status === 422) {
    if (error.code === 'CHAT_SETTINGS_E2EE_UNSUPPORTED') return t('chatSettings.error.e2ee');
    const field = error.details?.field;
    if (field === 'name') return t('chatSettings.error.name');
    if (field === 'description') return t('chatSettings.error.description');
    return t('chatSettings.error.validation');
  }
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatSettings.error.generic');
}

function blockActionErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: blockErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

/** #80 cover errors: the server owns every attachment/role guard. */
function coverErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatSettings.cover.error.forbidden');
  if (error.status === 404) return t('chatSettings.cover.error.notFound');
  if (error.status === 409) return t('chatSettings.cover.error.notReady');
  if (error.status === 423) return t('chatSettings.cover.error.quarantined');
  if (error.status === 422) {
    if (error.code === 'CHAT_SETTINGS_E2EE_UNSUPPORTED') return t('chatSettings.error.e2ee');
    if (error.code === 'CHAT_MEMBERSHIP_UNSUPPORTED') {
      return t('chatSettings.directUnsupported');
    }
    return t('chatSettings.cover.error.invalid');
  }
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatSettings.error.generic');
}

/** #80 rights-matrix errors. */
function rightsErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatSettings.rights.error.forbidden');
  if (error.status === 404) return t('chatSettings.error.notFound');
  if (error.status === 422) return t('chatSettings.rights.error.validation');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatSettings.error.generic');
}

/** #80 archive/delete errors. */
function archiveErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatSettings.dangerError.forbidden');
  if (error.status === 404) return t('chatSettings.error.notFound');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatSettings.error.generic');
}

const PERMISSION_LABEL: Record<ChatPermissionKey, MessageKey> = {
  post_messages: 'chatSettings.rights.post_messages',
  invite_members: 'chatSettings.rights.invite_members',
  create_polls: 'chatSettings.rights.create_polls',
  start_calls: 'chatSettings.rights.start_calls',
  pin_messages: 'chatSettings.rights.pin_messages',
  change_info: 'chatSettings.rights.change_info',
};

const PERMISSION_HINT: Record<ChatPermissionKey, MessageKey> = {
  post_messages: 'chatSettings.rights.post_messagesHint',
  invite_members: 'chatSettings.rights.invite_membersHint',
  create_polls: 'chatSettings.rights.create_pollsHint',
  start_calls: 'chatSettings.rights.start_callsHint',
  pin_messages: 'chatSettings.rights.pin_messagesHint',
  change_info: 'chatSettings.rights.change_infoHint',
};

const ROLE_LABEL: Record<ChatPermissionRole, MessageKey> = {
  OWNER: 'chatMembers.role.OWNER',
  ADMIN: 'chatMembers.role.ADMIN',
  MODERATOR: 'chatMembers.role.MODERATOR',
  MEMBER: 'chatMembers.role.MEMBER',
  GUEST: 'chatMembers.role.GUEST',
};

const EDITABLE_MATRIX_ROLES: readonly ChatPermissionRole[] = CHAT_PERMISSION_ROLES.filter(
  (role) => role !== 'OWNER',
);

const ROLE_KEY = {
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  MEMBER: 'member',
  GUEST: 'guest',
} as const;

function roleRights(matrix: ChatPermissions, role: ChatPermissionRole): ChatRolePermissions {
  if (role === 'OWNER') return matrix.owner ?? defaultChatPermissions().owner ?? {};
  return matrix[ROLE_KEY[role as keyof typeof ROLE_KEY]] ?? {};
}

function hasRightsChanges(draft: ChatPermissions, base: ChatPermissions | null): boolean {
  if (!base) return false;
  return EDITABLE_MATRIX_ROLES.some((role) =>
    CHAT_PERMISSION_KEYS.some(
      (permission) => roleRights(draft, role)[permission] !== roleRights(base, role)[permission],
    ),
  );
}

/** Only the changed role rights are sent; an empty object is never PATCHed. */
function rightsPatch(draft: ChatPermissions, base: ChatPermissions): ChatPermissionsUpdate {
  const patch: ChatPermissionsUpdate = {};
  for (const role of EDITABLE_MATRIX_ROLES) {
    const next = roleRights(draft, role);
    const previous = roleRights(base, role);
    const changed: ChatRolePermissionsUpdate = {};
    let count = 0;
    for (const permission of CHAT_PERMISSION_KEYS) {
      if (next[permission] === previous[permission]) continue;
      changed[permission] = next[permission] === true;
      count += 1;
    }
    if (count > 0) patch[ROLE_KEY[role as keyof typeof ROLE_KEY]] = changed;
  }
  return patch;
}

const COVER_BY_MODE = {
  managed: '/covers/cover-atlas.svg',
  e2ee: '/covers/cover-family.svg',
  direct: '/covers/cover-dm.svg',
} as const;

export interface ChatSettingsDialogProps {
  open: boolean;
  chat: ChatSummary | null;
  onClose: () => void;
}

/**
 * D1 UX fidelity 2 chat settings.
 *
 * - 820 px / r18 / 58 px header + 42 px tabs (`Основное`, `Участники`, `Права`,
 *   `Опасная зона`; DIRECT: `Приватность`).
 * - `PATCH /chats/{chatId}` (name/description), #79 channel members, invite
 *   links, leave and DIRECT block are wired. Rights, cover upload, privacy
 *   toggles, archive/delete stay honestly disabled until their APIs land.
 * - No optimistic update: the header/list change only after a server response.
 * - Focus trap, Escape, focus return, labelled/described, 390 px friendly.
 * - Nested confirm dialogs own Escape/focus; the parent trap pauses meanwhile.
 */
export function ChatSettingsDialog({ open, chat, onClose }: ChatSettingsDialogProps) {
  const store = useChatStore();
  const filesStore = useFilesStore();
  const state = useChatState();
  const settings = state.chatSettings;
  const permissions = state.chatPermissions;
  const coverState = state.chatCover;
  const archiveState = state.chatArchive;
  const deletionState = state.chatDeletion;
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const leadId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();
  const descriptionErrorId = useId();
  const e2eeNoteId = useId();
  const readOnlyId = useId();
  const dangerNoteId = useId();
  const coverHintId = useId();

  const [activeTab, setActiveTab] = useState<TabId>('main');
  const [name, setName] = useState(chat?.name ?? '');
  const [description, setDescription] = useState(chat?.description ?? '');
  const [readOnly, setReadOnly] = useState(chat?.read_only ?? false);
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>(
    chat?.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
  );
  const [joinPolicy, setJoinPolicy] = useState<ChatJoinPolicy>(chat?.join_policy ?? 'INVITE_ONLY');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; description?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [nestedModalOpen, setNestedModalOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [rightsDraft, setRightsDraft] = useState<ChatPermissions | null>(null);
  const [rightsNotice, setRightsNotice] = useState<string | null>(null);
  const [dangerNotice, setDangerNotice] = useState<string | null>(null);
  const initializedFor = useRef<string | null>(null);

  const role = state.activeWorkspace?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const isE2ee = (chat?.security_mode ?? 'MANAGED') === 'E2EE';
  const isDirect = chat?.type === 'DIRECT';
  const saving = settings.status === 'saving' && settings.chatId === chat?.id;
  const serverError = settings.status === 'error' ? settings.error : null;
  const serverField =
    serverError?.details?.field === 'name' || serverError?.details?.field === 'description'
      ? serverError.details.field
      : null;
  const viewerId = state.user?.id ?? state.me?.user.id ?? state.session?.user.id ?? null;
  const chatMembers = chat && state.chatMembers.chatId === chat.id ? state.chatMembers : null;
  const chatMemberCount = chatMembers?.status === 'ready' ? chatMembers.items.length : null;
  const actorChatRole =
    chatMembers?.items.find((member) => member.user_id === viewerId)?.role ?? null;
  /** Structural settings (cover/read-only/visibility/rights) need chat OWNER/ADMIN. */
  const canManageStructure =
    isDirect === false && (actorChatRole === 'OWNER' || actorChatRole === 'ADMIN');
  const structureDisabledReason = isDirect
    ? t('chatSettings.directUnsupported')
    : actorChatRole === null
      ? t('chatSettings.structureLoading')
      : t('chatSettings.structureForbidden');
  /**
   * P0-2 (#80): name/description accept workspace OWNER/ADMIN *or* a chat role
   * with `change_info`. The matrix is loaded with the dialog, so a delegated
   * MEMBER gets the form enabled once the server response arrives.
   */
  const canManageName =
    canManage ||
    (actorChatRole !== null &&
      chatPermissionAllowed(
        permissions.chatId === chat?.id ? permissions.matrix : null,
        actorChatRole,
        'change_info',
      ));
  const peerMember = chat?.peer_id
    ? (chatMembers?.items.find((member) => member.user_id === chat.peer_id) ?? null)
    : null;
  const peerName = peerMember?.display_name ?? chat?.name?.trim() ?? t('chat.group');
  const blockedUsers = state.blockedUsers;
  const peerBlocked =
    chat?.peer_id !== null &&
    chat?.peer_id !== undefined &&
    blockedUsers.items.some((item) => item.user_id === chat.peer_id);
  const blockPending =
    chat?.peer_id !== null &&
    chat?.peer_id !== undefined &&
    blockedUsers.pendingUserId === chat.peer_id;
  const blockActionError =
    chat?.peer_id !== null &&
    chat?.peer_id !== undefined &&
    blockedUsers.actionError?.userId === chat.peer_id
      ? blockedUsers.actionError.error
      : null;
  const leavePending = chatMembers?.leaveStatus === 'leaving';
  const leaveError = chatMembers?.leaveStatus === 'error' ? chatMembers.leaveError : null;

  // Reset only when the dialog opens or switches to another chat; a live
  // summary refresh must not overwrite the draft.
  useEffect(() => {
    if (!open) {
      initializedFor.current = null;
      return;
    }
    const key = chat?.id ?? null;
    if (initializedFor.current === key) return;
    initializedFor.current = key;
    setName(chat?.name ?? '');
    setDescription(chat?.description ?? '');
    setReadOnly(chat?.read_only ?? false);
    setVisibility(chat?.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE');
    setJoinPolicy(chat?.join_policy ?? 'INVITE_ONLY');
    setFieldErrors({});
    setNotice(null);
    setDangerNotice(null);
    setNestedModalOpen(false);
    setBlockOpen(false);
    setLeaveOpen(false);
    setDeleteOpen(false);
    setCoverPickerOpen(false);
    setCoverUrl(null);
    setRightsDraft(null);
    setRightsNotice(null);
    setActiveTab('main');
    store.clearChatSettings();
    store.clearChatMembers();
    store.clearChatInvites();
    store.clearChatPermissions();
    store.clearChatCover();
    store.clearChatArchive();
  }, [open, chat, store]);

  // #79: the participant directory supplies the viewer's channel role and the
  // cover count; DIRECT also returns the peer row used by the block card.
  useEffect(() => {
    if (!open || !chat) return;
    void store.loadChatMembers(chat.id);
  }, [chat, open, store]);

  // #80: the rights matrix is readable by every ACTIVE participant, but only
  // chat OWNER/ADMIN may save it. Loaded on open so the tab has real values.
  useEffect(() => {
    if (!open || !chat || chat.type === 'DIRECT') return;
    void store.loadChatPermissions(chat.id);
  }, [chat, open, store]);

  // #80: the current cover is an attachment id; a download URL is obtained
  // lazily and a failure keeps the static design fallback.
  useEffect(() => {
    const coverFileId = chat?.cover_file_id ?? null;
    setCoverUrl(null);
    if (!open || !coverFileId) return;
    let active = true;
    void filesStore
      .getDownloadUrl(coverFileId)
      .then((download) => {
        if (active) setCoverUrl(download.url);
      })
      .catch(() => {
        // Static fallback below; the picker still works.
      });
    return () => {
      active = false;
    };
  }, [chat?.cover_file_id, filesStore, open]);

  // DIRECT danger actions need the own-block list to render block vs unblock.
  useEffect(() => {
    if (!open || activeTab !== 'danger' || chat?.type !== 'DIRECT') return;
    void store.loadBlockedUsers();
  }, [activeTab, chat?.type, open, store]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  const nestedModal = nestedModalOpen || blockOpen || leaveOpen || deleteOpen;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // A nested confirm owns Escape and the focus trap while it is mounted.
      if (nestedModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [nestedModal, onClose, open, saving]);

  if (!open || !chat) return null;

  const normalizedName = normalizeName(name);
  const normalizedDescription = normalizeDescription(description);
  const originalName = chat.name ?? '';
  const originalDescription = chat.description ?? '';
  const originalReadOnly = chat.read_only ?? false;
  const originalVisibility = chat.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE';
  const originalJoinPolicy = chat.join_policy ?? 'INVITE_ONLY';
  const nameChanged = canManageName && normalizedName !== originalName;
  const descriptionChanged =
    canManageName && !isE2ee && normalizedDescription !== originalDescription;
  const readOnlyChanged = canManageStructure && readOnly !== originalReadOnly;
  const visibilityChanged = canManageStructure && visibility !== originalVisibility;
  const joinPolicyChanged = canManageStructure && joinPolicy !== originalJoinPolicy;
  const dirty =
    nameChanged || descriptionChanged || readOnlyChanged || visibilityChanged || joinPolicyChanged;

  const handleFieldChange = () => {
    if (notice) setNotice(null);
    if (settings.status !== 'idle') store.clearChatSettings();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((!canManageName && !canManageStructure) || saving) return;
    setNotice(null);

    const nextErrors: { name?: string; description?: string } = {};
    if (canManageName) {
      const nextNameError = nameError(normalizedName);
      if (nextNameError) nextErrors.name = nextNameError;
      if (!isE2ee) {
        const nextDescriptionError = descriptionError(normalizedDescription);
        if (nextDescriptionError) nextErrors.description = nextDescriptionError;
      }
    }
    setFieldErrors(nextErrors);
    if (nextErrors.name || nextErrors.description) return;

    if (!dirty) {
      setNotice(t('chatSettings.noChanges'));
      return;
    }

    const patch: ChatUpdateRequest = {};
    if (nameChanged) patch.name = normalizedName;
    if (descriptionChanged) patch.description = normalizedDescription;
    if (readOnlyChanged) patch.read_only = readOnly;
    if (visibilityChanged) patch.visibility = visibility;
    if (joinPolicyChanged) {
      // PUBLIC is always OPEN; the server also forces it.
      patch.join_policy = visibility === 'PUBLIC' ? 'OPEN' : joinPolicy;
    }

    const ok = await store.saveChatSettings(chat.id, patch);
    if (!ok) return;
    setName(normalizedName);
    setDescription(normalizedDescription);
    setFieldErrors({});
    setNotice(t('chatSettings.saved'));
  };

  const handleBlockConfirm = async () => {
    if (!chat.peer_id) return;
    const ok = await store.blockUser(chat.peer_id);
    if (!ok) return;
    setBlockOpen(false);
    setDangerNotice(t('chatSettings.blockDone'));
  };

  const handleUnblock = async () => {
    if (!chat.peer_id) return;
    setDangerNotice(null);
    const ok = await store.unblockUser(chat.peer_id);
    if (ok) setDangerNotice(t('chatSettings.unblockDone'));
  };

  const handleLeaveConfirm = async () => {
    const ok = await store.leaveChat(chat.id);
    if (!ok) return;
    setLeaveOpen(false);
    onClose();
  };

  const descriptionDisabled = !canManageName || isE2ee;
  const descriptionValue = isE2ee ? '' : description;
  const nameServerInvalid = serverField === 'name';
  const descriptionServerInvalid = serverField === 'description';
  const tabs: ReadonlyArray<{ id: TabId; label: string }> = isDirect
    ? [
        { id: 'main', label: t('chatSettings.tab.main') },
        { id: 'privacy', label: t('chatSettings.tab.privacy') },
        { id: 'danger', label: t('chatSettings.tab.danger') },
      ]
    : [
        { id: 'main', label: t('chatSettings.tab.main') },
        { id: 'members', label: t('chatSettings.tab.members') },
        { id: 'rights', label: t('chatSettings.tab.rights') },
        { id: 'danger', label: t('chatSettings.tab.danger') },
      ];
  const cover = isDirect
    ? COVER_BY_MODE.direct
    : isE2ee
      ? COVER_BY_MODE.e2ee
      : COVER_BY_MODE.managed;
  const typeLabel = isDirect ? t('chatSettings.type.direct') : t('chatSettings.type.group');
  const modeLabel = isE2ee ? t('chatSettings.mode.e2ee') : t('chatSettings.mode.managed');
  const currentCover = coverUrl ?? cover;
  const coverBusy =
    coverState.chatId === chat.id &&
    (coverState.actionStatus === 'saving' || coverState.actionStatus === 'removing');
  const coverActionError =
    coverState.chatId === chat.id && coverState.actionStatus === 'error'
      ? coverState.actionError
      : null;
  const coverImagesLoading = coverState.chatId === chat.id && coverState.imagesStatus === 'loading';
  const coverImagesError =
    coverState.chatId === chat.id && coverState.imagesStatus === 'error'
      ? coverState.imagesError
      : null;
  const coverImages = coverState.chatId === chat.id ? coverState.images : [];
  const coverDisabledReason = isE2ee
    ? t('chatSettings.cover.error.e2ee')
    : !canManageStructure
      ? structureDisabledReason
      : null;

  const baseMatrix =
    permissions.chatId === chat.id && permissions.status === 'ready' ? permissions.matrix : null;
  const matrix = rightsDraft ?? baseMatrix ?? defaultChatPermissions();
  const rightsDirty = baseMatrix !== null && hasRightsChanges(matrix, baseMatrix);
  const canEditRights = canManageStructure && baseMatrix !== null;
  const rightsLoading = permissions.chatId === chat.id && permissions.status === 'loading';
  const rightsLoadError =
    permissions.chatId === chat.id && permissions.status === 'error' ? permissions.error : null;
  const rightsSaveError =
    permissions.chatId === chat.id && permissions.saveStatus === 'error'
      ? permissions.saveError
      : null;
  const rightsSaving = permissions.chatId === chat.id && permissions.saveStatus === 'saving';
  const archiveBusy =
    archiveState.chatId === chat.id &&
    (archiveState.status === 'archiving' || archiveState.status === 'unarchiving');
  const archiveError =
    archiveState.chatId === chat.id && archiveState.status === 'error' ? archiveState.error : null;
  const deleting = deletionState.chatId === chat.id && deletionState.status === 'deleting';
  const deleteError =
    deletionState.chatId === chat.id && deletionState.status === 'error'
      ? deletionState.error
      : null;
  const canDelete = actorChatRole === 'OWNER';
  const dangerBusy = archiveBusy || deleting || leavePending;

  const handleSelectCover = async (fileId: string) => {
    setDangerNotice(null);
    const ok = await store.setChatCover(chat.id, fileId);
    if (!ok) return;
    setCoverPickerOpen(false);
    setNotice(t('chatSettings.cover.saved'));
  };

  const handleRemoveCover = async () => {
    setDangerNotice(null);
    const ok = await store.removeChatCover(chat.id);
    if (ok) setNotice(t('chatSettings.cover.removed'));
  };

  const handleToggleRight = (role: ChatPermissionRole, permission: ChatPermissionKey) => {
    if (!canEditRights) return;
    setRightsNotice(null);
    setRightsDraft((current) => {
      const draft = current ?? matrix;
      const rights = roleRights(draft, role);
      return {
        ...draft,
        [ROLE_KEY[role as keyof typeof ROLE_KEY]]: {
          ...rights,
          [permission]: !(rights[permission] === true),
        },
      };
    });
  };

  const handleSaveRights = async () => {
    if (!baseMatrix || rightsSaving) return;
    setRightsNotice(null);
    if (!rightsDirty) {
      setRightsNotice(t('chatSettings.rights.noChanges'));
      return;
    }
    const ok = await store.saveChatPermissions(chat.id, rightsPatch(matrix, baseMatrix));
    if (!ok) return;
    setRightsDraft(null);
    setRightsNotice(t('chatSettings.rights.saved'));
  };

  const handleArchive = async () => {
    setDangerNotice(null);
    const ok = chat.archived
      ? await store.unarchiveChat(chat.id)
      : await store.archiveChat(chat.id);
    if (!ok) return;
    setDangerNotice(t(chat.archived ? 'chatSettings.unarchiveDone' : 'chatSettings.archiveDone'));
    if (!chat.archived) onClose();
  };

  const handleDeleteConfirm = async () => {
    const ok = await store.deleteOwnChat(chat.id);
    if (!ok) return;
    setDeleteOpen(false);
    onClose();
  };

  const membersPane = (
    <>
      <ChatInvitesPanel
        chatId={chat.id}
        actorRole={actorChatRole}
        variant="members"
        onNestedModalChange={setNestedModalOpen}
      />
      <ChatMembersPanel chat={chat} onLeft={onClose} onNestedModalChange={setNestedModalOpen} />
    </>
  );

  const mainPane = (
    <>
      <div className="chat-settings-head">
        <span className="chat-settings-cover">
          <img src={currentCover} alt={t('chatSettings.cover.current')} />
        </span>
        <div>
          <div className="cs-name">{chat.name?.trim() || t('chatSettings.type.direct')}</div>
          <small>
            {chatMemberCount !== null
              ? t('chatSettings.coverMeta', { count: chatMemberCount, mode: modeLabel })
              : t('chatSettings.coverMetaLoading', { mode: modeLabel })}
          </small>
        </div>
        <div className="chat-settings-head__cover-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={coverDisabledReason !== null || coverBusy || saving}
            title={coverDisabledReason ?? t('chatSettings.cover.pickerHint')}
            aria-describedby={coverHintId}
            aria-expanded={coverPickerOpen}
            onClick={() => {
              setCoverPickerOpen((open) => !open);
              if (!coverPickerOpen) void store.loadChatCoverImages(chat.id);
            }}
          >
            {coverBusy && coverState.actionStatus === 'saving'
              ? t('chatSettings.cover.working')
              : t('chatSettings.cover.change')}
          </button>
          {chat.cover_file_id && canManageStructure ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={coverBusy || saving}
              onClick={() => void handleRemoveCover()}
            >
              {coverState.actionStatus === 'removing'
                ? t('chatSettings.cover.removing')
                : t('chatSettings.cover.remove')}
            </button>
          ) : null}
        </div>
      </div>
      <p className="chat-settings-cover-hint" id={coverHintId}>
        {isE2ee
          ? t('chatSettings.cover.error.e2ee')
          : canManageStructure || isDirect
            ? t('chatSettings.cover.pickerHint')
            : structureDisabledReason}
      </p>
      {coverActionError ? (
        <p className="chat-settings-error" role="alert">
          {coverErrorText(coverActionError)}
        </p>
      ) : null}
      {coverPickerOpen && !isDirect && !isE2ee ? (
        <section className="cover-picker" aria-label={t('chatSettings.cover.pickerTitle')}>
          <p className="cover-picker__title">{t('chatSettings.cover.pickerTitle')}</p>
          {coverImagesLoading ? (
            <p className="pane-sub">{t('chatSettings.cover.loading')}</p>
          ) : coverImagesError ? (
            <div>
              <p className="chat-settings-error" role="alert">
                {coverErrorText(coverImagesError)}
              </p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void store.loadChatCoverImages(chat.id, true)}
              >
                {t('chatSettings.cover.retry')}
              </button>
            </div>
          ) : coverImages.length === 0 ? (
            <p className="pane-sub">{t('chatSettings.cover.empty')}</p>
          ) : (
            <ul className="cover-picker__grid">
              {coverImages.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="cover-picker__item"
                    disabled={coverBusy || item.id === chat.cover_file_id}
                    aria-label={`${item.filename ?? item.id}: ${t('chatSettings.cover.select')}`}
                    onClick={() => void handleSelectCover(item.id)}
                  >
                    {safeHttpUrl(item.media?.artwork_url) ? (
                      <img
                        src={safeHttpUrl(item.media?.artwork_url) ?? undefined}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className="cover-picker__fallback" aria-hidden="true">
                        {item.filename ?? 'IMG'}
                      </span>
                    )}
                    <span className="cover-picker__name">
                      {item.filename ?? t('chatSettings.cover.select')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <form
        id="chat-settings-form"
        className="chat-settings-form"
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
      >
        <section className="chat-settings-section" aria-labelledby={`${nameId}-section`}>
          <h3 className="chat-settings-section__title" id={`${nameId}-section`}>
            {t('chatSettings.main')}
          </h3>
          <div className="field">
            <label className="field__label" htmlFor={nameId}>
              {t('chatSettings.name')}
            </label>
            <input
              ref={nameRef}
              id={nameId}
              className="field__input"
              type="text"
              value={name}
              autoComplete="off"
              disabled={!canManageName || saving}
              aria-invalid={Boolean(fieldErrors.name) || nameServerInvalid}
              aria-describedby={[
                nameHintId,
                fieldErrors.name ? nameErrorId : null,
                !canManageName ? readOnlyId : null,
              ]
                .filter(Boolean)
                .join(' ')}
              onChange={(event) => {
                setName(event.target.value);
                if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
                handleFieldChange();
              }}
            />
            <div className="field__meta">
              <span id={nameHintId}>{t('chatSettings.nameHint')}</span>
              <span className="chat-settings-counter" aria-hidden="true">
                {codePointLength(normalizedName)}/{NAME_MAX}
              </span>
            </div>
            {fieldErrors.name ? (
              <p className="field__error" id={nameErrorId} role="alert">
                {fieldErrors.name}
              </p>
            ) : null}
          </div>
        </section>

        <section className="chat-settings-section" aria-labelledby={`${descriptionId}-section`}>
          <h3 className="chat-settings-section__title" id={`${descriptionId}-section`}>
            {t('chatSettings.description')}
          </h3>
          <div className="field">
            <label className="field__label" htmlFor={descriptionId}>
              {t('chatSettings.description')}
            </label>
            <textarea
              id={descriptionId}
              className="field__input chat-settings-description"
              value={descriptionValue}
              rows={4}
              disabled={descriptionDisabled || saving}
              aria-invalid={Boolean(fieldErrors.description) || descriptionServerInvalid}
              aria-describedby={[
                descriptionHintId,
                fieldErrors.description ? descriptionErrorId : null,
                isE2ee ? e2eeNoteId : null,
                !canManageName ? readOnlyId : null,
              ]
                .filter(Boolean)
                .join(' ')}
              onChange={(event) => {
                setDescription(event.target.value);
                if (fieldErrors.description) {
                  setFieldErrors((prev) => ({ ...prev, description: undefined }));
                }
                handleFieldChange();
              }}
            />
            <div className="field__meta">
              <span id={descriptionHintId}>{t('chatSettings.descriptionHint')}</span>
              {!isE2ee ? (
                <span className="chat-settings-counter" aria-hidden="true">
                  {codePointLength(normalizedDescription)}/{DESCRIPTION_MAX}
                </span>
              ) : null}
            </div>
            {fieldErrors.description ? (
              <p className="field__error" id={descriptionErrorId} role="alert">
                {fieldErrors.description}
              </p>
            ) : null}
          </div>
          {isE2ee ? (
            <div className="chat-settings-e2ee" id={e2eeNoteId}>
              <LockIcon aria-hidden="true" />
              <div>
                <p className="chat-settings-e2ee__title">{t('chatSettings.e2eeTitle')}</p>
                <p className="chat-settings-e2ee__text">{t('chatSettings.e2eeDescription')}</p>
              </div>
            </div>
          ) : null}
        </section>

        {!isDirect ? (
          <section className="chat-settings-section" aria-labelledby={`${readOnlyId}-policy`}>
            <h3 className="chat-settings-section__title" id={`${readOnlyId}-policy`}>
              {t('chatSettings.structure.title')}
            </h3>
            <p className="chat-settings-section__hint">{t('chatSettings.structure.hint')}</p>
            <label className="chat-toggle">
              <input
                type="checkbox"
                checked={readOnly}
                disabled={!canManageStructure || saving}
                aria-describedby={`${readOnlyId}-hint`}
                onChange={(event) => {
                  setReadOnly(event.target.checked);
                  handleFieldChange();
                }}
              />
              <span className="chat-toggle__body">
                <b>{t('chatSettings.readOnlyLabel')}</b>
                <small id={`${readOnlyId}-hint`}>{t('chatSettings.readOnlyHint')}</small>
              </span>
            </label>
            {!canManageStructure ? (
              <p className="chat-settings-readonly">{structureDisabledReason}</p>
            ) : null}
            <div className="form-grid">
              <div className="form-row">
                <label htmlFor={`${readOnlyId}-visibility`}>
                  {t('chatSettings.visibilityLabel')}
                </label>
                <select
                  id={`${readOnlyId}-visibility`}
                  className="select"
                  value={visibility}
                  disabled={!canManageStructure || saving}
                  onChange={(event) => {
                    const next = event.target.value === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE';
                    setVisibility(next);
                    if (next === 'PUBLIC') setJoinPolicy('OPEN');
                    else if (joinPolicy === 'OPEN') setJoinPolicy('INVITE_ONLY');
                    handleFieldChange();
                  }}
                >
                  <option value="PUBLIC">{t('chatSettings.visibility.PUBLIC')}</option>
                  <option value="PRIVATE">{t('chatSettings.visibility.PRIVATE')}</option>
                </select>
              </div>
              <div className="form-row">
                <label htmlFor={`${readOnlyId}-join-policy`}>
                  {t('chatSettings.joinPolicyLabel')}
                </label>
                <select
                  id={`${readOnlyId}-join-policy`}
                  className="select"
                  value={visibility === 'PUBLIC' ? 'OPEN' : joinPolicy}
                  disabled={!canManageStructure || saving || visibility === 'PUBLIC'}
                  onChange={(event) => {
                    setJoinPolicy(event.target.value as ChatJoinPolicy);
                    handleFieldChange();
                  }}
                >
                  <option value="OPEN">{t('chatSettings.joinPolicy.OPEN')}</option>
                  <option value="INVITE_ONLY">{t('chatSettings.joinPolicy.INVITE_ONLY')}</option>
                  <option value="CLOSED">{t('chatSettings.joinPolicy.CLOSED')}</option>
                </select>
              </div>
            </div>
            <p className="pane-sub">{t('chatSettings.joinPolicyHint')}</p>
            {canManageStructure && !canManageName ? (
              <div className="form-actions">
                <button
                  type="submit"
                  className="btn btn--accent"
                  disabled={saving}
                  aria-busy={saving}
                >
                  {saving ? t('chatSettings.saving') : t('chatSettings.structure.save')}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="chat-type">{t('chatSettings.type')}</label>
            <select id="chat-type" className="select" disabled value={typeLabel}>
              <option>{typeLabel}</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="chat-mode">{t('chatSettings.mode')}</label>
            <input id="chat-mode" className="input" value={modeLabel} readOnly />
          </div>
        </div>

        {!isDirect ? (
          <ChatInvitesPanel
            chatId={chat.id}
            actorRole={actorChatRole}
            variant="main"
            onOpenMembers={() => setActiveTab('members')}
          />
        ) : null}

        {!isDirect ? (
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setActiveTab('members')}>
              {t('chatSettings.openChatMembers')}
            </button>
          </div>
        ) : null}
      </form>
    </>
  );

  return (
    <div
      className="modal-layer chat-settings-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal--lg chat-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {t('chatSettings.title')}
          </h2>
          <span className="modal-sub" id={leadId}>
            {chat.name?.trim() || t('chatSettings.type.direct')}
          </span>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            disabled={saving}
            aria-label={t('chatSettings.close')}
            title={t('chatSettings.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <div className="modal-tabs" role="tablist" aria-label={t('chatSettings.title')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`chat-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`chat-pane-${tab.id}`}
              className={`modal-tab${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.id === 'main') {
                  window.setTimeout(() => nameRef.current?.focus(), 0);
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {!canManageName ? (
            <p className="chat-settings-readonly" id={readOnlyId}>
              {t('chatSettings.readOnly')}
            </p>
          ) : null}

          {notice ? (
            <p className="chat-settings-notice" role="status">
              {notice}
            </p>
          ) : null}

          {serverError ? (
            <p className="chat-settings-error" role="alert">
              {chatSettingsErrorText(serverError)}
            </p>
          ) : null}

          <div
            role="tabpanel"
            id={`chat-pane-${activeTab}`}
            aria-labelledby={`chat-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'main' ? mainPane : null}

            {activeTab === 'members' ? membersPane : null}

            {activeTab === 'rights' ? (
              <section className="chat-rights" aria-label={t('chatSettings.rights.title')}>
                <div className="chat-rights__head">
                  <div>
                    <h3 className="chat-settings-section__title">
                      {t('chatSettings.rights.title')}
                    </h3>
                    <p className="pane-sub">{t('chatSettings.rights.hint')}</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setRightsDraft(null);
                      setRightsNotice(null);
                      void store.loadChatPermissions(chat.id, true);
                    }}
                    disabled={rightsLoading}
                    aria-busy={rightsLoading}
                  >
                    {rightsLoading ? t('common.loading') : t('chatSettings.rights.retry')}
                  </button>
                </div>

                {!canManageStructure && baseMatrix ? (
                  <p className="chat-settings-readonly">{t('chatSettings.rights.readOnly')}</p>
                ) : null}
                {rightsNotice ? (
                  <p className="chat-settings-notice" role="status">
                    {rightsNotice}
                  </p>
                ) : null}
                {rightsSaveError ? (
                  <p className="chat-settings-error" role="alert">
                    {rightsErrorText(rightsSaveError)}
                  </p>
                ) : null}

                {rightsLoading && !baseMatrix ? (
                  <p className="pane-sub" role="status">
                    {t('chatSettings.rights.loading')}
                  </p>
                ) : rightsLoadError && !baseMatrix ? (
                  <div>
                    <p className="chat-settings-error" role="alert">
                      {rightsErrorText(rightsLoadError)}
                    </p>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void store.loadChatPermissions(chat.id, true)}
                    >
                      {t('chatSettings.rights.retry')}
                    </button>
                  </div>
                ) : baseMatrix ? (
                  <>
                    <div className="rights-matrix-wrap">
                      <table className="rights-matrix">
                        <caption className="visually-hidden">
                          {t('chatSettings.rights.title')}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">{t('chatSettings.rights.permission')}</th>
                            {CHAT_PERMISSION_ROLES.map((role) => (
                              <th scope="col" key={role}>
                                {t(ROLE_LABEL[role])}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {CHAT_PERMISSION_KEYS.map((permission) => (
                            <tr key={permission}>
                              <th scope="row">
                                <b>{t(PERMISSION_LABEL[permission])}</b>
                                <small>{t(PERMISSION_HINT[permission])}</small>
                              </th>
                              {CHAT_PERMISSION_ROLES.map((role) => {
                                const checked =
                                  role === 'OWNER'
                                    ? true
                                    : roleRights(matrix, role)[permission] === true;
                                return (
                                  <td key={role}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={!canEditRights || role === 'OWNER'}
                                      aria-label={t('chatSettings.rights.checkbox', {
                                        permission: t(PERMISSION_LABEL[permission]),
                                        role: t(ROLE_LABEL[role]),
                                      })}
                                      onChange={() => handleToggleRight(role, permission)}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="pane-sub">{t('chatSettings.rights.fixedOwner')}</p>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn--accent"
                        disabled={!canEditRights || rightsSaving || !rightsDirty}
                        aria-busy={rightsSaving}
                        onClick={() => void handleSaveRights()}
                      >
                        {rightsSaving
                          ? t('chatSettings.rights.saving')
                          : t('chatSettings.rights.save')}
                      </button>
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}

            {activeTab === 'privacy' ? (
              <>
                <div className="setting-row">
                  <div className="text">
                    <b>{t('chatSettings.privacy.secret')}</b>
                    <small>{t('chatSettings.privacy.secretHint')}</small>
                  </div>
                  <span className={`chip${isE2ee ? ' chip--accent' : ''}`}>
                    {isE2ee ? t('details.secretOn') : t('details.secretOff')}
                  </span>
                </div>
                {[
                  ['chatSettings.privacy.reads', 'chatSettings.privacy.readsHint'],
                  ['chatSettings.privacy.typing', 'chatSettings.privacy.typingHint'],
                  ['chatSettings.privacy.keys', 'chatSettings.privacy.keysHint'],
                ].map(([title, hint]) => (
                  <div className="setting-row" key={title}>
                    <div className="text">
                      <b>{t(title as Parameters<typeof t>[0])}</b>
                      <small>{t(hint as Parameters<typeof t>[0])}</small>
                    </div>
                    <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
                  </div>
                ))}
                <p className="pane-sub">{t('chatSettings.privacyUnavailable')}</p>
              </>
            ) : null}

            {activeTab === 'danger' ? (
              <div className="danger-cards">
                {dangerNotice ? (
                  <p className="chat-settings-notice" role="status">
                    {dangerNotice}
                  </p>
                ) : null}
                <div className="danger-card">
                  <h4>{chat.archived ? t('chatSettings.unarchive') : t('chatSettings.archive')}</h4>
                  <p>{t('chatSettings.archiveHint')}</p>
                  <p>{t('chatSettings.archivePersonal')}</p>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={archiveBusy || leavePending}
                    aria-busy={archiveBusy}
                    onClick={() => void handleArchive()}
                  >
                    {archiveBusy
                      ? t(
                          archiveState.status === 'unarchiving'
                            ? 'chatSettings.unarchiveWorking'
                            : 'chatSettings.archiveWorking',
                        )
                      : chat.archived
                        ? t('chatSettings.unarchive')
                        : t('chatSettings.archive')}
                  </button>
                  {archiveError ? (
                    <p className="chat-settings-error" role="alert">
                      {archiveErrorText(archiveError)}
                    </p>
                  ) : null}
                </div>
                <div className="danger-card">
                  <h4>
                    {isDirect
                      ? peerBlocked
                        ? t('chatSettings.unblock')
                        : t('chatSettings.blockContact')
                      : t('chatSettings.leave')}
                  </h4>
                  <p>
                    {isDirect
                      ? t('chatSettings.blockLead', { name: peerName })
                      : t('chatSettings.leaveHint')}
                  </p>
                  {isDirect ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={!chat.peer_id || blockPending}
                        title={chat.peer_id ? undefined : t('chatSettings.blockUnavailableDirect')}
                        aria-busy={blockPending}
                        onClick={() => {
                          if (!chat.peer_id) return;
                          setDangerNotice(null);
                          if (peerBlocked) void handleUnblock();
                          else setBlockOpen(true);
                        }}
                      >
                        {blockPending
                          ? t('chatSettings.blocking')
                          : peerBlocked
                            ? t('chatSettings.unblock')
                            : t('chatSettings.blockContact')}
                      </button>
                      {blockActionError ? (
                        <p className="chat-settings-error" role="alert">
                          {blockErrorText(blockActionError)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={leavePending}
                        aria-busy={leavePending}
                        onClick={() => {
                          setDangerNotice(null);
                          setLeaveOpen(true);
                        }}
                      >
                        {leavePending ? t('chatSettings.leaving') : t('chatSettings.leave')}
                      </button>
                      {leaveError ? (
                        <p className="chat-settings-error" role="alert">
                          {chatMembershipErrorText(leaveError)}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
                {!isDirect ? (
                  <div className="danger-card">
                    <h4>{t('chatSettings.delete')}</h4>
                    <p>{t('chatSettings.deleteHint')}</p>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={!canDelete || deleting || dangerBusy}
                      aria-busy={deleting}
                      title={canDelete ? undefined : t('chatSettings.deleteOwnerOnly')}
                      onClick={() => {
                        setDangerNotice(null);
                        setDeleteOpen(true);
                      }}
                    >
                      {deleting ? t('chatSettings.deleteBusy') : t('chatSettings.delete')}
                    </button>
                    {!canDelete ? (
                      <p className="pane-sub">{t('chatSettings.deleteOwnerOnly')}</p>
                    ) : null}
                    {deleteError ? (
                      <p className="chat-settings-error" role="alert">
                        {archiveErrorText(deleteError)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="chat-settings-danger__note" id={dangerNoteId}>
                  {t('chatSettings.dangerNote')}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="modal-foot">
          {activeTab === 'danger' ? (
            <button type="button" className="btn" onClick={onClose}>
              {t('chatSettings.dangerClose')}
            </button>
          ) : activeTab === 'main' ? (
            canManageName ? (
              <>
                <button type="button" className="btn" onClick={onClose} disabled={saving}>
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  form="chat-settings-form"
                  className="btn btn--accent"
                  disabled={saving}
                  aria-busy={saving}
                >
                  {saving ? t('chatSettings.saving') : t('chatSettings.save')}
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={onClose}>
                {t('chatSettings.dangerClose')}
              </button>
            )
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {t('chatSettings.dangerClose')}
            </button>
          )}
        </div>
      </div>

      {blockOpen ? (
        <AdminConfirmDialog
          title={t('chatSettings.blockConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatSettings.blockLead', { name: peerName })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatSettings.blockNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatSettings.blockConfirm')}
          busyLabel={t('chatSettings.blocking')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={blockPending}
          error={blockActionError ? blockActionErrorInfo(blockActionError) : null}
          errorDetails={blockActionError}
          onConfirm={() => void handleBlockConfirm()}
          onClose={() => {
            if (blockPending) return;
            setBlockOpen(false);
          }}
        />
      ) : null}

      {leaveOpen ? (
        <AdminConfirmDialog
          title={t('chatSettings.leaveConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatSettings.leaveConfirmLead', { name: peerName })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatSettings.leaveConfirmNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatSettings.leaveConfirm')}
          busyLabel={t('chatSettings.leaving')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={leavePending}
          error={
            leaveError
              ? {
                  text: chatMembershipErrorText(leaveError),
                  tone: 'error',
                  retryable: leaveError.isNetwork || leaveError.status >= 500,
                  closeOnError: false,
                }
              : null
          }
          errorDetails={leaveError}
          onConfirm={() => void handleLeaveConfirm()}
          onClose={() => {
            if (leavePending) return;
            setLeaveOpen(false);
          }}
        />
      ) : null}

      {deleteOpen ? (
        <AdminConfirmDialog
          title={t('chatSettings.deleteConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatSettings.deleteConfirmLead', {
                  name: chat.name?.trim() || t('chatSettings.type.group'),
                })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatSettings.deleteConfirmNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatSettings.deleteConfirm')}
          busyLabel={t('chatSettings.deleteBusy')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={deleting}
          error={
            deleteError
              ? {
                  text: archiveErrorText(deleteError),
                  tone: 'error',
                  retryable: deleteError.isNetwork || deleteError.status >= 500,
                  closeOnError: false,
                }
              : null
          }
          errorDetails={deleteError}
          onConfirm={() => void handleDeleteConfirm()}
          onClose={() => {
            if (deleting) return;
            setDeleteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
