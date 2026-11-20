import { useEffect, useId } from 'react';
import type { AdminAuditExportFormat } from '../../api/types';
import { t, type MessageKey } from '../../i18n/ru';
import { downloadBlob } from '../../security/download';
import { useAdminDirectoryState, useAdminDirectoryStore } from '../../store/ChatProvider';
import { AdminEmptyState, AdminErrorState, AdminListCount, AdminSkeleton } from './AdminStates';
import { ErrorDetails } from '../ErrorDetails';
import { AdminCell, AdminRow, AdminRowsHead } from './AdminListParts';
import {
  KNOWN_AUDIT_ACTIONS,
  auditActionLabelKey,
  auditActor,
  auditTargetLabelKey,
  shortId,
} from './adminAudit';
import { formatDateTime } from './format';

const COLUMNS: MessageKey[] = [
  'admin.audit.column.time',
  'admin.audit.column.action',
  'admin.audit.column.actor',
  'admin.audit.column.target',
];

/**
 * `/admin?tab=audit` (FR-ADM-17).
 *
 * Renders exactly the seven fields of `AdminAuditEvent`: time, action, actor
 * (email/id) and target (type/id). The contract has no `metadata`, hash-chain
 * or `request_id` fields, and none are invented here — message bodies, file
 * names and secrets therefore cannot appear in this view.
 */
