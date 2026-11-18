import { useEffect, type ReactNode } from 'react';
import { useAppAuth, usePasswordAuth } from '../../auth/AuthContext';
import { useLocation, useNavigate } from '../../router/router';
import { LoginScreen } from './LoginScreen';
import { RegisterScreen } from './RegisterScreen';
import { VerifyEmailScreen } from './VerifyEmailScreen';
import { SplashScreen } from './AuthStatusScreens';

const AUTH_ROUTES = new Set(['/login', '/register', '/verify']);

/**
 * Password-mode guard: anonymous users only see the auth routes, authenticated
 * users see the app. There is no callback route and no redirect to Keycloak.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAppAuth();
  const { pending } = usePasswordAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.split('?')[0] ?? '/';

  useEffect(() => {
    if (auth.status === 'anonymous') {
      if (pathname === '/verify' && !pending) {
        navigate('/login?verification=missing', { replace: true });
      } else if (!AUTH_ROUTES.has(pathname)) {
        navigate('/login', { replace: true });
      }
      return;
    }
    if (auth.status === 'authenticated' && AUTH_ROUTES.has(pathname)) {
      navigate('/', { replace: true });
    }
  }, [auth.status, pathname, pending, navigate]);

  if (auth.status === 'loading') return <SplashScreen />;

  if (auth.status === 'anonymous') {
    if (pathname === '/register') return <RegisterScreen />;
    if (pathname === '/verify' && pending) return <VerifyEmailScreen />;
    return <LoginScreen />;
  }

  return <>{children}</>;
}
