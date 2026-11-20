import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { ApiMessage, StickerRef } from '../api/types';
import { describeError } from '../domain/errors';
import { chatDisplayName } from '../domain/chatLabel';
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
import type { OutgoingMessage } from '../store/chatStore';
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
import { ChatIcon, CloseIcon, LockIcon, PaperclipIcon, SearchIcon } from './Icons';
import { MessageList } from './MessageList';
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
  onNavigate?: (view: 'plugins' | 'security') => void;
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
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // D1.1 (#76): composer plugin actions and their modal/panel handoff.
  const [pollDialogOpen, setPollDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [pluginPanelRequest, setPluginPanelRequest] = useState<{
    panel: 'polls' | 'tasks';
    nonce: number;
  } | null>(null);
  /** #77: GROUP calls first open the participant picker. */
  const [callPicker, setCallPicker] = useState<{ chatId: string; video: boolean } | null>(null);
  const pluginPanelNonce = useRef(0);

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
    setPollDialogOpen(false);
    setTaskDialogOpen(false);
    setPluginPanelRequest(null);
    setCallPicker(null);
    lastTypingSentAt.current = 0;
  }, [activeChatId]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

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
  const isE2eeChat = activeChatId ? store.isE2eeChat(activeChatId) : false;
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

  const searchMatches = (() => {
    const query = searchQuery.trim().toLocaleLowerCase('ru');
    if (!slice || query.length === 0) return 0;
    return slice.messages.filter((message) => {
      if (message.thread_root_id) return false;
      const decrypted = slice.e2ee[message.id]?.text ?? '';
      return `${decrypted} ${message.text ?? ''}`.toLocaleLowerCase('ru').includes(query);
    }).length;
  })();

  const sessionError = state.sessionError ? describeError(state.sessionError) : null;
  const sliceError = slice?.error ? describeError(slice.error) : null;

  const ready = state.sessionStatus === 'ready' && slice?.status === 'ready';

  const uploadTasks = filesStore.tasksFor(activeChatId);
  const readyAttachments = filesStore.readyAttachments(activeChatId);
  const role = state.activeWorkspace?.role ?? null;
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
    setDraft('');
    setReplyTo(null);
    void store.send(activeChatId, text, target?.id ?? null, attachments);
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

  const focusPluginPanel = (panel: 'polls' | 'tasks') => {
    pluginPanelNonce.current += 1;
    setPluginPanelRequest({ panel, nonce: pluginPanelNonce.current });
    setDetailsOpen(true);
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
        searchQuery={searchQuery}
        readByOthersSeq={readByOthersSeq}
        retryDisabled={sendBlockedReason !== null}
        e2eeChat={isE2eeChat}
        threadsAvailable={threadsAvailable}
        threadDisabledReason={threadDisabledReason}
        mentionNames={mentionNames}
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
              setSearchQuery((query) => (searchOpen ? '' : query));
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
              {searchQuery.trim().length > 0 ? (
                <span className="search-count" aria-live="polite">
                  {t('chat.searchCount', { count: searchMatches })}
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
                }}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
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
                mentionMembers={state.workspaceMembers.items}
                mentionsEnabled={!isE2eeChat}
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
          pluginPanelRequest={pluginPanelRequest}
          onStartCall={
            activeChatId && (chatSummary?.type === 'DIRECT' || chatSummary?.type === 'GROUP')
              ? (video) => startCall(activeChatId, video)
              : undefined
          }
          callDisabledReason={callsDisabledReason}
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
          onCreated={() => {
            setPollDialogOpen(false);
            focusPluginPanel('polls');
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
          onCreated={() => {
            setTaskDialogOpen(false);
            focusPluginPanel('tasks');
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
