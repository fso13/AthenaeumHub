import { useEffect, useId, useState } from 'react';
import type { ApiError } from '../api/problem';
import type { WorkspaceSummary } from '../api/types';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import type { WorkspaceLifecycleAction } from '../workspace/lifecycle';
import { AdminConfirmDialog } from './admin/AdminConfirmDialog';

function lifecycleErrorText(error: ApiError, action: WorkspaceLifecycleAction): string {
  if (error.status === 409 && error.code === 'LAST_OWNER') {
    return t('workspace.lifecycle.error.lastOwner');
  }
  if (error.status === 403) {
    return action === 'delete'
      ? t('workspace.lifecycle.error.forbiddenDelete')
      : t('workspace.lifecycle.error.forbiddenLeave');
  }
  if (error.status === 404) return t('workspace.lifecycle.error.notFound');
  if (error.isNetwork || error.status === 429 || error.status >= 500) {
    return t('workspace.lifecycle.error.unavailable');
  }
  return t('workspace.lifecycle.error.generic');
}

export interface WorkspaceLifecycleDialogsProps {
  /** Workspace targeted by the pending action, or null when nothing is open. */
  workspace: WorkspaceSummary | null;
  action: WorkspaceLifecycleAction | null;
  onClose: () => void;
  /** Called after the server accepted the action and local state was pruned. */
  onRemoved?: (workspaceId: string) => void;
}

/**
 * #99 confirmations shared by every entry point (settings danger zone, space
 * rail and workspace switcher).
 *
 * - Leave names the workspace and explains the lost access; the server still
 *   answers `409 LAST_OWNER` if the caller became the last owner in another
 *   tab, which is shown verbatim instead of silently closing.
 * - Delete is irreversible and requires typing the exact workspace name; the
 *   confirm button stays disabled until it matches.
 * - Both dialogs keep the raw `ApiError` for the diagnostic details block and
 *   do not close on a retryable failure.
 */
export function WorkspaceLifecycleDialogs({
  workspace,
  action,
  onClose,
  onRemoved,
}: WorkspaceLifecycleDialogsProps) {
  const store = useChatStore();
  const state = useChatState();
  const [typedName, setTypedName] = useState('');
  const typedInputId = useId();

  const lifecycle = state.workspaceLifecycle;
  const active =
    workspace !== null &&
    action !== null &&
    lifecycle.workspaceId === workspace.id &&
    lifecycle.action === action;
  const busy = active && (lifecycle.status === 'leaving' || lifecycle.status === 'deleting');
  const error = active && lifecycle.status === 'error' ? lifecycle.error : null;

  useEffect(() => {
    setTypedName('');
  }, [workspace?.id, action]);

  if (!workspace || !action) return null;

  const errorInfo = error
    ? {
        text: lifecycleErrorText(error, action),
        tone: 'error' as const,
        retryable: error.isNetwork || error.status >= 500,
        closeOnError: false,
      }
    : null;

  const run = async () => {
    const ok =
      action === 'delete'
        ? await store.deleteWorkspace(workspace.id)
        : await store.leaveWorkspace(workspace.id);
    if (ok) onRemoved?.(workspace.id);
  };

  if (action === 'leave') {
    return (
      <AdminConfirmDialog
        title={t('workspace.lifecycle.leaveConfirmTitle', { name: workspace.name })}
        description={
          <>
            <p className="admin-confirm__lead">
              {t('workspace.lifecycle.leaveConfirmLead', { name: workspace.name })}
            </p>
            <ul className="admin-confirm__list">
              <li>{t('workspace.lifecycle.leaveConfirmNote')}</li>
            </ul>
          </>
        }
        confirmLabel={t('workspace.lifecycle.leaveConfirm')}
        busyLabel={t('workspace.lifecycle.leaving')}
        cancelLabel={t('common.cancel')}
        destructive
        busy={busy}
        error={errorInfo}
        errorDetails={error}
        onConfirm={() => void run()}
        onClose={() => {
          if (busy) return;
          store.clearWorkspaceLifecycle();
          onClose();
        }}
      />
    );
  }

  const matches = typedName.trim() === workspace.name.trim();
  return (
    <AdminConfirmDialog
      title={t('workspace.lifecycle.deleteConfirmTitle', { name: workspace.name })}
      description={
        <>
          <p className="admin-confirm__lead">
            {t('workspace.lifecycle.deleteConfirmLead', { name: workspace.name })}
          </p>
          <ul className="admin-confirm__list">
            <li>{t('workspace.lifecycle.deleteConfirmNote')}</li>
          </ul>
          <div className="form-row admin-confirm__type">
            <label htmlFor={typedInputId}>{t('workspace.lifecycle.deleteTypeLabel')}</label>
            <input
              id={typedInputId}
              className="input"
              type="text"
              value={typedName}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={typedName.length > 0 && !matches}
              aria-describedby={`${typedInputId}-hint`}
              onChange={(event) => setTypedName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && matches && !busy) {
                  event.preventDefault();
                  void run();
                }
              }}
            />
            <div className="field__meta" id={`${typedInputId}-hint`}>
              {typedName.length > 0 && !matches
                ? t('workspace.lifecycle.deleteTypeMismatch')
                : t('workspace.lifecycle.deleteTypeHint', { name: workspace.name })}
            </div>
          </div>
        </>
      }
      confirmLabel={t('workspace.lifecycle.deleteConfirm')}
      busyLabel={t('workspace.lifecycle.deleting')}
      cancelLabel={t('common.cancel')}
      destructive
      busy={busy}
      confirmDisabled={!matches}
      error={errorInfo}
      errorDetails={error}
      onConfirm={() => void run()}
      onClose={() => {
        if (busy) return;
        store.clearWorkspaceLifecycle();
        onClose();
      }}
    />
  );
}
