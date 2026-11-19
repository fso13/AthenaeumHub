import { useEffect } from 'react';
import type { Poll } from '../../api/types';
import { formatDateTime } from '../../domain/messages';
import { t } from '../../i18n/ru';
import { pluginActionErrorText } from '../../plugins/errors';
import {
  useChatState,
  usePluginActionsState,
  usePluginActionsStore,
} from '../../store/ChatProvider';
import { PollIcon } from '../Icons';

function PollCard({
  chatId,
  poll,
  viewerId,
}: {
  chatId: string;
  poll: Poll;
  viewerId: string | null;
}) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const pending = state.pendingPollIds.includes(poll.id);
  const closing = state.closingPollIds.includes(poll.id);
  const error = state.pollErrors[poll.id] ?? null;
  const titleId = `poll-title-${poll.id}`;
  const total = poll.total_votes;
  const myOption = poll.options.find((option) => option.id === poll.my_option_id) ?? null;
  const options = [...poll.options].sort((a, b) => a.position - b.position);

  return (
    <article className="poll-card" aria-labelledby={titleId} aria-busy={pending}>
      <h3 className="poll-card__title" id={titleId}>
        {poll.question}
      </h3>
      <p className="poll-card__meta">
        <span className={`poll-status${poll.closed ? ' poll-status--closed' : ''}`}>
          {poll.closed ? t('pluginActions.pollClosed') : t('pluginActions.pollOpen')}
        </span>
        <span>{t('pluginActions.pollVotes', { count: total })}</span>
        {poll.closed && poll.closed_at ? (
          <span>{t('pluginActions.pollClosedAt', { time: formatDateTime(poll.closed_at) })}</span>
        ) : null}
      </p>

      <ul className="poll-options">
        {options.map((option) => {
          const mine = option.id === poll.my_option_id;
          const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
          const base = mine
            ? t('pluginActions.pollVoteMine', { option: option.text })
            : t('pluginActions.pollVoteLabel', { option: option.text });
          const label = `${base}, ${t('pluginActions.pollVotes', { count: option.votes })}`;
          return (
            <li key={option.id}>
              <button
                type="button"
                className={`poll-option${mine ? ' is-mine' : ''}`}
                aria-pressed={mine}
                aria-label={label}
                disabled={poll.closed || pending}
                onClick={() => void store.votePoll(chatId, poll.id, option.id)}
              >
                <span className="poll-option__bar" aria-hidden="true">
                  <span style={{ width: `${percent}%` }} />
                </span>
                <span className="poll-option__text">{option.text}</span>
                <span className="poll-option__count" aria-hidden="true">
                  {option.votes} · {percent}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {myOption ? (
        <p className="poll-card__mine">
          {t('pluginActions.pollMyVote')}: «{myOption.text}»
        </p>
      ) : null}

      {error ? (
        <p className="plugin-inline-error" role="alert">
          {t('pluginActions.pollError')} {pluginActionErrorText(error, 'poll')}
        </p>
      ) : null}

      {!poll.closed && viewerId !== null && poll.creator_id === viewerId ? (
        <div className="poll-card__actions">
          <button
            type="button"
            className="button button--small"
            onClick={() => void store.closePoll(chatId, poll.id)}
            disabled={pending}
          >
            {closing ? t('pluginActions.pollClosing') : t('pluginActions.pollClose')}
          </button>
        </div>
      ) : null}
    </article>
  );
}

interface PollPanelProps {
  chatId: string;
}

/**
 * D1.1 (#76) poll list for the chat details panel. Rows, vote totals and the
 * closed state are server values; a vote only moves after the response and the
 * button set is disabled while that request is in flight.
 */
export function PollPanel({ chatId }: PollPanelProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const chat = useChatState();
  const viewerId = chat.user?.id ?? chat.session?.user.id ?? null;
  const currentChat = state.chatId === chatId;

  useEffect(() => {
    void store.ensurePolls(chatId);
  }, [store, chatId]);

  if (!currentChat || state.pollsStatus === 'idle' || state.pollsStatus === 'loading') {
    return (
      <p className="plugin-panel__state" role="status">
        {t('pluginActions.pollsLoading')}
      </p>
    );
  }

  if (state.pollsStatus === 'error') {
    return (
      <div className="plugin-panel__state">
        <p role="alert">{t('pluginActions.pollsError')}</p>
        {state.pollsError ? (
          <p className="plugin-inline-error">{pluginActionErrorText(state.pollsError, 'poll')}</p>
        ) : null}
        <button
          type="button"
          className="button button--small"
          onClick={() => void store.loadPolls(chatId, true)}
        >
          {t('pluginActions.pollsRetry')}
        </button>
      </div>
    );
  }

  if (state.polls.length === 0) {
    return (
      <p className="plugin-panel__state">
        <PollIcon aria-hidden="true" /> {t('pluginActions.pollsEmpty')}
      </p>
    );
  }

  return (
    <div className="plugin-panel">
      {state.polls.map((poll) => (
        <PollCard key={poll.id} chatId={chatId} poll={poll} viewerId={viewerId} />
      ))}
    </div>
  );
}
