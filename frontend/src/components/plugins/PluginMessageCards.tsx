import type { Poll, Task } from '../../api/types';
import { formatDateTime, formatShortDate } from '../../domain/messages';
import { t } from '../../i18n/ru';
import {
  canToggleTask,
  canVotePoll,
  pluginTitleId,
  pollPercent,
  sortPollOptions,
} from '../../plugins/messageCards';
import { pluginActionErrorText } from '../../plugins/errors';
import { usePluginActionsState, usePluginActionsStore } from '../../store/ChatProvider';
import { CheckIcon, PollIcon, TaskIcon } from '../Icons';

interface PollMessageCardProps {
  messageId: string;
  chatId: string;
  poll: Poll;
  viewerId: string | null;
  /** Server says the `polls` plugin is enabled and available for this chat. */
  enabled: boolean;
}

/**
 * #95 poll card in the flat feed. Every number/question/state is the embedded
 * server object; a vote/close waits for the response and the chat store then
 * replaces `message.poll` in place (the plugin store only owns its own list).
 */
export function PollMessageCard({
  messageId,
  chatId,
  poll,
  viewerId,
  enabled,
}: PollMessageCardProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const pending = state.pendingPollIds.includes(poll.id);
  const closing = state.closingPollIds.includes(poll.id);
  const error = state.pollErrors[poll.id] ?? null;
  const titleId = pluginTitleId(messageId);
  const total = Math.max(0, poll.total_votes);
  const myOption = poll.options.find((option) => option.id === poll.my_option_id) ?? null;
  const options = sortPollOptions(poll);
  const canVote = enabled && canVotePoll(poll) && viewerId !== null;
  const votingOffReason = !enabled
    ? t('pluginActions.pollVotingOff')
    : poll.closed
      ? t('pluginActions.pollClosed')
      : null;

  return (
    <div className={`plugin-message plugin-message--poll${poll.closed ? ' is-closed' : ''}`}>
      <div className="poll-card" aria-busy={pending}>
        <p className="plugin-message__kind">
          <PollIcon aria-hidden="true" />
          {t('pluginActions.poll')}
        </p>
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

        <ul className="poll-options" aria-label={t('pluginActions.pollOptionsLabel')}>
          {options.map((option) => {
            const mine = option.id === poll.my_option_id;
            const percent = pollPercent(option.votes, total);
            const base = mine
              ? t('pluginActions.pollVoteMine', { option: option.text })
              : t('pluginActions.pollVoteLabel', { option: option.text });
            const label = `${base}, ${t('pluginActions.pollVotes', { count: option.votes })}, ${percent}%`;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  className={`poll-option${mine ? ' is-mine' : ''}`}
                  aria-pressed={mine}
                  aria-label={label}
                  title={!canVote ? (votingOffReason ?? undefined) : label}
                  disabled={!canVote || pending}
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

        {votingOffReason && !error ? (
          <p className="plugin-message__hint">{votingOffReason}</p>
        ) : null}

        {error ? (
          <p className="plugin-inline-error" role="alert">
            {t('pluginActions.pollError')} {pluginActionErrorText(error, 'poll')}
          </p>
        ) : null}

        {enabled && viewerId !== null && poll.creator_id === viewerId && !poll.closed ? (
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
      </div>
    </div>
  );
}

interface TaskMessageCardProps {
  messageId: string;
  chatId: string;
  task: Task;
  viewerId: string | null;
  /** Server says the `tasks` plugin is enabled and available for this chat. */
  enabled: boolean;
  /** Workspace OWNER/ADMIN, same rule the task panel used. */
  canManage: boolean;
  memberNames: ReadonlyMap<string, string>;
}

/**
 * #95 task card in the flat feed. The checkbox is never optimistic: `done`
 * and `completed_*` are the server response, applied to `message.task`.
 */
export function TaskMessageCard({
  messageId,
  chatId,
  task,
  viewerId,
  enabled,
  canManage,
  memberNames,
}: TaskMessageCardProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const pending = state.pendingTaskIds.includes(task.id);
  const error = state.taskErrors[task.id] ?? null;
  const titleId = pluginTitleId(messageId);
  const allowed = canToggleTask(task, viewerId, canManage);
  const canToggle = enabled && allowed;
  const assignee = task.assignee_id
    ? (memberNames.get(task.assignee_id) ?? t('chat.unknownAuthor'))
    : null;
  const completedBy = task.completed_by
    ? (memberNames.get(task.completed_by) ?? t('chat.unknownAuthor'))
    : null;
  const toggleLabel = task.done ? t('pluginActions.taskReopen') : t('pluginActions.taskToggle');
  const deniedReason = !enabled
    ? t('pluginActions.taskActionsOff')
    : t('pluginActions.taskToggleDenied');

  return (
    <div className={`plugin-message plugin-message--task${task.done ? ' is-done' : ''}`}>
      <div className={`task-card${task.done ? ' task-card--done' : ''}`} aria-busy={pending}>
        <span className="task-check" title={canToggle ? toggleLabel : deniedReason}>
          <input
            type="checkbox"
            checked={task.done}
            disabled={!canToggle || pending}
            aria-label={toggleLabel}
            title={canToggle ? toggleLabel : deniedReason}
            onChange={() => void store.updateTask(chatId, task.id, !task.done)}
          />
        </span>
        <div className="task-card__body">
          <p className="plugin-message__kind">
            <TaskIcon aria-hidden="true" />
            {t('pluginActions.task')}
          </p>
          <h3 className="task-card__title" id={titleId}>
            {task.title}
          </h3>
          <p className="task-card__meta">
            <span>
              {t('pluginActions.taskAssigneeLabel', {
                name: assignee ?? t('pluginActions.taskNoAssignee'),
              })}
            </span>
            {task.due_at ? (
              <span>{t('pluginActions.taskDueLabel', { date: formatShortDate(task.due_at) })}</span>
            ) : null}
            {task.done && task.completed_by ? (
              <span>
                {t('pluginActions.taskCompletedBy', {
                  name: completedBy ?? t('chat.unknownAuthor'),
                })}
              </span>
            ) : null}
          </p>
          {error ? (
            <p className="plugin-inline-error" role="alert">
              {t('pluginActions.taskError')} {pluginActionErrorText(error, 'task')}
            </p>
          ) : null}
        </div>
        {task.done ? (
          <span className="task-done-chip">
            <CheckIcon aria-hidden="true" />
            {t('pluginActions.taskDone')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface PluginMessageFallbackProps {
  messageId: string;
  kind: 'POLL' | 'TASK';
}

/**
 * A POLL/TASK row whose embedded object is missing or malformed (never a
 * tombstone: those render the normal deleted row). No question/title is
 * invented and no action is offered.
 */
export function PluginMessageFallback({ messageId, kind }: PluginMessageFallbackProps) {
  const titleId = pluginTitleId(messageId);
  const Icon = kind === 'POLL' ? PollIcon : TaskIcon;
  return (
    <div className="plugin-message plugin-message--missing">
      <p className="plugin-message__kind">
        <Icon aria-hidden="true" />
        {kind === 'POLL' ? t('pluginActions.poll') : t('pluginActions.task')}
      </p>
      <h3 className="plugin-message__title" id={titleId}>
        {kind === 'POLL' ? t('pluginActions.pollUnavailable') : t('pluginActions.taskUnavailable')}
      </h3>
    </div>
  );
}
