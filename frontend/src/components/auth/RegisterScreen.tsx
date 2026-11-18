import { useState, type FormEvent } from 'react';
import { usePasswordAuth } from '../../auth/AuthContext';
import { authErrorMessage } from '../../auth/errors';
import { t } from '../../i18n/ru';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 80;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;

interface FieldErrors {
  displayName?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

function validate(
  displayName: string,
  email: string,
  password: string,
  confirm: string,
): FieldErrors {
  const errors: FieldErrors = {};
  const trimmedName = displayName.trim();
  if (!trimmedName) errors.displayName = t('auth.register.nameRequired');
  else if (trimmedName.length > MAX_NAME) errors.displayName = t('auth.register.nameTooLong');

  const trimmedEmail = email.trim();
  if (!trimmedEmail) errors.email = t('auth.register.emailRequired');
  else if (trimmedEmail.length > 254 || !EMAIL_RE.test(trimmedEmail)) {
    errors.email = t('auth.register.emailInvalid');
  }

  if (!password) errors.password = t('auth.register.passwordRequired');
  else if (password.length < MIN_PASSWORD) errors.password = t('auth.register.passwordShort');
  else if (password.length > MAX_PASSWORD) errors.password = t('auth.register.passwordLong');

  if (!confirm) errors.confirm = t('auth.register.confirmRequired');
  else if (confirm !== password) errors.confirm = t('auth.register.passwordMismatch');

  return errors;
}

/**
 * Registration form. Success does not create a session: the backend sends a
 * 6-digit TOTP to the email and the app moves to `/verify`.
 */
export function RegisterScreen() {
  const auth = usePasswordAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors = validate(displayName, email, password, confirm);
  const hasErrors = Object.keys(errors).length > 0;
  const showError = (field: keyof FieldErrors) => touched && Boolean(errors[field]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors || auth.busy) return;
    void auth.register({ displayName, email, password });
  };

  return (
    <main className="auth-shell" aria-labelledby="register-title">
      <section className="auth-card">
        <div className="auth-card__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--real">{t('auth.mode.password')}</span>
        </div>

        <h1 className="auth-card__title" id="register-title">
          {t('auth.register.title')}
        </h1>
        <p className="auth-card__lead">{t('auth.register.lead')}</p>

        {auth.error ? (
          <p className="auth-status auth-status--error" role="alert">
            {authErrorMessage(auth.error)}
          </p>
        ) : null}

        <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="register-name">
              {t('auth.register.nameLabel')}
            </label>
            <input
              id="register-name"
              className="field__input"
              type="text"
              name="name"
              value={displayName}
              autoComplete="name"
              maxLength={MAX_NAME}
              required
              disabled={auth.busy}
              aria-invalid={showError('displayName')}
              aria-describedby={showError('displayName') ? 'register-name-error' : undefined}
              onChange={(event) => {
                setDisplayName(event.target.value);
                auth.clearError();
              }}
              onBlur={() => setTouched(true)}
            />
            {showError('displayName') ? (
              <p className="field__error" id="register-name-error" role="alert">
                {errors.displayName}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="register-email">
              {t('auth.register.emailLabel')}
            </label>
            <input
              id="register-email"
              className="field__input"
              type="email"
              name="email"
              value={email}
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
              disabled={auth.busy}
              aria-invalid={showError('email')}
              aria-describedby={showError('email') ? 'register-email-error' : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                auth.clearError();
              }}
              onBlur={() => setTouched(true)}
            />
            {showError('email') ? (
              <p className="field__error" id="register-email-error" role="alert">
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="register-password">
              {t('auth.register.passwordLabel')}
            </label>
            <div className="field__control">
              <input
                id="register-password"
                className="field__input field__input--with-action"
                type={showPassword ? 'text' : 'password'}
                name="new-password"
                value={password}
                autoComplete="new-password"
                required
                disabled={auth.busy}
                aria-invalid={showError('password')}
                aria-describedby={
                  showError('password')
                    ? 'register-password-error register-password-hint'
                    : 'register-password-hint'
                }
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
            <p className="field__meta" id="register-password-hint">
              {t('auth.register.passwordHint')}
            </p>
            {showError('password') ? (
              <p className="field__error" id="register-password-error" role="alert">
                {errors.password}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="register-confirm">
              {t('auth.register.confirmLabel')}
            </label>
            <input
              id="register-confirm"
              className="field__input"
              type={showPassword ? 'text' : 'password'}
              name="confirm-password"
              value={confirm}
              autoComplete="new-password"
              required
              disabled={auth.busy}
              aria-invalid={showError('confirm')}
              aria-describedby={showError('confirm') ? 'register-confirm-error' : undefined}
              onChange={(event) => {
                setConfirm(event.target.value);
                auth.clearError();
              }}
              onBlur={() => setTouched(true)}
            />
            {showError('confirm') ? (
              <p className="field__error" id="register-confirm-error" role="alert">
                {errors.confirm}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            className="button button--primary button--wide"
            disabled={auth.busy}
          >
            {auth.busy ? t('auth.register.submitting') : t('auth.register.submit')}
          </button>
        </form>

        <p className="auth-card__hint">{t('auth.register.haveAccount')}</p>
        <div className="auth-actions">
          <button
            type="button"
            className="button button--secondary button--wide"
            disabled={auth.busy}
            onClick={auth.openLogin}
          >
            {t('auth.login.signIn')}
          </button>
        </div>
      </section>
    </main>
  );
}
