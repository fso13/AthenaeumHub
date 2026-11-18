import { useEffect, useState, type FormEvent } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { authErrorMessage } from '../../auth/errors';
import { t } from '../../i18n/ru';

const CODE_LENGTH = 6;

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 6-digit email TOTP screen. The code itself is never persisted; only the
 * verification id/email and countdown deadlines live in the auth storage.
 */
export function VerifyEmailScreen() {
  const auth = usePasswordAuth();
  const pending = auth.pending;
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (!pending) {
    return (
      <main className="auth-shell" aria-labelledby="verify-missing-title">
        <section className="auth-card auth-card--message auth-card--error">
          <div className="auth-card__brand">
            <span className="brand__name">{t('app.name')}</span>
          </div>
          <h1 className="auth-card__title" id="verify-missing-title">
            {t('auth.verify.missingTitle')}
          </h1>
          <p className="auth-card__lead">{t('auth.verify.missing')}</p>
          <div className="auth-actions">
            <button type="button" className="button button--primary" onClick={auth.openLogin}>
              {t('auth.verify.backToLogin')}
            </button>
          </div>
        </section>
      </main>
    );
  }

  const expiresIn =
    pending.expiresAt === null ? null : Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
  const expired = expiresIn === 0;
  const resendIn = Math.max(0, Math.ceil((pending.resendUntil - now) / 1000));
  const canResend = !expired && resendIn === 0 && !auth.busy;
  const codeValid = new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code);
  const showCodeError = submitted && !codeValid;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!codeValid || expired || auth.busy) return;
    void auth.verify(code);
  };

  return (
    <main className="auth-shell" aria-labelledby="verify-title">
      <section className="auth-card">
        <div className="auth-card__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--real">{t('auth.mode.password')}</span>
        </div>

        <h1 className="auth-card__title" id="verify-title">
          {t('auth.verify.title')}
        </h1>
        <p className="auth-card__lead">{t('auth.verify.lead', { email: pending.email })}</p>

        {auth.notice ? (
          <p className="auth-status auth-status--success" role="status">
            {t(auth.notice)}
          </p>
        ) : null}

        {auth.error ? (
          <p className="auth-status auth-status--error" role="alert">
            {authErrorMessage(auth.error)}
          </p>
        ) : null}

        <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="verify-code">
              {t('auth.verify.codeLabel')}
            </label>
            <input
              id="verify-code"
              className="field__input field__input--code"
              type="text"
              name="one-time-code"
              value={code}
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={CODE_LENGTH}
              required
              autoFocus
              disabled={auth.busy || expired}
              aria-invalid={showCodeError}
              aria-describedby="verify-code-hint verify-code-error"
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH));
                auth.clearError();
              }}
            />
            <div className="field__meta">
              <span id="verify-code-hint">{t('auth.verify.codeHint')}</span>
              {expiresIn !== null ? (
                <span>{t('auth.verify.expiresIn', { time: formatDuration(expiresIn) })}</span>
              ) : null}
            </div>
            {showCodeError ? (
              <p className="field__error" id="verify-code-error" role="alert">
                {t('auth.verify.codeFormat')}
              </p>
            ) : null}
          </div>

          {expired ? (
            <p className="auth-status auth-status--error" role="status">
              {t('auth.verify.expired')}
            </p>
          ) : null}

          <button
            type="submit"
            className="button button--primary button--wide"
            disabled={auth.busy || expired}
          >
            {auth.busy ? t('auth.verify.submitting') : t('auth.verify.submit')}
          </button>

          <button
            type="button"
            className="button button--secondary button--wide"
            disabled={!canResend}
            onClick={() => void auth.resendCode()}
          >
            {resendIn > 0
              ? t('auth.verify.resendIn', { seconds: resendIn })
              : t('auth.verify.resend')}
          </button>
        </form>

        <div className="auth-actions">
          <button type="button" className="button button--ghost" onClick={auth.openLogin}>
            {t('auth.verify.backToLogin')}
          </button>
        </div>
      </section>
    </main>
  );
}
