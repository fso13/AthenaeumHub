import { useEffect, useRef, useState } from 'react';
import { useChatState, ChatProvider, useOpsState, useOpsStore } from './store/ChatProvider';
import type { ChatStore } from './store/chatStore';
import type { AppConfig } from './config/env';
import {
  useAppBootstrap,
  useOnlineStatus,
  useReadReceipt,
  useReconnectSync,
} from './hooks/useChatEffects';
import { maxSeq } from './domain/messages';
import { AuthRoot } from './auth/AuthRoot';
import { useAppAuth } from './auth/AuthContext';
import { useLocation, useNavigate } from './router/router';
import { AuthGate } from './components/auth/AuthGate';
import {
  AccessDeniedScreen,
  AdminForbiddenScreen,
  SessionExpiredScreen,
  SetupIncompleteScreen,
  SetupStatusErrorScreen,
  SplashScreen,
} from './components/auth/AuthStatusScreens';
import { OnboardingScreen } from './components/auth/OnboardingScreen';
import { CreateChatDialog } from './components/CreateChatDialog';
import { AdminScreen } from './components/admin/AdminScreen';
import { SetupWizard } from './components/admin/SetupWizard';
import { AppShell } from './components/AppShell';
import { WorkspaceMembersDialog } from './components/WorkspaceMembersDialog';

interface AppProps {
  store: ChatStore;
  config: AppConfig;
}

export function App({ store, config }: AppProps) {
  return (
    <ChatProvider store={store}>
      <AuthRoot config={config}>
        {config.authMode === 'dev' ? (
          <DevApp store={store} config={config} />
        ) : (
          <AuthGate>
            <PasswordApp store={store} config={config} />
          </AuthGate>
        )}
      </AuthRoot>
    </ChatProvider>
  );
}

function useChatRuntime(store: ChatStore, config: AppConfig, bootstrapKey: string | null = null) {
  useAppBootstrap(store, bootstrapKey);
  useOnlineStatus(store);
  const state = useChatState();

  const activeSlice = state.activeChatId ? (state.slices[state.activeChatId] ?? null) : null;
  const lastVisibleSeq = maxSeq(activeSlice?.messages ?? []);
  const ready = state.sessionStatus === 'ready';

  useReconnectSync(store, ready, config.syncIntervalMs);
  useReadReceipt(
    store,
    state.activeChatId,
    lastVisibleSeq,
    ready && state.online,
    config.readReceiptDebounceMs,
  );

  return state;
}

