import type { ApiMessage } from '../api/types';
import { describeError } from '../domain/errors';
import { formatTime, replyPreview } from '../domain/messages';
import { t } from '../i18n/ru';
import type { E2eeMessageView, OutgoingMessage } from '../store/chatStore';
import { isStickerMessage, stickerOf } from '../stickers/model';
import { AttachmentList } from './AttachmentCard';
import { Avatar } from './Avatar';
import { ErrorDetails } from './ErrorDetails';
import { AlertIcon, ClockIcon, ReplyIcon, RetryIcon, ThreadIcon } from './Icons';
import { ThreadLink } from './ThreadLink';

const UNKNOWN_AUTHOR = () => t('chat.unknownAuthor');

interface MessageRowProps {
  message: ApiMessage;
  mine: boolean;
  readByOthers: boolean;
  replyTo: ApiMessage | null;
  /** E7-F5: decrypted text / unavailable / error state for an E2EE message. */
  e2ee?: E2eeMessageView;
  /** E2EE reply-bar text (plaintext server fields are never rendered). */
  replyText?: string | null;
  /**
   * E7-F5F: the chat is E2EE. Server `text`/reply previews/attachments must
   * never be rendered here, even before decryption or when init failed.
   */
  e2eeChat?: boolean;
  /** D1-FE3: flat threads are managed-only; `false` renders an honest disabled action. */
  threadsAvailable?: boolean;
  /** Explanation shown on the disabled thread action (E2EE chats). */
  threadDisabledReason?: string | null;
  /** Resolved display name of `thread_summary.last_reply_author_id`. */
  threadAuthorName?: string | null;
  onOpenThread?: (message: ApiMessage) => void;
  /** D1-FE3: replies inside a thread do not offer quote-reply. */
  allowReply?: boolean;
  onReply?: (message: ApiMessage) => void;
  onJumpTo: (messageId: string) => void;
}

/** Reply bar summary for text, sticker and attachment-only messages. */
function messagePreview(message: ApiMessage | null): string {
  if (!message) return t('chat.replyUnavailable');
  if (message.deleted_at) return t('chat.deletedMessage');
  const text = replyPreview(message.text);
  if (text) return text;
  const sticker = stickerOf(message);
  if (sticker?.alt) return t('stickers.replyPreview', { alt: sticker.alt });
  if ((message.attachments?.length ?? 0) > 0) return t('attachments.attachmentOnly');
  return t('chat.deletedMessage');
}

