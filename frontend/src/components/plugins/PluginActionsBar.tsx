import { t } from '../../i18n/ru';
import { PollIcon, TaskIcon } from '../Icons';

interface PluginActionsBarProps {
  pollsEnabled: boolean;
  tasksEnabled: boolean;
  onCreatePoll: () => void;
  onCreateTask: () => void;
}

/**
 * D1.1 (#76) compact action bar above the composer. Buttons exist only when the
 * per-chat plugin rows are loaded and the server reports the plugin enabled and
 * available; a disabled plugin gets no affordance at all.
 */
export function PluginActionsBar({
  pollsEnabled,
  tasksEnabled,
  onCreatePoll,
  onCreateTask,
}: PluginActionsBarProps) {
  if (!pollsEnabled && !tasksEnabled) return null;

  return (
    <div className="plugin-bar" role="group" aria-label={t('pluginActions.barLabel')}>
      {pollsEnabled ? (
        <button
          type="button"
          className="plugin-bar__button"
          onClick={onCreatePoll}
          aria-label={t('pluginActions.createPoll')}
          title={t('pluginActions.createPoll')}
        >
          <PollIcon aria-hidden="true" />
          <span>{t('pluginActions.poll')}</span>
        </button>
      ) : null}
      {tasksEnabled ? (
        <button
          type="button"
          className="plugin-bar__button"
          onClick={onCreateTask}
          aria-label={t('pluginActions.createTask')}
          title={t('pluginActions.createTask')}
        >
          <TaskIcon aria-hidden="true" />
          <span>{t('pluginActions.task')}</span>
        </button>
      ) : null}
    </div>
  );
}
