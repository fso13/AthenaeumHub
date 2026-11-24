import { useMemo } from 'react';
import type { ApiMessage } from '../api/types';
import { describeError } from '../domain/errors';
import { formatDateTime, formatTime, replyPreview } from '../domain/messages';
import { t } from '../i18n/ru';
import {
  embeddedPoll,
  embeddedTask,
  pluginMessageKind,
  pluginTitleId,
} from '../plugins/messageCards';
import type { E2eeMessageView, OutgoingMessage } from '../store/chatStore';
import { useProfileWorkspaceState } from '../store/ChatProvider';
import { isStickerMessage, stickerAssetUrl, stickerOf } from '../stickers/model';
import { AttachmentList } from './AttachmentCard';
import { Avatar } from './Avatar';
import { ErrorDetails } from './ErrorDetails';
import { AlertIcon, ClockIcon, RetryIcon } from './Icons';
import { MentionText } from './MentionText';
import { MessageActions, ReactionBar } from './MessageActions';
import {
  PluginMessageFallback,
  PollMessageCard,
  TaskMessageCard,
} from './plugins/PluginMessageCards';
import { TranslatedMessage } from './plugins/TranslatedMessage';
import { RichText } from './RichText';
import { ThreadLink } from './ThreadLink';

const UNKNOWN_AUTHOR = () => t('chat.unknownAuthor');
const NO_MEMBER_NAMES: ReadonlyMap<string, string> = new Map();

interface MessageRowProps {
  message: ApiMessage;
  mine: boolean;
  /** Viewer id for poll/task permissions (voting/close/toggle). */
  viewerId?: string | null;
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
  /** Active workspace member names for @mention chips (managed only). */
  mentionNames?: readonly string[];
  /** #95: server plugin gate for this chat; cards render read-only when false. */
  pollsEnabled?: boolean;
  tasksEnabled?: boolean;
  /** Workspace OWNER/ADMIN may complete any task (server still re-checks). */
  canManageTasks?: boolean;
  /** `assignee_id`/`completed_by` display names for task cards. */
  memberNames?: ReadonlyMap<string, string>;
  /** Newly created poll/task card: brief focus highlight. */
  highlighted?: boolean;
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
  const profilePoll = embeddedPoll(message);
  if (profilePoll) return `${t('pluginActions.poll')}: ${profilePoll.question}`;
  const profileTask = embeddedTask(message);
  if (profileTask) return `${t('pluginActions.task')}: ${profileTask.title}`;
  const text = replyPreview(message.text);
  if (text) return text;
  const sticker = stickerOf(message);
  if (sticker?.alt) return t('stickers.replyPreview', { alt: sticker.alt });
  if ((message.attachments?.length ?? 0) > 0) return t('attachments.attachmentOnly');
  return t('chat.deletedMessage');
}

interface ForwardMeta {
  chatId: string;
  messageId: string;
  senderId: string | null;
  author: string;
  createdAt: string;
  chatType: string | null;
  chatName: string | null;
}

function parseForward(text: string): { meta: ForwardMeta; body: string; header: string } | null {
  const match = /^↪([^\n]*)\nsova-forward:([^\n]+)\n?\n?/.exec(text);
  if (!match) return null;
  const header = `↪${match[1]}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(match[2] ?? ''));
  } catch {
    // Older markers were only `chatId:messageId`; keep the body navigable.
    const [chatId, messageId] = (match[2] ?? '').split(':');
    parsed = { chatId, messageId };
  }
  const raw =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return {
    meta: {
      chatId: typeof raw.chatId === 'string' ? raw.chatId : '',
      messageId: typeof raw.messageId === 'string' ? raw.messageId : '',
      senderId: typeof raw.senderId === 'string' ? raw.senderId : null,
      author:
        typeof raw.author === 'string' && raw.author.trim().length > 0
          ? raw.author
          : t('message.forwardUnknownAuthor'),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      chatType: typeof raw.chatType === 'string' ? raw.chatType : null,
      chatName: typeof raw.chatName === 'string' ? raw.chatName : null,
    },
    body: text.slice(match[0].length),
    header,
  };
}

function ForwardedMessage({ text }: { text: string }) {
  const parsed = parseForward(text);
  if (!parsed) return <RichText text={text} />;
  const { meta, body } = parsed;
  const sourceLabel =
    meta.chatType === 'DIRECT'
      ? t('message.forwardDirect')
      : meta.chatName
        ? `#${meta.chatName}`
        : t('message.forwardChannel');
  return (
    <div className="forward-card">
      <div className="forward-card__head">
        <Avatar name={meta.author} seed={meta.senderId ?? meta.author} size="sm" />
        <div className="forward-card__meta">
          <strong>{meta.author}</strong>
          {meta.createdAt ? <time>{formatDateTime(meta.createdAt)}</time> : null}
          <span className="forward-card__source">{sourceLabel}</span>
        </div>
        <button
          type="button"
          className="forward-card__jump"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('sova:open-forward', {
                detail: { chatId: meta.chatId, messageId: meta.messageId },
              }),
            )
          }
          aria-label={t('message.forwardOpenSource')}
          title={t('message.forwardOpenSource')}
        >
          ↗
        </button>
      </div>
      <div className="forward-card__body">
        <RichText text={body} />
      </div>
    </div>
  );
}

