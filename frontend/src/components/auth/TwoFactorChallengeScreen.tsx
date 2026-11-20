import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { authErrorMessage } from '../../auth/errors';
import { useCountdown } from '../../hooks/useCountdown';
import { t } from '../../i18n/ru';
import { TwoFactorEnrollPanel } from './TwoFactorEnrollPanel';

const TOTP_RE = /^[0-9]{6}$/;
const RECOVERY_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
/** Local guard so "resend" cannot hammer the login rate limit. */
const RESEND_COOLDOWN_SECONDS = 15;

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeRecoveryCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '')
    .slice(0, 12)
    .replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * P0-4 (#82) second-factor screen.
 *
 * The password step returned `202 {challenge_id, expires_in}`: no session and
 * no tokens exist in the browser yet. The screen accepts a 6-digit TOTP code or
 * a one-time recovery code, shows the challenge expiry, and lets the user
 * request a fresh challenge (re-submitting the already verified password,
 * because the contract has no separate resend endpoint), go back to the
 * credentials form, or retry after a wrong code. Nothing here is persisted and
 * no TOTP secret is ever displayed.
 */
export function TwoFactorChallengeScreen() {
  const auth = usePasswordAuth();
  const titleId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const errorId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const challenge = auth.challenge;
  const enroll = challenge?.mode === 'ENROLL';
  const methods = challenge?.methods ?? ['TOTP'];
  const supportsTotp = !enroll && methods.includes('TOTP');
  const supportsRecovery = !enroll && methods.includes('RECOVERY_CODE');
  const enrollmentStartedFor = useRef<string | null>(null);

  const [mode, setMode] = useState<'TOTP' | 'RECOVERY_CODE'>(
    supportsTotp ? 'TOTP' : 'RECOVERY_CODE',
  );
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [resendUntil, setResendUntil] = useState(0);

  const secondsLeft = useCountdown(challenge?.expiresAt ?? null);
  const resendWait = useCountdown(resendUntil > 0 ? resendUntil : null);
  const expired = challenge !== null && secondsLeft === 0;

  useEffect(() => {
    codeRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    // Leave a consumed/expired challenge automatically: the guard would render
    // the login form only after the provider state changes, so show the hint
    // here and let the user decide when to return.
    if (!expired) return;
    setCode('');
  }, [expired]);

  useEffect(() => {
    // ENROLL has no code to enter before setup: request the one-time secret as
    // soon as the screen appears. The ref makes this idempotent across the
    // provider's re-renders and StrictMode-style double effects.
    const challengeId = challenge?.id ?? null;
    if (!enroll || !challengeId) {
      enrollmentStartedFor.current = null;
      return;
    }
    if (enrollmentStartedFor.current === challengeId) return;
    enrollmentStartedFor.current = challengeId;
    void auth.startEnrollment();
  }, [auth, challenge?.id, enroll]);

  if (!challenge) return null;

  if (enroll) {
    return (
      <main className="login-shell" aria-label={t('auth.enroll.title')}>
        <section className="login-card">
          <aside className="login-hero" aria-hidden="true">
            <div className="login-hero__brand">
              <span className="login-wordmark">{t('app.name')}</span>
            </div>
            <p className="login-hero__title">
              <span>{t('auth.enroll.heroLead')}</span>
              <strong>{t('auth.enroll.heroStrong')}</strong>
            </p>
          </aside>

          <div className="login-pane">
            <div className="login-form-wrap">
              {expired ? (
                <p className="login-status login-status--error" role="alert">
                  {t('auth.twoFactor.expired')}
                </p>
              ) : (
                <p className="login-status" role="status">
                  {t('auth.twoFactor.expiresIn', { time: formatSeconds(secondsLeft) })}
                </p>
              )}

              <TwoFactorEnrollPanel
                setup={auth.enrollmentSetup}
                status={auth.enrollmentStatus === 'idle' ? 'starting' : auth.enrollmentStatus}
                recoveryCodes={auth.enrollmentRecoveryCodes}
                errorText={auth.enrollmentError ? authErrorMessage(auth.enrollmentError) : null}
                onRetry={() => void auth.startEnrollment()}
                onVerify={async (value) => {
                  await auth.verifyEnrollment(value);
                }}
                onFinish={auth.finishEnrollment}
                finishLabel={t('auth.enroll.continueApp')}
              />

              <div className="login-switch login-switch--column">
                <button
                  type="button"
                  className="login-switch__link"
                  onClick={auth.cancelChallenge}
                  disabled={auth.enrollmentStatus === 'verifying'}
                >
                  {t('auth.enroll.back')}
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const normalized = mode === 'TOTP' ? code.trim() : normalizeRecoveryCode(code);
  const formatError =
    mode === 'TOTP'
      ? TOTP_RE.test(normalized)
        ? null
        : t('auth.twoFactor.codeFormat')
      : RECOVERY_RE.test(normalized)
        ? null
        : t('auth.twoFactor.recoveryFormat');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (expired || auth.busy || formatError) return;
    void (async () => {
      const ok = await auth.verifyTwoFactor(normalized);
      if (!ok) setCode('');
    })();
  };

  const handleResend = () => {
    if (auth.busy || resendWait > 0) return;
    void (async () => {
      const ok = await auth.resendChallenge();
      if (ok) {
        setCode('');
        setTouched(false);
        setResendUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      }
    })();
  };

  const shownError = auth.error ? authErrorMessage(auth.error) : null;
  const showFormatError = touched && formatError !== null && !shownError;

  return (
    <main className="login-shell" aria-labelledby={titleId}>
      <section className="login-card">
        <aside className="login-hero" aria-hidden="true">
          <div className="login-hero__brand">
            <span className="login-wordmark">{t('app.name')}</span>
          </div>
          <p className="login-hero__title">
            <span>{t('auth.twoFactor.heroLead')}</span>
            <strong>{t('auth.twoFactor.heroStrong')}</strong>
          </p>
        </aside>

        <div className="login-pane">
          <div className="login-form-wrap">
            <header className="login-head">
              <h1 id={titleId}>{t('auth.twoFactor.title')}</h1>
              <p className="login-lead">{t('auth.twoFactor.lead')}</p>
            </header>

            {auth.notice ? (
              <p className="login-status login-status--success" role="status">
                {t(auth.notice)}
              </p>
            ) : null}

            {expired ? (
              <p className="login-status login-status--error" role="alert">
                {t('auth.twoFactor.expired')}
              </p>
            ) : (
              <p className="login-status" role="status">
                {t('auth.twoFactor.expiresIn', { time: formatSeconds(secondsLeft) })}
              </p>
            )}

            {shownError ? (
              <p className="login-status login-status--error" role="alert" id={errorId}>
                {shownError}
              </p>
            ) : null}

            {supportsTotp && supportsRecovery ? (
              <div className="seg" role="group" aria-label={t('auth.twoFactor.methodLabel')}>
                <button
                  type="button"
                  className={mode === 'TOTP' ? 'is-active' : ''}
                  aria-pressed={mode === 'TOTP'}
                  disabled={auth.busy}
                  onClick={() => {
                    setMode('TOTP');
                    setCode('');
                    setTouched(false);
                    auth.clearError();
                  }}
                >
                  {t('auth.twoFactor.method.totp')}
                </button>
                <button
                  type="button"
                  className={mode === 'RECOVERY_CODE' ? 'is-active' : ''}
                  aria-pressed={mode === 'RECOVERY_CODE'}
                  disabled={auth.busy}
                  onClick={() => {
                    setMode('RECOVERY_CODE');
                    setCode('');
                    setTouched(false);
                    auth.clearError();
                  }}
                >
                  {t('auth.twoFactor.method.recovery')}
                </button>
              </div>
            ) : null}

            <form className="login-form" onSubmit={handleSubmit} noValidate>
              <div className="login-field">
                <label className="login-label" htmlFor={codeId}>
                  {mode === 'TOTP'
                    ? t('auth.twoFactor.codeLabel')
                    : t('auth.twoFactor.recoveryLabel')}
                </label>
                <input
                  ref={codeRef}
                  id={codeId}
                  className="login-input"
                  type="text"
                  inputMode={mode === 'TOTP' ? 'numeric' : 'text'}
                  name={mode === 'TOTP' ? 'totp' : 'recovery_code'}
                  value={code}
                  autoComplete="one-time-code"
                  spellCheck={false}
                  maxLength={mode === 'TOTP' ? 6 : 14}
                  placeholder={
                    mode === 'TOTP'
                      ? t('auth.twoFactor.codePlaceholder')
                      : t('auth.twoFactor.recoveryPlaceholder')
                  }
                  disabled={auth.busy || expired}
                  aria-invalid={showFormatError || Boolean(shownError)}
                  aria-describedby={`${codeHintId}${shownError ? ` ${errorId}` : ''}`}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCode(mode === 'TOTP' ? next.replace(/\D/g, '') : next);
                    auth.clearError();
                  }}
                  onBlur={() => setTouched(true)}
                />
                <p className="login-hint" id={codeHintId}>
                  {mode === 'TOTP'
                    ? t('auth.twoFactor.codeHint')
                    : t('auth.twoFactor.recoveryHint')}
                </p>
                {showFormatError ? (
                  <p className="login-error" role="alert">
                    {formatError}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                className="login-submit"
                disabled={auth.busy || expired}
                aria-busy={auth.busy}
              >
                {auth.busy ? t('auth.twoFactor.submitting') : t('auth.twoFactor.submit')}
              </button>
            </form>

            <div className="login-switch login-switch--column">
              <button
                type="button"
                className="login-switch__link"
                disabled={auth.busy || resendWait > 0}
                onClick={handleResend}
              >
                {resendWait > 0
                  ? t('auth.twoFactor.resendIn', { seconds: resendWait })
                  : t('auth.twoFactor.resend')}
              </button>
              <button
                type="button"
                className="login-switch__link"
                disabled={auth.busy}
                onClick={auth.cancelChallenge}
              >
                {t('auth.twoFactor.back')}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