export function AdminAuditSection() {
  const store = useAdminDirectoryStore();
  const { audit } = useAdminDirectoryState();
  const filterId = useId();
  const filterHintId = useId();

  useEffect(() => {
    void store.loadAudit();
  }, [store]);

  const showSkeleton = audit.status === 'loading' && audit.items.length === 0;
  const forbidden = audit.error?.status === 403;
  const hasFilter = audit.action.length > 0;
  const exporting = audit.exportStatus === 'exporting';

  const exportAudit = async (format: AdminAuditExportFormat) => {
    const result = await store.exportAudit(format);
    if (!result) return;
    downloadBlob(result.blob, result.filename, format);
  };

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-audit-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-audit-title">
            {t('admin.audit.title')}
          </h2>
          <p className="admin-card__lead">{t('admin.audit.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadAudit({ force: true })}
          disabled={audit.status === 'loading'}
        >
          {t('admin.refresh')}
        </button>
      </div>

      <div className="admin-toolbar admin-toolbar--audit">
        <div className="field">
          <label className="field__label" htmlFor={filterId}>
            {t('admin.audit.filter')}
          </label>
          <select
            id={filterId}
            className="field__input admin-select"
            value={audit.action}
            aria-describedby={filterHintId}
            onChange={(event) => store.setAuditAction(event.target.value)}
          >
            <option value="">{t('admin.audit.filterAll')}</option>
            {KNOWN_AUDIT_ACTIONS.map((action) => {
              const key = auditActionLabelKey(action);
              return (
                <option key={action} value={action}>
                  {key ? `${t(key)} (${action})` : action}
                </option>
              );
            })}
          </select>
          <p className="field__meta" id={filterHintId}>
            {t('admin.audit.filterHint')}
          </p>
        </div>
        {hasFilter ? (
          <button
            type="button"
            className="button button--ghost admin-toolbar__action"
            onClick={() => store.setAuditAction('')}
          >
            {t('admin.users.clear')}
          </button>
        ) : null}
      </div>

      <p className="admin-card__hint">{t('admin.audit.metadataHint')}</p>

      <div className="admin-toolbar admin-toolbar--audit">
        <div>
          <p className="admin-card__hint">{t('admin.audit.exportHint')}</p>
        </div>
        <div className="admin-toolbar__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void exportAudit('csv')}
            disabled={exporting}
          >
            {exporting && audit.exportFormat === 'csv'
              ? t('admin.audit.exporting')
              : t('admin.audit.exportCsv')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void exportAudit('json')}
            disabled={exporting}
          >
            {exporting && audit.exportFormat === 'json'
              ? t('admin.audit.exporting')
              : t('admin.audit.exportJson')}
          </button>
        </div>
      </div>

      {audit.exportStatus === 'done' ? (
        <p className="admin-notice admin-notice--ok" role="status" aria-live="polite">
          {audit.exportRows === null
            ? t('admin.audit.exportDoneUnknown')
            : t('admin.audit.exportDone', { count: audit.exportRows })}
        </p>
      ) : null}

      {audit.exportStatus === 'done' && audit.exportTruncated ? (
        <p className="admin-notice admin-notice--warning" role="alert">
          {t('admin.audit.exportTruncated')}
        </p>
      ) : null}

      {audit.exportStatus === 'error' && audit.exportError ? (
        <div className="admin-state admin-state--error" role="alert">
          <div className="admin-state__body">
            <p>{t('admin.audit.exportError')}</p>
            <ErrorDetails error={audit.exportError} />
          </div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void exportAudit(audit.exportFormat ?? 'csv')}
          >
            {t('admin.audit.exportRetry')}
          </button>
        </div>
      ) : null}

      {showSkeleton ? <AdminSkeleton label={t('admin.audit.loading')} /> : null}

      {audit.status === 'error' && audit.items.length > 0 ? (
        <div className="admin-state admin-state--error" role="alert">
          <p>{forbidden ? t('admin.forbidden.text') : t('admin.audit.error')}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void store.loadAudit({ force: true })}
          >
            {t('admin.audit.retry')}
          </button>
        </div>
      ) : null}

      {audit.status === 'error' && audit.items.length === 0 ? (
        <AdminErrorState
          text={forbidden ? t('admin.forbidden.text') : t('admin.audit.error')}
          error={audit.error}
          retryLabel={t('admin.audit.retry')}
          onRetry={() => void store.loadAudit({ force: true })}
        />
      ) : null}

      {audit.status === 'ready' && audit.items.length === 0 ? (
        <AdminEmptyState
          title={t(hasFilter ? 'admin.audit.emptyTitle' : 'admin.audit.emptyAllTitle')}
          text={t(hasFilter ? 'admin.audit.emptyText' : 'admin.audit.emptyAllText')}
        />
      ) : null}

      {audit.items.length > 0 ? (
        <>
          <AdminListCount label={t('admin.audit.count', { count: audit.items.length })} />
          <div className="admin-rows admin-rows--audit">
            <AdminRowsHead labels={COLUMNS.map((key) => t(key))} />
            <ul className="admin-rows__items">
              {audit.items.map((event) => {
                const actionKey = auditActionLabelKey(event.action);
                const targetKey =
                  event.target_type === null ? null : auditTargetLabelKey(event.target_type);
                const actor = auditActor(event);
                return (
                  <AdminRow key={event.id}>
                    <AdminCell label={t('admin.audit.column.time')} primary>
                      <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                    </AdminCell>
                    <AdminCell label={t('admin.audit.column.action')}>
                      <span className="admin-cell__strong">
                        {actionKey ? t(actionKey) : event.action}
                      </span>
                      <code className="admin-cell__code" title={event.action}>
                        {event.action}
                      </code>
                    </AdminCell>
                    <AdminCell label={t('admin.audit.column.actor')}>
                      {actor.isSystem ? (
                        <span className="admin-cell__muted">{t('admin.audit.systemActor')}</span>
                      ) : (
                        <>
                          <span className="admin-cell__strong">
                            {actor.email ?? t('admin.audit.unknownActor')}
                          </span>
                          {actor.id ? (
                            <code
                              className="admin-cell__code"
                              title={actor.id}
                              aria-label={actor.id}
                            >
                              {shortId(actor.id)}
                            </code>
                          ) : null}
                        </>
                      )}
                    </AdminCell>
                    <AdminCell label={t('admin.audit.column.target')}>
                      {event.target_type === null ? (
                        <span className="admin-cell__muted">{t('admin.audit.noTarget')}</span>
                      ) : (
                        <>
                          <span>{targetKey ? t(targetKey) : event.target_type}</span>
                          {event.target_id ? (
                            <code
                              className="admin-cell__code"
                              title={event.target_id}
                              aria-label={event.target_id}
                            >
                              {shortId(event.target_id)}
                            </code>
                          ) : null}
                        </>
                      )}
                    </AdminCell>
                  </AdminRow>
                );
              })}
            </ul>
          </div>

          {audit.moreError ? (
            <div className="admin-more">
              <p className="admin-state admin-state--error-inline" role="alert">
                {t('admin.audit.loadMoreError')}
              </p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreAudit()}
              >
                {t('admin.audit.retry')}
              </button>
            </div>
          ) : audit.hasMore ? (
            <div className="admin-more">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreAudit()}
                disabled={audit.loadingMore}
              >
                {t(audit.loadingMore ? 'admin.audit.loadingMore' : 'admin.audit.loadMore')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
