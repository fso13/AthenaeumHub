import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig } from '../config/env';
import { railSpaces, sumUnread } from '../domain/unread';
import { t } from '../i18n/ru';
import { useNavigate, useLocation } from '../router/router';
import { parseView, withView, type AppView } from '../router/views';
import { useChatState, useChatStore } from '../store/ChatProvider';
import type { AppState } from '../store/chatStore';
import { useTheme } from '../hooks/useTheme';
import { ChatScreen } from './ChatScreen';
import { FilesPage } from './pages/FilesPage';
import { OverviewPage } from './pages/OverviewPage';
import { PluginsPage } from './pages/PluginsPage';
import { SecurityPage } from './pages/SecurityPage';
import { SettingsPage } from './pages/SettingsPage';
import { Sidebar } from './Sidebar';
import { SpaceRail } from './SpaceRail';
import { ChatIcon, CloseIcon, MenuIcon } from './Icons';

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
  const navigate = useNavigate();
  const location = useLocation();
  const view = parseView(location);
  const { theme, setTheme } = useTheme();
  const [navOpen, setNavOpen] = useState(false);

  const spaces = useMemo(() => railSpaces(currentState), [currentState]);
  const unread = useMemo(() => workspaceUnreadTotals(currentState), [currentState]);
  const activeSpaceId =
    currentState.activeWorkspaceId ?? currentState.session?.workspace.id ?? null;
  const workspaceName =
    currentState.activeWorkspace?.name ?? currentState.session?.workspace.name ?? t('app.tagline');

  // Inactive-space badges need one chat-list read per workspace (there is no
  // aggregate unread endpoint in this contract).
  useEffect(() => {
    if (currentState.sessionStatus !== 'ready') return;
    if (currentState.workspaces.length < 2) return;
    void store.loadWorkspaceUnread();
  }, [store, currentState.sessionStatus, currentState.workspaces, currentState.activeWorkspaceId]);

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

  const page = view === 'chat' ? null : view;

  return (
    <div className={`app${navOpen ? ' app--nav-open' : ''}`}>
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
        />
        <Sidebar
          state={currentState}
          useMocks={config.useMocks}
          view={view}
          onNavigate={go}
          onSelect={openChat}
          onLogout={onLogout}
          onSelectWorkspace={handleWorkspace}
          onCreateChat={onCreateChat}
          onOpenAdmin={onOpenAdmin}
          onOpenMembers={onOpenMembers}
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
            <ChatIcon aria-hidden="true" />
            {t('app.name')}
          </span>
          <span className="app__mobilebar-space">{workspaceName}</span>
        </div>
        {page === null ? (
          <ChatScreen />
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
            onLogout={onLogout}
          />
        ) : page === 'plugins' ? (
          <PluginsPage onBack={() => go('chat')} onOpenChat={() => go('chat')} />
        ) : (
          <SecurityPage onBack={() => go('chat')} onOpenChat={() => go('chat')} />
        )}
      </div>
    </div>
  );
}
