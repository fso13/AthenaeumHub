import { useEffect, useId, useMemo, useState } from 'react';
import type { ApiError } from '../../api/problem';
import type { ChatBot, ChatMemberRole, ChatSummary } from '../../api/types';
import { chatBotErrorText } from '../../bots/errors';
import { formatDateTime } from '../admin/format';
import { t } from '../../i18n/ru';
import { isChatManagerRole } from '../../store/chatStore';
import { useBotsState, useBotsStore, useChatState } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { Avatar } from '../Avatar';
import { BotIcon, RefreshIcon } from '../Icons';

export interface ChatBotsPanelProps {
  chat: ChatSummary;
  /** Viewer's channel role (null while the member directory is loading). */
  actorRole: ChatMemberRole | null;
  /** Keeps the parent Escape/focus trap out of the nested confirm dialog. */
  onNestedModalChange?: (open: boolean) => void;
}

function actionErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: chatBotErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

/**
 * #96 chat settings → Боты.
 *
 * - `GET /chats/{id}/bots` is readable by any ACTIVE participant; install and
 *   uninstall require the chat OWNER/ADMIN role (not the workspace role, which
 *   the server does not use here).
 * - Only ACTIVE workspace bots not yet installed are offered. A disabled bot
 *   stays visible with an honest "cannot send" note.
 * - E2EE chats never install a bot (the backend rejects it with
 *   `422 BOT_E2EE_UNSUPPORTED`); the UI does not even render the picker there.
 * - Rows come only from the server (`ChatBot`), never from local guesses.
 */
