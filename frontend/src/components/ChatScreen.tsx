import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { ApiMessage, StickerRef } from '../api/types';
import { describeError } from '../domain/errors';
import { chatDisplayName } from '../domain/chatLabel';
import { useCountdown } from '../hooks/useCountdown';
import { t } from '../i18n/ru';
import {
  useChatStore,
  useChatState,
  useFilesState,
  useFilesStore,
  useStickersState,
  useStickersStore,
} from '../store/ChatProvider';
import type { OutgoingMessage } from '../store/chatStore';
import { isActiveUpload } from '../store/filesStore';
import { MAX_MESSAGE_ATTACHMENTS, effectiveMaxFileBytes, isStorageFull } from '../files/limits';
import { formatBytes } from '../files/format';
import { RateLimitBanner, OfflineBanner, RealtimeBanner, SyncErrorBanner } from './Banners';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { E2eeBanner } from './E2eeBanner';
import { SafetyNumberDialog } from './SafetyNumberDialog';
import { ChatIcon, LockIcon, PaperclipIcon } from './Icons';
import { MessageList } from './MessageList';
import { StatePanel } from './StatePanel';
import { StickerPicker } from './StickerPicker';
import { ThreadPanel } from './ThreadPanel';
import { TypingIndicator } from './TypingIndicator';
import { LimitsBar } from './LimitsBar';
import { UploadTray } from './UploadTray';

export function ChatScreen() {
  const store = useChatStore();
  const state = useChatState();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ApiMessage | null>(null);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickerButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentAt = useRef(0);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);

  const filesStore = useFilesStore();
  const filesState = useFilesState();
  const stickersStore = useStickersStore();
  const stickersState = useStickersState();
  const activeChatId = state.activeChatId;
  const slice = activeChatId ? (state.slices[activeChatId] ?? null) : null;
  const chatSummary = state.chats.find((chat) => chat.id === activeChatId) ?? null;
  const rateLimitSeconds = useCountdown(state.rateLimitUntil);
  const typingEntries = activeChatId ? (state.typing[activeChatId] ?? []) : [];
  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
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
    lastTypingSentAt.current = 0;
  }, [activeChatId]);

  useEffect(() => {
    if (!stickerPickerOpen || !activeChatId) return;
    void stickersStore.ensure(activeChatId);
  }, [activeChatId, stickerPickerOpen, stickersStore]);

  const e2eeBlock = activeChatId ? store.e2eeBlockReason(activeChatId) : null;
  const sendBlockedReason = !state.online
    ? ('offline' as const)
    : rateLimitSeconds > 0
      ? ('rate_limit' as const)
      : e2eeBlock !== null
        ? ('e2ee_blocked' as const)
        : null;
  const isE2eeChat = activeChatId ? store.isE2eeChat(activeChatId) : false;
  const threadsAvailable = activeChatId ? store.threadsAvailable(activeChatId) : false;
  const threadDisabledReason = threadsAvailable ? null : t('thread.e2eeDisabled');
  const threadOpen = state.activeThread !== null;
  // P2-33: the reply bar must never show the server's plaintext quote in an
  // E2EE context; only the decrypted local view (or "unavailable") is allowed.
  const replyE2eeText =
    isE2eeChat && replyTo !== null ? (slice?.e2ee[replyTo.id]?.text ?? null) : null;

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

  const addFiles = (files: File[]) => {
    if (!activeChatId || !canAttach || files.length === 0) return;
    void filesStore.addFiles(files, activeChatId);
  };

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
        readByOthersSeq={readByOthersSeq}
        retryDisabled={sendBlockedReason !== null}
        e2eeChat={isE2eeChat}
        threadsAvailable={threadsAvailable}
        threadDisabledReason={threadDisabledReason}
        onLoadMore={() => void store.loadMore(activeChatId)}
        onRetry={(clientMessageId) => void store.retry(activeChatId, clientMessageId)}
        onRestore={handleRestore}
        onReply={handleReply}
        onOpenThread={(message) => void store.openThread(activeChatId, message.id)}
      />
    );
  }

  return (
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
        />

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
            <LimitsBar
              limits={filesState.limits}
              status={filesState.limitsStatus}
              error={filesState.limitsError}
              role={role}
              onRetry={() => void filesStore.refreshLimits()}
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
            <Composer
              value={draft}
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
            />
          </div>
        ) : null}
      </div>

      <ThreadPanel />
    </main>
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
          <div
            className={`skeleton-row${index % 2 === 0 ? ' skeleton-row--mine' : ''}`}
            key={index}
            aria-hidden="true"
          >
            <span className={`skeleton skeleton--bubble skeleton--bubble-${(index % 3) + 1}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
