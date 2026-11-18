import { t } from '../../i18n/ru';
import { PlugIcon, ShieldIcon } from '../Icons';
import { PageShell } from './PageShell';

interface SimplePageProps {
  onBack: () => void;
  onOpenChat: () => void;
}

/**
 * D1-FE1 / D1.1: the plugin catalog needs a server API that does not exist in
 * this contract. The page is intentionally honest: no fake catalog and no
 * toggles that cannot persist.
 */
export function PluginsPage({ onBack, onOpenChat }: SimplePageProps) {
  return (
    <PageShell title={t('plugins.title')} subtitle={t('plugins.subtitle')} onBack={onBack}>
      <section className="page-card page-card--empty" aria-labelledby="plugins-state">
        <span className="empty-panel__icon" aria-hidden="true">
          <PlugIcon />
        </span>
        <h2 className="page-card__title" id="plugins-state">
          {t('plugins.emptyTitle')}
        </h2>
        <p className="page-card__hint">{t('plugins.emptyText')}</p>
        <div className="disabled-row" aria-disabled="true">
          <span>{t('plugins.catalog')}</span>
          <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
        </div>
        <div className="disabled-row" aria-disabled="true">
          <span>{t('plugins.permissions')}</span>
          <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
        </div>
        <button type="button" className="button button--secondary" onClick={onOpenChat}>
          <ShieldIcon aria-hidden="true" />
          {t('page.backToChat')}
        </button>
      </section>
    </PageShell>
  );
}