export function MessageRow({
  message,
  mine,
  readByOthers,
  replyTo,
  e2ee,
  replyText,
  e2eeChat = false,
  threadsAvailable = false,
  threadDisabledReason = null,
  threadAuthorName = null,
  onOpenThread,
  allowReply = true,
  onReply,
  onJumpTo,
}: MessageRowProps) {
  if (message.type === 'SYSTEM') {
    return (
      <div className="system-message" role="note">
        {e2eeChat ? t('chat.systemMessage') : message.text?.trim() || t('chat.systemMessage')}
      </div>
    );
  }

  const author = message.sender_display_name?.trim() || UNKNOWN_AUTHOR();
  const deleted = Boolean(message.deleted_at);
  const e2eeFallback =
    e2ee?.status === 'unavailable'
      ? t('e2ee.unavailable')
      : e2ee?.status === 'error'
        ? t('e2ee.decryptError')
        : null;
  // E7-F5F: in an E2EE chat the only permitted text sources are the decrypted
  // view and the sealed local copy exposed through it. `message.text` is
  // server-controlled plaintext and is never a fallback.
  const text = deleted
    ? t('chat.deletedMessage')
    : (e2eeFallback ?? e2ee?.text ?? (e2eeChat ? '' : (message.text ?? '')));
  const showText = deleted || text.trim().length > 0;

  const quoteAuthor = replyTo?.sender_display_name?.trim() || UNKNOWN_AUTHOR();
  const quoteText = e2eeChat
    ? (replyText ?? (replyTo?.deleted_at ? t('chat.deletedMessage') : t('chat.replyUnavailable')))
    : (replyText ?? messagePreview(replyTo));

  // D1-FE3: only a main-feed root can start/open a thread (depth is one).
  const canThread = !deleted && !message.thread_root_id;
  const threadSummary = message.thread_summary ?? null;
  const threadReplyCount = threadSummary?.reply_count ?? 0;
  const threadLink =
    canThread &&
    threadsAvailable &&
    threadSummary !== null &&
    threadReplyCount > 0 &&
    onOpenThread ? (
      <ThreadLink
        summary={threadSummary}
        authorName={threadAuthorName}
        onOpen={() => onOpenThread(message)}
      />
    ) : null;
  const replyAction =
    !deleted && allowReply && onReply ? (
      <button
        type="button"
        className="message-action"
        onClick={() => onReply(message)}
        aria-label={`${t('chat.reply')}: ${author}`}
        title={t('chat.reply')}
      >
        <ReplyIcon aria-hidden="true" />
        <span>{t('chat.reply')}</span>
      </button>
    ) : null;
  // With replies the always-visible `ThreadLink` is the single entry point;
  // the hover action only creates a still-empty thread (no duplicate control
  // with the same accessible name).
  const threadAction =
    canThread && threadsAvailable && onOpenThread && threadReplyCount === 0 ? (
      <button
        type="button"
        className="message-action"
        onClick={() => onOpenThread(message)}
        aria-label={
          threadReplyCount > 0
            ? t('thread.openLabel', { count: threadReplyCount })
            : t('thread.startLabel', { author })
        }
        title={threadReplyCount > 0 ? t('thread.open') : t('thread.start')}
      >
        <ThreadIcon aria-hidden="true" />
        <span>{threadReplyCount > 0 ? t('thread.open') : t('thread.start')}</span>
      </button>
    ) : canThread && !threadsAvailable && threadDisabledReason ? (
      <button
        type="button"
        className="message-action"
        disabled
        aria-label={threadDisabledReason}
        title={threadDisabledReason}
      >
        <ThreadIcon aria-hidden="true" />
        <span>{t('thread.disabled')}</span>
      </button>
    ) : null;
  const hasActions = Boolean(replyAction || threadAction);

  const quote = message.reply_to_id ? (
    replyTo ? (
      <button
        type="button"
        className="quote"
        onClick={() => onJumpTo(replyTo.id)}
        aria-label={`${t('chat.replyTo')}: ${quoteAuthor}: ${quoteText}`}
      >
        <span className="quote__author">{quoteAuthor}</span>
        <span className="quote__text">{quoteText}</span>
      </button>
    ) : (
      <div className="quote quote--missing">
        <span className="quote__text">{quoteText}</span>
      </div>
    )
  ) : null;

  if (isStickerMessage(message) && !e2ee && !e2eeChat) {
    const sticker = stickerOf(message);
    const alt = sticker?.alt?.trim() || t('stickers.imageAlt');
    return (
      <article
        className={`msg-row msg-row--sticker${mine ? ' msg-row--mine' : ''}`}
        id={`message-${message.id}`}
        tabIndex={-1}
      >
        {!mine ? <Avatar name={author} seed={message.sender_id} /> : null}
        <div className="msg-stack msg-stack--sticker">
          {!mine ? <span className="msg-author">{author}</span> : null}
          <div className={`sticker-message${deleted ? ' sticker-message--deleted' : ''}`}>
            {quote}
            {deleted ? (
              <span className="sticker-message__deleted">{t('chat.deletedMessage')}</span>
            ) : sticker?.url ? (
              <img
                className="sticker-message__image"
                src={sticker.url}
                alt={alt}
                width={512}
                height={512}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            ) : (
              <span className="sticker-message__missing" role="img" aria-label={alt}>
                {t('stickers.unavailable')}
              </span>
            )}
            <div className="sticker-message__foot">
              {message.edited_at ? <span>{t('chat.edited')}</span> : null}
              {mine && readByOthers ? (
                <span className="receipt-state">{t('message.read')}</span>
              ) : null}
              <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
            </div>
          </div>
          {threadLink}
          {hasActions ? (
            <div className="message-actions">
              {replyAction}
              {threadAction}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <article
      className={`msg-row${mine ? ' msg-row--mine' : ''}`}
      id={`message-${message.id}`}
      tabIndex={-1}
    >
      {!mine ? <Avatar name={author} seed={message.sender_id} /> : null}
      <div className="msg-stack">
        {!mine ? <span className="msg-author">{author}</span> : null}
        <div className="bubble">
          {quote}
          {showText ? (
            <div className={`bubble-text${deleted ? ' bubble-text--deleted' : ''}`}>{text}</div>
          ) : null}
          {!deleted && !e2eeChat ? (
            <AttachmentList attachments={message.attachments ?? []} />
          ) : null}
          <div className="bubble-foot">
            {message.edited_at ? <span>{t('chat.edited')}</span> : null}
            {mine && readByOthers ? (
              <span className="receipt-state">{t('message.read')}</span>
            ) : null}
            <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          </div>
        </div>
        {threadLink}
        {hasActions ? (
          <div className="message-actions">
            {replyAction}
            {threadAction}
          </div>
        ) : null}
      </div>
    </article>
  );
}

interface OutgoingRowProps {
  item: OutgoingMessage;
  retryDisabled: boolean;
  onRetry: (clientMessageId: string) => void;
  onRestore: (item: OutgoingMessage) => void;
}

export function OutgoingRow({ item, retryDisabled, onRetry, onRestore }: OutgoingRowProps) {
  const failed = item.status === 'failed';
  const described = item.error ? describeError(item.error) : null;
  const sticker = item.kind === 'STICKER' ? item.sticker : null;

  const status = (
    <span className="outgoing-status" role="status" aria-live="polite">
      {failed ? <AlertIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
      {failed ? t('message.failed') : t('message.pending')}
    </span>
  );
  const time = (
    <time dateTime={new Date(item.createdAt).toISOString()}>
      {formatTime(new Date(item.createdAt).toISOString())}
    </time>
  );
  const errorBlock =
    failed && item.error && described ? (
      <div className="outgoing-error" role="alert">
        <p className="outgoing-error__title">{described.title}</p>
        <p className="outgoing-error__text">{described.message}</p>
        <div className="outgoing-error__actions">
          {described.retryable ? (
            <button
              type="button"
              className="button button--small button--primary"
              onClick={() => onRetry(item.clientMessageId)}
              disabled={retryDisabled}
            >
              <RetryIcon aria-hidden="true" />
              {t('message.retry')}
            </button>
          ) : null}
          {described.canRestoreText ? (
            <button type="button" className="button button--small" onClick={() => onRestore(item)}>
              {t('message.restore')}
            </button>
          ) : item.kind === 'STICKER' ? (
            <button type="button" className="button button--small" onClick={() => onRestore(item)}>
              {t('message.dismiss')}
            </button>
          ) : null}
        </div>
        <ErrorDetails error={item.error} />
      </div>
    ) : null;

  if (sticker) {
    const alt = sticker.alt?.trim() || t('stickers.imageAlt');
    return (
      <article
        className="msg-row msg-row--mine msg-row--sticker"
        data-outgoing-status={item.status}
        data-sticker-outgoing="true"
      >
        <div className="msg-stack msg-stack--sticker">
          <div className="sticker-message sticker-message--outgoing">
            <img
              className="sticker-message__image"
              src={sticker.url}
              alt={alt}
              width={512}
              height={512}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
            <div className="sticker-message__foot">
              {status}
              {time}
            </div>
          </div>
          {errorBlock}
        </div>
      </article>
    );
  }

  return (
    <article className="msg-row msg-row--mine" data-outgoing-status={item.status}>
      <div className="msg-stack">
        <div className="bubble bubble--outgoing">
          {item.text.trim().length > 0 ? <div className="bubble-text">{item.text}</div> : null}
          <AttachmentList attachments={item.attachments} outgoing />
          <div className="bubble-foot">
            {status}
            {time}
          </div>
        </div>

        {errorBlock}
      </div>
    </article>
  );
}
