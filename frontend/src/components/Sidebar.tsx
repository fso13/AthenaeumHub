import { useState } from 'react';
import type { AppState } from '../store/chatStore';
import type { AppView, PageView } from '../router/views';
import type { Theme } from '../theme/themePreference';
import { chatDisplayName } from '../domain/chatLabel';
import { formatUnreadBadge } from '../domain/unread';
import { t, type MessageKey } from '../i18n/ru';
import { Avatar } from './Avatar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  LogoutIcon,
  MoonIcon,
  OverviewIcon,
  PeopleIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  SunIcon,
} from './Icons';
import { NotificationBell } from './NotificationBell';

const NAV_ITEMS: ReadonlyArray<{ view: PageView; label: MessageKey; Icon: typeof OverviewIcon }> = [
  { view: 'overview', label: 'nav.overview', Icon: OverviewIcon },
  { view: 'files', label: 'nav.files', Icon: FolderIcon },
  { view: 'plugins', label: 'nav.plugins', Icon: PlugIcon },
  { view: 'security', label: 'nav.security', Icon: ShieldIcon },
  { view: 'settings', label: 'nav.settings', Icon: SettingsIcon },
];

interface SidebarProps {
  state: AppState;
  useMocks: boolean;
  view: AppView;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onNavigate: (view: AppView) => void;
  onSelect: (chatId: string) => void;
  onLogout?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onCreateChat?: () => void;
  onOpenAdmin?: () => void;
  onOpenMembers?: () => void;
  /** D1-FE5: opens the profile modal from the signed-in user row. */
  onOpenProfile?: () => void;
  /** #65: collapse the sidebar to an icon rail. */
  navCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({
  state,
  view,
  theme,
  onThemeChange,
  onNavigate,
  onSelect,
  onLogout,
  onSelectWorkspace,
  onCreateChat,
  onOpenMembers,
  onOpenProfile,
  navCollapsed = false,
  onToggleCollapsed,
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
  const channels = state.chats.filter((chat) => chat.type === 'GROUP');
  const directs = state.chats.filter((chat) => chat.type === 'DIRECT');
  const [collapsed, setCollapsed] = useState<{ channels: boolean; directs: boolean }>({
    channels: false,
    directs: false,
  });

  const renderChatItem = (chat: AppState['chats'][number]) => {
    const active = chat.id === state.activeChatId;
    const unread = Math.max(0, chat.unread_count);
    const badge = formatUnreadBadge(unread);
    const label = chatDisplayName(chat, state.workspaceMembers.items);
    const typeLabel = chat.type === 'GROUP' ? t('chat.group') : t('chat.direct');
    return (
      <li key={chat.id}>
        <button
          type="button"
          className={`chat-item${active ? ' chat-item--active' : ''}`}
          aria-current={active ? 'page' : undefined}
          aria-label={`${label}, ${typeLabel}`}
          title={`${label} · ${typeLabel}`}
          onClick={() => onSelect(chat.id)}
        >
          <Avatar name={label} seed={chat.id} size="sm" />
          <span className="chat-item__name">{label}</span>
          {badge ? (
            <span
              className="unread-badge"
              aria-hidden="true"
              title={t('sidebar.unread', { count: unread })}
            >
              {badge}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const sectionAdd = (kind: 'channels' | 'directs') => {
    if (!onCreateChat) return null;
    const label = kind === 'channels' ? t('sidebar.addChannel') : t('sidebar.addDirect');
    return (
      <button
        type="button"
        className="section-add"
        onClick={onCreateChat}
        disabled={!canCreateChat}
        aria-label={label}
        title={label}
      >
        <PlusIcon aria-hidden="true" />
      </button>
    );
  };

  const renderSection = (kind: 'channels' | 'directs', title: string, chats: AppState['chats']) => {
    if (chats.length === 0) return null;
    const isCollapsed = collapsed[kind];
    return (
      <section className="section" aria-label={title}>
        <div className="section-head">
          <button
            type="button"
            className="section-toggle"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed((current) => ({ ...current, [kind]: !current[kind] }))}
          >
            <ChevronDownIcon className="chev" aria-hidden="true" />
            <span>{title}</span>
          </button>
          {sectionAdd(kind)}
        </div>
        {isCollapsed ? null : <ul className="chat-list__items">{chats.map(renderChatItem)}</ul>}
      </section>
    );
  };

  return (
    <aside className="sidebar" aria-label={t('sidebar.label')}>
      <div className="ws-head">
        {state.workspaces.length > 1 && onSelectWorkspace ? (
          <WorkspaceSwitcher
            workspaces={state.workspaces}
            activeWorkspaceId={state.activeWorkspaceId}
            currentName={workspaceName ?? (loading ? t('common.loading') : t('app.tagline'))}
            onSelect={onSelectWorkspace}
          />
        ) : (
          <div className="ws-btn">
            <span className="ws-btn__name">
              {workspaceName ?? (loading ? t('common.loading') : t('app.tagline'))}
            </span>
          </div>
        )}
        {onToggleCollapsed ? (
          <button
            type="button"
            className="icon-button ws-head__collapse"
            onClick={onToggleCollapsed}
            aria-label={navCollapsed ? t('nav.expand') : t('nav.collapse')}
            title={navCollapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!navCollapsed}
          >
            {navCollapsed ? (
              <ChevronRightIcon aria-hidden="true" />
            ) : (
              <ArrowLeftIcon aria-hidden="true" />
            )}
          </button>
        ) : null}
        {state.sessionStatus === 'ready' ? <NotificationBell /> : null}
        {onCreateChat ? (
          <button
            type="button"
            className="icon-button ws-head__action"
            onClick={onCreateChat}
            disabled={!canCreateChat}
            aria-label={t('chat.create.open')}
            title={chatLimitReached ? t('chat.create.limitReachedGeneric') : t('chat.create.open')}
          >
            <PlusIcon aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <nav className="nav" aria-label={t('nav.label')}>
        <ul className="nav-items">
          {NAV_ITEMS.map(({ view: itemView, label, Icon }) => {
            const active = view === itemView;
            const badge = null;
            return (
              <li key={itemView}>
                <button
                  type="button"
                  className={`nav-item${active ? ' is-on' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(itemView)}
                >
                  <Icon aria-hidden="true" />
                  <span>{t(label)}</span>
                  {badge ? (
                    <span className="nav-badge" aria-hidden="true">
                      {badge}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav className="side-scroll" aria-label={t('sidebar.chats')}>
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
          <>
            {renderSection('channels', t('sidebar.channels'), channels)}
            {renderSection('directs', t('sidebar.directs'), directs)}
          </>
        )}
      </nav>

      <div className="me">
        {user ? (
          <>
            {onOpenProfile ? (
              <button
                type="button"
                className="me-btn"
                onClick={onOpenProfile}
                aria-label={t('profile.open')}
                title={t('profile.open')}
              >
                <Avatar name={user.display_name} seed={user.id} size="sm" />
                <span className="me-text">
                  <b>{user.display_name}</b>
                  <span className={`me-status${state.online ? '' : ' is-offline'}`} role="status">
                    <span className={`dot${state.online ? ' is-online' : ''}`} aria-hidden="true" />
                    {t(state.online ? 'sidebar.online' : 'sidebar.offline')}
                  </span>
                </span>
              </button>
            ) : (
              <div className="me-btn">
                <Avatar name={user.display_name} seed={user.id} size="sm" />
                <div className="me-text">
                  <b>{user.display_name}</b>
                  <span className={`me-status${state.online ? '' : ' is-offline'}`}>
                    {t(state.online ? 'sidebar.online' : 'sidebar.offline')}
                  </span>
                </div>
              </div>
            )}
            <div className="me-actions">
              {onOpenMembers && state.sessionStatus === 'ready' ? (
                <button
                  type="button"
                  className="icon-button"
                  onClick={onOpenMembers}
                  aria-label={t('members.open')}
                  title={t('members.open')}
                >
                  <PeopleIcon aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button"
                onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
                aria-label={theme === 'dark' ? t('theme.toggleLight') : t('theme.toggleDark')}
                title={theme === 'dark' ? t('theme.toggleLight') : t('theme.toggleDark')}
              >
                {theme === 'dark' ? (
                  <SunIcon aria-hidden="true" />
                ) : (
                  <MoonIcon aria-hidden="true" />
                )}
              </button>
              {onLogout ? (
                <button
                  type="button"
                  className="icon-button"
                  onClick={onLogout}
                  aria-label={t('auth.logout')}
                  title={t('auth.logout')}
                >
                  <LogoutIcon aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
