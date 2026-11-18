import type { ReactNode } from 'react';
import { t } from '../../i18n/ru';
import { AlertIcon, LockIcon } from '../Icons';

interface MessageCardProps {
  title: string;
  text: string;
  tone?: 'neutral' | 'error' | 'forbidden';
  busy?: boolean;
  children?: ReactNode;
}

function MessageCard({ title, text, tone = 'neutral', busy = false, children }: MessageCardProps) {
  return (
    <main className="auth-shell" aria-labelledby="auth-message-title">
      <section className={`auth-card auth-card--message auth-card--${tone}`}>
        <div className="auth-card__brand">
          <span className="brand__name">{t('app.name')}</span>
        </div>
        <div className="auth-card__message-icon" aria-hidden="true">
          {tone === 'neutral' ? <span className="spinner" /> : <AlertIcon />}
        </div>
        <h1 className="auth-card__title" id="auth-message-title">
          {title}
        </h1>
        <p className="auth-card__lead" role={busy ? 'status' : undefined} aria-live="polite">
          {text}
        </p>
        {children ? <div className="auth-actions">{children}</div> : null}
      </section>
    </main>
  );
}

export function SplashScreen() {
  return <MessageCard title={t('auth.splash')} text={t('auth.splash.text')} busy />;
}

export function SessionExpiredScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <MessageCard title={t('auth.expired.title')} text={t('auth.expired.text')} tone="forbidden">
      <button type="button" className="button button--primary" onClick={onSignIn}>
        <LockIcon aria-hidden="true" />
        {t('auth.login.signIn')}
      </button>
    </MessageCard>
  );
}

export function AccessDeniedScreen({
  onRetry,
  onLogout,
}: {
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <MessageCard title={t('auth.denied.title')} text={t('auth.denied.text')} tone="forbidden">
      <button type="button" className="button button--primary" onClick={onRetry}>
        {t('auth.denied.retry')}
      </button>
      <button type="button" className="button button--secondary" onClick={onLogout}>
        {t('auth.logout')}
      </button>
    </MessageCard>
  );
}

/** R-03: a non-admin must never reach `/setup`; the server also rejects it. */
export function SetupIncompleteScreen({
  onRetry,
  onLogout,
}: {
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <MessageCard
      title={t('setup.incomplete.title')}
      text={t('setup.incomplete.text')}
      tone="forbidden"
    >
      <button type="button" className="button button--secondary" onClick={onRetry}>
        {t('setup.incomplete.retry')}
      </button>
      <button type="button" className="button button--secondary" onClick={onLogout}>
        {t('auth.logout')}
      </button>
    </MessageCard>
  );
}

export function SetupStatusErrorScreen({
  onRetry,
  onLogout,
}: {
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <MessageCard
      title={t('setup.statusError.title')}
      text={t('setup.statusError.text')}
      tone="error"
    >
      <button type="button" className="button button--primary" onClick={onRetry}>
        {t('common.retry')}
      </button>
      <button type="button" className="button button--secondary" onClick={onLogout}>
        {t('auth.logout')}
      </button>
    </MessageCard>
  );
}

/** R-04/FR-ADM-8: UI 403 for a non-admin `/admin` deep link (server is truth). */
export function AdminForbiddenScreen({
  onBack,
  onLogout,
}: {
  onBack: () => void;
  onLogout: () => void;
}) {
  return (
    <MessageCard
      title={t('admin.forbidden.title')}
      text={t('admin.forbidden.text')}
      tone="forbidden"
    >
      <p className="auth-card__hint">{t('admin.forbidden.hint')}</p>
      <button type="button" className="button button--primary" onClick={onBack}>
        {t('admin.forbidden.back')}
      </button>
      <button type="button" className="button button--secondary" onClick={onLogout}>
        {t('admin.forbidden.logout')}
      </button>
    </MessageCard>
  );
}
