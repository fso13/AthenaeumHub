import type { ThreadSummary } from '../api/types';
import { formatShortDate } from '../domain/messages';
import { t } from '../i18n/ru';
import { ThreadIcon } from './Icons';
import { MentionText } from './MentionText';

interface ThreadLinkProps {
  /** Server-computed summary of the root (managed only; never invented). */
  summary: ThreadSummary;
  /** Display name resolved locally from loaded senders; null is honest. */
  authorName?: string | null;
  /** Active workspace member names for mention chips in the excerpt. */
  mentionNames?: readonly string[];
  onOpen: () => void;
}

/** Russian plural for the reply counter; the exact number stays the source. */
export function threadReplyCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return t('thread.countOne', { count });
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return t('thread.countFew', { count });
  }
  return t('thread.countMany', { count });
}

/**
 * D1-FE3: inline entry point under a root message. Shows the server reply
 * count, the last reply excerpt (managed only) and its time. Replies with no
 * text (sticker/attachment) render an honest fallback instead of a fake quote.
 */
export function ThreadLink({
  summary,
  authorName = null,
  mentionNames = [],
  onOpen,
}: ThreadLinkProps) {
  const replyCount = summary.reply_count ?? 0;
  const countLabel = threadReplyCountLabel(replyCount);
  const excerpt = summary.last_reply_excerpt?.trim() ?? '';
  const preview = excerpt.length > 0 ? excerpt : t('thread.previewFallback');
  const author = authorName?.trim() ?? '';
  const when = formatShortDate(summary.last_reply_at);

  return (
    <button
      type="button"
      className="thread-link"
      onClick={onOpen}
      aria-label={t('thread.openLabel', { count: replyCount })}
    >
      <ThreadIcon aria-hidden="true" />
      <span className="thread-link__count">{countLabel}</span>
      <span className="thread-link__preview">
        {author ? <span className="thread-link__author">{author}: </span> : null}
        <MentionText text={preview} mentions={mentionNames} />
      </span>
      {when ? (
        <time className="thread-link__time" dateTime={summary.last_reply_at ?? undefined}>
          {when}
        </time>
      ) : null}
    </button>
  );
}
