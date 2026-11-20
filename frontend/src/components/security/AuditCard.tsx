import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { AuditExportFormat } from '../../api/types';
import { t } from '../../i18n/ru';
import { shortId } from '../../security/model';
import { downloadBlob } from '../../security/download';
import { securityErrorMessage } from '../../security/errors';
import type { AuditFilters } from '../../security/securityStore';
import { useSecurityState, useSecurityStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { DownloadIcon, RefreshIcon } from '../Icons';
import { ErrorDetails } from '../ErrorDetails';
import { SectionEmpty, SectionError, SectionLoading, SectionPagination } from './SecurityUi';

function filterErrorText(error: ApiError): string {
  const field = error.details?.field;
  if (field === 'action') return t('security.audit.filterErrorAction');
  if (field === 'actor_id') return t('security.audit.filterErrorActor');
  if (field === 'from' || field === 'to') return t('security.audit.filterErrorRange');
  return t('security.error.validation');
}

/**
 * Workspace audit page + bounded export.
 *
 * The filter form validates locally (UUID/range/length) and only then starts a
 * new opaque-cursor chain. Export is a Blob download straight from the API; the
 * truncation notice comes from `X-Export-Truncated`, so the UI never claims a
 * complete export when the server capped it at 10 000 rows.
 */
export function AuditCard() {
  const store = useSecurityStore();
  const { audit } = useSecurityState();
  const actionId = useId();
  const actorId = useId();
  const fromId = useId();
  const toId = useId();
  const [draft, setDraft] = useState<AuditFilters>(audit.filters);

  // A workspace switch resets the applied filters in the store; mirror them.
  useEffect(() => {
    setDraft(audit.filters);
  }, [audit.filters]);
  const hasFilter =
    audit.filters.action !== '' ||
    audit.filters.actorId !== '' ||
    audit.filters.from !== '' ||
    audit.filters.to !== '';
  const loaded = audit.status === 'ready';
  const exporting = audit.exportStatus === 'exporting';

  const apply = (event: FormEvent) => {
    event.preventDefault();
    store.applyAuditFilters(draft);
  };

  const reset = () => {
    setDraft({ action: '', actorId: '', from: '', to: '' });
    store.clearAuditFilters();
  };

  const exportAudit = async (format: AuditExportFormat) => {
    const result = await store.exportAudit(format);
    if (!result) return;
    downloadBlob(result.blob, result.filename, format);
  };

  return (
    <section className="card card--wide" aria-labelledby="security-audit">
      <div className="card-head">
        <h2 className="card-title" id="security-audit">
          {t('security.audit.title')}
        </h2>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void store.loadAudit(true)}
          disabled={audit.status === 'loading'}
        >
          <RefreshIcon aria-hidden="true" />
          {t('security.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('security.audit.lead')}</p>

      <form className="sec-filters sec-filters--audit" onSubmit={apply} noValidate>
        <div className="form-row">
          <label htmlFor={actionId}>{t('security.audit.filterAction')}</label>
          <input
            id={actionId}
            className="input mono"
            value={draft.action}
            maxLength={120}
            placeholder={t('security.audit.filterActionPlaceholder')}
            onChange={(event) =>
              setDraft((current) => ({ ...current, action: event.target.value }))
            }
          />
        </div>
        <div className="form-row">
          <label htmlFor={actorId}>{t('security.audit.filterActor')}</label>
          <input
            id={actorId}
            className="input mono"
            value={draft.actorId}
            placeholder={t('security.audit.filterActorPlaceholder')}
            onChange={(event) =>
              setDraft((current) => ({ ...current, actorId: event.target.value }))
            }
          />
        </div>
        <div className="form-row">
          <label htmlFor={fromId}>{t('security.audit.filterFrom')}</label>
          <input
            id={fromId}
            type="datetime-local"
            className="input"
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
        </div>
        <div className="form-row">
          <label htmlFor={toId}>{t('security.audit.filterTo')}</label>
          <input
            id={toId}
            type="datetime-local"
            className="input"
            value={draft.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
        <div className="sec-filter-actions">
          <button type="submit" className="btn btn--sm btn--accent">
            {t('security.audit.apply')}
          </button>
          <button type="button" className="btn btn--sm" onClick={reset}>
            {t('security.audit.reset')}
          </button>
        </div>
      </form>

      {audit.filterError ? (
        <div className="pg-inline-error" role="alert">
          <p>{filterErrorText(audit.filterError)}</p>
        </div>
      ) : null}

      <div className="sec-export">
        <div className="sec-head-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void exportAudit('csv')}
            disabled={exporting || audit.filterError !== null}
          >
            <DownloadIcon aria-hidden="true" />
            {exporting && audit.exportFormat === 'csv'
              ? t('security.audit.exporting')
              : t('security.audit.exportCsv')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void exportAudit('json')}
            disabled={exporting || audit.filterError !== null}
          >
            <DownloadIcon aria-hidden="true" />
            {exporting && audit.exportFormat === 'json'
              ? t('security.audit.exporting')
              : t('security.audit.exportJson')}
          </button>
        </div>
        <p className="pg-footnote">{t('security.audit.exportHint')}</p>
      </div>

      {audit.exportStatus === 'done' ? (
        <div className="sec-notice" role="status" aria-live="polite">
          <p>
            {audit.exportRows === null
              ? t('security.audit.exportDoneUnknown')
              : t('security.audit.exportDone', { count: audit.exportRows })}
          </p>
        </div>
      ) : null}

      {audit.exportStatus === 'done' && audit.exportTruncated ? (
        <div className="sec-notice sec-notice--warning" role="alert">
          <p>{t('security.audit.exportTruncated')}</p>
        </div>
      ) : null}

      {audit.exportStatus === 'error' && audit.exportError ? (
        <div className="pg-inline-error" role="alert">
          <div>
            <p>{securityErrorMessage(audit.exportError, 'security.audit.exportError')}</p>
            <ErrorDetails error={audit.exportError} />
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void exportAudit(audit.exportFormat === 'json' ? 'json' : 'csv')}
          >
            {t('security.audit.retry')}
          </button>
        </div>
      ) : null}

      {audit.status === 'loading' && !loaded ? (
        <SectionLoading label={t('security.audit.loading')} />
      ) : null}

      {audit.error ? (
        <SectionError
          text={t('security.audit.error')}
          error={audit.error}
          onRetry={() => void store.loadAudit(true)}
          retryLabel={t('security.audit.retry')}
        />
      ) : null}

      {loaded && audit.items.length === 0 ? (
        <SectionEmpty
          title={t(hasFilter ? 'security.audit.noMatchesTitle' : 'security.audit.emptyTitle')}
          text={t(hasFilter ? 'security.audit.noMatchesText' : 'security.audit.emptyText')}
        >
          {hasFilter ? (
            <button type="button" className="btn btn--sm" onClick={reset}>
              {t('security.audit.reset')}
            </button>
          ) : null}
        </SectionEmpty>
      ) : null}

      {audit.items.length > 0 ? (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <caption className="visually-hidden">{t('security.audit.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('security.audit.column.time')}</th>
                <th scope="col">{t('security.audit.column.action')}</th>
                <th scope="col">{t('security.audit.column.actor')}</th>
                <th scope="col">{t('security.audit.column.target')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                  </td>
                  <td>
                    <code className="sec-action">{event.action}</code>
                  </td>
                  <td>
                    {event.actor_id ? (
                      <code title={event.actor_id} aria-label={event.actor_id}>
                        {shortId(event.actor_id)}
                      </code>
                    ) : (
                      <span className="muted">{t('security.audit.systemActor')}</span>
                    )}
                  </td>
                  <td>
                    {event.target_type ? (
                      <>
                        <span>{event.target_type}</span>
                        {event.target_id ? (
                          <code
                            className="sec-cell-meta"
                            title={event.target_id}
                            aria-label={event.target_id}
                          >
                            {shortId(event.target_id)}
                          </code>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">{t('security.audit.noTarget')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <SectionPagination
        hasMore={audit.hasMore}
        loadingMore={audit.loadingMore}
        moreError={audit.moreError}
        onLoadMore={() => void store.loadMoreAudit()}
        loadMoreLabel={t('security.audit.loadMore')}
        loadingLabel={t('security.audit.loadingMore')}
        errorLabel={t('security.audit.loadMoreError')}
      />
    </section>
  );
}