interface MessageMetaProps {
  author: string;
  mine: boolean;
  isBot: boolean;
  message: ApiMessage;
  readByOthers: boolean;
  e2eeChat: boolean;
}

/** Flat author/time header shared by every message kind. */
function MessageMeta({ author, mine, isBot, message, readByOthers, e2eeChat }: MessageMetaProps) {
  return (
    <div className="msg-head">
      <span className="msg-author">{author}</span>
      {/*
        #96: bot identity is derived from `sender_type`, never from the display
        name: a renamed bot or a user called "Bot" must not gain the badge.
      */}
      {isBot ? (
        <span className="msg-bot-badge" title={t('chat.botMessageHint')}>
          {t('chat.botBadge')}
        </span>
      ) : null}
      {mine && !e2eeChat ? <span className="msg-you">{t('sidebar.user')}</span> : null}
      <time className="msg-time" dateTime={message.created_at}>
        {formatTime(message.created_at)}
      </time>
      {message.edited_at && !e2eeChat ? (
        <span
          className="msg-edited"
          title={t('message.editedTitle', { time: formatDateTime(message.edited_at) })}
          aria-label={t('message.editedTitle', { time: formatDateTime(message.edited_at) })}
        >
          {t('chat.edited')}
        </span>
      ) : null}
      {mine && readByOthers ? <span className="receipt-state">{t('message.read')}</span> : null}
    </div>
  );
}

