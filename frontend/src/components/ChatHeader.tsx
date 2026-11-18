import type { ChatSummary } from '../api/types';
import { chatDisplayName } from '../domain/chatLabel';
import { formatTime } from '../domain/messages';
import { t, type MessageKey } from '../i18n/ru';
import type { AppState } from '../store/chatStore';
import { LockIcon, RefreshIcon } from './Icons';

interface ChatHeaderProps {
  state: AppState;
  chat: ChatSummary | null;
  onRefresh: () => void;
  /** E7-F5: opens the per-device safety number dialog. */
  onOpenSafety?: () => void;
}

const REALTIME_LABEL: Record<AppState['realtimeStatus'], MessageKey> = {
  idle: 'chat.realtimeIdle',
  connecting: 'chat.realtimeConnecting',
  reconnecting: 'chat.realtimeReconnecting',
  online: 'chat.realtimeOnline',
  offline: 'chat.realtimeOffline',
  revoked: 'chat.realtimeRevoked',
};

export function ChatHeader({ state, chat, onRefresh, onOpenSafety }: ChatHeaderProps) {
  const name = chatDisplayName(
    chat,
    state.workspaceMembers.items,
    state.session?.chat.name ?? null,
  );
  const chatType = chat?.type ?? state.session?.chat.type ?? 'GROUP';
  const securityMode =
    chat?.security_mode ??
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    'MANAGED';
  const onlineCount = Object.values(state.presence).filter(
    (presence) => presence.status === 'ONLINE',
  ).length;
  const realtimeLabel = t(REALTIME_LABEL[state.realtimeStatus]);

  const syncLabel =
    state.syncStatus === 'syncing'
      ? t('chat.syncing')
      : state.syncStatus === 'error'
        ? t('chat.syncError')
        : state.lastSyncedAt
          ? t('chat.syncIdle', { time: formatTime(state.lastSyncedAt) })
          : t('chat.syncNever');

  return (
    <header className="chat-head">
      <div className="chat-head__identity">
        <h1 className="chat-head__title">{name}</h1>
        <div className="chat-head__meta">
          <span className="chat-head__type">
            {chatType === 'GROUP' ? t('chat.group') : t('chat.direct')}
          </span>
          <span
            className={`security-badge security-badge--${securityMode.toLowerCase()}`}
            title={securityMode === 'MANAGED' ? t('chat.managed') : t('chat.e2ee')}
          >
            <LockIcon aria-hidden="true" />
            {securityMode === 'MANAGED' ? t('chat.managed') : t('chat.e2ee')}
          </span>
          {onlineCount > 0 ? (
            <span className="chat-head__presence">
              {t('chat.onlineCount', { count: onlineCount })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="chat-head__actions">
        {securityMode === 'E2EE' && onOpenSafety ? (
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSafety}
            aria-label={t('e2ee.security')}
            title={t('e2ee.security')}
          >
            <LockIcon aria-hidden="true" />
          </button>
        ) : null}
        <span
          className={`realtime-status realtime-status--${state.realtimeStatus}`}
          role="status"
          aria-live="polite"
          title={realtimeLabel}
        >
          <span className="realtime-status__dot" aria-hidden="true" />
          {realtimeLabel}
        </span>
        <span className={`sync-status sync-status--${state.syncStatus}`}>{syncLabel}</span>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={state.syncStatus === 'syncing'}
          aria-label={t('chat.refresh')}
          title={t('chat.refresh')}
        >
          <RefreshIcon
            className={state.syncStatus === 'syncing' ? 'icon icon--spin' : 'icon'}
            aria-hidden="true"
          />
        </button>
      </div>
    </header>
  );
}
