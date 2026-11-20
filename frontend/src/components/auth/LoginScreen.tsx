import { useState, type FormEvent } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { authErrorMessage } from '../../auth/errors';
import {
  clearRememberedEmail,
  readRememberedEmail,
  writeRememberedEmail,
} from '../../auth/storage';
import { t } from '../../i18n/ru';
import { useLocation } from '../../router/router';
import { EyeIcon, EyeOffIcon } from '../Icons';

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
 * Split-screen login from the 2026 auth concept: dark hero on the left, a
 * focused credential pane on the right. The Auth BFF flow is unchanged —
 * the password is sent only to `/auth/login` and never stored.
 *
 * "Запомнить меня" remembers only the email for this tab (sessionStorage).
 * Access/refresh tokens remain session-scoped by AUTH-D-06.
 */
export function LoginScreen() {
  const auth = usePasswordAuth();
  const location = useLocation();
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  const loggedOut = params.get('logged_out') === '1';
  const verificationMissing = params.get('verification') === 'missing';
  const twoFactorRequired = params.get('2fa') === 'required';

  const [rememberedEmail] = useState(() => readRememberedEmail());
  const [email, setEmail] = useState(rememberedEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(Boolean(rememberedEmail));
  const [touched, setTouched] = useState(false);

  const errors = validate(email, password);
  const showEmailError = touched && Boolean(errors.email);
  const showPasswordError = touched && Boolean(errors.password);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (errors.email || errors.password || auth.busy) return;
    void (async () => {
      const ok = await auth.login(email, password);
      if (!ok) return;
      if (remember) writeRememberedEmail(email);
      else clearRememberedEmail();
    })();
  };

  return (
    <main className="login-shell" aria-labelledby="login-title">
      <section className="login-card">
        <aside className="login-hero" aria-hidden="true">
          <div className="login-hero__brand">
            <span className="login-wordmark">{t('app.name')}</span>
          </div>
          <p className="login-hero__title">
            <span>{t('auth.login.heroLead')}</span>
            <strong>{t('auth.login.heroStrong')}</strong>
          </p>
        </aside>

        <div className="login-pane">
          <div className="login-form-wrap">
            <header className="login-head">
              <h1 id="login-title">{t('auth.login.title')}</h1>
            </header>

            {loggedOut ? (
              <p className="login-status login-status--success" role="status">
                {t('auth.login.loggedOut')}
              </p>
            ) : null}

            {verificationMissing ? (
              <p className="login-status login-status--error" role="status">
                {t('auth.verify.missing')}
              </p>
            ) : null}

            {twoFactorRequired ? (
              <p className="login-status login-status--error" role="status">
                {t('auth.login.twoFactorRequired')}
              </p>
            ) : null}

            {auth.error ? (
              <p className="login-status login-status--error" role="alert">
                {authErrorMessage(auth.error)}
              </p>
            ) : null}

            <form className="login-form" onSubmit={handleSubmit} noValidate>
              <div className="login-field">
                <label className="login-label" htmlFor="login-email">
                  {t('auth.login.emailLabel')}
                </label>
                <input
                  id="login-email"
                  className="login-input"
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
                  <p className="login-error" id="login-email-error" role="alert">
                    {errors.email}
                  </p>
                ) : null}
              </div>

              <div className="login-field">
                <label className="login-label" htmlFor="login-password">
                  {t('auth.login.passwordLabel')}
                </label>
                <div className="login-password">
                  <input
                    id="login-password"
                    className="login-input login-input--password"
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
                    className="login-eye"
                    aria-label={
                      showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                    }
                    aria-pressed={showPassword}
                    title={
                      showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                    }
                    disabled={auth.busy}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? (
                      <EyeOffIcon aria-hidden="true" />
                    ) : (
                      <EyeIcon aria-hidden="true" />
                    )}
                  </button>
                </div>
                {showPasswordError ? (
                  <p className="login-error" id="login-password-error" role="alert">
                    {errors.password}
                  </p>
                ) : null}
              </div>

              <label className="login-check">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={auth.busy}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setRemember(next);
                    if (!next) clearRememberedEmail();
                  }}
                />
                <span>{t('auth.login.rememberMe')}</span>
              </label>

              <button type="submit" className="login-submit" disabled={auth.busy}>
                {auth.busy ? t('auth.login.submitting') : t('auth.login.signIn')}
              </button>
            </form>

            <p className="login-switch">
              <span>{t('auth.login.noAccount')}</span>
              <button
                type="button"
                className="login-switch__link"
                disabled={auth.busy}
                onClick={auth.openRegister}
              >
                {t('auth.login.signUp')}
              </button>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
