import { useMemo } from 'react';
import type { MessageSearchHit, SearchHighlight } from '../api/types';
import { formatShortDate } from '../domain/messages';
import { t } from '../i18n/ru';
import type { ApiError } from '../api/problem';
import type { MessageSearchState } from '../store/chatStore';
import { RefreshIcon, SearchIcon } from './Icons';

/**
 * #83: renders the server `snippet` **as text** and marks the `highlights`
 * ranges. The offsets are UTF-16 code units, exactly like JS strings; ranges
 * are clamped, sorted and merged so hostile/overlapping input cannot break the
 * layout or highlight outside the snippet.
 */
function HighlightedSnippet({
  snippet,
  highlights,
}: {
  snippet: string;
  highlights: readonly SearchHighlight[];
}) {
  const parts = useMemo(() => {
    const ranges = highlights
      .map((range) => ({
        start: Math.max(0, Math.min(snippet.length, range.start)),
        end: Math.max(0, Math.min(snippet.length, range.end)),
      }))
      .filter((range) => range.end > range.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);

    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }

    const result: Array<{ text: string; mark: boolean }> = [];
    let cursor = 0;
    for (const range of merged) {
      if (range.start > cursor)
        result.push({ text: snippet.slice(cursor, range.start), mark: false });
      result.push({ text: snippet.slice(range.start, range.end), mark: true });
      cursor = range.end;
    }
    if (cursor < snippet.length) result.push({ text: snippet.slice(cursor), mark: false });
    return result;
  }, [highlights, snippet]);

  return (
    <span className="search-hit__snippet" dir="auto">
      {parts.map((part, index) =>
        part.mark ? (
          <mark key={index} className="search-hit__mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

interface MessageSearchPanelProps {
  readonly state: MessageSearchState;
  readonly onSelect: (hit: MessageSearchHit) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}

function errorText(error: ApiError | null): string {
  if (error?.status === 403) return t('chat.forbiddenText');
  if (error?.status === 404) return t('chat.forbiddenText');
  return t('chat.searchErrorText');
}

/**
 * #83 workspace search results. Every row is server-produced: chat name,
 * plain-text snippet, highlight ranges and an opaque cursor. An empty query is
 * an explicit hint, never a client-side filter over loaded history.
 */
export function MessageSearchPanel({
  state,
  onSelect,
  onLoadMore,
  onRetry,
}: MessageSearchPanelProps) {
  if (state.status === 'idle') {
    return (
      <div className="chat-search__panel" role="status">
        <strong>{t('chat.searchHintTitle')}</strong>
        <p>{t('chat.searchHintText')}</p>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="chat-search__panel" role="status" aria-busy="true">
        {t('chat.searchLoading')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="chat-search__panel chat-search__panel--error" role="alert">
        <strong>{t('chat.searchErrorTitle')}</strong>
        <p>{errorText(state.error)}</p>
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          <RefreshIcon aria-hidden="true" />
          {t('chat.searchRetry')}
        </button>
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="chat-search__panel" role="status">
        <SearchIcon aria-hidden="true" />
        <strong>{t('chat.searchEmptyTitle')}</strong>
        <p>{t('chat.searchEmptyText')}</p>
      </div>
    );
  }

  return (
    <div className="chat-search__panel">
      <ul className="search-hit-list" aria-label={t('chat.searchResults')}>
        {state.items.map((hit) => (
          <li key={hit.message_id}>
            <button
              type="button"
              className="search-hit"
              onClick={() => onSelect(hit)}
              aria-label={`${hit.chat_name ?? t('files.unknownChat')}: ${hit.snippet}`}
            >
              <span className="search-hit__head">
                <span className="search-hit__chat">{hit.chat_name ?? t('files.unknownChat')}</span>
                <time className="search-hit__time" dateTime={hit.created_at}>
                  {formatShortDate(hit.created_at)}
                </time>
              </span>
              {hit.sender_display_name ? (
                <span className="search-hit__author">{hit.sender_display_name}</span>
              ) : null}
              <HighlightedSnippet snippet={hit.snippet} highlights={hit.highlights} />
            </button>
          </li>
        ))}
      </ul>
      {state.hasMore || state.loadMoreStatus === 'error' ? (
        <div className="search-hit__more">
          {state.loadMoreStatus === 'error' ? (
            <span className="search-hit__more-error">{t('chat.searchErrorText')}</span>
          ) : null}
          <button
            type="button"
            className="btn btn--sm"
            onClick={onLoadMore}
            disabled={state.loadMoreStatus === 'loading'}
          >
            {state.loadMoreStatus === 'loading'
              ? t('chat.searchLoadingMore')
              : t('chat.searchLoadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
