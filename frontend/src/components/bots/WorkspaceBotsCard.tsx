import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { Bot, BotStatus, WorkspacePermissionRole, WorkspaceSummary } from '../../api/types';
import { botErrorText } from '../../bots/errors';
import { formatDateTime } from '../admin/format';
import { t, type MessageKey } from '../../i18n/ru';
import { useBotsState, useBotsStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { Avatar } from '../Avatar';
import { BotIcon, RefreshIcon } from '../Icons';
import { BotEventsDialog } from './BotEventsDialog';
import { BotTokenDialog } from './BotTokenDialog';

const BOT_STATUS_LABEL: Record<BotStatus, MessageKey> = {
  ACTIVE: 'bots.status.ACTIVE',
  DISABLED: 'bots.status.DISABLED',
};

type BotConfirm = { kind: 'rotate'; bot: Bot } | { kind: 'delete'; bot: Bot };

function actionErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: botErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

export interface WorkspaceBotsCardProps {
  workspace: WorkspaceSummary;
  /** Workspace role; bot management is role-gated (not the permission matrix). */
  actorRole: WorkspacePermissionRole | 'GUEST' | null;
}

/**
 * #96/#98 workspace bot management (Settings → Боты).
 *
 * - `GET /workspaces/{id}/bots` is readable by any ACTIVE member; create,
 *   rotate, enable/disable, delete and event settings are OWNER/ADMIN-only
 *   (the server still enforces every guard).
 * - The raw token appears only in the one-time `BotToken` modal and is dropped
 *   from the store when the modal closes, the tab unmounts or the workspace
 *   changes. It is never written to storage or logged.
 * - #98 event settings (https URL, subscriptions, slash commands, signing
 *   secret, deliveries and the test ping) live in `BotEventsDialog`; the
 *   signing secret is equally one-time and memory-only.
 * - Rows are replaced only by server responses; the soft-disable `204` triggers
 *   a re-read instead of an optimistic status flip.
 */
export function WorkspaceBotsCard({ workspace, actorRole }: WorkspaceBotsCardProps) {
  const store = useBotsStore();
  const state = useBotsState();
  const bots = state.workspace.workspaceId === workspace.id ? state.workspace : null;

  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<BotConfirm | null>(null);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const titleId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const scopeId = useId();

  const canManage = actorRole === 'OWNER' || actorRole === 'ADMIN';
  const loading = bots === null || bots.status === 'loading';
  const listError = bots?.status === 'error' ? bots.error : null;
  const createError = bots?.createStatus === 'error' ? bots.createError : null;
  const creating = bots?.createStatus === 'creating';
  const rotatePendingId = bots?.rotatePendingId ?? null;
  const disablePendingId = bots?.disablePendingId ?? null;
  const updatePendingId = bots?.updatePendingId ?? null;
  const busy = rotatePendingId !== null || disablePendingId !== null || updatePendingId !== null;
  const items = bots?.items ?? [];
  const settingsBot = settingsBotId
    ? (items.find((item) => item.id === settingsBotId) ?? null)
    : null;

  useEffect(() => {
    void store.loadWorkspaceBots(workspace.id);
  }, [store, workspace.id]);

  // A raw token must not survive leaving this tab or switching workspaces.
  useEffect(() => {
    store.clearToken();
    return () => store.clearToken();
  }, [store, workspace.id]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldError(t('bots.nameRequired'));
      return;
    }
    if (trimmed.length > 80) {
      setFieldError(t('bots.nameTooLong'));
      return;
    }
    setFieldError(null);
    setNotice(null);
    const created = await store.createBot(workspace.id, {
      name: trimmed,
      scopes: ['chat.write'],
    });
    if (created) setName('');
  };

  const handleToggle = async (bot: Bot) => {
    setNotice(null);
    const nextStatus: BotStatus = bot.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const updated = await store.updateBot(workspace.id, bot.id, { status: nextStatus });
    if (updated) {
      setNotice(t(nextStatus === 'ACTIVE' ? 'bots.enabledNotice' : 'bots.disabledNotice'));
    }
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    if (confirm.kind === 'rotate') {
      const issued = await store.rotateBotToken(workspace.id, confirm.bot.id);
      if (issued) {
        setConfirm(null);
        setNotice(t('bots.updated'));
      }
      return;
    }
    const ok = await store.disableBot(workspace.id, confirm.bot.id);
    if (ok) {
      setConfirm(null);
      setNotice(t('bots.deletedNotice'));
    }
  };

  const confirmError =
    confirm === null
      ? null
      : confirm.kind === 'rotate'
        ? bots?.rotateError?.botId === confirm.bot.id
          ? bots.rotateError.error
          : null
        : bots?.disableError?.botId === confirm.bot.id
          ? bots.disableError.error
          : null;
  const confirmBusy =
    confirm !== null &&
    (confirm.kind === 'rotate'
      ? rotatePendingId === confirm.bot.id
      : disablePendingId === confirm.bot.id);

  const rowError = (bot: Bot): ApiError | null => {
    if (bots?.rotateError?.botId === bot.id) return bots.rotateError.error;
    if (bots?.updateError?.botId === bot.id) return bots.updateError.error;
    if (bots?.disableError?.botId === bot.id) return bots.disableError.error;
    return null;
  };

  return (
    <section className="card bots-card" aria-labelledby={`${titleId}-title`}>
      <div className="card-head">
        <h3 className="card-title" id={`${titleId}-title`}>
          {t('bots.title')}
        </h3>
        <button
          type="button"
          className="btn btn--sm"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void store.loadWorkspaceBots(workspace.id, true)}
        >
          <RefreshIcon aria-hidden="true" />
          {loading ? t('bots.loading') : t('bots.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('bots.hint')}</p>

      {!canManage ? <p className="chat-settings-readonly">{t('bots.readOnly')}</p> : null}

      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {listError ? (
        <div className="members-list__state" role="alert">
          <p>{botErrorText(listError)}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadWorkspaceBots(workspace.id, true)}
          >
            {t('bots.retry')}
          </button>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="card-empty" role="status">
          {t('bots.loading')}
        </p>
      ) : null}

      {bots?.status === 'ready' && items.length === 0 ? (
        <p className="card-empty">{t('bots.empty')}</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="bots-list" aria-label={t('bots.title')}>
          {items.map((bot) => {
            const error = rowError(bot);
            const rowBusy =
              rotatePendingId === bot.id ||
              disablePendingId === bot.id ||
              updatePendingId === bot.id;
            return (
              <li className="bot-row" key={bot.id}>
                <Avatar name={bot.name} seed={bot.id} size="md" />
                <div className="bot-row__body">
                  <span className="bot-row__name">
                    <BotIcon aria-hidden="true" />
                    {bot.name}
                    <span className={`bot-status bot-status--${bot.status.toLowerCase()}`}>
                      {t(BOT_STATUS_LABEL[bot.status])}
                    </span>
                    {bot.scopes.map((scope) => (
                      <span className="bot-scope" key={scope}>
                        {t('bots.scope.chatWrite')}
                      </span>
                    ))}
                  </span>
                  <span className="bot-row__meta">
                    {t('bots.meta.created', { date: formatDateTime(bot.created_at) })}
                    {' · '}
                    {bot.token_rotated_at
                      ? t('bots.meta.rotated', { date: formatDateTime(bot.token_rotated_at) })
                      : t('bots.meta.noToken')}
                  </span>
                </div>
                {canManage ? (
                  <div className="bot-row__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setNotice(null);
                        setSettingsBotId(bot.id);
                      }}
                    >
                      {t('bots.events.open')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || rowBusy}
                      onClick={() => {
                        setNotice(null);
                        setConfirm({ kind: 'rotate', bot });
                      }}
                    >
                      {rotatePendingId === bot.id ? t('bots.rotating') : t('bots.rotate')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || rowBusy}
                      onClick={() => void handleToggle(bot)}
                    >
                      {bot.status === 'ACTIVE' ? t('bots.disable') : t('bots.enable')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busy || rowBusy}
                      onClick={() => {
                        setNotice(null);
                        setConfirm({ kind: 'delete', bot });
                      }}
                    >
                      {t('bots.delete')}
                    </button>
                  </div>
                ) : null}
                {error ? (
                  <p className="bot-row__error" role="alert">
                    {botErrorText(error)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canManage ? (
        <form className="bot-create" onSubmit={(event) => void handleCreate(event)} noValidate>
          <h4 className="bot-create__title">{t('bots.createTitle')}</h4>
          <p className="pane-sub">{t('bots.createHint')}</p>
          <div className="bot-create__fields">
            <div className="form-row">
              <label htmlFor={nameId}>{t('bots.nameLabel')}</label>
              <input
                id={nameId}
                className="input"
                value={name}
                maxLength={80}
                placeholder={t('bots.namePlaceholder')}
                disabled={creating}
                aria-invalid={fieldError !== null}
                aria-describedby={nameHintId}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldError) setFieldError(null);
                }}
              />
              <div className="field__meta" id={nameHintId}>
                <span>{fieldError ?? t('bots.nameHint', { count: name.trim().length })}</span>
              </div>
            </div>
            <div className="form-row">
              <span className="bot-create__scope-label" id={scopeId}>
                {t('bots.scopeLabel')}
              </span>
              <label className="bot-create__scope">
                <input type="checkbox" checked readOnly aria-describedby={`${scopeId}-hint`} />
                {t('bots.scopeChatWrite')}
              </label>
              <p className="field__meta" id={`${scopeId}-hint`}>
                {t('bots.scopeHint')}
              </p>
            </div>
          </div>
          {createError ? (
            <p className="chat-settings-error" role="alert">
              {botErrorText(createError)}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="btn btn--accent" disabled={creating}>
              <BotIcon aria-hidden="true" />
              {creating ? t('bots.creating') : t('bots.create')}
            </button>
          </div>
        </form>
      ) : null}

      {settingsBot ? (
        <BotEventsDialog
          workspaceId={workspace.id}
          bot={settingsBot}
          onClose={() => setSettingsBotId(null)}
        />
      ) : null}

      {bots?.token ? (
        <BotTokenDialog
          token={bots.token}
          reason={bots.tokenReason ?? 'created'}
          onClose={() => store.clearToken()}
        />
      ) : null}

      {confirm ? (
        <AdminConfirmDialog
          title={t(
            confirm.kind === 'rotate' ? 'bots.rotateConfirmTitle' : 'bots.deleteConfirmTitle',
          )}
          description={
            <>
              <p className="admin-confirm__lead">
                {t(
                  confirm.kind === 'rotate' ? 'bots.rotateConfirmLead' : 'bots.deleteConfirmLead',
                  { name: confirm.bot.name },
                )}
              </p>
              <ul className="admin-confirm__list">
                <li>
                  {t(
                    confirm.kind === 'rotate' ? 'bots.rotateConfirmNote' : 'bots.deleteConfirmNote',
                  )}
                </li>
              </ul>
            </>
          }
          confirmLabel={t(confirm.kind === 'rotate' ? 'bots.rotateConfirm' : 'bots.deleteConfirm')}
          busyLabel={t(confirm.kind === 'rotate' ? 'bots.rotating' : 'bots.deleting')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={confirmBusy}
          error={confirmError ? actionErrorInfo(confirmError) : null}
          errorDetails={confirmError}
          onConfirm={() => void handleConfirm()}
          onClose={() => {
            if (confirmBusy) return;
            setConfirm(null);
          }}
        />
      ) : null}
    </section>
  );
}
