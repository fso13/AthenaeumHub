import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig } from '../config/env';
import type { WorkspaceSummary } from '../api/types';
import { describeError } from '../domain/errors';
import { railSpaces, sumUnread } from '../domain/unread';
import { t } from '../i18n/ru';
import { useNavigate, useLocation } from '../router/router';
import { parseView, withView, type AppView } from '../router/views';
import {
  useAvatarsState,
  useAvatarsStore,
  useChatState,
  useChatStore,
} from '../store/ChatProvider';
import type { AppState } from '../store/chatStore';
import { useTheme } from '../hooks/useTheme';
import { ChatScreen } from './ChatScreen';
import { CallLayer } from './CallLayer';
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog';
import { WorkspaceLifecycleDialogs } from './WorkspaceLifecycleDialogs';
import type { WorkspaceLifecycleAction } from '../workspace/lifecycle';
import { FilesPage } from './pages/FilesPage';
import { OverviewPage } from './pages/OverviewPage';
import { PluginsPage } from './pages/PluginsPage';
import { SecurityPage } from './pages/SecurityPage';
import { SettingsPage } from './pages/SettingsPage';
import { Sidebar } from './Sidebar';
import { SpaceRail } from './SpaceRail';
import { ChatSettingsDialog } from './ChatSettingsDialog';
import { ProfileDialog } from './ProfileDialog';
import { CloseIcon, MenuIcon } from './Icons';

interface AppShellProps {
  config: AppConfig;
  onLogout?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onCreateChat?: () => void;
  onOpenAdmin?: () => void;
  onOpenMembers?: () => void;
}

/** D1-FE1: unread totals for every space, exact for the active one. */
export function workspaceUnreadTotals(state: AppState): Record<string, number> {
  const totals = { ...state.workspaceUnread };
  const activeWorkspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  if (activeWorkspaceId !== null) totals[activeWorkspaceId] = sumUnread(state.chats);
  return totals;
}

/** Dialog error text for a failed create; the dialog stays open on failure. */
function workspaceCreateErrorText(state: AppState): string | null {
  const error = state.onboardingError;
  if (!error) return null;
  if (error.status === 422) return t('workspace.create.invalid');
  return describeError(error).message || t('workspace.create.error');
}

/**
 * D1-FE1 shell: space rail + sidebar (drawer on mobile), section pages and the
 * preserved chat surface. The chat stays mounted only on the chat view, but its
 * store state (active chat, slices, thread) is never reset by navigation.
 */
