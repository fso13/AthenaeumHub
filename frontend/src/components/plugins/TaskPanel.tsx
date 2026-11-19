import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../api/types';
import { formatShortDate } from '../../domain/messages';
import { t } from '../../i18n/ru';
import { pluginActionErrorText } from '../../plugins/errors';
import {
  useChatState,
  usePluginActionsState,
  usePluginActionsStore,
} from '../../store/ChatProvider';
import { CheckIcon, TaskIcon } from '../Icons';

type TaskFilter = 'open' | 'done';

function TaskRow({
  chatId,
  task,
  viewerId,
  canManage,
  memberNames,
}: {
  chatId: string;
  task: Task;
  viewerId: string | null;
  canManage: boolean;
  memberNames: ReadonlyMap<string, string>;
}) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const pending = state.pendingTaskIds.includes(task.id);
  const error = state.taskErrors[task.id] ?? null;
  const canToggle = canManage || task.creator_id === viewerId || task.assignee_id === viewerId;
  const assignee = task.assignee_id ? (memberNames.get(task.assignee_id) ?? null) : null;
  const completedBy = task.completed_by ? (memberNames.get(task.completed_by) ?? null) : null;
  const titleId = `task-title-${task.id}`;
  const toggleLabel = task.done ? t('pluginActions.taskReopen') : t('pluginActions.taskToggle');

  return (
    <article
      className={`task-card${task.done ? ' task-card--done' : ''}`}
      aria-labelledby={titleId}
    >
      <span
        className="task-check"
        title={canToggle ? toggleLabel : t('pluginActions.taskToggleDenied')}
      >
        <input
          type="checkbox"
          checked={task.done}
          disabled={!canToggle || pending}
          aria-label={toggleLabel}
          onChange={() => void store.updateTask(chatId, task.id, !task.done)}
        />
      </span>
      <div className="task-card__body">
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
    </article>
  );
}

interface TaskPanelProps {
  chatId: string;
}

/**
 * D1.1 (#76) task list for the details panel. Filters are a local view over the
 * server rows; completing/reopening waits for the `PATCH` response and never
 * flips the checkbox optimistically.
 */
export function TaskPanel({ chatId }: TaskPanelProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const chat = useChatState();
  const [filter, setFilter] = useState<TaskFilter>('open');
  const viewerId = chat.user?.id ?? chat.session?.user.id ?? null;
  const role =
    chat.activeWorkspace?.role ??
    chat.workspaces.find((workspace) => workspace.id === chat.activeWorkspaceId)?.role ??
    null;
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const currentChat = state.chatId === chatId;

  const memberNames = useMemo(
    () =>
      new Map(chat.workspaceMembers.items.map((member) => [member.user_id, member.display_name])),
    [chat.workspaceMembers.items],
  );
  const open = state.tasks.filter((task) => !task.done);
  const done = state.tasks.filter((task) => task.done);
  const visible = filter === 'open' ? open : done;

  useEffect(() => {
    void store.ensureTasks(chatId);
  }, [store, chatId]);

  if (!currentChat || state.tasksStatus === 'idle' || state.tasksStatus === 'loading') {
    return (
      <p className="plugin-panel__state" role="status">
        {t('pluginActions.tasksLoading')}
      </p>
    );
  }

  if (state.tasksStatus === 'error') {
    return (
      <div className="plugin-panel__state">
        <p role="alert">{t('pluginActions.tasksError')}</p>
        {state.tasksError ? (
          <p className="plugin-inline-error">{pluginActionErrorText(state.tasksError, 'task')}</p>
        ) : null}
        <button
          type="button"
          className="button button--small"
          onClick={() => void store.loadTasks(chatId, true)}
        >
          {t('pluginActions.tasksRetry')}
        </button>
      </div>
    );
  }

  return (
    <div className="plugin-panel">
      <div className="task-filters" role="group" aria-label={t('pluginActions.tasksFilterLabel')}>
        <button
          type="button"
          className={`task-filter${filter === 'open' ? ' is-active' : ''}`}
          aria-pressed={filter === 'open'}
          onClick={() => setFilter('open')}
        >
          {t('pluginActions.tasksFilterOpen')} <span aria-hidden="true">{open.length}</span>
        </button>
        <button
          type="button"
          className={`task-filter${filter === 'done' ? ' is-active' : ''}`}
          aria-pressed={filter === 'done'}
          onClick={() => setFilter('done')}
        >
          {t('pluginActions.tasksFilterDone')} <span aria-hidden="true">{done.length}</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="plugin-panel__state">
          <TaskIcon aria-hidden="true" />{' '}
          {filter === 'open'
            ? t('pluginActions.tasksEmptyOpen')
            : t('pluginActions.tasksEmptyDone')}
        </p>
      ) : (
        <div className="task-list">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              chatId={chatId}
              task={task}
              viewerId={viewerId}
              canManage={canManage}
              memberNames={memberNames}
            />
          ))}
        </div>
      )}
    </div>
  );
}
