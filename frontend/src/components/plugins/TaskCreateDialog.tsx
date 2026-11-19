import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { Task, WorkspaceMember } from '../../api/types';
import { t } from '../../i18n/ru';
import { usePluginActionsState, usePluginActionsStore } from '../../store/ChatProvider';
import { pluginActionErrorText } from '../../plugins/errors';
import { PluginModal } from './PluginModal';

const MAX_TITLE = 500;

function hasForbiddenChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '<' || char === '>') return true;
  }
  return false;
}

function titleIssue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE) return 'length';
  if (hasForbiddenChars(trimmed)) return 'chars';
  return null;
}

interface TaskCreateDialogProps {
  chatId: string;
  members: readonly WorkspaceMember[];
  membersLoading: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}

/**
 * D1.1 (#76) task composer. `assignee_id` is an ACTIVE chat member (server
 * validates) and `due_at` is an optional ISO date-time; the created row comes
 * from the `201` response.
 */
export function TaskCreateDialog({
  chatId,
  members,
  membersLoading,
  onClose,
  onCreated,
}: TaskCreateDialogProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const titleId = useId();
  const inputId = useId();
  const inputErrorId = useId();
  const assigneeIdField = useId();
  const dueId = useId();
  const dueErrorId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const busy = state.createTaskPending;

  useEffect(() => {
    store.clearCreateTaskError();
    titleRef.current?.focus();
  }, [store]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    let valid = true;
    if (titleIssue(title) !== null) {
      setTitleError(t('pluginActions.validationTaskTitle'));
      valid = false;
    } else {
      setTitleError(null);
    }
    let dueIso: string | null = null;
    if (dueAt.trim().length > 0) {
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) {
        setDueError(t('pluginActions.validationTaskDue'));
        valid = false;
      } else {
        dueIso = parsed.toISOString();
        setDueError(null);
      }
    } else {
      setDueError(null);
    }
    if (!valid) return;

    const task = await store.createTask(chatId, {
      title: title.trim(),
      assignee_id: assigneeId.length > 0 ? assigneeId : null,
      due_at: dueIso,
    });
    if (task) {
      onCreated(task);
      return;
    }
    setFormError(store.getSnapshot().createTaskError);
  };

  return (
    <PluginModal
      title={t('pluginActions.taskDialogTitle')}
      titleId={titleId}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t('pluginActions.cancel')}
          </button>
          <button
            type="submit"
            form="task-create-form"
            className="button button--primary"
            disabled={busy}
          >
            {busy ? t('pluginActions.taskSubmitting') : t('pluginActions.taskSubmit')}
          </button>
        </>
      }
    >
      <form id="task-create-form" className="plugin-form" onSubmit={(event) => void submit(event)}>
        <div className="plugin-field">
          <label htmlFor={inputId}>{t('pluginActions.taskTitle')}</label>
          <input
            id={inputId}
            ref={titleRef}
            type="text"
            value={title}
            maxLength={MAX_TITLE}
            placeholder={t('pluginActions.taskTitlePlaceholder')}
            aria-invalid={titleError !== null}
            aria-describedby={titleError ? inputErrorId : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              if (titleError) setTitleError(null);
            }}
          />
          {titleError ? (
            <p className="plugin-field__error" id={inputErrorId} role="alert">
              {titleError}
            </p>
          ) : null}
        </div>

        <div className="plugin-field">
          <label htmlFor={assigneeIdField}>{t('pluginActions.taskAssignee')}</label>
          <select
            id={assigneeIdField}
            value={assigneeId}
            disabled={busy}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">{t('pluginActions.taskAssigneeNone')}</option>
            {members.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.display_name}
              </option>
            ))}
          </select>
          {membersLoading ? <p className="plugin-field__hint">{t('common.loading')}</p> : null}
        </div>

        <div className="plugin-field">
          <label htmlFor={dueId}>{t('pluginActions.taskDue')}</label>
          <input
            id={dueId}
            type="datetime-local"
            value={dueAt}
            disabled={busy}
            aria-invalid={dueError !== null}
            aria-describedby={dueError ? dueErrorId : undefined}
            onChange={(event) => {
              setDueAt(event.target.value);
              if (dueError) setDueError(null);
            }}
          />
          {dueError ? (
            <p className="plugin-field__error" id={dueErrorId} role="alert">
              {dueError}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p className="plugin-form__error" role="alert">
            {t('pluginActions.taskCreateError')} {pluginActionErrorText(formError, 'taskCreate')}
          </p>
        ) : null}
      </form>
    </PluginModal>
  );
}
