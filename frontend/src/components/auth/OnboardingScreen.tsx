import { useState, type FormEvent } from 'react';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import { t } from '../../i18n/ru';
import { WorkspaceIcon } from '../Icons';

const MAX_NAME_LENGTH = 120;

export function OnboardingScreen() {
  const store = useChatStore();
  const state = useChatState();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;
  const submitting = state.onboardingStatus === 'submitting';
  const showValidation = touched && !valid;
  const errorText =
    state.onboardingError?.status === 422
      ? t('onboarding.validation')
      : state.onboardingError
        ? t('onboarding.error')
        : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || submitting) return;
    void store.createWorkspace(trimmed);
  };

  return (
    <main className="auth-shell" aria-labelledby="onboarding-title">
      <section className="auth-card auth-card--wide">
        <div className="auth-card__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--mock">{t('onboarding.securityValue')}</span>
        </div>

        <div className="auth-card__message-icon" aria-hidden="true">
          <WorkspaceIcon />
        </div>
        <h1 className="auth-card__title" id="onboarding-title">
          {t('onboarding.title')}
        </h1>
        <p className="auth-card__lead">{t('onboarding.lead')}</p>
        {state.user ? (
          <p className="auth-card__hint">
            {t('onboarding.user', { name: state.user.display_name })}
          </p>
        ) : null}

        <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="workspace-name">
              {t('onboarding.nameLabel')}
            </label>
            <input
              id="workspace-name"
              className="field__input"
              type="text"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              placeholder={t('onboarding.namePlaceholder')}
              aria-describedby="workspace-name-hint workspace-name-error"
              aria-invalid={showValidation}
              autoComplete="organization"
              disabled={submitting}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setTouched(true)}
            />
            <div className="field__meta">
              <span id="workspace-name-hint">{t('onboarding.nameHint')}</span>
              <span aria-hidden="true">
                {name.length} / {MAX_NAME_LENGTH}
              </span>
            </div>
            {showValidation ? (
              <p className="field__error" id="workspace-name-error" role="alert">
                {t('onboarding.validation')}
              </p>
            ) : null}
          </div>

          <div className="onboarding-form__security">
            <span className="onboarding-form__security-label">{t('onboarding.securityLabel')}</span>
            <span className="security-badge security-badge--managed">
              {t('onboarding.securityValue')}
            </span>
            <p className="auth-card__hint">{t('onboarding.securityHint')}</p>
          </div>

          {errorText ? (
            <p className="auth-status auth-status--error" role="alert">
              {errorText}
            </p>
          ) : null}

          <button
            type="submit"
            className="button button--primary button--wide"
            disabled={submitting || !valid}
          >
            {submitting ? t('onboarding.submitting') : t('onboarding.submit')}
          </button>
        </form>
      </section>
    </main>
  );
}
