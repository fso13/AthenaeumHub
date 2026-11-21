import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { ApiMessage, MessageSearchHit, StickerRef } from '../api/types';
import { describeError } from '../domain/errors';
import { chatDisplayName } from '../domain/chatLabel';
import { buildMentionPayload } from '../domain/mentions';
import { useCountdown } from '../hooks/useCountdown';
import { getVoiceSupport, useVoiceRecorder, type RecordedVoice } from '../hooks/useVoiceRecorder';
import { t, type MessageKey } from '../i18n/ru';
import {
  useChatStore,
  useChatState,
  useFilesState,
  useFilesStore,
  usePluginActionsStore,
  usePluginsStore,
  useStickersState,
  useStickersStore,
} from '../store/ChatProvider';
import { isChatManagerRole, type OutgoingMessage } from '../store/chatStore';
import { isActiveUpload } from '../store/filesStore';
import { MAX_MESSAGE_ATTACHMENTS, effectiveMaxFileBytes, isStorageFull } from '../files/limits';
import { formatBytes } from '../files/format';
import { MAX_VOICE_DURATION_MS, planUploadMediaBatch } from '../files/media';
import { RateLimitBanner, OfflineBanner, RealtimeBanner, SyncErrorBanner } from './Banners';
import { ChatDetails } from './ChatDetails';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { E2eeBanner } from './E2eeBanner';
import { GroupCallPicker } from './GroupCallPicker';
import { RecordingBar } from './RecordingBar';
import { SafetyNumberDialog } from './SafetyNumberDialog';
import { ChatIcon, CloseIcon, LockIcon, PaperclipIcon, PinIcon, SearchIcon } from './Icons';
import { MessageList } from './MessageList';
import { MessageSearchPanel } from './MessageSearchPanel';
import { PluginActionsBar } from './plugins/PluginActionsBar';
import { PollCreateDialog } from './plugins/PollCreateDialog';
import { TaskCreateDialog } from './plugins/TaskCreateDialog';
import { StatePanel } from './StatePanel';
import { StickerPicker } from './StickerPicker';
import { ThreadPanel } from './ThreadPanel';
import { TypingIndicator } from './TypingIndicator';
import { UploadTray } from './UploadTray';
import { usePluginGate } from '../plugins/gate';

interface ChatScreenProps {
  /** D1-FE5: opens the chat settings dialog from the header. */
  onOpenChatSettings?: () => void;
  /** E12: opens the existing workspace members directory. */
  onOpenMembers?: () => void;
  /** D1 UX: section pages reachable from the details panel. */
  onNavigate?: (view: 'plugins' | 'security' | 'files') => void;
}