function ChatWorkspace({
  config,
  onLogout,
  onSelectWorkspace,
  onOpenAdmin,
}: {
  config: AppConfig;
  onLogout?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onOpenAdmin?: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  return (
    <>
      <AppShell
        config={config}
        onLogout={onLogout}
        onSelectWorkspace={onSelectWorkspace}
        onCreateChat={() => setCreateOpen(true)}
        onOpenAdmin={onOpenAdmin}
        onOpenMembers={() => setMembersOpen(true)}
      />
      <CreateChatDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <WorkspaceMembersDialog open={membersOpen} onClose={() => setMembersOpen(false)} />
    </>
  );
}

/** F-01 dev mode: POST /dev/session on boot and on 401. */
function DevApp({ store, config }: AppProps) {
  useChatRuntime(store, config);
  return <ChatWorkspace config={config} />;
}

/**
 * Auth BFF (password) mode: guarded login/register/verify routes, onboarding and
 * the `/me` bootstrap. There is no redirect to Keycloak and no callback route.
 */
function PasswordApp({ store, config }: AppProps) {
  const auth = useAppAuth();
  const ops = useOpsStore();
  const opsState = useOpsState();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.split('?')[0] ?? '/';
  const identityRef = useRef<string | null>(null);
  const identity = auth.user?.sub ?? null;

  // A different user (or a fresh login) must never inherit the previous user's
  // chats/slices from the long-lived store instance.
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    if (identity) store.reset();
  }, [identity, store]);

  const state = useChatRuntime(
    store,
    config,
    auth.user ? `${auth.user.sub}:${auth.user.expiresAt ?? 0}` : null,
  );

  // Public setup probe. It runs only inside the authenticated shell; the
  // server still enforces the admin flag on every `/admin/*` mutation.
  useEffect(() => {
    void ops.loadSetupStatus();
  }, [ops]);

  const logout = () => {
    store.reset();
    void auth.signOut();
  };

  const signInAgain = () => {
    store.reset();
    void auth.signOut();
  };

  const admin = state.me?.user.is_platform_admin === true;
  const setupStatus = opsState.setupStatus;
  const setupRequired = setupStatus?.setup_required === true;
  const setupLoading =
    opsState.setupStatusStatus === 'idle' || opsState.setupStatusStatus === 'loading';
  const setupError = opsState.setupStatusStatus === 'error';
  // The server is the source of truth: if it rejects `/admin/*` with 403, do
  // not keep rendering the admin surface even when `/me` looked stale.
  const adminServerForbidden =
    opsState.settingsError?.status === 403 ||
    opsState.overviewError?.status === 403 ||
    opsState.saveError?.status === 403 ||
    opsState.testEmailError?.status === 403;

  // R-03: an admin with an incomplete setup is pinned to `/setup`; once the
  // setup completes (possibly in another tab), `/setup` redirects to `/admin`.
  useEffect(() => {
    if (!setupStatus) return;
    if (setupRequired && admin && pathname !== '/setup') {
      navigate('/setup', { replace: true });
    } else if (!setupRequired && pathname === '/setup') {
      navigate(admin ? '/admin' : '/', { replace: true });
    }
  }, [admin, navigate, pathname, setupRequired, setupStatus]);

  useEffect(() => {
    if (setupLoading || setupError || setupRequired) return;
    if (pathname === '/setup' || pathname === '/admin') return;
    if (state.onboardingRequired && pathname !== '/onboarding') {
      navigate('/onboarding', { replace: true });
    } else if (!state.onboardingRequired && pathname === '/onboarding') {
      if (state.sessionStatus === 'ready') navigate('/', { replace: true });
    }
  }, [
    pathname,
    state.onboardingRequired,
    state.sessionStatus,
    navigate,
    setupError,
    setupLoading,
    setupRequired,
  ]);

  if (state.authExpired || state.sessionError?.status === 401) {
    return <SessionExpiredScreen onSignIn={signInAgain} />;
  }

  if (state.sessionError?.status === 403) {
    return <AccessDeniedScreen onRetry={() => void store.retryBootstrap()} onLogout={logout} />;
  }

  if (setupError) {
    return (
      <SetupStatusErrorScreen onRetry={() => void ops.loadSetupStatus(true)} onLogout={logout} />
    );
  }

  if (
    (!setupStatus && setupLoading) ||
    state.sessionStatus === 'idle' ||
    state.sessionStatus === 'loading'
  ) {
    return <SplashScreen />;
  }

  if (setupRequired) {
    if (!admin || opsState.settingsError?.status === 403 || opsState.saveError?.status === 403) {
      return (
        <SetupIncompleteScreen onRetry={() => void ops.loadSetupStatus(true)} onLogout={logout} />
      );
    }
    if (pathname !== '/setup') return <SplashScreen />;
    return <SetupWizard onLogout={logout} />;
  }

  if (!setupStatus) return <SplashScreen />;

  if (pathname === '/setup') return <SplashScreen />;

  if (pathname === '/admin') {
    if (!admin || adminServerForbidden) {
      return <AdminForbiddenScreen onBack={() => navigate('/')} onLogout={logout} />;
    }
    return (
      <AdminScreen
        onBackToChats={() => navigate('/')}
        onOpenSetup={() => navigate('/setup')}
        onLogout={logout}
      />
    );
  }

  if (state.onboardingRequired) {
    return <OnboardingScreen />;
  }

  return (
    <ChatWorkspace
      config={config}
      onLogout={logout}
      onSelectWorkspace={(workspaceId) => void store.selectWorkspace(workspaceId)}
      onOpenAdmin={admin ? () => navigate('/admin') : undefined}
    />
  );
}
