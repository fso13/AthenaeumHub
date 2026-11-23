import { useEffect, type ReactNode } from 'react';
import { useAppAuth, usePasswordAuth } from '../../auth/AuthContext';
import { useLocation, useNavigate } from '../../router/router';
import {
  parseWorkspaceInviteRoute,
  readInviteToken,
  workspaceInvitePath,
} from '../../router/inviteRoutes';
import { WorkspaceInviteAcceptPage } from '../WorkspaceInviteAcceptPage';
import { LoginScreen } from './LoginScreen';
import { RegisterScreen } from './RegisterScreen';
import { SplashScreen } from './AuthStatusScreens';
import { TwoFactorChallengeScreen } from './TwoFactorChallengeScreen';
import { VerifyEmailScreen } from './VerifyEmailScreen';

const AUTH_ROUTES = new Set(['/login', '/register', '/verify', '/2fa']);

/**
 * Password-mode guard: anonymous users only see the auth routes, authenticated
 * users see the app. There is no callback route and no redirect to Keycloak.
 *
 * P0-4 (#82): a `202` login challenge pins the anonymous flow to `/2fa` until
 * the code is verified, cancelled or the challenge is invalidated. A stale
 * `/2fa` URL without a challenge falls back to the credentials form.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAppAuth();
  const { pending, challenge } = usePasswordAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.split('?')[0] ?? '/';
  const workspaceInvite = parseWorkspaceInviteRoute(location);
  // #79: the invite route must survive the login round-trip. It stays in the
  // URL while the anonymous user sees the login screen, so the accept page is
  // restored immediately after authentication.
  const isInviteRoute =
    pathname === '/invite' ||
    pathname.startsWith('/invite/') ||
    pathname === '/workspace-invite' ||
    pathname.startsWith('/workspace-invite/');

  useEffect(() => {
    if (auth.status === 'anonymous') {
      if (challenge && pathname !== '/2fa') {
        navigate('/2fa', { replace: true });
      } else if (!challenge && pathname === '/2fa') {
        navigate('/login', { replace: true });
      } else if (pathname === '/verify' && !pending) {
        navigate('/login?verification=missing', { replace: true });
      } else if (!AUTH_ROUTES.has(pathname) && !isInviteRoute) {
        navigate('/login', { replace: true });
      }
      return;
    }
    if (auth.status === 'authenticated' && AUTH_ROUTES.has(pathname)) {
      // #100: a token carried through login/register returns to the invite
      // page so the authenticated user can accept it. The token is only in
      // the URL, never in storage.
      const inviteToken = readInviteToken(location);
      navigate(inviteToken ? workspaceInvitePath(inviteToken) : '/', { replace: true });
    }
  }, [auth.status, challenge, isInviteRoute, location, pathname, pending, navigate]);

  if (auth.status === 'loading') return <SplashScreen />;

  if (auth.status === 'anonymous') {
    if (challenge) return <TwoFactorChallengeScreen />;
    // #100: the public preview works without an account; the accept action
    // is rendered on the same page after authentication.
    if (workspaceInvite.matched) {
      return <WorkspaceInviteAcceptPage token={workspaceInvite.token} anonymous />;
    }
    if (pathname === '/register') return <RegisterScreen />;
    if (pathname === '/verify' && pending) return <VerifyEmailScreen />;
    return <LoginScreen />;
  }

  return <>{children}</>;
}