export function AppShell({
  config,
  onLogout,
  onSelectWorkspace,
  onCreateChat,
  onOpenAdmin,
  onOpenMembers,
}: AppShellProps) {
  const store = useChatStore();
  const currentState = useChatState();
  const avatars = useAvatarsState();
  const avatarsStore = useAvatarsStore();
  const navigate = useNavigate();
  const location = useLocation();
  const view = parseView(location);
  const { theme, setTheme } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [workspaceCreateBusy, setWorkspaceCreateBusy] = useState(false);
  const [workspaceCreateError, setWorkspaceCreateError] = useState<string | null>(null);
  const [workspaceAction, setWorkspaceAction] = useState<{
    workspace: WorkspaceSummary;
    action: WorkspaceLifecycleAction;
  } | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem('krug.navCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const activeChat =
    currentState.chats.find((chat) => chat.id === currentState.activeChatId) ?? null;

  const spaces = useMemo(() => railSpaces(currentState), [currentState]);
  const unread = useMemo(() => workspaceUnreadTotals(currentState), [currentState]);
  const activeSpaceId =
    currentState.activeWorkspaceId ?? currentState.session?.workspace.id ?? null;
  const workspaceLogoUrls = useMemo(() => {
    const urls: Record<string, string | null> = {};
    for (const space of spaces) {
      urls[space.id] = avatars.workspaces[space.id]?.url ?? null;
    }
    return urls;
  }, [avatars.workspaces, spaces]);
  const workspaceName =
    currentState.activeWorkspace?.name ?? currentState.session?.workspace.name ?? t('app.tagline');

  // Inactive-space badges need one chat-list read per workspace (there is no
  // aggregate unread endpoint in this contract).
  useEffect(() => {
    if (currentState.sessionStatus !== 'ready') return;
    if (currentState.workspaces.length < 2) return;
    void store.loadWorkspaceUnread();
  }, [store, currentState.sessionStatus, currentState.workspaces, currentState.activeWorkspaceId]);

  // One logo read per workspace that has `logo_file_id`; the avatar store
  // dedupes the rail, switcher and settings-panel callers.
  useEffect(() => {
    for (const space of spaces) {
      if (space.logo_file_id) void avatarsStore.ensureWorkspace(space.id, space.logo_file_id);
    }
  }, [avatarsStore, spaces]);

  const go = useCallback(
    (next: AppView) => {
      setNavOpen(false);
      if (next === view) return;
      navigate(withView(location, next));
    },
    [location, navigate, view],
  );

  const openChat = useCallback(
    (chatId: string) => {
      void store.setActiveChat(chatId);
      go('chat');
    },
    [go, store],
  );

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem('krug.navCollapsed', navCollapsed ? '1' : '0');
    } catch {
      // localStorage may be unavailable; the in-memory state still works.
    }
  }, [navCollapsed]);

  useEffect(() => {
    if (!navOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [navOpen]);

  const handleWorkspace = (workspaceId: string) => {
    setNavOpen(false);
    onSelectWorkspace?.(workspaceId);
  };

  /**
   * #99: one confirmation surface for the settings danger zone, the rail and
   * the switcher. The row is resolved from the refreshed `/me` list so the
   * dialog always names the workspace the server will act on.
   */
  const requestWorkspaceAction = useCallback(
    (workspaceId: string, action: WorkspaceLifecycleAction) => {
      const workspace = currentState.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      setNavOpen(false);
      setWorkspaceAction({ workspace, action });
    },
    [currentState.workspaces],
  );

  const handleWorkspaceRemoved = useCallback(() => {
    setWorkspaceAction(null);
    go('chat');
  }, [go]);

  const openWorkspaceCreate = () => {
    setWorkspaceCreateError(null);
    setWorkspaceCreateOpen(true);
  };

  const page = view === 'chat' ? null : view;

  return (
    <div
      className={`app${navOpen ? ' app--nav-open' : ''}${page === null ? '' : ' app--page'}${navCollapsed ? ' app--nav-collapsed' : ''}`}
    >
      <a className="skip-link" href="#chat-main">
        {t('app.skipToChat')}
      </a>

      <button
        type="button"
        className="app__menu"
        aria-label={navOpen ? t('nav.close') : t('nav.open')}
        aria-expanded={navOpen}
        aria-controls="app-nav"
        onClick={() => setNavOpen((open) => !open)}
      >
        {navOpen ? <CloseIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
      </button>

      <div className="app__nav" id="app-nav">
        <SpaceRail
          spaces={spaces}
          activeSpaceId={activeSpaceId}
          unreadBySpace={unread}
          onSelect={handleWorkspace}
          onCreateWorkspace={openWorkspaceCreate}
          logoUrls={workspaceLogoUrls}
          onWorkspaceAction={requestWorkspaceAction}
        />
        <Sidebar
          state={currentState}
          useMocks={config.useMocks}
          view={view}
          theme={theme}
          onThemeChange={setTheme}
          onNavigate={go}
          onSelect={openChat}
          onLogout={onLogout}
          onSelectWorkspace={handleWorkspace}
          onCreateChat={onCreateChat}
          onCreateWorkspace={openWorkspaceCreate}
          onWorkspaceAction={requestWorkspaceAction}
          onOpenAdmin={onOpenAdmin}
          onOpenMembers={onOpenMembers}
          onOpenProfile={() => setProfileOpen(true)}
          navCollapsed={navCollapsed}
          onToggleCollapsed={() => setNavCollapsed((value) => !value)}
        />
      </div>

      {navOpen ? (
        <button
          type="button"
          className="app__backdrop"
          aria-label={t('nav.dismiss')}
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <div className="app__content">
        <div className="app__mobilebar">
          <span className="app__mobilebar-brand">
            <img src="/icons/sova-icon-32.png" alt="" width={20} height={20} />
            {t('app.name')}
          </span>
          <span className="app__mobilebar-space">{workspaceName}</span>
        </div>
        {page === null ? (
          <ChatScreen
            onOpenChatSettings={() => setChatSettingsOpen(true)}
            onOpenMembers={() => onOpenMembers?.()}
            onNavigate={go}
          />
        ) : page === 'overview' ? (
          <OverviewPage
            onBack={() => go('chat')}
            onOpenChat={openChat}
            onNavigate={go}
            onOpenMembers={() => onOpenMembers?.()}
          />
        ) : page === 'files' ? (
          <FilesPage onBack={() => go('chat')} onOpenChat={openChat} />
        ) : page === 'settings' ? (
          <SettingsPage
            theme={theme}
            onThemeChange={setTheme}
            onBack={() => go('chat')}
            onOpenAdmin={onOpenAdmin}
            onOpenMembers={() => onOpenMembers?.()}
            onOpenProfile={() => setProfileOpen(true)}
            onLogout={onLogout}
            onNavigate={go}
            onWorkspaceAction={requestWorkspaceAction}
          />
        ) : page === 'plugins' ? (
          <PluginsPage onBack={() => go('chat')} />
        ) : (
          <SecurityPage onBack={() => go('chat')} />
        )}
      </div>

      <ChatSettingsDialog
        open={chatSettingsOpen}
        chat={activeChat}
        onClose={() => setChatSettingsOpen(false)}
      />
      <ProfileDialog
        open={profileOpen}
        theme={theme}
        onThemeChange={setTheme}
        onClose={() => setProfileOpen(false)}
        onLogout={onLogout}
      />
      <CallLayer />
      <WorkspaceLifecycleDialogs
        workspace={workspaceAction?.workspace ?? null}
        action={workspaceAction?.action ?? null}
        onClose={() => setWorkspaceAction(null)}
        onRemoved={handleWorkspaceRemoved}
      />
      <WorkspaceCreateDialog
        open={workspaceCreateOpen}
        busy={workspaceCreateBusy}
        error={workspaceCreateError}
        onClose={() => {
          if (!workspaceCreateBusy) setWorkspaceCreateOpen(false);
        }}
        onCreate={async (name) => {
          setWorkspaceCreateBusy(true);
          setWorkspaceCreateError(null);
          const ok = await store.createWorkspace(name);
          setWorkspaceCreateBusy(false);
          const next = store.getSnapshot();
          if (!ok) {
            setWorkspaceCreateError(workspaceCreateErrorText(next));
            return;
          }
          // `createWorkspace` already activated the new space (`activateWorkspace`),
          // so the rail/switcher and the chat list now point at it.
          setWorkspaceCreateOpen(false);
          setWorkspaceCreateError(null);
        }}
      />
    </div>
  );
}
