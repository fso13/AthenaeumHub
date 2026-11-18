import { useState, type FormEvent } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { authErrorMessage } from '../../auth/errors';
import { t } from '../../i18n/ru';
import { useLocation } from '../../router/router';
import { LockIcon } from '../Icons';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  password?: string;
}

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = t('auth.login.emailRequired');
  else if (email.trim().length > 254 || !EMAIL_RE.test(email.trim())) {
    errors.email = t('auth.login.emailInvalid');
  }
  if (!password) errors.password = t('auth.login.passwordRequired');
  return errors;
}

/**
 * Email/password form for the Auth BFF. The password is sent only to
 * `/auth/login`; it is never stored, logged or placed in the URL.
 */
export function LoginScreen() {
  const auth = usePasswordAuth();
  const location = useLocation();
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  const loggedOut = params.get('logged_out') === '1';
  const verificationMissing = params.get('verification') === 'missing';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors = validate(email, password);
  const showEmailError = touched && Boolean(errors.email);
  const showPasswordError = touched && Boolean(errors.password);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (errors.email || errors.password || auth.busy) return;
    void auth.login(email, password);
  };

  return (
    <main className="auth-shell" aria-labelledby="login-title">
      <section className="auth-card">
        <div className="auth-card__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--real">{t('auth.mode.password')}</span>
        </div>

        <h1 className="auth-card__title" id="login-title">
          {t('auth.login.title')}
        </h1>
        <p className="auth-card__lead">{t('auth.login.lead')}</p>

        {loggedOut ? (
          <p className="auth-status auth-status--success" role="status">
            {t('auth.login.loggedOut')}
          </p>
        ) : null}

        {verificationMissing ? (
          <p className="auth-status auth-status--error" role="status">
            {t('auth.verify.missing')}
          </p>
        ) : null}

        {auth.error ? (
          <p className="auth-status auth-status--error" role="alert">
            {authErrorMessage(auth.error)}
          </p>
        ) : null}

        <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="login-email">
              {t('auth.login.emailLabel')}
            </label>
            <input
              id="login-email"
              className="field__input"
              type="email"
              name="email"
              value={email}
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              placeholder={t('auth.login.emailPlaceholder')}
              required
              disabled={auth.busy}
              aria-invalid={showEmailError}
              aria-describedby={showEmailError ? 'login-email-error' : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                auth.clearError();
              }}
              onBlur={() => setTouched(true)}
            />
            {showEmailError ? (
              <p className="field__error" id="login-email-error" role="alert">
                {errors.email}
              </p>
            ) : (
              <p className="field__meta">{t('auth.login.emailHint')}</p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="login-password">
              {t('auth.login.passwordLabel')}
            </label>
            <div className="field__control">
              <input
                id="login-password"
                className="field__input field__input--with-action"
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={password}
                autoComplete="current-password"
                required
                disabled={auth.busy}
                aria-invalid={showPasswordError}
                aria-describedby={showPasswordError ? 'login-password-error' : undefined}
                onChange={(event) => {
                  setPassword(event.target.value);
                  auth.clearError();
                }}
                onBlur={() => setTouched(true)}
              />
              <button
                type="button"
                className="field__action"
                aria-pressed={showPassword}
                aria-label={
                  showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                }
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? t('auth.login.hideShort') : t('auth.login.showShort')}
              </button>
            </div>
            {showPasswordError ? (
              <p className="field__error" id="login-password-error" role="alert">
                {errors.password}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            className="button button--primary button--wide"
            disabled={auth.busy}
          >
            <LockIcon aria-hidden="true" />
            {auth.busy ? t('auth.login.submitting') : t('auth.login.signIn')}
          </button>
        </form>

        <p className="auth-card__hint">{t('auth.login.registrationHint')}</p>
        <div className="auth-actions">
          <button
            type="button"
            className="button button--secondary button--wide"
            disabled={auth.busy}
            onClick={auth.openRegister}
          >
            {t('auth.login.signUp')}
          </button>
        </div>
      </section>
    </main>
  );
}
