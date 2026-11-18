import { useMemo, useState } from 'react';
import { describeError } from '../../domain/errors';
import { formatBytes } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import { useChatState, useFilesState, useFilesStore } from '../../store/ChatProvider';
import { PageShell } from './PageShell';
import {
  collectFiles,
  fileName,
  fileKind,
  fileKindLabel,
  storagePercent,
  storageUsed,
  storageLimit,
  tariffLabel,
  type FileKind,
} from './pageData';

type Filter = 'all' | FileKind;

const FILTERS: ReadonlyArray<{ id: Filter; label: MessageKey }> = [
  { id: 'all', label: 'files.filter.all' },
  { id: 'image', label: 'files.filter.image' },
  { id: 'doc', label: 'files.filter.doc' },
  { id: 'audio', label: 'files.filter.audio' },
  { id: 'video', label: 'files.filter.video' },
];

interface FilesPageProps {
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
}

/**
 * D1-FE1: managed files surface. There is no `GET /files` in the contract yet,
 * so the page only shows attachments already present in loaded messages plus
 * upload limits from `/workspaces/{id}/limits`. No invented file list.
 */
export function FilesPage({ onBack, onOpenChat }: FilesPageProps) {
  const state = useChatState();
  const filesStore = useFilesStore();
  const filesState = useFilesState();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const allFiles = useMemo(() => collectFiles(state), [state]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFiles = allFiles.filter((entry) => {
    const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
    if (filter !== 'all' && kind !== filter) return false;
    if (!normalizedQuery) return true;
    const name = (entry.attachment.filename ?? '').toLowerCase();
    return name.includes(normalizedQuery) || entry.chatName.toLowerCase().includes(normalizedQuery);
  });

  const limits = filesState.limits ?? state.chatLimits;
  const limitsError = filesState.limitsStatus === 'error' ? filesState.limitsError : null;
  const error = limitsError ? describeError(limitsError) : null;
  const percent = storagePercent(limits);

  return (
    <PageShell
      title={t('files.title')}
      subtitle={t('files.subtitle')}
      onBack={onBack}
      actions={
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void filesStore.refreshLimits()}
        >
          {t('files.refresh')}
        </button>
      }
    >
      {error ? (
        <section className="page-card page-card--error" role="alert">
          <h2 className="page-card__title">{t('files.limitsErrorTitle')}</h2>
          <p className="page-card__hint">{error.message}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void filesStore.refreshLimits()}
          >
            {t('files.retryLimits')}
          </button>
        </section>
      ) : null}

      <section className="page-card" aria-labelledby="files-quota">
        <header className="page-card__head">
          <h2 className="page-card__title" id="files-quota">
            {t('limits.title')}
          </h2>
          <span className="page-card__meta">
            {limits ? tariffLabel(limits.tariff) : t('common.loading')}
          </span>
        </header>
        <div
          className="storage-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('overview.storageUsage', { percent })}
        >
          <span className="storage-bar__fill" style={{ width: `${percent}%` }} />
        </div>
        <dl className="limit-list">
          <div className="limit-list__row">
            <dt>{t('limits.usageLabel')}</dt>
            <dd>{limits ? `${storageUsed(limits)} / ${storageLimit(limits)}` : '—'}</dd>
          </div>
          <div className="limit-list__row">
            <dt>
              {t('limits.maxFile', { size: limits ? formatBytes(limits.max_file_bytes) : '—' })}
            </dt>
            <dd>{limits ? formatBytes(limits.max_file_bytes) : '—'}</dd>
          </div>
          <div className="limit-list__row">
            <dt>{t('limits.maxAttachments', { count: limits ? limits.max_attachments : '—' })}</dt>
            <dd>{limits ? limits.max_attachments : '—'}</dd>
          </div>
          <div className="limit-list__row">
            <dt>
              {t('limits.guest', { size: limits ? formatBytes(limits.guest_file_bytes) : '—' })}
            </dt>
            <dd>{limits ? formatBytes(limits.guest_file_bytes) : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="page-card" aria-labelledby="files-list-title">
        <header className="page-card__head">
          <h2 className="page-card__title" id="files-list-title">
            {t('files.attachments')}
          </h2>
          <span className="page-card__meta" aria-live="polite">
            {t('files.count', { count: visibleFiles.length })}
          </span>
        </header>

        <div className="files-toolbar">
          <label className="field files-search">
            <span className="field__label">{t('files.searchLabel')}</span>
            <input
              className="input"
              type="search"
              value={query}
              placeholder={t('files.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="filter-group" role="group" aria-label={t('files.filters')}>
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`filter-chip${filter === item.id ? ' filter-chip--active' : ''}`}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </div>

        {allFiles.length === 0 ? (
          <div className="empty-panel" role="status">
            <strong>{t('files.emptyTitle')}</strong>
            <p>{t('files.emptyText')}</p>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-panel" role="status">
            <strong>{t('files.noMatchesTitle')}</strong>
            <p>{t('files.noMatchesText')}</p>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              {t('files.resetFilters')}
            </button>
          </div>
        ) : (
          <ul className="file-rows">
            {visibleFiles.map((entry) => {
              const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
              return (
                <li key={entry.attachment.id} className="file-row">
                  <span className={`file-row__kind file-row__kind--${kind}`} aria-hidden="true">
                    {fileKindLabel(kind)}
                  </span>
                  <span className="file-row__name">{fileName(entry.attachment)}</span>
                  <span className="file-row__chat">{entry.chatName}</span>
                  <span className="file-row__size">{formatBytes(entry.attachment.size_bytes)}</span>
                  <span className="file-row__scan">
                    {t(`files.scanStatus.${entry.attachment.scan_status}`)}
                  </span>
                  <button
                    type="button"
                    className="link-button file-row__open"
                    onClick={() => onOpenChat(entry.chatId)}
                  >
                    {t('files.openChat')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PageShell>
  );
}