export function ChatBotsPanel({ chat, actorRole, onNestedModalChange }: ChatBotsPanelProps) {
  const store = useBotsStore();
  const botsState = useBotsState();
  const chatState = useChatState();
  const workspaceId = chatState.activeWorkspace?.id ?? null;

  const chatBots = botsState.chat.chatId === chat.id ? botsState.chat : null;
  const workspaceBots =
    workspaceId !== null && botsState.workspace.workspaceId === workspaceId
      ? botsState.workspace
      : null;
  const installedIds = useMemo(
    () => new Set((chatBots?.items ?? []).map((item) => item.bot.id)),
    [chatBots?.items],
  );
  const available = useMemo(
    () =>
      (workspaceBots?.items ?? []).filter(
        (bot) => bot.status === 'ACTIVE' && !installedIds.has(bot.id),
      ),
    [installedIds, workspaceBots?.items],
  );

  const [selectedId, setSelectedId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<ChatBot | null>(null);
  const titleId = useId();
  const selectId = useId();

  const canManage = isChatManagerRole(actorRole);
  const isE2ee = (chat.security_mode ?? 'MANAGED') === 'E2EE';
  const workspaceBotsLoading = workspaceBots === null || workspaceBots.status === 'loading';
  const loading = chatBots === null || chatBots.status === 'loading';
  const listError = chatBots?.status === 'error' ? chatBots.error : null;
  const installPendingId = chatBots?.installPendingId ?? null;
  const uninstallPendingId = chatBots?.uninstallPendingId ?? null;
  const items = chatBots?.items ?? [];
  const installDisabledReason = isE2ee
    ? t('chatSettings.bots.e2ee')
    : actorRole === null
      ? t('chatSettings.bots.loading')
      : !canManage
        ? t('chatSettings.bots.readOnly')
        : workspaceBotsLoading
          ? t('chatSettings.bots.loading')
          : available.length === 0
            ? t('chatSettings.bots.noAvailable')
            : null;

  useEffect(() => {
    void store.loadChatBots(chat.id);
  }, [chat.id, store]);

  useEffect(() => {
    if (!canManage || workspaceId === null) return;
    void store.loadWorkspaceBots(workspaceId);
  }, [canManage, store, workspaceId]);

  useEffect(() => {
    onNestedModalChange?.(uninstallTarget !== null);
  }, [onNestedModalChange, uninstallTarget]);

  useEffect(() => {
    if (selectedId === '') return;
    if (available.some((bot) => bot.id === selectedId)) return;
    setSelectedId('');
  }, [available, selectedId]);

  const handleInstall = async () => {
    if (!canManage || isE2ee || selectedId === '' || installPendingId !== null) return;
    setNotice(null);
    const installed = await store.installChatBot(chat.id, selectedId);
    if (!installed) return;
    setSelectedId('');
    setNotice(t('chatSettings.bots.installed'));
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    const ok = await store.uninstallChatBot(chat.id, uninstallTarget.bot.id);
    if (!ok) return;
    setUninstallTarget(null);
    setNotice(t('chatSettings.bots.uninstalled'));
  };

  const uninstallError =
    uninstallTarget && chatBots?.uninstallError?.botId === uninstallTarget.bot.id
      ? chatBots.uninstallError.error
      : null;
  const uninstalling = uninstallTarget !== null && uninstallPendingId === uninstallTarget.bot.id;

  return (
    <section className="chat-bots" aria-labelledby={titleId}>
      <div className="chat-members__head">
        <h3 className="chat-settings-section__title" id={titleId}>
          {t('chatSettings.bots.title')}
        </h3>
        <button
          type="button"
          className="btn btn--sm"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void store.loadChatBots(chat.id, true)}
        >
          <RefreshIcon aria-hidden="true" />
          {loading ? t('chatSettings.bots.loading') : t('chatSettings.bots.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('chatSettings.bots.hint')}</p>

      {isE2ee ? (
        <p className="chat-settings-readonly">{t('chatSettings.bots.e2ee')}</p>
      ) : actorRole !== null && !canManage ? (
        <p className="chat-settings-readonly">{t('chatSettings.bots.readOnly')}</p>
      ) : null}

      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {chatBots?.installError ? (
        <p className="chat-settings-error" role="alert">
          {chatBotErrorText(chatBots.installError)}
        </p>
      ) : null}

      {listError ? (
        <div className="members-list__state" role="alert">
          <p>{chatBotErrorText(listError)}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadChatBots(chat.id, true)}
          >
            {t('chatSettings.bots.retry')}
          </button>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="card-empty" role="status">
          {t('chatSettings.bots.loading')}
        </p>
      ) : null}

      {chatBots?.status === 'ready' && items.length === 0 ? (
        <p className="card-empty">{t('chatSettings.bots.empty')}</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="bots-list" aria-label={t('chatSettings.bots.title')}>
          {items.map((item) => {
            const bot = item.bot;
            const active = item.enabled && bot.status === 'ACTIVE';
            const statusLabel = active
              ? t('chatSettings.bots.statusActive')
              : item.enabled
                ? t('chatSettings.bots.statusUnavailable')
                : t('chatSettings.bots.statusDisabled');
            const rowError =
              chatBots?.uninstallError?.botId === bot.id ? chatBots.uninstallError.error : null;
            return (
              <li className="bot-row" key={bot.id}>
                <Avatar name={bot.name} seed={bot.id} size="md" />
                <div className="bot-row__body">
                  <span className="bot-row__name">
                    <BotIcon aria-hidden="true" />
                    {bot.name}
                    <span
                      className={`bot-status ${active ? 'bot-status--active' : 'bot-status--disabled'}`}
                    >
                      {statusLabel}
                    </span>
                    <span className="bot-scope">{t('bots.scope.chatWrite')}</span>
                  </span>
                  <span className="bot-row__meta">
                    {t('chatSettings.bots.installedAt', {
                      date: formatDateTime(item.installed_at),
                    })}
                  </span>
                  {!active ? (
                    <span className="bot-row__note">{t('chatSettings.bots.disabledNote')}</span>
                  ) : null}
                </div>
                {canManage && !isE2ee ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={uninstallPendingId !== null}
                    onClick={() => {
                      setNotice(null);
                      setUninstallTarget(item);
                    }}
                  >
                    {t('chatSettings.bots.uninstall')}
                  </button>
                ) : null}
                {rowError ? (
                  <p className="bot-row__error" role="alert">
                    {chatBotErrorText(rowError)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canManage && !isE2ee ? (
        <div className="bot-install">
          <h4 className="bot-create__title">{t('chatSettings.bots.installTitle')}</h4>
          <p className="pane-sub">{t('chatSettings.bots.installHint')}</p>
          {workspaceBots?.status === 'error' ? (
            <div className="members-list__state" role="alert">
              <p>
                {workspaceBots.error
                  ? chatBotErrorText(workspaceBots.error)
                  : t('chatSettings.bots.loadError')}
              </p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  if (workspaceId !== null) void store.loadWorkspaceBots(workspaceId, true);
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}
          <div className="bot-install__row">
            <div className="field">
              <label className="field__label" htmlFor={selectId}>
                {t('chatSettings.bots.selectLabel')}
              </label>
              <select
                id={selectId}
                className="field__input"
                value={selectedId}
                disabled={installPendingId !== null || available.length === 0}
                aria-describedby={`${selectId}-hint`}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                <option value="">{t('chatSettings.bots.selectPlaceholder')}</option>
                {available.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
              <p className="field__meta" id={`${selectId}-hint`}>
                {installDisabledReason ?? t('chatSettings.bots.installHint')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--accent"
              disabled={installPendingId !== null || selectedId === ''}
              onClick={() => void handleInstall()}
            >
              <BotIcon aria-hidden="true" />
              {installPendingId !== null
                ? t('chatSettings.bots.installing')
                : t('chatSettings.bots.install')}
            </button>
          </div>
          {available.length === 0 ? (
            <p className="pane-sub">{t('chatSettings.bots.noBotsHint')}</p>
          ) : null}
        </div>
      ) : null}

      {uninstallTarget ? (
        <AdminConfirmDialog
          title={t('chatSettings.bots.uninstallConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatSettings.bots.uninstallConfirmLead', {
                  name: uninstallTarget.bot.name,
                })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatSettings.bots.uninstallConfirmNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatSettings.bots.uninstallConfirm')}
          busyLabel={t('chatSettings.bots.uninstalling')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={uninstalling}
          error={uninstallError ? actionErrorInfo(uninstallError) : null}
          errorDetails={uninstallError}
          onConfirm={() => void handleUninstall()}
          onClose={() => {
            if (uninstalling) return;
            setUninstallTarget(null);
          }}
        />
      ) : null}
    </section>
  );
}