export function ChatScreen({
  onOpenChatSettings,
  onOpenMembers,
  onNavigate,
}: ChatScreenProps = {}) {
  const store = useChatStore();
  const state = useChatState();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ApiMessage | null>(null);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickerButtonRef = useRef<HTMLButtonElement>(null);
  const voiceButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentAt = useRef(0);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  // D1 UX: the details column is open by default (design width 304) and the
  // header/info control toggles it. Search is an inline filter over history.
  const [detailsOpen, setDetailsOpen] = useState(() => {
    // Desktop keeps the design's details column open; overlay breakpoints
    // (≤1180) start closed so the conversation keeps the full width.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return !window.matchMedia('(max-width: 1180px)').matches;
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinIndex, setPinIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** #83: honest notice when a search hit is outside the loaded history. */
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const searchState = state.messageSearch;
  // D1.1 (#76): composer plugin actions and their modal/panel handoff.
  const [pollDialogOpen, setPollDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  /** #95: the created POLL/TASK card is scrolled to/selected once it arrives. */
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  /** #77: GROUP calls first open the participant picker. */
  const [callPicker, setCallPicker] = useState<{ chatId: string; video: boolean } | null>(null);
  const focusNonce = useRef(0);

  const filesStore = useFilesStore();
  const filesState = useFilesState();
  const stickersStore = useStickersStore();
  const stickersState = useStickersState();
  const pluginsStore = usePluginsStore();
  const pluginActions = usePluginActionsStore();
  const activeChatId = state.activeChatId;
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const slice = activeChatId ? (state.slices[activeChatId] ?? null) : null;
  const chatSummary = state.chats.find((chat) => chat.id === activeChatId) ?? null;
  const rateLimitSeconds = useCountdown(state.rateLimitUntil);
  const typingEntries = activeChatId ? (state.typing[activeChatId] ?? []) : [];
  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const threadOpen = state.activeThread !== null;
  const readByOthersSeq = Math.max(
    0,
    ...Object.entries(slice?.receipts ?? {})
      .filter(([userId]) => userId !== viewerId)
      .map(([, lastReadSeq]) => lastReadSeq),
  );

  useEffect(() => {
    setDraft('');
    setReplyTo(null);
    setStickerPickerOpen(false);
    setSafetyOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
    setJumpNotice(null);
    store.clearSearch();
    setPollDialogOpen(false);
    setTaskDialogOpen(false);
    setFocusRequest(null);
    setCallPicker(null);
    lastTypingSentAt.current = 0;
  }, [activeChatId, store]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  // #83: the server owns search. Input is debounced; an empty query returns to
  // the hint state instead of filtering already loaded history locally.
  useEffect(() => {
    if (!searchOpen) return;
    const query = searchQuery.trim();
    const timer = window.setTimeout(() => {
      if (query.length === 0) {
        store.clearSearch();
        return;
      }
      void store.searchMessages(query);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchOpen, searchQuery, store]);

  // D1 UX: Esc closes the details overlay on narrow viewports; the thread
  // panel owns its own Escape handling, so skip when a thread is open.
  useEffect(() => {
    if (!detailsOpen || threadOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('dialog')) return;
      setDetailsOpen(false);
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [detailsOpen, threadOpen]);

  useEffect(() => {
    if (!stickerPickerOpen || !activeChatId) return;
    void stickersStore.ensure(activeChatId);
  }, [activeChatId, stickerPickerOpen, stickersStore]);

  // #80: the rights matrix and the viewer's channel role drive the pin action
  // and the read-only send guard. Both are chat-scoped and loaded lazily.
  const activeChatKind = chatSummary?.type ?? null;
  useEffect(() => {
    if (!activeChatId || activeChatKind !== 'GROUP') return;
    void store.loadChatMembers(activeChatId);
    void store.loadChatPermissions(activeChatId);
  }, [activeChatId, activeChatKind, store]);

  const readOnlyBlocked = activeChatId ? !store.canPostInChat(activeChatId) : false;
  const isE2eeChat = activeChatId ? store.isE2eeChat(activeChatId) : false;
  const pinsState = state.chatPins;
  const activePins =
    activeChatId && pinsState.chatId === activeChatId
      ? pinsState.items
      : ([] as typeof pinsState.items);
  const currentPin =
    activePins.length > 0 ? activePins[Math.min(pinIndex, activePins.length - 1)] : null;
  const currentPinnedMessage = currentPin
    ? (slice?.messages.find((message) => message.id === currentPin.message_id) ?? null)
    : null;
  const currentPinPreview = currentPinnedMessage?.deleted_at
    ? t('chat.deletedMessage')
    : currentPinnedMessage?.text?.trim() ||
      (currentPinnedMessage?.sticker ? t('details.pinsSticker') : t('details.pinsUnavailable'));

  useEffect(() => {
    if (!activeChatId || isE2eeChat) return;
    if (pinsState.chatId !== activeChatId) {
      void store.loadChatPins(activeChatId);
    }
  }, [activeChatId, isE2eeChat, pinsState.chatId, store]);

  // #95: task cards label the assignee/completer by workspace directory name.
  // Load the first directory page once when loaded history contains such ids.
  useEffect(() => {
    if (!slice) return;
    const hasTaskPeople = slice.messages.some(
      (message) => message.task?.assignee_id || message.task?.completed_by,
    );
    if (!hasTaskPeople || state.workspaceMembers.status !== 'idle') return;
    void store.loadWorkspaceMembers({ query: '' });
  }, [slice, state.workspaceMembers.status, store]);

  useEffect(() => {
    setPinIndex(0);
  }, [activeChatId]);

  const jumpToPin = (messageId: string) => {
    setPinIndex((index) => (activePins.length > 0 ? (index + 1) % activePins.length : 0));
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.focus({ preventScroll: true });
  };

  const e2eeBlock = activeChatId ? store.e2eeBlockReason(activeChatId) : null;
  const sendBlockedReason = !state.online
    ? ('offline' as const)
    : rateLimitSeconds > 0
      ? ('rate_limit' as const)
      : readOnlyBlocked
        ? ('read_only' as const)
        : e2eeBlock !== null
          ? ('e2ee_blocked' as const)
          : null;
  const callsBlockedKey = store.callDisabledReason(activeChatId);
  const callsDisabledReason = callsBlockedKey ? t(callsBlockedKey as MessageKey) : null;
  const startCall = useCallback(
    (chatId: string, video: boolean) => {
      const chat = state.chats.find((item) => item.id === chatId) ?? null;
      if (!chat || callsBlockedKey !== null) return;
      if (chat.type === 'DIRECT') {
        store.startCall(chatId, video);
        return;
      }
      if (chat.type === 'GROUP' && !store.isE2eeChat(chatId)) {
        setCallPicker({ chatId, video });
      }
    },
    [callsBlockedKey, state.chats, store],
  );
  const threadsAvailable = activeChatId ? store.threadsAvailable(activeChatId) : false;
  const isGroupChat = chatSummary?.type === 'GROUP';
  const pluginGate = usePluginGate(activeChatId, isE2eeChat);
  const pollsEnabled = isGroupChat && pluginGate.enabled('polls');
  const tasksEnabled = isGroupChat && pluginGate.enabled('tasks');

  // D1.1 (#76): drop the previous chat's poll/task/translation cache and load
  // this chat's gates. E2EE chats never load server-plugin state.
  useEffect(() => {
    if (!activeChatId) return;
    pluginActions.enterChat(activeChatId);
    if (isE2eeChat) return;
    void pluginsStore.ensureChat(activeChatId);
  }, [activeChatId, isE2eeChat, pluginActions, pluginsStore]);
  const threadDisabledReason = threadsAvailable ? null : t('thread.e2eeDisabled');
  const mentionNames = useMemo(
    () => state.workspaceMembers.items.map((member) => member.display_name),
    [state.workspaceMembers.items],
  );
  /**
   * #83: the autocomplete/send directory is the **chat** participant list when
   * it is loaded (the server rejects non-participants with 422), with the
   * workspace directory as the pre-load fallback so the picker never hangs.
   */
  const mentionMembers = useMemo(() => {
    if (activeChatId && state.chatMembers.chatId === activeChatId) {
      return state.chatMembers.items
        .filter((member) => member.status === 'ACTIVE')
        .map((member) => ({ user_id: member.user_id, display_name: member.display_name }));
    }
    return state.workspaceMembers.items.map((member) => ({
      user_id: member.user_id,
      display_name: member.display_name,
    }));
  }, [activeChatId, state.chatMembers, state.workspaceMembers.items]);
  /**
   * `@all` is a broadcast, so the candidate is only offered to chat
   * OWNER/ADMIN. Unknown role (members still loading) hides it; the server
   * remains the authority and would still answer an honest 403.
   */
  const mentionAllAllowed = isChatManagerRole(
    activeChatId ? store.chatActorRole(activeChatId) : null,
  );
  const memberNames = useMemo(
    () =>
      new Map(state.workspaceMembers.items.map((member) => [member.user_id, member.display_name])),
    [state.workspaceMembers.items],
  );
  const mentionDirectoryLoading =
    state.workspaceMembers.status === 'idle' || state.workspaceMembers.status === 'loading';
  const ensureMentionDirectory = useCallback(() => {
    // Composer autocomplete needs the whole first directory page, not the
    // search-filtered page the members dialog may have left behind.
    void store.loadWorkspaceMembers({ query: '' });
  }, [store]);
  // P2-33: the reply bar must never show the server's plaintext quote in an
  // E2EE context; only the decrypted local view (or "unavailable") is allowed.
  const replyE2eeText =
    isE2eeChat && replyTo !== null ? (slice?.e2ee[replyTo.id]?.text ?? null) : null;

  /**
   * #83 jump: switch to the hit's chat, then page older history until the
   * message is loaded (bounded). If it is still outside the window, say so
   * instead of pretending to scroll somewhere.
   */
  const openSearchHit = async (hit: MessageSearchHit) => {
    setSearchOpen(false);
    setSearchQuery('');
    setJumpNotice(null);
    store.clearSearch();
    if (hit.chat_id !== activeChatId) {
      await store.setActiveChat(hit.chat_id);
    }
    for (let page = 0; page < 10; page += 1) {
      const current = store.getSnapshot().slices[hit.chat_id];
      if (!current) break;
      if (current.messages.some((message) => message.id === hit.message_id)) {
        focusNonce.current += 1;
        setFocusRequest({ id: hit.message_id, nonce: focusNonce.current });
        return;
      }
      if (!current.hasMore) break;
      const before = current.messages.length;
      await store.loadMore(hit.chat_id);
      const after = store.getSnapshot().slices[hit.chat_id]?.messages.length ?? before;
      if (after === before) break;
    }
    setJumpNotice(t('chat.searchJumpUnavailable'));
  };

  const sessionError = state.sessionError ? describeError(state.sessionError) : null;
  const sliceError = slice?.error ? describeError(slice.error) : null;

  const ready = state.sessionStatus === 'ready' && slice?.status === 'ready';

  const uploadTasks = filesStore.tasksFor(activeChatId);
  const readyAttachments = filesStore.readyAttachments(activeChatId);
  const role = state.activeWorkspace?.role ?? null;
  const canManageTasks = role === 'OWNER' || role === 'ADMIN';
  const maxAttachments = Math.min(
    MAX_MESSAGE_ATTACHMENTS,
    filesState.limits?.max_attachments ?? MAX_MESSAGE_ATTACHMENTS,
  );
  const activeUploads = uploadTasks.filter(isActiveUpload).length;
  const storageFull = isStorageFull(filesState.limits);
  const canAttach =
    ready &&
    state.online &&
    !storageFull &&
    !isE2eeChat &&
    activeUploads < maxAttachments &&
    maxAttachments > 0;
  const effectiveMax = effectiveMaxFileBytes(filesState.limits, role);
  const attachHint = storageFull
    ? t('files.storageFull')
    : activeUploads >= maxAttachments
      ? t('files.maxCountReached')
      : t('files.attachHint', {
          count: maxAttachments,
          size: effectiveMax ? formatBytes(effectiveMax) : '—',
        });

  // Voice is managed-only: in E2EE chats the mic stays visible but disabled
  // with an honest explanation (never a silent no-op).
  const voiceSupport = getVoiceSupport();
  const voiceHint = isE2eeChat
    ? t('voice.e2eeUnavailable')
    : !voiceSupport.supported
      ? t(voiceSupport.reasonKey ?? 'voice.unsupported')
      : attachHint;

  const addFiles = (files: File[]) => {
    if (!activeChatId || !canAttach || files.length === 0) return;
    const chatId = activeChatId;
    void (async () => {
      // ID3 probing only reads the tag prefix; a failure degrades to no media.
      const plans = await planUploadMediaBatch(files);
      if (!activeChatIdRef.current) return;
      if (activeChatIdRef.current !== chatId) return;
      await filesStore.addFiles(
        files,
        chatId,
        plans.map((plan) => (plan ? { media: plan.media, artwork: plan.artwork } : null)),
      );
    })();
  };

  const focusVoiceButton = useCallback(() => {
    voiceButtonRef.current?.focus();
  }, []);

  const handleVoiceRecorded = useCallback(
    (result: RecordedVoice) => {
      const chatId = activeChatIdRef.current;
      focusVoiceButton();
      if (!chatId) return;
      // A take recorded before switching to E2EE must never be uploaded there.
      if (store.isE2eeChat(chatId)) return;
      // #80: a read-only channel denies send for non-manager roles.
      if (!store.canPostInChat(chatId)) return;
      void (async () => {
        const tasks = await filesStore.addFiles([result.file], chatId, [{ media: result.media }]);
        const task = tasks[0];
        if (!task || result.intent !== 'send') return;
        const attachment = await filesStore.waitForReady(task.localId);
        if (!attachment || activeChatIdRef.current !== chatId) return;
        void store.send(chatId, '', null, [attachment]);
      })();
    },
    [filesStore, focusVoiceButton, store],
  );

  const voice = useVoiceRecorder({
    onRecorded: handleVoiceRecorded,
    maxDurationMs: MAX_VOICE_DURATION_MS,
  });
  const voiceActive =
    voice.status === 'requesting' || voice.status === 'recording' || voice.status === 'stopping';
  const cancelVoiceRef = useRef(voice.cancel);
  cancelVoiceRef.current = voice.cancel;
  // Switching chats with an open microphone must release it immediately.
  useEffect(() => {
    return () => {
      cancelVoiceRef.current();
    };
  }, [activeChatId]);

  const handleSend = () => {
    if (!activeChatId || !ready) return;
    const text = draft;
    const target = replyTo;
    const attachments = filesStore.readyAttachments(activeChatId);
    if (!text.trim() && attachments.length === 0) return;
    // #83: mentions are derived from the exact text being sent. Unknown names
    // stay literal, E2EE chats never reach this branch, and `@all` is only
    // advertised when the viewer's chat role allows it.
    const mentionPayload = isE2eeChat
      ? null
      : buildMentionPayload(text, mentionMembers, mentionAllAllowed);
    setDraft('');
    setReplyTo(null);
    void store.send(activeChatId, text, target?.id ?? null, attachments, mentionPayload);
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!activeChatId || value.trim().length === 0) return;
    // Ephemeral, TTL 5 s on the server; 2 s cadence avoids a frame per key.
    const now = Date.now();
    if (now - lastTypingSentAt.current < 2_000) return;
    lastTypingSentAt.current = now;
    store.sendTyping(activeChatId);
  };

  const handleToggleStickers = () => {
    if (!activeChatId || !ready) return;
    if (stickerPickerOpen) {
      setStickerPickerOpen(false);
      return;
    }
    stickersStore.clearFavoriteError();
    setStickerPickerOpen(true);
  };

  const handleSendSticker = (sticker: StickerRef) => {
    if (!activeChatId || !ready || sendBlockedReason !== null) return;
    const target = replyTo;
    setReplyTo(null);
    setStickerPickerOpen(false);
    void store.sendSticker(activeChatId, sticker, target?.id ?? null);
    textareaRef.current?.focus();
  };

  const handleFavoriteSticker = (sticker: StickerRef) => {
    void stickersStore.toggleFavorite(sticker);
  };

  const handleRestore = (item: OutgoingMessage) => {
    if (!activeChatId) return;
    const removed = store.discardOutgoing(activeChatId, item.clientMessageId);
    if (!removed) return;
    if (removed.kind === 'STICKER') {
      // A sticker has no draft text to restore; reopen the picker instead.
      setStickerPickerOpen(true);
      return;
    }
    setDraft(removed.text);
    const target = removed.replyToId
      ? (slice?.messages.find((message) => message.id === removed.replyToId) ?? null)
      : null;
    setReplyTo(target);
    textareaRef.current?.focus();
  };

  const handleReply = (message: ApiMessage) => {
    setReplyTo(message);
    textareaRef.current?.focus();
  };

  /**
   * #95: the backend creates the timeline message in the same transaction and
   * returns its id. The live WS frame may arrive before/after the `201`; if it
   * is not in the loaded slice yet, one `after_seq` catch-up fetches it. The
   * message is never appended locally, so it cannot be duplicated.
   */
  const focusCreatedPluginMessage = async (
    chatId: string,
    target: { messageId?: string | null; pollId?: string; taskId?: string },
  ): Promise<void> => {
    const findCreated = () => {
      const messages = store.getSnapshot().slices[chatId]?.messages ?? [];
      return (
        messages.find(
          (message) =>
            (target.messageId ? message.id === target.messageId : false) ||
            (target.pollId ? message.poll_id === target.pollId : false) ||
            (target.taskId ? message.task_id === target.taskId : false),
        ) ?? null
      );
    };
    let created = findCreated();
    if (!created) {
      await store.refreshTail(chatId);
      created = findCreated();
    }
    if (!created || activeChatIdRef.current !== chatId) return;
    setSearchQuery('');
    setSearchOpen(false);
    focusNonce.current += 1;
    setFocusRequest({ id: created.id, nonce: focusNonce.current });
  };

  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

  const jumpToMessage = (messageId: string) => {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({
        block: 'center',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }
    element.focus({ preventScroll: true });
  };

  const openTaskDialog = () => {
    if (!tasksEnabled) return;
    // The assignee picker needs the ACTIVE workspace directory; `query: ''`
    // returns the first page and is a no-op when it is already loaded.
    void store.loadWorkspaceMembers({ query: '' });
    setTaskDialogOpen(true);
  };

  const handleFileInput = (files: FileList | null) => {
    if (!files) return;
    addFiles(Array.from(files));
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!canAttach) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!canAttach) return;
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!canAttach) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (!canAttach) return;
    addFiles(Array.from(event.dataTransfer.files ?? []));
  };

  let body: ReactNode;
  if (state.sessionStatus === 'idle' || state.sessionStatus === 'loading') {
    body = <ChatSkeleton />;
  } else if (state.sessionStatus === 'error') {
    body = (
      <StatePanel
        tone="error"
        icon={<LockIcon />}
        title={sessionError?.title ?? t('chat.errorTitle')}
        text={sessionError?.message ?? t('chat.errorText')}
        actionLabel={t('common.retry')}
        onAction={() => void store.retryBootstrap()}
        details={state.sessionError}
      />
    );
  } else if (!activeChatId || !slice) {
    body = (
      <StatePanel
        tone="neutral"
        icon={<ChatIcon />}
        title={t('chat.noChatsTitle')}
        text={t('chat.noChatsText')}
        actionLabel={t('common.retry')}
        onAction={() => void store.retryBootstrap()}
      />
    );
  } else if (slice.status === 'idle' || slice.status === 'loading') {
    body = <ChatSkeleton />;
  } else if (slice.status === 'error') {
    const forbidden = slice.error?.status === 403 || slice.error?.status === 404;
    body = (
      <StatePanel
        tone={forbidden ? 'forbidden' : 'error'}
        icon={<LockIcon />}
        title={forbidden ? t('chat.forbiddenTitle') : (sliceError?.title ?? t('chat.errorTitle'))}
        text={forbidden ? t('chat.forbiddenText') : (sliceError?.message ?? t('chat.errorText'))}
        actionLabel={forbidden ? undefined : t('chat.retry')}
        onAction={forbidden ? undefined : () => void store.retryHistory(activeChatId)}
        details={slice.error}
      />
    );
  } else if (slice.messages.length === 0 && slice.outbox.length === 0) {
    body = (
      <StatePanel
        tone="neutral"
        icon={<ChatIcon />}
        title={t('chat.emptyTitle')}
        text={t('chat.emptyText')}
      />
    );
  } else {
    body = (
      <MessageList
        key={activeChatId}
        slice={slice}
        viewerId={viewerId}
        viewerName={
          state.user?.display_name ?? state.session?.user.display_name ?? t('sidebar.user')
        }
        readByOthersSeq={readByOthersSeq}
        retryDisabled={sendBlockedReason !== null}
        e2eeChat={isE2eeChat}
        threadsAvailable={threadsAvailable}
        threadDisabledReason={threadDisabledReason}
        mentionNames={mentionNames}
        pollsEnabled={pollsEnabled}
        tasksEnabled={tasksEnabled}
        canManageTasks={canManageTasks}
        memberNames={memberNames}
        focusRequest={focusRequest}
        onFocusHandled={clearFocusRequest}
        onLoadMore={() => void store.loadMore(activeChatId)}
        onRetry={(clientMessageId) => void store.retry(activeChatId, clientMessageId)}
        onRestore={handleRestore}
        onReply={handleReply}
        onOpenThread={(message) => void store.openThread(activeChatId, message.id)}
      />
    );
  }

  return (
    <>
      <main
        className={`chat${threadOpen ? ' chat--thread-open' : ''}`}
        id="chat-main"
        tabIndex={-1}
        aria-label={chatDisplayName(
          chatSummary,
          state.workspaceMembers.items,
          state.session?.chat.name ?? null,
        )}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="chat__main">
          <ChatHeader
            state={state}
            chat={chatSummary}
            onRefresh={() => void store.sync()}
            onOpenSafety={() => setSafetyOpen(true)}
            onOpenSettings={onOpenChatSettings}
            searchOpen={searchOpen}
            onToggleSearch={() => {
              if (searchOpen) {
                setSearchQuery('');
                store.clearSearch();
              }
              setSearchOpen((open) => !open);
            }}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen((open) => !open)}
            onStartCall={(video) => {
              if (activeChatId) startCall(activeChatId, video);
            }}
            callActive={state.call.phase !== 'idle'}
            callDisabledReason={callsDisabledReason}
          />

          {currentPin && currentPinnedMessage && !isE2eeChat ? (
            <div className="chat-pinned-bar" role="status" aria-label={t('chat.pinnedBar')}>
              <PinIcon aria-hidden="true" />
              <button
                type="button"
                className="chat-pinned-bar__link"
                onClick={() => jumpToPin(currentPin.message_id)}
                title={t('chat.pinnedJump')}
              >
                <span className="chat-pinned-bar__label">{t('chat.pinnedMessage')}</span>
                <span className="chat-pinned-bar__text">{currentPinPreview}</span>
              </button>
              {activePins.length > 1 ? (
                <span className="chat-pinned-bar__count">
                  {t('chat.pinnedCount', {
                    current: Math.min(pinIndex, activePins.length - 1) + 1,
                    total: activePins.length,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}

          {searchOpen ? (
            <div className="chat-search" role="search">
              <SearchIcon aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                aria-label={t('chat.search')}
                placeholder={t('chat.searchPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {searchQuery.trim().length > 0 && searchState.status === 'ready' ? (
                <span className="search-count" aria-live="polite">
                  {t('chat.searchCount', { count: searchState.items.length })}
                </span>
              ) : null}
              <button
                type="button"
                className="icon-button icon-button--small"
                aria-label={t('chat.searchClose')}
                title={t('chat.searchClose')}
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery('');
                  store.clearSearch();
                }}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {searchOpen ? (
            <MessageSearchPanel
              state={searchState}
              onSelect={(hit) => void openSearchHit(hit)}
              onLoadMore={() => void store.loadMoreSearchResults()}
              onRetry={() => void store.searchMessages(searchQuery)}
            />
          ) : null}

          {activeChatId ? (
            <E2eeBanner
              state={state}
              chatId={activeChatId}
              onAcceptKeyChange={(userId, deviceId) => {
                void store.acceptKeyChange(activeChatId, userId, deviceId);
              }}
              onConfirmManaged={() => {
                void store.confirmManagedMode(activeChatId);
              }}
              onRefresh={() => {
                void store.refreshE2eeChat(activeChatId);
              }}
              onRetryReset={() => {
                void store.retryPendingReset(activeChatId);
              }}
            />
          ) : null}

          {!state.online ? <OfflineBanner /> : null}
          {rateLimitSeconds > 0 ? <RateLimitBanner seconds={rateLimitSeconds} /> : null}
          {state.syncStatus === 'error' ? (
            <SyncErrorBanner onRetry={() => void store.sync()} />
          ) : null}
          <RealtimeBanner
            issue={state.realtimeIssue}
            status={state.realtimeStatus}
            onReconnect={() => store.reconnectRealtime()}
          />

          {jumpNotice ? (
            <div className="chat-notice" role="status">
              <span>{jumpNotice}</span>
              <button
                type="button"
                className="icon-button icon-button--small"
                onClick={() => setJumpNotice(null)}
                aria-label={t('files.uploadDismiss')}
                title={t('files.uploadDismiss')}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
          ) : null}

          <div className="chat__body">{body}</div>

          {activeChatId ? (
            <SafetyNumberDialog
              open={safetyOpen}
              chatId={activeChatId}
              onClose={() => setSafetyOpen(false)}
            />
          ) : null}

          <TypingIndicator entries={typingEntries} />

          {dragActive && canAttach ? (
            <div className="drop-overlay" role="status" aria-live="polite">
              <PaperclipIcon aria-hidden="true" />
              <strong>{t('files.dropTitle')}</strong>
              <span>{t('files.dropHint')}</span>
            </div>
          ) : null}

          {ready ? (
            <div className="composer-stack">
              <input
                id="file-input"
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                multiple
                tabIndex={-1}
                aria-label={t('files.attach')}
                onChange={(event) => {
                  handleFileInput(event.target.files);
                  event.target.value = '';
                }}
              />
              <UploadTray
                tasks={uploadTasks}
                onPause={(localId) => filesStore.pauseTask(localId)}
                onResume={(localId) => void filesStore.resumeTask(localId)}
                onCancel={(localId) => void filesStore.cancelTask(localId)}
                onRetry={(localId) => void filesStore.retryTask(localId)}
                onRemove={(localId) => void filesStore.removeTask(localId)}
              />
              {stickerPickerOpen ? (
                <StickerPicker
                  state={stickersState}
                  onSend={handleSendSticker}
                  onFavorite={handleFavoriteSticker}
                  onRetry={() => {
                    if (activeChatId) void stickersStore.load(activeChatId, true);
                  }}
                  onClose={() => setStickerPickerOpen(false)}
                  sendBlockedReason={sendBlockedReason}
                  rateLimitSeconds={rateLimitSeconds}
                  triggerRef={stickerButtonRef}
                />
              ) : null}
              <PluginActionsBar
                pollsEnabled={pollsEnabled}
                tasksEnabled={tasksEnabled}
                onCreatePoll={() => {
                  if (pollsEnabled) setPollDialogOpen(true);
                }}
                onCreateTask={openTaskDialog}
              />
              <Composer
                value={draft}
                chatName={
                  chatSummary
                    ? chatDisplayName(
                        chatSummary,
                        state.workspaceMembers.items,
                        state.session?.chat.name ?? null,
                      )
                        .replace(/[«»]/g, '')
                        .trim()
                    : undefined
                }
                onChange={handleDraftChange}
                onSend={handleSend}
                disabled={false}
                sendBlockedReason={sendBlockedReason}
                rateLimitSeconds={rateLimitSeconds}
                replyTo={replyTo}
                e2eeChat={isE2eeChat}
                replyText={replyE2eeText}
                onCancelReply={() => setReplyTo(null)}
                textareaRef={textareaRef}
                attachmentCount={readyAttachments.length}
                attachDisabled={!canAttach}
                attachHint={attachHint}
                onAttach={() => fileInputRef.current?.click()}
                stickersOpen={stickerPickerOpen}
                onToggleStickers={handleToggleStickers}
                stickerButtonRef={stickerButtonRef}
                voiceButtonRef={voiceButtonRef}
                voiceDisabled={!canAttach || !voiceSupport.supported || readOnlyBlocked}
                voiceHint={voiceHint}
                voiceActive={voiceActive}
                onStartVoice={() => {
                  if (voice.status === 'idle' || voice.status === 'error') {
                    void voice.start('send');
                  }
                }}
                voiceBar={
                  voice.status !== 'idle' ? (
                    <RecordingBar
                      status={voice.status}
                      elapsedMs={voice.elapsedMs}
                      errorKey={voice.errorKey}
                      maxDurationMs={MAX_VOICE_DURATION_MS}
                      disabled={!canAttach}
                      onCancel={() => {
                        voice.cancel();
                        focusVoiceButton();
                      }}
                      onSend={voice.stop}
                      onRetry={() => void voice.start('send')}
                      onDismiss={() => {
                        voice.dismissError();
                        focusVoiceButton();
                      }}
                    />
                  ) : undefined
                }
                mentionMembers={mentionMembers}
                mentionsEnabled={!isE2eeChat}
                allowMentionAll={mentionAllAllowed}
                mentionDirectoryLoading={mentionDirectoryLoading}
                onMentionDirectoryNeeded={ensureMentionDirectory}
              />
            </div>
          ) : null}
        </div>

        <ThreadPanel />
      </main>
      {detailsOpen && !threadOpen ? (
        <button
          type="button"
          className="details-backdrop"
          aria-label={t('chat.detailsClose')}
          onClick={() => setDetailsOpen(false)}
        />
      ) : null}
      {!threadOpen ? (
        <ChatDetails
          open={detailsOpen}
          chat={chatSummary}
          slice={slice}
          onClose={() => setDetailsOpen(false)}
          onOpenSettings={() => onOpenChatSettings?.()}
          onOpenSafety={() => setSafetyOpen(true)}
          onOpenMembers={onOpenMembers}
          onNavigate={(view) => onNavigate?.(view)}
          searchValue={searchQuery}
          onSearch={(value) => {
            setSearchQuery(value);
            setSearchOpen(true);
          }}
          onJumpToMessage={jumpToMessage}
          onStartCall={
            activeChatId && (chatSummary?.type === 'DIRECT' || chatSummary?.type === 'GROUP')
              ? (video) => startCall(activeChatId, video)
              : undefined
          }
          callDisabledReason={callsDisabledReason}
          onAttachAudio={canAttach ? () => fileInputRef.current?.click() : undefined}
        />
      ) : null}

      {callPicker ? (
        <GroupCallPicker
          key={callPicker.chatId}
          chatId={callPicker.chatId}
          chatName={
            chatDisplayName(
              state.chats.find((item) => item.id === callPicker.chatId) ?? null,
              state.workspaceMembers.items,
              state.session?.chat.name ?? null,
            ) || t('calls.groupCall')
          }
          initialVideo={callPicker.video}
          onClose={() => setCallPicker(null)}
        />
      ) : null}

      {pollDialogOpen && activeChatId ? (
        <PollCreateDialog
          chatId={activeChatId}
          onClose={() => setPollDialogOpen(false)}
          onCreated={(poll) => {
            setPollDialogOpen(false);
            void focusCreatedPluginMessage(activeChatId, {
              messageId: poll.message_id ?? null,
              pollId: poll.id,
            });
          }}
        />
      ) : null}
      {taskDialogOpen && activeChatId ? (
        <TaskCreateDialog
          chatId={activeChatId}
          members={state.workspaceMembers.items}
          membersLoading={
            state.workspaceMembers.status === 'loading' || state.workspaceMembers.status === 'idle'
          }
          onClose={() => setTaskDialogOpen(false)}
          onCreated={(task) => {
            setTaskDialogOpen(false);
            void focusCreatedPluginMessage(activeChatId, {
              messageId: task.message_id ?? null,
              taskId: task.id,
            });
          }}
        />
      ) : null}
    </>
  );
}

function ChatSkeleton() {
  return (
    <div
      className="messages messages--skeleton"
      role="status"
      aria-label={t('chat.loading')}
      aria-busy="true"
    >
      <div className="messages__inner">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div className="skeleton-row" key={index} aria-hidden="true">
            <span className="skeleton skeleton--avatar" />
            <span className="skeleton-row__body">
              <span className="skeleton skeleton--line-sm" />
              <span className={`skeleton skeleton--text skeleton--text-${(index % 3) + 1}`} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
