import { t } from '../../i18n/ru';
import { useOpsState, useOpsStore } from '../../store/ChatProvider';
import type { AdminTab } from './tabs';

interface AdminOverviewSectionProps {
  onOpenTab: (tab: AdminTab) => void;
}

/**
 * `/admin` overview (default tab): installation-wide counters and quick links.
 * Aggregates only — `/admin/overview` has no per-user data.
 */
export function AdminOverviewSection({ onOpenTab }: AdminOverviewSectionProps) {
  const store = useOpsStore();
  const ops = useOpsState();
  const overview = ops.overview;
  const loading = !overview && (ops.overviewStatus === 'idle' || ops.overviewStatus === 'loading');
  const forbidden = ops.overviewError?.status === 403;

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-overview-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-overview-title">
            {t('admin.overviewSection')}
          </h2>
          <p className="admin-card__lead">{t('admin.overview.auditNote')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadOverview(true)}
          disabled={ops.overviewStatus === 'loading'}
        >
          {t('admin.overview.retry')}
        </button>
      </div>

      {loading ? (
        <p className="admin-state" role="status" aria-busy="true">
          {t('admin.overview.loading')}
        </p>
      ) : null}

      {!overview && ops.overviewStatus === 'error' ? (
        <div className="admin-state admin-state--error" role="alert">
          <p>{forbidden ? t('admin.forbidden.text') : t('admin.overview.error')}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void store.loadOverview(true)}
          >
            {t('admin.overview.retry')}
          </button>
        </div>
      ) : null}

      {overview ? (
        <dl className="admin-stats">
          <div className="admin-stat">
            <dt>{t('admin.overview.users')}</dt>
            <dd>{overview.users}</dd>
          </div>
          <div className="admin-stat">
            <dt>{t('admin.overview.workspaces')}</dt>
            <dd>{overview.workspaces}</dd>
          </div>
          <div className="admin-stat">
            <dt>{t('admin.overview.chats')}</dt>
            <dd>{overview.chats}</dd>
          </div>
        </dl>
      ) : null}

      <div className="admin-quicklinks">
        <h3 className="admin-quicklinks__title">{t('admin.overview.quickLinks')}</h3>
        <div className="admin-quicklinks__row">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onOpenTab('users')}
          >
            {t('admin.overview.openUsers')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onOpenTab('chats')}
          >
            {t('admin.overview.openChats')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onOpenTab('storage')}
          >
            {t('admin.overview.openStorage')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onOpenTab('settings')}
          >
            {t('admin.overview.openSettings')}
          </button>
        </div>
      </div>
    </section>
  );
}
