import { useEffect, useState } from 'react';
import type { AppState } from '../store/chatStore';
import type { AppView, PageView } from '../router/views';
import type { Theme } from '../theme/themePreference';
import { chatDisplayName } from '../domain/chatLabel';
import { formatUnreadBadge } from '../domain/unread';
import { t, type MessageKey } from '../i18n/ru';
import type { WorkspaceLifecycleAction } from '../workspace/lifecycle';
import {
  useAvatarsState,
  useAvatarsStore,
  useChatStore,
  useProfileWorkspaceState,
  useProfileWorkspaceStore,
} from '../store/ChatProvider';
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
  PinIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  VideoIcon,
} from './Icons';
import { useRoomsState, useRoomsStore } from '../store/ChatProvider';
import { NotificationBell } from './NotificationBell';
import { readPinnedChatIds, togglePinnedChatId } from '../sidebar/pins';
import {
  readSidebarSections,
  writeSidebarSections,
  type SidebarSectionsState,
} from '../sidebar/sections';

const NAV_ITEMS: ReadonlyArray<{ view: PageView; label: MessageKey; Icon: typeof OverviewIcon }> = [
  { view: 'overview', label: 'nav.overview', Icon: OverviewIcon },
  { view: 'files', label: 'nav.files', Icon: FolderIcon },
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
  /** Workspace switcher "Создать пространство" (same dialog as the rail "+"). */
  onCreateWorkspace?: () => void;
  /** #99: leave/delete action shared with the settings danger zone. */
  onWorkspaceAction?: (workspaceId: string, action: WorkspaceLifecycleAction) => void;
  onOpenAdmin?: () => void;
  onOpenMembers?: () => void;
  /** D1-FE5: opens the profile modal from the signed-in user row. */
  onOpenProfile?: () => void;
  /** #193: open the pre-join lobby instead of joining immediately. */
  onOpenRoom?: (room: import('../api/types').Room) => void;
  /** Opens the room manager modal (creation/edit). */
  onOpenRooms?: () => void;
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
  onCreateWorkspace,
  onWorkspaceAction,
  onOpenMembers,
  onOpenProfile,
  onOpenRoom,
  onOpenRooms,
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
  const store = useChatStore();
  const avatars = useAvatarsState();
  const avatarsStore = useAvatarsStore();
  const profileStore = useProfileWorkspaceStore();
  const profileState = useProfileWorkspaceState();
  const userAvatarUrl = profileState.avatar.previewUrl;
  const roomsStore = useRoomsStore();
  const rooms = useRoomsState();
  const activeWorkspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    roomsStore.setWorkspace(activeWorkspaceId);
    void roomsStore.load();
    const timer = window.setInterval(() => void roomsStore.load(), 5000);
    return () => {
      window.clearInterval(timer);
      roomsStore.detach();
    };
  }, [activeWorkspaceId, roomsStore]);

  const userId = user?.id ?? null;
  const [collapsed, setCollapsed] = useState<SidebarSectionsState>(() =>
    readSidebarSections(userId),
  );
  useEffect(() => {
    setCollapsed(readSidebarSections(userId));
  }, [userId]);
  const toggleSection = (kind: keyof SidebarSectionsState) => {
    setCollapsed((current) => writeSidebarSections(userId, { ...current, [kind]: !current[kind] }));
  };
  // #80: the personal archive is a separate list; it never mixes with `chats`.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archived = state.archivedChats;

  // Personal pinned chats: ordered ids scoped to the signed-in user and kept
  // in browser storage. They only reorder this client's sidebar.
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedChatIds(userId));
  useEffect(() => {
    setPinnedIds(readPinnedChatIds(userId));
  }, [userId]);
  const pinnedSet = new Set(pinnedIds);
  const pinnedChats = pinnedIds
    .map((id) => state.chats.find((chat) => chat.id === id) ?? null)
    .filter((chat): chat is AppState['chats'][number] => chat !== null);
  const togglePinned = (chatId: string) => {
    setPinnedIds((current) => togglePinnedChatId(userId, chatId, current));
    // Pinning moves the row between two sections, so React remounts it. Return
    // keyboard focus to the same chat's pin control instead of losing it to
    // the document body.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`.chat-pin[data-chat-id="${chatId}"]`)?.focus();
    });
  };
  // Pinned chats live only in their own top section, never duplicated below.
  const byActivity = (a: AppState['chats'][number], b: AppState['chats'][number]) => {
    const at = (chat: AppState['chats'][number]) => {
      const time = chat.last_message_at ? Date.parse(chat.last_message_at) : 0;
      return Number.isFinite(time) ? time : 0;
    };
    return at(b) - at(a);
  };
  const channels = state.chats
    .filter((chat) => chat.type === 'GROUP' && !pinnedSet.has(chat.id))
    .sort(byActivity);
  const directs = state.chats
    .filter((chat) => chat.type === 'DIRECT' && !pinnedSet.has(chat.id))
    .sort(byActivity);

  // Own avatar: the authenticated `GET /me/avatar` blob is resolved once per
  // session (deduped in the store) and shared with the profile dialog.
  useEffect(() => {
    if (state.sessionStatus !== 'ready') return;
    void profileStore.loadMyAvatarPreview();
  }, [profileStore, state.sessionStatus]);

  // Chat icons: one `GET /chats/{id}/avatar` per chat that actually has one;
  // the avatar store dedupes every header/sidebar/settings caller.
  useEffect(() => {
    for (const chat of state.chats) {
      if (chat.avatar_file_id && chat.type !== 'DIRECT') {
        void avatarsStore.ensureChat(chat.id);
      }
    }
    for (const chat of state.archivedChats.items) {
      if (chat.avatar_file_id && chat.type !== 'DIRECT') {
        void avatarsStore.ensureChat(chat.id);
      }
    }
  }, [avatarsStore, state.archivedChats.items, state.chats]);

  const renderChatItem = (chat: AppState['chats'][number]) => {
    const active = chat.id === state.activeChatId;
    const unread = Math.max(0, chat.unread_count);
    const badge = formatUnreadBadge(unread);
    const label = chatDisplayName(chat, state.workspaceMembers.items);
    const typeLabel = chat.type === 'GROUP' ? t('chat.group') : t('chat.direct');
    const pinned = pinnedSet.has(chat.id);
    const nameId = `chat-name-${chat.id}`;
    const pinLabel = pinned
      ? t('sidebar.unpinChat', { name: label })
      : t('sidebar.pinChat', { name: label });
    return (
      <li key={chat.id} className="chat-row">
        <button
          type="button"
          className={`chat-item${active ? ' chat-item--active' : ''}`}
          aria-current={active ? 'page' : undefined}
          aria-label={`${label}, ${typeLabel}`}
          title={`${label} · ${typeLabel}`}
          onClick={() => onSelect(chat.id)}
        >
          <Avatar name={label} seed={chat.id} size="sm" src={avatars.chats[chat.id]?.url ?? null} />
          <span className="chat-item__name" id={nameId}>
            {label}
          </span>
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
        <button
          type="button"
          className={`chat-pin${pinned ? ' is-pinned' : ''}`}
          data-chat-id={chat.id}
          aria-pressed={pinned}
          aria-label={pinned ? t('sidebar.unpin') : t('sidebar.pin')}
          aria-describedby={nameId}
          title={pinLabel}
          onClick={() => togglePinned(chat.id)}
        >
          <PinIcon aria-hidden="true" />
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
            onClick={() => toggleSection(kind)}
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
            onCreateWorkspace={onCreateWorkspace}
            onWorkspaceAction={onWorkspaceAction}
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
            {pinnedChats.length > 0 ? (
              <section className="section section--pinned" aria-label={t('sidebar.pinned')}>
                <div className="section-head">
                  <span className="section-title">
                    <PinIcon aria-hidden="true" />
                    <span>{t('sidebar.pinned')}</span>
                  </span>
                </div>
                <ul className="chat-list__items">{pinnedChats.map(renderChatItem)}</ul>
              </section>
            ) : null}
            <section className="section" aria-label={t('nav.rooms')}>
              <div className="section-head">
                <button
                  type="button"
                  className="section-toggle"
                  aria-expanded={!collapsed.rooms}
                  onClick={() => toggleSection('rooms')}
                >
                  <VideoIcon className="chev" aria-hidden="true" />
                  <span>{t('nav.rooms')}</span>
                </button>
                <button
                  type="button"
                  className="section-add"
                  onClick={() => onOpenRooms?.()}
                  aria-label={t('rooms.open')}
                  title={t('rooms.open')}
                >
                  <PlusIcon aria-hidden="true" />
                </button>
              </div>
              {collapsed.rooms ? null : rooms.items.length === 0 ? (
                <p className="rooms-nav-empty">{t('sidebar.roomsEmpty')}</p>
              ) : (
                <ul className="chat-list__items">
                  {rooms.items.map((room) => (
                    <li key={room.id}>
                      <button
                        type="button"
                        className={`chat-item rooms-nav-item${rooms.presenceRoomId === room.id ? ' chat-item--active' : ''}`}
                        onClick={() =>
                          onOpenRoom ? onOpenRoom(room) : void roomsStore.joinRoom(room.id)
                        }
                        title={room.name}
                      >
                        <span className="rooms-nav-icon" aria-hidden="true">
                          <VideoIcon />
                        </span>
                        <span className="chat-item__body">
                          <span className="chat-item__name">{room.name}</span>
                          <span className="chat-item__preview">
                            {t('rooms.participants.count', { count: room.participant_count })}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {renderSection('channels', t('sidebar.channels'), channels)}
            {renderSection('directs', t('sidebar.directs'), directs)}
          </>
        )}

        <div className="archive-section">
          <button
            type="button"
            className="archive-toggle"
            aria-expanded={archivedOpen}
            onClick={() => {
              setArchivedOpen((open) => !open);
              if (!archivedOpen) void store.loadArchivedChats();
            }}
          >
            <span>{t('sidebar.archived')}</span>
            <span className="count">
              {archived.status === 'ready' ? archived.items.length : '—'}
            </span>
          </button>
          {archivedOpen ? (
            <div className="archive-list">
              {archived.status === 'loading' ? (
                <p className="chat-list__empty">{t('sidebar.archivedLoading')}</p>
              ) : archived.status === 'error' ? (
                <div>
                  <p className="chat-list__empty">{t('sidebar.archivedError')}</p>
                  <button
                    type="button"
                    className="archive-row__unarchive"
                    onClick={() => void store.loadArchivedChats(true)}
                  >
                    {t('sidebar.archivedRetry')}
                  </button>
                </div>
              ) : archived.items.length === 0 ? (
                <p className="chat-list__empty">{t('sidebar.archivedEmpty')}</p>
              ) : (
                <ul className="chat-list__items">
                  {archived.items.map((chat) => {
                    const label = chatDisplayName(chat, state.workspaceMembers.items);
                    const busy = archived.pendingChatId === chat.id;
                    return (
                      <li className="archive-row" key={chat.id}>
                        <span className="archive-row__name" title={label}>
                          {label}
                        </span>
                        <button
                          type="button"
                          className="archive-row__unarchive"
                          disabled={archived.pendingChatId !== null}
                          aria-busy={busy}
                          onClick={() => void store.unarchiveChat(chat.id)}
                        >
                          {busy ? t('sidebar.unarchiving') : t('sidebar.unarchive')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {archived.actionError ? (
                <p className="chat-settings-error" role="alert">
                  {t('sidebar.unarchiveError')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
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
                <Avatar name={user.display_name} seed={user.id} size="sm" src={userAvatarUrl} />
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
                <Avatar name={user.display_name} seed={user.id} size="sm" src={userAvatarUrl} />
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