export function MessageRow({
  message,
  mine: mineProp,
  readByOthers,
  viewerId = null,
  replyTo,
  e2ee,
  replyText,
  e2eeChat = false,
  threadsAvailable = false,
  threadDisabledReason = null,
  threadAuthorName = null,
  mentionNames = [],
  pollsEnabled = false,
  tasksEnabled = false,
  canManageTasks = false,
  memberNames = NO_MEMBER_NAMES,
  highlighted = false,
  onOpenThread,
  allowReply = true,
  onReply,
  onJumpTo,
}: MessageRowProps) {
  // #96: a bot row can never be "mine" and never shows user affordances; the
  // server also enforces `sender_id=null` for BOT, this is a local backstop.
  const isBot = message.sender_type === 'BOT';
  const mine = mineProp && !isBot;
  /**
   * #83: the server is authoritative about who was mentioned. When the message
   * carries `mentions`, only those ids render as chips (a literal `@Name` typed
   * by hand stays plain text); legacy rows without the field keep the
   * text-based fallback. `@all` is matched by the parser and is only rendered
   * for messages the server marked with `mention_all`.
   */
  const resolvedMentionNames = useMemo(() => {
    if (message.mentions === undefined) return mentionNames;
    if (message.mentions.length === 0) return [];
    const names: string[] = [];
    for (const id of message.mentions) {
      const name = memberNames.get(id);
      if (name) names.push(name);
    }
    return names;
  }, [memberNames, mentionNames, message.mentions]);
  const resolvedReplyMentionNames = useMemo(() => {
    if (!replyTo || replyTo.mentions === undefined) return mentionNames;
    if (replyTo.mentions.length === 0) return [];
    const names: string[] = [];
    for (const id of replyTo.mentions) {
      const name = memberNames.get(id);
      if (name) names.push(name);
    }
    return names;
  }, [memberNames, mentionNames, replyTo]);
  const profile = useProfileWorkspaceState();
  if (message.type === 'SYSTEM') {
    return (
      <div className="system-message" role="note">
        {e2eeChat ? t('chat.systemMessage') : message.text?.trim() || t('chat.systemMessage')}
      </div>
    );
  }

  const author = message.sender_display_name?.trim() || UNKNOWN_AUTHOR();
  const deleted = Boolean(message.deleted_at);
  // #95: E2EE chats never render server plugin projections (the server cannot
  // enable the plugin there, but the guard is local and fail-closed).
  const poll = !e2eeChat && !deleted ? embeddedPoll(message) : null;
  const task = !e2eeChat && !deleted ? embeddedTask(message) : null;
  const pluginKind = !e2eeChat && !deleted ? pluginMessageKind(message) : null;
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
  const forward = !e2eeChat && message.type === 'TEXT' ? parseForward(text) : null;
  const visibleText = forward ? forward.body : text;
  const showText = deleted || visibleText.trim().length > 0;

  const quoteAuthor = replyTo?.sender_display_name?.trim() || UNKNOWN_AUTHOR();
  const quoteText = e2eeChat
    ? (replyText ?? (replyTo?.deleted_at ? t('chat.deletedMessage') : t('chat.replyUnavailable')))
    : (replyText ?? messagePreview(replyTo));

  // D1-FE3: only a main-feed root can start/open a thread (depth is one).
  const canThread = !deleted && !message.thread_root_id;
  const threadSummary = message.thread_summary ?? null;
  const threadReplyCount = threadSummary?.reply_count ?? 0;
  const threadLink =
    pluginKind === null &&
    canThread &&
    threadsAvailable &&
    threadSummary !== null &&
    threadReplyCount > 0 &&
    onOpenThread ? (
      <ThreadLink
        summary={threadSummary}
        authorName={threadAuthorName}
        mentionNames={mentionNames}
        onOpen={() => onOpenThread(message)}
      />
    ) : null;

  const quote = message.reply_to_id ? (
    replyTo ? (
      <button
        type="button"
        className="quote"
        onClick={() => onJumpTo(replyTo.id)}
        aria-label={`${t('chat.replyTo')}: ${quoteAuthor}: ${quoteText}`}
      >
        <span className="quote__author">{quoteAuthor}</span>
        <span className="quote__text">
          {e2eeChat ? (
            quoteText
          ) : (
            <MentionText text={quoteText} mentions={resolvedReplyMentionNames} />
          )}
        </span>
      </button>
    ) : (
      <div className="quote quote--missing">
        <span className="quote__text">
          {e2eeChat ? (
            quoteText
          ) : (
            <MentionText text={quoteText} mentions={resolvedReplyMentionNames} />
          )}
        </span>
      </div>
    )
  ) : null;

  const meta = (
    <MessageMeta
      author={author}
      mine={mine}
      isBot={isBot}
      message={message}
      readByOthers={readByOthers}
      e2eeChat={e2eeChat}
    />
  );

  if (isStickerMessage(message) && !e2ee && !e2eeChat) {
    const sticker = stickerOf(message);
    const alt = sticker?.alt?.trim() || t('stickers.imageAlt');
    return (
      <article
        className={`msg msg-row msg-row--sticker${mine ? ' msg-row--mine' : ''}${isBot ? ' msg-row--bot' : ''}`}
        id={`message-${message.id}`}
        tabIndex={-1}
      >
        <Avatar
          name={author}
          seed={message.bot_id ?? message.sender_id}
          size="lg"
          src={mine ? profile.avatar.previewUrl : null}
        />
        <div className="msg-body">
          {meta}
          {quote}
          <div className={`sticker-message${deleted ? ' sticker-message--deleted' : ''}`}>
            {deleted ? (
              <span className="sticker-message__deleted">{t('chat.deletedMessage')}</span>
            ) : sticker?.url ? (
              <img
                className="sticker-message__image"
                src={stickerAssetUrl(sticker.url)}
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
          </div>
          {threadLink}
          <ReactionBar message={message} e2eeChat={e2eeChat} />
          <MessageActions
            message={message}
            author={author}
            mine={mine}
            e2eeChat={e2eeChat}
            allowReply={allowReply}
            onReply={onReply}
            threadsAvailable={threadsAvailable}
            threadDisabledReason={threadDisabledReason}
            threadReplyCount={threadReplyCount}
            onOpenThread={onOpenThread}
          />
        </div>
      </article>
    );
  }

  if (pluginKind !== null) {
    const titleId = pluginTitleId(message.id);
    return (
      <article
        className={`msg msg-row msg-row--plugin${mine ? ' msg-row--mine' : ''}${
          isBot ? ' msg-row--bot' : ''
        }${highlighted ? ' is-focused' : ''}`}
        id={`message-${message.id}`}
        aria-labelledby={titleId}
        data-message-type={message.type}
        tabIndex={-1}
      >
        <Avatar name={author} seed={message.bot_id ?? message.sender_id} size="lg" />
        <div className="msg-body">
          {meta}
          {quote}
          {poll ? (
            <PollMessageCard
              messageId={message.id}
              chatId={message.chat_id}
              poll={poll}
              viewerId={viewerId ?? null}
              enabled={pollsEnabled}
            />
          ) : task ? (
            <TaskMessageCard
              messageId={message.id}
              chatId={message.chat_id}
              task={task}
              viewerId={viewerId ?? null}
              enabled={tasksEnabled}
              canManage={canManageTasks}
              memberNames={memberNames}
            />
          ) : (
            <PluginMessageFallback messageId={message.id} kind={pluginKind} />
          )}
          <ReactionBar message={message} e2eeChat={e2eeChat} />
          <MessageActions
            message={message}
            author={author}
            mine={mine}
            e2eeChat={e2eeChat}
            allowReply={false}
            allowThread={false}
            structured
            threadsAvailable={threadsAvailable}
            threadDisabledReason={threadDisabledReason}
            threadReplyCount={threadReplyCount}
            onOpenThread={onOpenThread}
          />
        </div>
      </article>
    );
  }

  return (
    <article
      className={`msg msg-row${mine ? ' msg-row--mine' : ''}${isBot ? ' msg-row--bot' : ''}${
        highlighted ? ' is-focused' : ''
      }`}
      id={`message-${message.id}`}
      tabIndex={-1}
    >
      <Avatar name={author} seed={message.bot_id ?? message.sender_id} size="lg" />
      <div className="msg-body">
        {meta}
        {quote}
        {showText ? (
          deleted ? (
            <p className="msg-text msg-text--deleted">{text}</p>
          ) : e2eeChat ? (
            // E2EE is plain text: no Markdown, no mention chips, no links.
            <p className="msg-text msg-text--plain">{text}</p>
          ) : forward ? (
            <ForwardedMessage text={text} />
          ) : (
            <RichText text={visibleText} mentions={resolvedMentionNames} className="msg-text" />
          )
        ) : null}
        {!deleted && !e2eeChat ? (
          <TranslatedMessage chatId={message.chat_id} messageId={message.id} />
        ) : null}
        {!deleted && !e2eeChat ? <AttachmentList attachments={message.attachments ?? []} /> : null}
        {threadLink}
        <ReactionBar message={message} e2eeChat={e2eeChat} />
        <MessageActions
          message={message}
          author={author}
          mine={mine}
          e2eeChat={e2eeChat}
          allowReply={allowReply}
          onReply={onReply}
          threadsAvailable={threadsAvailable}
          threadDisabledReason={threadDisabledReason}
          threadReplyCount={threadReplyCount}
          onOpenThread={onOpenThread}
        />
      </div>
    </article>
  );
}

interface OutgoingRowProps {
  item: OutgoingMessage;
  viewerName: string;
  retryDisabled: boolean;
  onRetry: (clientMessageId: string) => void;
  onRestore: (item: OutgoingMessage) => void;
  /** Active workspace member names for @mention chips (managed only). */
  mentionNames?: readonly string[];
  /** E2EE optimistic rows stay plain text, like the confirmed E2EE row. */
  richText?: boolean;
}

export function OutgoingRow({
  item,
  viewerName,
  retryDisabled,
  onRetry,
  onRestore,
  mentionNames = [],
  richText = false,
}: OutgoingRowProps) {
  const failed = item.status === 'failed';
  const described = item.error ? describeError(item.error) : null;
  const sticker = item.kind === 'STICKER' ? item.sticker : null;
  const createdAt = new Date(item.createdAt).toISOString();

  const status = (
    <span className="outgoing-status" role="status" aria-live="polite">
      {failed ? <AlertIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
      {failed ? t('message.failed') : t('message.pending')}
    </span>
  );
  const time = <time className="msg-time">{formatTime(createdAt)}</time>;
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

  const head = (
    <div className="msg-head">
      <span className="msg-author">{viewerName}</span>
      <span className="msg-you">{t('sidebar.user')}</span>
      {time}
      {status}
    </div>
  );

  if (sticker) {
    const alt = sticker.alt?.trim() || t('stickers.imageAlt');
    return (
      <article
        className="msg msg-row msg-row--mine msg-row--sticker"
        data-outgoing-status={item.status}
        data-sticker-outgoing="true"
      >
        <Avatar name={viewerName} seed={viewerName} size="lg" />
        <div className="msg-body">
          {head}
          <div className="sticker-message sticker-message--outgoing">
            <img
              className="sticker-message__image"
              src={stickerAssetUrl(sticker.url)}
              alt={alt}
              width={512}
              height={512}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          </div>
          {errorBlock}
        </div>
      </article>
    );
  }

  return (
    <article className="msg msg-row msg-row--mine" data-outgoing-status={item.status}>
      <Avatar name={viewerName} seed={viewerName} size="lg" />
      <div className="msg-body">
        {head}
        {item.text.trim().length > 0 ? (
          richText ? (
            <RichText text={item.text} mentions={mentionNames} className="msg-text" />
          ) : (
            <p className="msg-text msg-text--plain">{item.text}</p>
          )
        ) : null}
        <AttachmentList attachments={item.attachments} outgoing />
        {errorBlock}
      </div>
    </article>
  );
}
