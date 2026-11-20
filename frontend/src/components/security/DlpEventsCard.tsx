import { useId } from 'react';
import type { DlpAction } from '../../api/types';
import { t } from '../../i18n/ru';
import { shortId } from '../../security/model';
import { useSecurityState, useSecurityStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { RefreshIcon } from '../Icons';
import { SectionEmpty, SectionError, SectionLoading, SectionPagination } from './SecurityUi';

const ACTIONS: ReadonlyArray<{ value: 'ALL' | DlpAction; label: string }> = [
  { value: 'ALL', label: t('security.events.allActions') },
  { value: 'WARN', label: t('security.dlp.action.WARN') },
  { value: 'BLOCK', label: t('security.dlp.action.BLOCK') },
];

/**
 * Content-free DLP journal. Rows render only the contract fields, so message
 * text, attachments, emails and IP addresses cannot appear here even if the
 * server changed (they are not part of `DlpEvent`).
 */
export function DlpEventsCard() {
  const store = useSecurityStore();
  const { events, policies } = useSecurityState();
  const policyFilterId = useId();
  const actionFilterId = useId();
  const hasFilter = events.policyId !== '' || events.action !== 'ALL';
  const loaded = events.status === 'ready';

  return (
    <section className="card card--wide" aria-labelledby="security-dlp-events">
      <div className="card-head">
        <h2 className="card-title" id="security-dlp-events">
          {t('security.events.title')}
        </h2>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void store.loadEvents(true)}
          disabled={events.status === 'loading'}
        >
          <RefreshIcon aria-hidden="true" />
          {t('security.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('security.events.lead')}</p>
      <p className="pg-footnote">{t('security.events.privacy')}</p>

      <div className="sec-filters">
        <div className="form-row">
          <label htmlFor={policyFilterId}>{t('security.events.filterPolicy')}</label>
          <select
            id={policyFilterId}
            className="select"
            value={events.policyId}
            onChange={(event) => store.setEventsPolicy(event.target.value)}
          >
            <option value="">{t('security.events.allPolicies')}</option>
            {policies.items.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor={actionFilterId}>{t('security.events.filterAction')}</label>
          <select
            id={actionFilterId}
            className="select"
            value={events.action}
            onChange={(event) => store.setEventsAction(event.target.value as 'ALL' | DlpAction)}
          >
            {ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {hasFilter ? (
          <button
            type="button"
            className="btn btn--sm sec-clear-filter"
            onClick={() => store.resetEventFilters()}
          >
            {t('security.audit.reset')}
          </button>
        ) : null}
      </div>

      {events.status === 'loading' && !loaded ? (
        <SectionLoading label={t('security.events.loading')} />
      ) : null}

      {events.error ? (
        <SectionError
          text={t('security.events.error')}
          error={events.error}
          onRetry={() => void store.loadEvents(true)}
          retryLabel={t('security.events.retry')}
        />
      ) : null}

      {loaded && events.items.length === 0 ? (
        <SectionEmpty
          title={t(hasFilter ? 'security.events.noMatchesTitle' : 'security.events.emptyTitle')}
          text={t(hasFilter ? 'security.events.noMatchesText' : 'security.events.emptyText')}
        />
      ) : null}

      {events.items.length > 0 ? (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <caption className="visually-hidden">{t('security.events.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('security.events.column.time')}</th>
                <th scope="col">{t('security.events.column.rule')}</th>
                <th scope="col">{t('security.events.column.action')}</th>
                <th scope="col">{t('security.events.column.actor')}</th>
                <th scope="col">{t('security.events.column.chat')}</th>
              </tr>
            </thead>
            <tbody>
              {events.items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                  </td>
                  <td>
                    <b>{event.policy_name}</b>
                    {event.policy_id === null ? (
                      <small className="sec-cell-meta">{t('security.dlp.ruleDeleted')}</small>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`chip ${event.action === 'BLOCK' ? 'chip--danger' : 'chip--warn'}`}
                    >
                      {event.action}
                    </span>
                  </td>
                  <td>
                    {event.actor_id ? (
                      <code title={event.actor_id} aria-label={event.actor_id}>
                        {shortId(event.actor_id)}
                      </code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {event.chat_id ? (
                      <code title={event.chat_id} aria-label={event.chat_id}>
                        {shortId(event.chat_id)}
                      </code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <SectionPagination
        hasMore={events.hasMore}
        loadingMore={events.loadingMore}
        moreError={events.moreError}
        onLoadMore={() => void store.loadMoreEvents()}
        loadMoreLabel={t('security.events.loadMore')}
        loadingLabel={t('security.events.loadingMore')}
        errorLabel={t('security.events.loadMoreError')}
      />
    </section>
  );
}
