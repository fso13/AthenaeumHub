import { useMemo, useState } from 'react';
import { describeError } from '../../domain/errors';
import { formatBytes } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import { useChatState, useFilesState, useFilesStore } from '../../store/ChatProvider';
import { ChatIcon, FolderIcon, PlusIcon, RefreshIcon, SearchIcon, ShieldIcon } from '../Icons';
import { PageShell } from './PageShell';
import {
  collectFiles,
  extensionOf,
  fileName,
  fileKind,
  fileKindLabel,
  securityModeLabel,
  shortDate,
  storageLimit,
  storagePercent,
  storageUsed,
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

const SCAN_LABEL: Record<string, MessageKey> = {
  PENDING: 'files.scanStatus.PENDING',
  CLEAN: 'files.scanStatus.CLEAN',
  INFECTED: 'files.scanStatus.INFECTED',
  FAILED: 'files.scanStatus.FAILED',
  SKIPPED: 'files.scanStatus.SKIPPED',
};

interface FilesPageProps {
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
}

/**
 * D1 UX fidelity 2: managed files surface. There is no `GET /files` in the
 * contract, so the table only shows attachments already present in loaded
 * messages plus upload limits from `/workspaces/{id}/limits`. Nothing invented.
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
  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const mode =
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    ('MANAGED' as const);
  const hasFilters = query.trim().length > 0 || filter !== 'all';

  return (
    <PageShell
      title={t('files.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(mode)}`}
      onBack={onBack}
      actions={
        <>
          <button
            type="button"
            className="btn btn--accent"
            disabled
            aria-label={t('files.upload')}
            title={t('files.uploadHint')}
          >
            <PlusIcon aria-hidden="true" />
            <span>{t('files.upload')}</span>
          </button>
          <button
            type="button"
            className="btn page-action--secondary"
            onClick={() => void filesStore.refreshLimits()}
            aria-label={t('files.refresh')}
            title={t('files.refresh')}
          >
            <RefreshIcon aria-hidden="true" />
            <span>{t('files.refreshShort')}</span>
          </button>
        </>
      }
    >
      {error ? (
        <section className="card pg-error" role="alert">
          <div>
            <h2 className="card-title">{t('files.limitsErrorTitle')}</h2>
            <p className="card-empty">{error.message}</p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void filesStore.refreshLimits()}
          >
            <RefreshIcon aria-hidden="true" />
            {t('files.retryLimits')}
          </button>
        </section>
      ) : null}

      <div className="page-tools">
        <div className="tab-pills" role="group" aria-label={t('files.filters')}>
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tab-pill${filter === item.id ? ' is-active' : ''}`}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <label className="page-search">
          <SearchIcon aria-hidden="true" />
          <span className="visually-hidden">{t('files.searchLabel')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('files.searchPlaceholder')}
            aria-label={t('files.searchLabel')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="files-count" aria-live="polite">
          {t('files.count', { count: visibleFiles.length })}
        </span>
      </div>

      <section className="card files-summary" aria-labelledby="files-summary-title">
        <span className="stat-ic" aria-hidden="true">
          <FolderIcon />
        </span>
        <div className="grow">
          <b id="files-summary-title">
            {limits
              ? t('files.storageSummary', {
                  used: storageUsed(limits),
                  limit: storageLimit(limits),
                })
              : t('files.limitsPending')}
          </b>
          <small>
            {limits
              ? t('files.storageHint', {
                  count: allFiles.length,
                  tariff: tariffLabel(limits.tariff),
                })
              : t('overview.limitsUnavailable')}
          </small>
          {limits ? (
            <div
              className="meter"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={t('overview.storageUsage', { percent })}
            >
              <i style={{ width: `${percent}%` }} />
            </div>
          ) : null}
        </div>
        {limits ? (
          <div className="limits">
            <span className="limit">
              {t('overview.storageLimitGuest', { size: formatBytes(limits.guest_file_bytes) })}
            </span>
            <span className="limit is-current">
              {t('overview.storageLimitFile', { size: formatBytes(limits.max_file_bytes) })}
            </span>
            <span className="limit">
              {t('overview.storageLimitCount', { count: limits.max_attachments })}
            </span>
          </div>
        ) : null}
      </section>

      <div className="files-table">
        <div className="file-head">
          <span aria-hidden="true" />
          <span>{t('files.column.name')}</span>
          <span>{t('files.column.chat')}</span>
          <span>{t('files.column.size')}</span>
          <span>{t('files.column.type')}</span>
          <span>{t('files.column.status')}</span>
          <span aria-hidden="true" />
        </div>

        {allFiles.length === 0 ? (
          <div className="file-empty" role="status">
            <FolderIcon aria-hidden="true" />
            <strong>{t('files.emptyTitle')}</strong>
            <p>{t('files.emptyText')}</p>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="file-empty" role="status">
            <SearchIcon aria-hidden="true" />
            <strong>{t('files.noMatchesTitle')}</strong>
            <p>{t('files.noMatchesText')}</p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              {t('files.resetFilters')}
            </button>
          </div>
        ) : (
          visibleFiles.map((entry) => {
            const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
            const ext = extensionOf(entry.attachment.filename);
            const scan = entry.attachment.scan_status;
            const artwork = entry.attachment.media?.artwork_url;
            return (
              <div className="file-row" key={entry.attachment.id}>
                <span
                  className={`file-icon${artwork ? ' file-cover' : ''}`}
                  data-kind={kind}
                  aria-hidden="true"
                >
                  {artwork ? <img src={artwork} alt="" loading="lazy" /> : ext}
                </span>
                <span className="file-name">
                  <b>{fileName(entry.attachment)}</b>
                  <small>
                    {fileKindLabel(kind)} · {shortDate(entry.createdAt)}
                  </small>
                </span>
                <span className="file-chat" title={entry.chatName}>
                  {entry.chatName}
                </span>
                <span className="file-size">{formatBytes(entry.attachment.size_bytes)}</span>
                <span className="file-type">{fileKindLabel(kind)}</span>
                <span className="file-status-cell">
                  <span className={`file-status file-status--${scan.toLowerCase()}`}>
                    {t(SCAN_LABEL[scan] ?? 'files.scanStatus.SKIPPED')}
                  </span>
                </span>
                <span className="file-actions">
                  <button
                    type="button"
                    className="file-dl"
                    onClick={() => onOpenChat(entry.chatId)}
                    aria-label={`${t('files.toChat')}: ${entry.chatName}`}
                    title={t('files.toChat')}
                  >
                    <ChatIcon aria-hidden="true" />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>

      {hasFilters && visibleFiles.length > 0 ? (
        <p className="pg-footnote">
          {t('files.count', { count: visibleFiles.length })} · {t('files.filters')}
        </p>
      ) : null}

      <div className="ov-grid">
        <section className="card limits-card" aria-labelledby="files-limits">
          <div className="card-head">
            <h2 className="card-title" id="files-limits">
              {t('files.limitsTitle')}
            </h2>
            <span className="chip">{limits ? tariffLabel(limits.tariff) : '—'}</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">
              {t('files.rule.maxFile', {
                size: limits ? formatBytes(limits.max_file_bytes) : '—',
              })}
            </span>
            <span className="size">
              {limits ? formatBytes(limits.max_file_bytes) : t('files.limitsPending')}
            </span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">
              {t('limits.maxAttachments', { count: limits?.max_attachments ?? '—' })}
            </span>
            <span className="size">{limits ? limits.max_attachments : '—'}</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">
              {t('files.rule.guest', {
                size: limits ? formatBytes(limits.guest_file_bytes) : '—',
              })}
            </span>
            <span className="size">{limits ? formatBytes(limits.guest_file_bytes) : '—'}</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">{t('files.rule.storage')}</span>
            <span className="size">
              {limits ? `${storageUsed(limits)} / ${storageLimit(limits)}` : '—'}
            </span>
          </div>
        </section>

        <section className="card limits-card" aria-labelledby="files-rules">
          <div className="card-head">
            <h2 className="card-title" id="files-rules">
              {t('files.rules')}
            </h2>
            <span className="chip">{allFiles.length}</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">{t('files.rule.antivirus')}</span>
            <span className="size">{t('files.rule.antivirusOn')}</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">{t('files.rule.tls')}</span>
            <span className="size">TLS</span>
          </div>
          <div className="policy-row">
            <ShieldIcon aria-hidden="true" />
            <span className="policy-label">{t('files.rule.retention')}</span>
            <span className="size">{t('files.rule.retentionValue')}</span>
          </div>
          <p className="pg-footnote">{t('files.uploadHint')}</p>
        </section>
      </div>
    </PageShell>
  );
}
