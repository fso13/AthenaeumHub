import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeError } from '../domain/errors';
import { formatShortDate, replyPreview, sortBySeq } from '../domain/messages';
import { useCountdown } from '../hooks/useCountdown';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { threadKey, type OutgoingMessage } from '../store/chatStore';
import type { SendBlockedReason } from './Composer';
import { ErrorDetails } from './ErrorDetails';
import { ChevronUpIcon, CloseIcon, ThreadIcon } from './Icons';
import { MentionText } from './MentionText';
import { MessageRow, OutgoingRow } from './MessageRow';
import { StatePanel } from './StatePanel';
import { ThreadComposer } from './ThreadComposer';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * D1-FE3: right-side thread panel on desktop, full-screen sheet on mobile.
 * It is a dialog with a focus trap, Escape/back close and focus return to the
 * message action that opened it. The root stays in the channel; only replies
 * and the reply composer live here.
 */
export function ThreadPanel() {
  const store = useChatStore();
  const state = useChatState();
  const active = state.activeThread;
  const key = active ? threadKey(active.chatId, active.rootId) : null;
  const thread = key ? (state.threads[key] ?? null) : null;
  const chat = active ? (state.chats.find((item) => item.id === active.chatId) ?? null) : null;
  const slice = active ? (state.slices[active.chatId] ?? null) : null;
  const root =
    active && slice
      ? (slice.messages.find((message) => message.id === active.rootId) ?? null)
      : null;

  const [draft, setDraft] = useState('');
  /** Mobile renders the panel as a full-screen sheet with a "Назад" affordance. */
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const closeRefCallback = useRef<() => void>(() => undefined);
  closeRefCallback.current = () => store.closeThread();

  useEffect(() => {
    if (key === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRefCallback.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Focus returns to the thread link/action that opened the panel.
      if (previous?.isConnected) previous.focus();
    };
  }, [key]);

  useEffect(() => {
    setDraft('');
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 900px)');
    if (typeof query.addEventListener !== 'function') return;
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const replies = useMemo(
    () => sortBySeq(thread?.replies ?? []).filter((reply) => !reply.deleted_at),
    [thread?.replies],
  );
  const replyById = useMemo(() => new Map(replies.map((reply) => [reply.id, reply])), [replies]);

  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const rateLimitSeconds = useCountdown(state.rateLimitUntil);
  const threadsAvailable = active ? store.threadsAvailable(active.chatId) : false;
  const mentionNames = useMemo(
    () => state.workspaceMembers.items.map((member) => member.display_name),
    [state.workspaceMembers.items],
  );
  const mentionDirectoryLoading =
    state.workspaceMembers.status === 'idle' || state.workspaceMembers.status === 'loading';
  const ensureMentionDirectory = useCallback(() => {
    void store.loadWorkspaceMembers({ query: '' });
  }, [store]);

  const e2eeBlocked = Boolean(active) && !threadsAvailable;
  const sendBlockedReason: SendBlockedReason = !state.online
    ? 'offline'
    : rateLimitSeconds > 0
      ? 'rate_limit'
      : e2eeBlocked
        ? 'e2ee_blocked'
        : null;

  const disabledReason = !active
    ? null
    : !threadsAvailable
      ? t('thread.e2eeDisabled')
      : thread?.unavailable === 'deleted' || root?.deleted_at
        ? t('thread.unavailableDeleted')
        : thread?.unavailable === 'not_found'
          ? t('thread.unavailableNotFound')
          : !root
            ? t('thread.rootMissing')
            : thread === null
              ? t('thread.loading')
              : thread.status === 'error'
                ? t('thread.sendDisabled')
                : thread.status !== 'ready'
                  ? t('thread.loading')
                  : null;

  if (!active || !thread || !chat) return null;

  // The error StatePanel already explains a missing/deleted root; don't repeat
  // the same sentence in the notice above the body.
  const showingErrorPanel = thread.status === 'error' && replies.length === 0;

  const readByOthersSeq = Math.max(
    0,
    ...Object.entries(slice?.receipts ?? {})
      .filter(([userId]) => userId !== viewerId)
      .map(([, lastReadSeq]) => lastReadSeq),
  );

  const handleSend = () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    void store.sendThreadReply(active.chatId, active.rootId, text).then((accepted) => {
      if (!accepted) setDraft(text);
    });
  };

  const handleRestore = (item: OutgoingMessage) => {
    const removed = store.discardThreadReply(active.chatId, active.rootId, item.clientMessageId);
    if (!removed) return;
    setDraft(removed.text);
    textareaRef.current?.focus();
  };

  const jumpTo = (messageId: string) => {
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

  // Defence in depth: an E2EE thread panel must never render plaintext root
  // text, even if it is somehow opened outside `openThread`'s guard.
  const rootText = !threadsAvailable
    ? t('thread.e2eeDisabled')
    : root
      ? root.deleted_at
        ? t('chat.deletedMessage')
        : replyPreview(root.text, 220) || t('thread.previewFallback')
      : '';

  let body: ReactNode;
  if (thread.status === 'error' && replies.length === 0) {
    const described = thread.error ? describeError(thread.error) : null;
    const unavailable = thread.unavailable !== null;
    body = (
      <StatePanel
        tone={unavailable ? 'forbidden' : 'error'}
        icon={<ThreadIcon />}
        title={
          unavailable
            ? t(
                thread.unavailable === 'deleted'
                  ? 'thread.unavailableDeletedTitle'
                  : 'thread.unavailableNotFoundTitle',
              )
            : (described?.title ?? t('thread.errorTitle'))
        }
        text={
          unavailable
            ? t(
                thread.unavailable === 'deleted'
                  ? 'thread.unavailableDeleted'
                  : 'thread.unavailableNotFound',
              )
            : (described?.message ?? t('thread.errorText'))
        }
        actionLabel={unavailable ? undefined : t('thread.retry')}
        onAction={
          unavailable ? undefined : () => void store.retryThread(active.chatId, active.rootId)
        }
        details={thread.error}
      />
    );
  } else if (thread.status === 'idle' || (thread.status === 'loading' && replies.length === 0)) {
    body = (
      <p className="thread-panel__state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        {t('thread.loading')}
      </p>
    );
  } else if (replies.length === 0) {
    body = (
      <div className="thread-panel__empty" role="status">
        <ThreadIcon aria-hidden="true" />
        <strong>{t('thread.emptyTitle')}</strong>
        <span>{t('thread.emptyText')}</span>
      </div>
    );
  } else {
    body = (
      <>
        {thread.hasMore || thread.loadMoreStatus !== 'idle' ? (
          <div className="thread-panel__more">
            {thread.loadMoreStatus === 'error' ? (
              <div className="history-error" role="alert">
                <p>{t('thread.loadMoreError')}</p>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void store.loadMoreThread(active.chatId, active.rootId)}
                >
                  {t('common.retry')}
                </button>
                <ErrorDetails error={thread.loadMoreError} />
              </div>
            ) : (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void store.loadMoreThread(active.chatId, active.rootId)}
                disabled={thread.loadMoreStatus === 'loading'}
                aria-busy={thread.loadMoreStatus === 'loading'}
              >
                {thread.loadMoreStatus === 'loading' ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <ChevronUpIcon aria-hidden="true" />
                )}
                {thread.loadMoreStatus === 'loading'
                  ? t('thread.loadingMore')
                  : t('thread.loadMore')}
              </button>
            )}
          </div>
        ) : null}
        {replies.map((reply) => (
          <MessageRow
            key={reply.id}
            message={reply}
            mine={Boolean(viewerId) && reply.sender_id === viewerId}
            readByOthers={
              Boolean(viewerId) && reply.sender_id === viewerId && reply.seq <= readByOthersSeq
            }
            replyTo={reply.reply_to_id ? (replyById.get(reply.reply_to_id) ?? null) : null}
            replyText={null}
            e2eeChat={!threadsAvailable}
            threadsAvailable={false}
            allowReply={false}
            mentionNames={mentionNames}
            onJumpTo={jumpTo}
          />
        ))}
        {thread.outbox.map((item) => (
          <OutgoingRow
            key={item.clientMessageId}
            item={item}
            viewerName={
              state.user?.display_name ?? state.session?.user.display_name ?? t('sidebar.user')
            }
            retryDisabled={sendBlockedReason !== null}
            onRetry={(clientMessageId) =>
              void store.retryThreadReply(active.chatId, active.rootId, clientMessageId)
            }
            onRestore={handleRestore}
            mentionNames={mentionNames}
            richText={threadsAvailable}
          />
        ))}
      </>
    );
  }

  return (
    <aside
      className="thread-panel"
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-thread-root={active.rootId}
    >
      <header className="thread-panel__head">
        <ThreadIcon aria-hidden="true" />
        <div className="thread-panel__heading">
          <h2 className="thread-panel__title" id={titleId}>
            {t('thread.title')}
          </h2>
          <p className="thread-panel__subtitle">{t('thread.subtitle')}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          onClick={() => store.closeThread()}
          aria-label={isMobile ? t('thread.back') : t('thread.close')}
          title={isMobile ? t('thread.back') : t('thread.close')}
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </header>

      <div className="thread-panel__root">
        <span className="thread-panel__root-author">
          {root?.sender_display_name?.trim() || t('chat.unknownAuthor')}
        </span>
        <p className="thread-panel__root-text">
          {root ? (
            threadsAvailable && !root.deleted_at ? (
              <MentionText text={rootText} mentions={mentionNames} />
            ) : (
              rootText
            )
          ) : (
            t('thread.rootMissing')
          )}
        </p>
        {root ? (
          <time className="thread-panel__root-time" dateTime={root.created_at}>
            {formatShortDate(root.created_at)}
          </time>
        ) : null}
      </div>

      {disabledReason !== null && root && !showingErrorPanel ? (
        <p className="thread-panel__notice" role="status">
          {disabledReason}
        </p>
      ) : null}

      <div className="thread-panel__body" role="log" aria-label={t('thread.messagesLabel')}>
        {body}
      </div>

      <ThreadComposer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        disabled={disabledReason !== null}
        disabledReason={disabledReason}
        sendBlockedReason={sendBlockedReason}
        rateLimitSeconds={rateLimitSeconds}
        textareaRef={textareaRef}
        mentionMembers={state.workspaceMembers.items}
        mentionsEnabled={threadsAvailable}
        mentionDirectoryLoading={mentionDirectoryLoading}
        onMentionDirectoryNeeded={ensureMentionDirectory}
      />
    </aside>
  );
}
