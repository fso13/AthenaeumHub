import { t } from '../../i18n/ru';
import { useChatState } from '../../store/ChatProvider';
import { LockIcon, ShieldIcon } from '../Icons';
import { PageShell } from './PageShell';

interface SecurityPageProps {
  onBack: () => void;
  onOpenChat: () => void;
}

/**
 * D1-FE1 / D1.1: DLP policies and workspace audit require APIs that are not in
 * this slice. Managed mode, role and key capabilities are shown from the
 * existing `/me`/`/workspaces` data; the rest is explicitly disabled.
 */
export function SecurityPage({ onBack, onOpenChat }: SecurityPageProps) {
  const state = useChatState();
  const workspace = state.activeWorkspace;
  const securityMode =
    workspace?.security_mode ?? state.session?.workspace.security_mode ?? 'MANAGED';
  const managed = securityMode === 'MANAGED';

  return (
    <PageShell title={t('security.title')} subtitle={t('security.subtitle')} onBack={onBack}>
      <section className="page-card" aria-labelledby="security-mode">
        <header className="page-card__head">
          <h2 className="page-card__title" id="security-mode">
            {t('security.mode')}
          </h2>
        </header>
        <p className="security-chip">
          <LockIcon aria-hidden="true" />
          {managed ? t('security.managed') : t('security.e2ee')}
        </p>
        <p className="page-card__hint">
          {managed ? t('security.managedHint') : t('security.e2eeHint')}
        </p>
      </section>

      <section className="page-card page-card--empty" aria-labelledby="security-state">
        <span className="empty-panel__icon" aria-hidden="true">
          <ShieldIcon />
        </span>
        <h2 className="page-card__title" id="security-state">
          {t('security.emptyTitle')}
        </h2>
        <p className="page-card__hint">{t('security.emptyText')}</p>
        <div className="disabled-row" aria-disabled="true">
          <span>{t('security.dlp')}</span>
          <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
        </div>
        <div className="disabled-row" aria-disabled="true">
          <span>{t('security.audit')}</span>
          <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
        </div>
        <button type="button" className="button button--secondary" onClick={onOpenChat}>
          {t('page.backToChat')}
        </button>
      </section>
    </PageShell>
  );
}
