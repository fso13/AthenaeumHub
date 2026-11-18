import type { AppState } from '../store/chatStore';
import { chatDisplayName } from '../domain/chatLabel';
import { formatShortDate } from '../domain/messages';
import { t } from '../i18n/ru';
import { Avatar } from './Avatar';
import { LogoutIcon, PeopleIcon, PlusIcon, SettingsIcon } from './Icons';
import { NotificationBell } from './NotificationBell';

interface SidebarProps {
  state: AppState;
  useMocks: boolean;
  onSelect: (chatId: string) => void;
  onLogout?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onCreateChat?: () => void;
  onOpenAdmin?: () => void;
  onOpenMembers?: () => void;
}

export function Sidebar({
  state,
  useMocks,
  onSelect,
  onLogout,
  onSelectWorkspace,
  onCreateChat,
  onOpenAdmin,
  onOpenMembers,
}: SidebarProps) {
  const loading = state.sessionStatus === 'loading' || state.sessionStatus === 'idle';
  const session = state.session;
  const workspaceName = state.activeWorkspace?.name ?? session?.workspace.name;
  const user = state.user ?? session?.user ?? null;
  const limits = state.chatLimits;
  const chatLimitReached = limits !== null && limits.chats_used >= limits.max_chats_per_user;
  // R-01/E10-F: GROUP needs OWNER/ADMIN, but DIRECT is available to every
  // active member, so the dialog (not the entry point) enforces the type.
  const canCreateChat = !chatLimitReached;
  const isAdmin = state.me?.user.is_platform_admin === true;

  return (
    <aside className="sidebar" aria-label={t('sidebar.label')}>
      <div className="sidebar__head">
        <div className="sidebar__headline">
          <div className="brand">
            <span className="brand__name">{t('app.name')}</span>
            <span className={`mode-chip mode-chip--${useMocks ? 'mock' : 'real'}`}>
              {t(useMocks ? 'sidebar.modeMock' : 'sidebar.modeReal')}
            </span>
          </div>
          {state.sessionStatus === 'ready' ? <NotificationBell /> : null}
        </div>
        <p className="brand__workspace">
          {workspaceName ?? (loading ? t('common.loading') : t('app.tagline'))}
        </p>
        {state.workspaces.length > 1 && onSelectWorkspace ? (
          <label className="workspace-switch" title={t('workspace.switchHint')}>
            <span className="visually-hidden">{t('workspace.switch')}</span>
            <select
              className="workspace-switch__select"
              value={state.activeWorkspaceId ?? ''}
              onChange={(event) => onSelectWorkspace(event.target.value)}
            >
              {state.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {onOpenMembers && state.sessionStatus === 'ready' ? (
          <div className="sidebar__workspace-actions">
            <button
              type="button"
              className="button button--secondary sidebar__members"
              onClick={onOpenMembers}
              aria-label={t('members.open')}
              title={t('members.open')}
            >
              <PeopleIcon aria-hidden="true" />
              <span>{t('members.open')}</span>
            </button>
          </div>
        ) : null}

        {onCreateChat ? (
          <div className="sidebar__create">
            <button
              type="button"
              className="button button--primary sidebar__create-button"
              onClick={onCreateChat}
              disabled={!canCreateChat}
              title={
                chatLimitReached ? t('chat.create.limitReachedGeneric') : t('chat.create.open')
              }
            >
              <PlusIcon aria-hidden="true" />
              {t('chat.create.open')}
            </button>
            {limits ? (
              <span className="sidebar__limit">
                {t('chat.create.limitUsage', {
                  used: limits.chats_used,
                  limit: limits.max_chats_per_user,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <nav className="chat-list" aria-label={t('sidebar.chats')}>
        {loading ? (
          <div className="chat-list__skeleton" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div className="chat-item chat-item--skeleton" key={index}>
                <span className="skeleton skeleton--avatar" />
                <span className="skeleton skeleton--line" />
              </div>
            ))}
          </div>
        ) : state.chats.length === 0 ? (
          <p className="chat-list__empty">{t('sidebar.noChats')}</p>
        ) : (
          <ul className="chat-list__items">
            {state.chats.map((chat) => {
              const active = chat.id === state.activeChatId;
              const unread = chat.unread_count;
              const label = chatDisplayName(chat, state.workspaceMembers.items);
              return (
                <li key={chat.id}>
                  <button
                    type="button"
                    className={`chat-item${active ? ' chat-item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect(chat.id)}
                  >
                    <Avatar name={label} seed={chat.id} size="md" />
                    <span className="chat-item__body">
                      <span className="chat-item__row">
                        <span className="chat-item__name">{label}</span>
                        {chat.last_message_at ? (
                          <time className="chat-item__time" dateTime={chat.last_message_at}>
                            {formatShortDate(chat.last_message_at)}
                          </time>
                        ) : null}
                      </span>
                      <span className="chat-item__row">
                        <span className="chat-item__preview">
                          {chat.type === 'GROUP' ? t('chat.group') : t('chat.direct')}
                        </span>
                        {unread > 0 ? (
                          <span
                            className="unread-badge"
                            aria-label={t('sidebar.unread', { count: unread })}
                          >
                            {unread > 99 ? '99+' : unread}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="sidebar__foot">
        {user ? (
          <div className="me">
            <Avatar name={user.display_name} seed={user.id} />
            <div className="me__text">
              <span className="me__name">{user.display_name}</span>
              <span
                className={`me__status${state.online ? '' : ' me__status--offline'}`}
                role="status"
              >
                {t(state.online ? 'sidebar.online' : 'sidebar.offline')}
              </span>
            </div>
            {isAdmin && onOpenAdmin ? (
              <button
                type="button"
                className="icon-button me__admin"
                onClick={onOpenAdmin}
                aria-label={t('admin.open')}
                title={t('admin.open')}
              >
                <SettingsIcon aria-hidden="true" />
              </button>
            ) : null}
            {onLogout ? (
              <button
                type="button"
                className="icon-button me__logout"
                onClick={onLogout}
                aria-label={t('auth.logout')}
                title={t('auth.logout')}
              >
                <LogoutIcon aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
