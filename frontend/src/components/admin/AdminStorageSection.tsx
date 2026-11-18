import { useEffect } from 'react';
import { formatBytes } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import { useAdminDirectoryState, useAdminDirectoryStore } from '../../store/ChatProvider';
import { AdminEmptyState, AdminErrorState, AdminSkeleton } from './AdminStates';
import { AdminCell, AdminRow, AdminRowsHead } from './AdminListParts';
import { formatCount, limitPercent } from './format';

const COLUMNS: MessageKey[] = [
  'admin.storage.column.workspace',
  'admin.storage.column.used',
  'admin.storage.column.reserved',
  'admin.storage.column.objects',
  'admin.storage.column.attachments',
  'admin.storage.column.limit',
];

/**
 * `/admin?tab=storage` (FR-ADM-12). Aggregates only: used/reserved bytes,
 * stored objects and attachment records per workspace. No cursor: the endpoint
 * returns one row per undeleted workspace (documented trade-off).
 */
export function AdminStorageSection() {
  const store = useAdminDirectoryStore();
  const { storage } = useAdminDirectoryState();
  const data = storage.data;
  const forbidden = storage.error?.status === 403;

  useEffect(() => {
    void store.loadStorage();
  }, [store]);

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-storage-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-storage-title">
            {t('admin.storage.title')}
          </h2>
          <p className="admin-card__lead">{t('admin.storage.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadStorage({ force: true })}
          disabled={storage.status === 'loading'}
        >
          {t(storage.data ? 'admin.storage.refresh' : 'admin.refresh')}
        </button>
      </div>

      {storage.status === 'loading' && !data ? (
        <AdminSkeleton label={t('admin.storage.loading')} rows={3} />
      ) : null}

      {storage.status === 'error' && !data ? (
        <AdminErrorState
          text={forbidden ? t('admin.forbidden.text') : t('admin.storage.error')}
          error={storage.error}
          retryLabel={t('admin.storage.retry')}
          onRetry={() => void store.loadStorage({ force: true })}
        />
      ) : null}

      {storage.status === 'error' && data ? (
        <AdminErrorState
          text={forbidden ? t('admin.forbidden.text') : t('admin.storage.error')}
          error={storage.error}
          retryLabel={t('admin.storage.retry')}
          onRetry={() => void store.loadStorage({ force: true })}
        />
      ) : null}

      {data ? (
        <>
          <div role="group" aria-label={t('admin.storage.totalsLabel')}>
            <dl className="admin-stats admin-stats--storage">
              <div className="admin-stat">
                <dt>{t('admin.storage.used')}</dt>
                <dd>{formatBytes(data.totals.used_bytes)}</dd>
              </div>
              <div className="admin-stat">
                <dt>{t('admin.storage.reserved')}</dt>
                <dd>{formatBytes(data.totals.reserved_bytes)}</dd>
              </div>
              <div className="admin-stat">
                <dt>{t('admin.storage.objects')}</dt>
                <dd>{formatCount(data.totals.objects)}</dd>
              </div>
              <div className="admin-stat">
                <dt>{t('admin.storage.attachments')}</dt>
                <dd>{formatCount(data.totals.attachments)}</dd>
              </div>
            </dl>
          </div>
          <p className="admin-card__hint">{t('admin.storage.totalsHint')}</p>

          {data.workspaces.length === 0 ? (
            <AdminEmptyState
              title={t('admin.storage.emptyTitle')}
              text={t('admin.storage.emptyText')}
            />
          ) : (
            <div className="admin-rows admin-rows--storage">
              <AdminRowsHead labels={COLUMNS.map((key) => t(key))} />
              <ul className="admin-rows__items">
                {data.workspaces.map((row) => {
                  const percent = limitPercent(row.used_bytes, row.storage_limit_bytes);
                  return (
                    <AdminRow key={row.workspace_id}>
                      <AdminCell label={t('admin.storage.column.workspace')} primary>
                        <span className="admin-cell__strong">{row.workspace_name}</span>
                        <span className="admin-cell__sub">
                          {t(row.security_mode === 'E2EE' ? 'chat.e2ee' : 'chat.managed')}
                        </span>
                      </AdminCell>
                      <AdminCell label={t('admin.storage.column.used')}>
                        {formatBytes(row.used_bytes)}
                      </AdminCell>
                      <AdminCell label={t('admin.storage.column.reserved')}>
                        {formatBytes(row.reserved_bytes)}
                      </AdminCell>
                      <AdminCell label={t('admin.storage.column.objects')}>
                        {formatCount(row.objects)}
                      </AdminCell>
                      <AdminCell label={t('admin.storage.column.attachments')}>
                        {formatCount(row.attachments)}
                      </AdminCell>
                      <AdminCell
                        label={t('admin.storage.column.limit')}
                        className="admin-cell--limit"
                      >
                        {percent === null ? (
                          <span className="admin-cell__muted">{t('admin.storage.noLimit')}</span>
                        ) : (
                          <span className="admin-bar__wrap">
                            <span
                              className="admin-bar"
                              role="progressbar"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={percent}
                              aria-label={t('admin.storage.limitBar', {
                                name: row.workspace_name,
                                percent,
                              })}
                            >
                              <span className="admin-bar__fill" style={{ width: `${percent}%` }} />
                            </span>
                            <span className="admin-bar__value">
                              {t('admin.storage.percent', { percent })}
                            </span>
                            <span className="admin-bar__limit">
                              {formatBytes(row.storage_limit_bytes)}
                            </span>
                          </span>
                        )}
                      </AdminCell>
                    </AdminRow>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="admin-card__hint">{t('admin.storage.noPagination')}</p>
        </>
      ) : null}
    </section>
  );
}
