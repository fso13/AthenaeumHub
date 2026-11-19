import type { ChatSummary } from '../api/types';
import { chatDisplayName } from '../domain/chatLabel';
import { formatTime } from '../domain/messages';
import { t, type MessageKey } from '../i18n/ru';
import type { AppState } from '../store/chatStore';
import { Avatar } from './Avatar';
import { pluralRu } from './pages/pageData';
import {
  InfoIcon,
  LockIcon,
  PhoneIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  VideoIcon,
} from './Icons';

interface ChatHeaderProps {
  state: AppState;
  chat: ChatSummary | null;
  onRefresh: () => void;
  /** E7-F5: opens the per-device safety number dialog. */
  onOpenSafety?: () => void;
  /** D1-FE5: opens the chat settings dialog ("О чате"). */
  onOpenSettings?: () => void;
  /** D1 UX: header search toggle (filters the loaded history). */
  searchOpen: boolean;
  onToggleSearch: () => void;
  /** D1 UX: right details panel toggle. */
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

const REALTIME_LABEL: Record<AppState['realtimeStatus'], MessageKey> = {
  idle: 'chat.realtimeIdle',
  connecting: 'chat.realtimeConnecting',
  reconnecting: 'chat.realtimeReconnecting',
  online: 'chat.realtimeOnline',
  offline: 'chat.realtimeOffline',
  revoked: 'chat.realtimeRevoked',
};

export function ChatHeader({
  state,
  chat,
  onRefresh,
  onOpenSafety,
  onOpenSettings,
  searchOpen,
  onToggleSearch,
  detailsOpen,
  onToggleDetails,
}: ChatHeaderProps) {
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
  const membersCount = state.workspaceMembers.items.length;
  const realtimeLabel = t(REALTIME_LABEL[state.realtimeStatus]);

  const meta =
    chatType === 'DIRECT'
      ? state.online
        ? t('sidebar.online')
        : t('sidebar.offline')
      : membersCount > 0
        ? t('chat.membersAndOnline', {
            count: membersCount,
            noun: pluralRu(membersCount, 'участник', 'участника', 'участников'),
            online: onlineCount,
          })
        : onlineCount > 0
          ? t('chat.onlineMembers', { count: onlineCount })
          : t('chat.memberFallback');

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
      <button type="button" className="chat-id" onClick={onToggleDetails}>
        <Avatar name={name} seed={chat?.id ?? name} size="lg" />
        <span className="chat-meta">
          <span className="chat-title" role="heading" aria-level={1}>
            {name}
          </span>
          <span className="chat-sub">
            <span className="sub-dot" aria-hidden="true" />
            <span className="chat-sub__text">{meta}</span>
          </span>
        </span>
      </button>

      <div className="chat-head__actions chat-actions">
        <span
          className={`realtime-status realtime-status--${state.realtimeStatus}`}
          role="status"
          aria-live="polite"
          title={realtimeLabel}
        >
          <span className="realtime-status__dot" aria-hidden="true" />
          <span className="visually-hidden">{realtimeLabel}</span>
        </span>
        <span className={`sync-status sync-status--${state.syncStatus} visually-hidden`}>
          {syncLabel}
        </span>

        <button
          type="button"
          className={`icon-button${searchOpen ? ' icon-button--on' : ''}`}
          onClick={onToggleSearch}
          aria-label={t('chat.search')}
          aria-pressed={searchOpen}
          title={t('chat.search')}
        >
          <SearchIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button chat-head__refresh"
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
        {onOpenSettings ? (
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            aria-label={t('chatSettings.open')}
            title={t('chatSettings.open')}
          >
            <SettingsIcon aria-hidden="true" />
          </button>
        ) : null}
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
        <button
          type="button"
          className="icon-button chat-head__call"
          disabled
          aria-label={t('chat.call')}
          title={t('chat.callsUnavailable')}
        >
          <PhoneIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button chat-head__video"
          disabled
          aria-label={t('chat.videoCall')}
          title={t('chat.callsUnavailable')}
        >
          <VideoIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`icon-button${detailsOpen ? ' icon-button--on' : ''}`}
          onClick={onToggleDetails}
          aria-label={detailsOpen ? t('chat.detailsHide') : t('chat.detailsShow')}
          aria-pressed={detailsOpen}
          title={detailsOpen ? t('chat.detailsHide') : t('chat.detailsShow')}
        >
          <InfoIcon aria-hidden="true" />
        </button>
      </div>

      <span className={`mode-chip mode-chip--${securityMode.toLowerCase()} chat-head__mode`}>
        {securityMode === 'MANAGED' ? t('chat.managedChip') : t('chat.e2eeChip')}
      </span>
    </header>
  );
}
