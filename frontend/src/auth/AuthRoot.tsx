import type { ReactNode } from 'react';
import type { AppConfig } from '../config/env';
import { PasswordAuthProvider } from './PasswordAuthProvider';

/**
 * Picks the auth adapter. `dev` keeps the F-01 `/dev/session` fallback and has
 * no auth screens. `password` renders the Auth BFF forms (no OIDC redirect).
 */
export function AuthRoot({ config, children }: { config: AppConfig; children: ReactNode }) {
  if (config.authMode === 'dev') return <>{children}</>;
  return <PasswordAuthProvider config={config}>{children}</PasswordAuthProvider>;
}
