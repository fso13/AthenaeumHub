import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ApiMessage } from '../api/types';
import { groupMessagesByDay, scrollAdjustment, sortBySeq } from '../domain/messages';
import { t } from '../i18n/ru';
import type { ChatSlice, OutgoingMessage } from '../store/chatStore';
import { ErrorDetails } from './ErrorDetails';
import { ChevronUpIcon } from './Icons';
import { MessageRow, OutgoingRow } from './MessageRow';

interface MessageListProps {
  slice: ChatSlice;
  viewerId: string | null;
  /** Max `message.receipt.last_read_seq` across other participants. */
  readByOthersSeq: number;
  retryDisabled: boolean;
  /** E7-F5F: never render server plaintext in an E2EE chat. */
  e2eeChat?: boolean;
  /** D1-FE3: managed chats only; E2EE renders a disabled thread action. */
  threadsAvailable?: boolean;
  threadDisabledReason?: string | null;
  onLoadMore: () => void;
  onRetry: (clientMessageId: string) => void;
  onRestore: (item: OutgoingMessage) => void;
  onReply: (message: ApiMessage) => void;
  onOpenThread: (message: ApiMessage) => void;
}

export function MessageList({
  slice,
  viewerId,
  readByOthersSeq,
  retryDisabled,
  e2eeChat = false,
  threadsAvailable = false,
  threadDisabledReason = null,
  onLoadMore,
  onRetry,
  onRestore,
  onReply,
  onOpenThread,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousScrollHeight = useRef<number | null>(null);
  const previousFirstId = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const initialScrollDone = useRef(false);

  const ordered = useMemo(
    () =>
      sortBySeq(slice.messages).filter((message) => {
        // D1-FE3: replies belong to the thread panel, never to the channel.
        if (message.thread_root_id) return false;
        const view = slice.e2ee[message.id];
        return view === undefined || (view.status !== 'control' && view.status !== 'superseded');
      }),
    [slice.messages, slice.e2ee],
  );
  const items = useMemo(() => groupMessagesByDay(ordered, new Date()), [ordered]);
  const replyById = useMemo(
    () => new Map(ordered.map((message) => [message.id, message])),
    [ordered],
  );
  /** Local sender directory for the thread link's "author: excerpt" preview. */
  const nameBySender = useMemo(() => {
    const names = new Map<string, string>();
    for (const message of ordered) {
      if (message.sender_id && message.sender_display_name) {
        names.set(message.sender_id, message.sender_display_name);
      }
    }
    return names;
  }, [ordered]);

  const handleLoadMore = () => {
    const element = scrollRef.current;
    if (element) {
      previousScrollHeight.current = element.scrollHeight;
      previousFirstId.current = slice.messages[0]?.id ?? null;
    }
    onLoadMore();
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (previousScrollHeight.current !== null) {
      const firstId = slice.messages[0]?.id ?? null;
      if (firstId !== previousFirstId.current) {
        element.scrollTop = scrollAdjustment(
          previousScrollHeight.current,
          element.scrollHeight,
          element.scrollTop,
        );
      }
      previousScrollHeight.current = null;
      previousFirstId.current = null;
      return;
    }

    const lastMessage = slice.messages[slice.messages.length - 1];
    const lastOutgoing = slice.outbox[slice.outbox.length - 1];
    const outboxFingerprint = slice.outbox
      .map((item) => `${item.clientMessageId}:${item.status}:${item.attempts}`)
      .join(',');
    const key = `${lastMessage?.id ?? ''}:${slice.messages.length}:${outboxFingerprint}`;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distanceToBottom < 180;

    if (!initialScrollDone.current) {
      element.scrollTop = element.scrollHeight;
      initialScrollDone.current = true;
    } else if (lastKey.current !== key && (nearBottom || lastOutgoing !== undefined)) {
      element.scrollTop = element.scrollHeight;
    }
    lastKey.current = key;
  }, [slice.messages, slice.outbox]);

  const handleJumpTo = (messageId: string) => {
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

  const loadingMore = slice.loadMoreStatus === 'loading';

  return (
    <div
      className="messages"
      ref={scrollRef}
      role="log"
      aria-label={t('chat.messagesLabel')}
      aria-live="polite"
      aria-relevant="additions text"
      tabIndex={0}
    >
      {slice.hasMore || slice.loadMoreStatus !== 'idle' ? (
        <div className="history-top">
          {slice.loadMoreStatus === 'error' ? (
            <div className="history-error" role="alert">
              <p>{t('chat.loadMoreError')}</p>
              <button type="button" className="button button--small" onClick={handleLoadMore}>
                {t('common.retry')}
              </button>
              <ErrorDetails error={slice.loadMoreError} />
            </div>
          ) : (
            <button
              type="button"
              className="button button--ghost history-more"
              onClick={handleLoadMore}
              disabled={loadingMore}
              aria-busy={loadingMore}
            >
              {loadingMore ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <ChevronUpIcon aria-hidden="true" />
              )}
              {loadingMore ? t('chat.loadingMore') : t('chat.loadMore')}
            </button>
          )}
        </div>
      ) : null}

      <div className="messages__inner">
        {items.map((item) =>
          item.kind === 'day' ? (
            <div
              className="day-separator"
              role="separator"
              aria-label={item.label}
              key={`day-${item.key}`}
            >
              <span>{item.label}</span>
            </div>
          ) : (
            <MessageRow
              key={item.message.id}
              message={item.message}
              mine={Boolean(viewerId) && item.message.sender_id === viewerId}
              readByOthers={
                Boolean(viewerId) &&
                item.message.sender_id === viewerId &&
                item.message.seq <= readByOthersSeq
              }
              e2ee={slice.e2ee[item.message.id]}
              e2eeChat={e2eeChat}
              threadsAvailable={threadsAvailable}
              threadDisabledReason={threadDisabledReason}
              threadAuthorName={
                item.message.thread_summary?.last_reply_author_id
                  ? (nameBySender.get(item.message.thread_summary.last_reply_author_id) ?? null)
                  : null
              }
              replyTo={
                item.message.reply_to_id ? (replyById.get(item.message.reply_to_id) ?? null) : null
              }
              replyText={
                item.message.reply_to_id
                  ? (slice.e2ee[item.message.reply_to_id]?.text ?? null)
                  : null
              }
              onReply={onReply}
              onOpenThread={onOpenThread}
              onJumpTo={handleJumpTo}
            />
          ),
        )}

        {slice.outbox.map((item) => (
          <OutgoingRow
            key={item.clientMessageId}
            item={item}
            retryDisabled={retryDisabled}
            onRetry={onRetry}
            onRestore={onRestore}
          />
        ))}
      </div>
    </div>
  );
}
