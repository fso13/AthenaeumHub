import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { t } from '../../i18n/ru';
import { twoFactorErrorText } from '../../profile/twoFactorErrors';
import {
  useChatStore,
  useProfileWorkspaceState,
  useProfileWorkspaceStore,
} from '../../store/ChatProvider';
import { ShieldIcon } from '../Icons';
import { TwoFactorEnrollPanel } from './TwoFactorEnrollPanel';

type GateStage = 'idle' | 'password' | 'setup' | 'recovery' | 'done';

export interface TwoFactorEnrollmentGateProps {
  /** Optional override; by default the gate resets the chat store and signs out. */
  onLogout?: () => void;
  children: ReactNode;
}

/**
 * #93 server-wide `require_2fa` gate for an already authenticated session.
 *
 * A user who signed in before the policy changed (or whose browser restored a
 * session) has no login challenge to enroll through, so the app is blocked
 * until `POST /me/2fa/setup` + `/verify` complete. Enrollment needs the account
 * password, exactly like the profile card. `GET /me/2fa` in the published
 * contract has no policy field yet, so the gate opens only on an additive
 * `required=true`/`enrollment_required=true`; without it the login ENROLL
 * challenge and the backend `403 TWO_FACTOR_REQUIRED` on refresh remain the
 * enforcement points. A failed status read never locks the user out.
 */
export function TwoFactorEnrollmentGate({ onLogout, children }: TwoFactorEnrollmentGateProps) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const chatStore = useChatStore();
  const auth = usePasswordAuth();
  const logout =
    onLogout ??
    (() => {
      chatStore.reset();
      void auth.signOut();
    });
  const twoFactor = state.twoFactor;
  const status = twoFactor.value;
  const required = status?.required === true || status?.enrollment_required === true;
  const enabled = status?.enabled === true;

  const [stage, setStage] = useState<GateStage>('idle');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const pendingPassword = useRef<string | null>(null);
  const passwordId = useId();
  const titleId = useId();

  useEffect(() => {
    // ChatStore resets the profile store when the authenticated identity is
    // applied; a read that raced that reset must be retried instead of
    // silently leaving the app unlocked.
    if (twoFactor.status !== 'idle') return;
    void store.loadTwoFactor();
  }, [store, twoFactor.status]);

  // Once the policy is visible and the account has no authenticator, open the
  // password step automatically; the setup itself still needs the password.
  useEffect(() => {
    if (stage !== 'idle') return;
    if (!required || enabled) return;
    setStage('password');
  }, [enabled, required, stage]);

  const blocking =
    stage !== 'done' &&
    ((required && !enabled) || stage === 'setup' || stage === 'recovery') &&
    twoFactor.status === 'ready';

  if (!blocking) return <>{children}</>;

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!password || twoFactor.setupStatus === 'starting') return;
    pendingPassword.current = password;
    setPassword('');
    setStage('setup');
    const ok = await store.setupTwoFactor(pendingPassword.current);
    if (!ok) {
      // Keep the password only in memory for a retry after a transient error;
      // the panel's retry returns to the password step for a clean re-entry.
      pendingPassword.current = null;
    }
  };

  const verify = async (code: string) => {
    const ok = await store.verifyTwoFactorSetup(code);
    if (!ok) return;
    // Show the recovery step first so the user sees progress while the
    // one-time codes are being issued; the panel reports a missing set if the
    // server rejects the re-issue.
    setStage('recovery');
    const secretPassword = pendingPassword.current;
    if (secretPassword) await store.issueRecoveryCodes(secretPassword);
  };

  const finish = () => {
    pendingPassword.current = null;
    store.clearTwoFactorDraft();
    setStage('done');
  };

  const panelStatus =
    stage === 'recovery'
      ? 'recovery'
      : twoFactor.setup
        ? twoFactor.verifyStatus === 'verifying'
          ? 'verifying'
          : 'ready'
        : twoFactor.setupStatus === 'error'
          ? 'error'
          : 'starting';

  const panelError =
    twoFactor.setupStatus === 'error'
      ? twoFactor.setupError
      : twoFactor.verifyStatus === 'error'
        ? twoFactor.verifyError
        : null;

  return (
    <main className="login-shell" aria-label={t('auth.enroll.requiredTitle')}>
      <section className="login-card">
        <aside className="login-hero" aria-hidden="true">
          <div className="login-hero__brand">
            <span className="login-wordmark">{t('app.name')}</span>
          </div>
          <p className="login-hero__title">
            <span>{t('auth.enroll.gateLead')}</span>
            <strong>{t('auth.enroll.gateStrong')}</strong>
          </p>
        </aside>

        <div className="login-pane">
          <div className="login-form-wrap">
            {stage === 'password' ? (
              <>
                <header className="login-head">
                  <h1 id={titleId}>
                    <ShieldIcon aria-hidden="true" /> {t('auth.enroll.requiredTitle')}
                  </h1>
                  <p className="login-lead">{t('auth.enroll.requiredLead')}</p>
                </header>
                <p className="login-status" role="status">
                  {t('auth.enroll.gateStatus')}
                </p>
                <form
                  className="login-form"
                  onSubmit={(event) => void startSetup(event)}
                  noValidate
                >
                  <div className="login-field">
                    <label className="login-label" htmlFor={passwordId}>
                      {t('profile.twoFactor.passwordLabel')}
                    </label>
                    <input
                      ref={passwordRef}
                      id={passwordId}
                      className="login-input"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      autoFocus
                      disabled={twoFactor.setupStatus === 'starting'}
                      aria-invalid={touched && !password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <p className="login-hint">{t('profile.twoFactor.passwordHint')}</p>
                  </div>
                  <button
                    type="submit"
                    className="login-submit"
                    disabled={!password || twoFactor.setupStatus === 'starting'}
                  >
                    {twoFactor.setupStatus === 'starting'
                      ? t('profile.twoFactor.verifying')
                      : t('profile.twoFactor.continue')}
                  </button>
                </form>
                <div className="login-switch login-switch--column">
                  <button type="button" className="login-switch__link" onClick={logout}>
                    {t('auth.logout')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <TwoFactorEnrollPanel
                  setup={twoFactor.setup}
                  status={panelStatus}
                  recoveryCodes={twoFactor.recoveryCodes?.codes ?? null}
                  errorText={panelError ? twoFactorErrorText(panelError) : null}
                  onRetry={() => {
                    pendingPassword.current = null;
                    store.clearTwoFactorDraft();
                    setStage('password');
                  }}
                  onVerify={verify}
                  onFinish={finish}
                  finishLabel={t('auth.enroll.continueApp')}
                />
                {stage === 'recovery' && twoFactor.recoveryStatus === 'error' ? (
                  <p className="login-status login-status--error" role="alert">
                    {t('auth.enroll.recoveryIssueError')}
                  </p>
                ) : null}
                <div className="login-switch login-switch--column">
                  <button
                    type="button"
                    className="login-switch__link"
                    onClick={logout}
                    disabled={twoFactor.verifyStatus === 'verifying'}
                  >
                    {t('auth.logout')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
