import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListFilesQuery } from '../../api/endpoints';
import { toApiError } from '../../api/problem';
import type { ApiError } from '../../api/problem';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { FileItem, FileKindFilter, FileScanStatusFilter } from '../../api/types';
import { describeError } from '../../domain/errors';
import { formatBytes, isSafePreviewImage } from '../../files/format';
import { songDisplay, songMetaLine } from '../../files/media';
import { useArtwork } from '../../hooks/useArtwork';
import { t, type MessageKey } from '../../i18n/ru';
import { useChatState, useFilesState, useFilesStore } from '../../store/ChatProvider';
import type { AppState } from '../../store/chatStore';
import {
  ChatIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  EditIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
} from '../Icons';
import { PageShell } from './PageShell';
import {
  chatDisplayName,
  extensionOf,
  fileKind,
  fileKindLabel,
  fileName,
  securityModeLabel,
  shortDate,
  storageLimit,
  storagePercent,
  storageUsed,
  tariffLabel,
} from './pageData';

type KindFilter = 'all' | NonNullable<FileKindFilter>;
type ScanFilter = 'ALL' | NonNullable<FileScanStatusFilter>;

const PAGE_SIZE = 50;

const FILTERS: ReadonlyArray<{ id: KindFilter; label: MessageKey }> = [
  { id: 'all', label: 'files.filter.all' },
  { id: 'IMAGE', label: 'files.filter.image' },
  { id: 'FILE', label: 'files.filter.doc' },
  { id: 'AUDIO', label: 'files.filter.audio' },
  { id: 'VIDEO', label: 'files.filter.video' },
];

const SCAN_FILTERS: ReadonlyArray<{ id: ScanFilter; label: MessageKey }> = [
  { id: 'ALL', label: 'files.scanFilter.all' },
  { id: 'PENDING', label: 'files.scanStatus.PENDING' },
  { id: 'CLEAN', label: 'files.scanStatus.CLEAN' },
  { id: 'INFECTED', label: 'files.scanStatus.INFECTED' },
  { id: 'FAILED', label: 'files.scanStatus.FAILED' },
  { id: 'SKIPPED', label: 'files.scanStatus.SKIPPED' },
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

/** `chat_name` is null for DIRECT chats; resolve it from the loaded directory. */
function chatNameFor(item: FileItem, state: AppState): string {
  if (item.chat_name?.trim()) return item.chat_name;
  const chat = state.chats.find((candidate) => candidate.id === item.chat_id);
  if (chat) return chatDisplayName(chat, state);
  return t('files.unknownChat');
}

/**
 * #97 row cover. Priority:
 *  1. a CLEAN raster image is previewed through the presigned attachment URL;
 *  2. otherwise the authenticated server artwork blob (AUDIO cover, or an
 *     IMAGE that cannot be previewed) — never `src=artwork_url`, which is an
 *     authenticated endpoint and would return `401`;
 *  3. the extension badge fallback.
 */
function useThumbnail(item: FileItem): string | null {
  const filesStore = useFilesStore();
  const previewable = isSafePreviewImage(item.mime_type) && item.scan_status === 'CLEAN';
  const [preview, setPreview] = useState<string | null>(null);
  const cover = useArtwork(item.id, item.media);

  useEffect(() => {
    setPreview(null);
    if (!previewable) return;
    let active = true;
    void filesStore
      .getDownloadUrl(item.id)
      .then((download) => {
        if (active) setPreview(download.url);
      })
      .catch(() => {
        // Keep the extension/service-artwork fallback; the row owns no preview
        // error surface.
      });
    return () => {
      active = false;
    };
  }, [filesStore, item.id, previewable]);

  return preview ?? cover.url;
}

function openExternal(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

type FileAction = 'upload' | 'rename' | 'delete';

/**
 * #83 error copy. The server is the source of truth: the contract codes are
 * mapped to the exact cause instead of a generic "something failed".
 */
function fileErrorText(error: ApiError, action: FileAction): string {
  switch (error.status) {
    case 403:
      return action === 'upload'
        ? t('files.uploadForbidden')
        : action === 'rename'
          ? t('files.renameForbidden')
          : t('files.deleteForbidden');
    case 404:
      // The server hides existence from non-owners; rename is owner-only.
      return action === 'rename' ? t('files.renameForbidden') : describeError(error).message;
    case 409:
      return t('files.deleteAttached');
    case 413:
      return t('files.uploadTooLarge');
    case 415:
      return t('files.uploadUnsupported');
    case 422:
      return action === 'upload' ? t('files.uploadDangerous') : t('files.uploadInvalid');
    case 503:
      return action === 'delete' ? t('files.deleteUnavailable') : t('files.uploadUnavailable');
    default:
      return describeError(error).message;
  }
}

/** Confirm-dialog projection: 404 is reconciled state, not a scary failure. */
function deleteErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: fileErrorText(error, 'delete'),
    tone: error.status === 404 ? 'warning' : 'error',
    retryable: error.source === 'network' || error.status === 503 || (error.status ?? 0) >= 500,
    closeOnError: error.status === 404,
  };
}

function FileRow({
  item,
  chatName,
  canModerate,
  onOpenChat,
  onRequestDelete,
}: {
  item: FileItem;
  chatName: string;
  /** Workspace OWNER/ADMIN may delete any file; the server re-checks. */
  canModerate: boolean;
  onOpenChat: (chatId: string) => void;
  onRequestDelete: (item: FileItem) => void;
}) {
  const filesStore = useFilesStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(fileName(item));
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const preview = useThumbnail(item);
  const thumb = previewFailed ? null : preview;
  const kind = fileKind(item.mime_type, item.filename);
  const ext = extensionOf(item.filename);
  const scan = item.scan_status;
  const scanBlocked = scan === 'INFECTED' || scan === 'FAILED';
  const name = fileName(item);
  // #97: server-extracted tags are shown for AUDIO rows (title/artist/album/
  // year/duration). They arrive on the row itself, so a fresh upload shows
  // metadata as soon as the post-upload `GET /files` refresh lands.
  const song = kind === 'audio' ? songDisplay(item.media) : null;
  const mediaLine = song ? songMetaLine(song, item.media?.duration_ms) : null;

  const handleDownload = async () => {
    if (busy || scanBlocked) return;
    setBusy(true);
    setError(null);
    try {
      // The list carries metadata only; the presigned URL is resolved here.
      const download = await filesStore.getDownloadUrl(item.id);
      openExternal(download.url);
    } catch (downloadError) {
      setError(toApiError(downloadError));
    } finally {
      setBusy(false);
    }
  };

  const startRename = () => {
    setEditValue(name);
    setRenameError(null);
    setEditing(true);
  };

  const cancelRename = () => {
    setEditing(false);
    setRenameError(null);
  };

  const submitRename = async () => {
    const next = editValue.trim();
    if (next.length === 0) {
      setRenameError(t('files.renameEmpty'));
      return;
    }
    if (next.length > 255) {
      setRenameError(t('files.renameTooLong'));
      return;
    }
    if (next === name) {
      cancelRename();
      return;
    }
    setRenaming(true);
    setRenameError(null);
    const result = await filesStore.renameFile(item.id, next);
    setRenaming(false);
    if (!result.ok) {
      setRenameError(fileErrorText(result.error, 'rename'));
      return;
    }
    setEditing(false);
  };

  return (
    <div className="file-row">
      <span
        className={`file-icon${thumb ? ' file-cover' : ''}`}
        data-kind={kind}
        aria-hidden="true"
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          ext
        )}
      </span>
      <span className="file-name">
        {editing ? (
          <form
            className="file-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <label className="visually-hidden" htmlFor={`rename-${item.id}`}>
              {t('files.rename')}
            </label>
            <input
              id={`rename-${item.id}`}
              value={editValue}
              maxLength={255}
              autoFocus
              disabled={renaming}
              aria-invalid={renameError !== null}
              aria-describedby={renameError ? `rename-error-${item.id}` : undefined}
              onChange={(event) => setEditValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
            <button
              type="submit"
              className="file-dl"
              disabled={renaming}
              aria-label={t('files.renameSave')}
              title={t('files.renameSave')}
            >
              <CheckIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className="file-dl"
              disabled={renaming}
              onClick={cancelRename}
              aria-label={t('files.renameCancel')}
              title={t('files.renameCancel')}
            >
              <CloseIcon aria-hidden="true" />
            </button>
          </form>
        ) : (
          <b title={name}>{name}</b>
        )}
        <small>
          {fileKindLabel(kind)} · {shortDate(item.created_at)}
        </small>
        {mediaLine ? (
          <small className="file-media-meta" title={mediaLine}>
            {mediaLine}
          </small>
        ) : null}
        {renameError ? (
          <small className="file-error" id={`rename-error-${item.id}`} role="alert">
            {renameError}
          </small>
        ) : null}
        {error ? (
          <small className="file-error" role="alert">
            {describeError(error).message}
          </small>
        ) : null}
      </span>
      <span className="file-chat" title={chatName}>
        {chatName}
      </span>
      <span className="file-size">{formatBytes(item.size_bytes)}</span>
      <span className="file-type">{fileKindLabel(kind)}</span>
      <span className="file-status-cell">
        <span className={`file-status file-status--${scan.toLowerCase()}`}>
          {t(SCAN_LABEL[scan] ?? 'files.scanStatus.SKIPPED')}
        </span>
      </span>
      <span className="file-actions files-row-actions">
        <button
          type="button"
          className="file-dl"
          onClick={() => void handleDownload()}
          disabled={busy || scanBlocked}
          aria-label={`${t('files.download')}: ${name}`}
          title={
            scanBlocked
              ? t('files.downloadBlocked')
              : busy
                ? t('files.downloading')
                : t('files.download')
          }
        >
          <DownloadIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="file-dl"
          onClick={() => {
            if (item.chat_id) onOpenChat(item.chat_id);
          }}
          disabled={!item.chat_id}
          aria-label={`${t('files.toChat')}: ${chatName}`}
          title={t('files.toChat')}
        >
          <ChatIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="file-dl"
          onClick={startRename}
          disabled={renaming || editing}
          aria-label={`${t('files.rename')}: ${name}`}
          title={t('files.rename')}
        >
          <EditIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="file-dl"
          onClick={() => onRequestDelete(item)}
          disabled={editing}
          aria-label={`${t('files.delete')}: ${name}`}
          title={canModerate ? t('files.delete') : t('files.actionsHint')}
        >
          <TrashIcon aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/**
 * #73 file-center. The list is `GET /files` (workspace-scoped, cursor paged,
 * metadata-only); quotas come from the response snapshot and `/limits`.
 * Download is the existing `GET /attachments/{id}/download-url` call. The UI
 * never renders object keys, sha256 or presigned URLs as list data.
 */
export function FilesPage({ onBack, onOpenChat }: FilesPageProps) {
  const state = useChatState();
  const filesStore = useFilesStore();
  const filesState = useFilesState();
  const center = filesState.fileCenter;
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filter, setFilter] = useState<KindFilter>('all');
  const [scan, setScan] = useState<ScanFilter>('ALL');
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [lastUpload, setLastUpload] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const workspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  const role = state.activeWorkspace?.role ?? null;
  const canModerate = role === 'OWNER' || role === 'ADMIN';
  const upload = filesState.fileCenterUpload;

  const appliedQuery = useMemo<ListFilesQuery>(
    () => ({
      workspaceId: workspaceId ?? undefined,
      kind: filter === 'all' ? undefined : filter,
      scanStatus: scan === 'ALL' ? undefined : scan,
      query: debouncedQuery || undefined,
      limit: PAGE_SIZE,
    }),
    [debouncedQuery, filter, scan, workspaceId],
  );

  useEffect(() => {
    if (!workspaceId) return;
    void filesStore.loadFiles(appliedQuery);
  }, [appliedQuery, filesStore, workspaceId]);

  const limits = filesState.limits ?? state.chatLimits;
  const limitsError = filesState.limitsStatus === 'error' ? filesState.limitsError : null;
  const limitsMessage = limitsError ? describeError(limitsError) : null;
  const quota = center.quota;
  const percent = quota ? quota.percent : storagePercent(limits);
  const usedLabel = quota ? formatBytes(quota.used_bytes) : storageUsed(limits);
  const limitLabel = quota ? formatBytes(quota.storage_bytes) : storageLimit(limits);
  const hasFilters = query.trim().length > 0 || filter !== 'all' || scan !== 'ALL';
  const rows = center.items;
  const listError = center.status === 'error' && center.error ? center.error : null;
  const listErrorMessage = listError
    ? listError.status === 503
      ? t('files.listUnavailable')
      : t('files.listErrorText')
    : null;
  const showInitialLoading = center.status === 'loading' && rows.length === 0;
  const showEmptyState = center.status === 'ready' && rows.length === 0 && !hasFilters;
  const showNoMatches = center.status === 'ready' && rows.length === 0 && hasFilters;

  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const mode =
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    ('MANAGED' as const);

  const reload = () => {
    void filesStore.loadFiles(appliedQuery);
    void filesStore.refreshLimits();
  };

  const startUpload = (file: File | null) => {
    if (!file || !workspaceId) return;
    setLastUpload(file);
    void filesStore.uploadFile(file);
  };

  const retryUpload = () => {
    if (!lastUpload || upload.status === 'uploading') return;
    void filesStore.uploadFile(lastUpload);
  };

  const closeDelete = () => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const result = await filesStore.deleteFile(deleteTarget.id);
    setDeleteBusy(false);
    if (result.ok) {
      setDeleteTarget(null);
      return;
    }
    setDeleteError(result.error);
  };

  const resetFilters = () => {
    setQuery('');
    setFilter('all');
    setScan('ALL');
  };

  const storageSummary =
    quota || limits
      ? t('files.storageSummary', { used: usedLabel, limit: limitLabel })
      : t('files.limitsPending');
  const storageHint = limits
    ? t('files.storageHintLoaded', {
        count: rows.length,
        tariff: tariffLabel(limits.tariff),
      })
    : quota
      ? t('files.storageHintLoadedNoTariff', { count: rows.length })
      : t('overview.limitsUnavailable');

  return (
    <PageShell
      title={t('files.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(mode)}`}
      onBack={onBack}
      actions={
        <>
          <input
            ref={uploadInputRef}
            className="visually-hidden"
            type="file"
            tabIndex={-1}
            aria-label={t('files.uploadChoose')}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = '';
              startUpload(file);
            }}
          />
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!workspaceId || upload.status === 'uploading'}
            aria-label={t('files.upload')}
            title={t('files.uploadHint')}
          >
            <PlusIcon aria-hidden="true" />
            <span>{t('files.upload')}</span>
          </button>
          <button
            type="button"
            className="btn page-action--secondary"
            onClick={reload}
            aria-label={t('files.refresh')}
            title={t('files.refresh')}
          >
            <RefreshIcon aria-hidden="true" />
            <span>{t('files.refreshShort')}</span>
          </button>
        </>
      }
    >
      {upload.status !== 'idle' ? (
        <section
          className={`files-upload${upload.status === 'error' ? ' files-upload--error' : ''}`}
          aria-live="polite"
          role={upload.status === 'error' ? 'alert' : 'status'}
        >
          <span className="stat-ic" aria-hidden="true">
            {upload.status === 'error' ? (
              <ShieldIcon />
            ) : upload.status === 'done' ? (
              <CheckIcon />
            ) : (
              <PlusIcon />
            )}
          </span>
          <div className="files-upload__body">
            <span className="files-upload__name">
              {upload.status === 'uploading'
                ? t('files.uploadProgress', {
                    name: upload.filename ?? '',
                    percent: upload.progress,
                  })
                : upload.status === 'done'
                  ? t('files.uploadDone', { name: upload.filename ?? '' })
                  : t('files.uploadErrorTitle')}
            </span>
            {upload.status === 'uploading' ? (
              <div
                className="files-upload__meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={upload.progress}
                aria-label={t('files.uploadProgress', {
                  name: upload.filename ?? '',
                  percent: upload.progress,
                })}
              >
                <i style={{ width: `${upload.progress}%` }} />
              </div>
            ) : (
              <span className="files-upload__hint">
                {upload.status === 'done'
                  ? t('files.uploadDoneHint')
                  : upload.error
                    ? fileErrorText(upload.error, 'upload')
                    : ''}
              </span>
            )}
          </div>
          {upload.status === 'uploading' ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => filesStore.cancelFileUpload()}
            >
              {t('files.uploadCancel')}
            </button>
          ) : (
            <>
              {upload.status === 'error' && lastUpload ? (
                <button type="button" className="btn btn--sm" onClick={retryUpload}>
                  <RefreshIcon aria-hidden="true" />
                  {t('files.uploadRetry')}
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button icon-button--small"
                onClick={() => filesStore.clearFileUpload()}
                aria-label={t('files.uploadDismiss')}
                title={t('files.uploadDismiss')}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </>
          )}
        </section>
      ) : null}

      {limitsMessage ? (
        <section className="card pg-error" role="alert">
          <div>
            <h2 className="card-title">{t('files.limitsErrorTitle')}</h2>
            <p className="card-empty">{limitsMessage.message}</p>
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
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="page-select">
          <ShieldIcon aria-hidden="true" />
          <span className="visually-hidden">{t('files.scanFilterLabel')}</span>
          <select
            value={scan}
            aria-label={t('files.scanFilterLabel')}
            onChange={(event) => setScan(event.target.value as ScanFilter)}
          >
            {SCAN_FILTERS.map((item) => (
              <option key={item.id} value={item.id}>
                {t(item.label)}
              </option>
            ))}
          </select>
        </label>
        <span className="files-count" aria-live="polite">
          {t('files.loadedCount', { count: rows.length })}
        </span>
      </div>

      <section className="card files-summary" aria-labelledby="files-summary-title">
        <span className="stat-ic" aria-hidden="true">
          <FolderIcon />
        </span>
        <div className="grow">
          <b id="files-summary-title">{storageSummary}</b>
          <small>{storageHint}</small>
          {quota ? (
            <small>{t('files.storageReserved', { size: formatBytes(quota.reserved_bytes) })}</small>
          ) : null}
          {quota || limits ? (
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

      {listError && rows.length === 0 ? (
        <section className="card pg-error" role="alert">
          <div>
            <h2 className="card-title">{t('files.listErrorTitle')}</h2>
            <p className="card-empty">{listErrorMessage}</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={reload}>
            <RefreshIcon aria-hidden="true" />
            {t('files.retryList')}
          </button>
        </section>
      ) : (
        <div className="files-table" aria-busy={center.status === 'loading'}>
          <div className="file-head">
            <span aria-hidden="true" />
            <span>{t('files.column.name')}</span>
            <span>{t('files.column.chat')}</span>
            <span>{t('files.column.size')}</span>
            <span>{t('files.column.type')}</span>
            <span>{t('files.column.status')}</span>
            <span>{t('files.column.actions')}</span>
          </div>

          {showInitialLoading ? (
            <div className="file-empty" role="status">
              <FolderIcon aria-hidden="true" />
              <strong>{t('files.loading')}</strong>
            </div>
          ) : showEmptyState ? (
            <div className="file-empty" role="status">
              <FolderIcon aria-hidden="true" />
              <strong>{t('files.emptyTitle')}</strong>
              <p>{t('files.emptyText')}</p>
            </div>
          ) : showNoMatches ? (
            <div className="file-empty" role="status">
              <SearchIcon aria-hidden="true" />
              <strong>{t('files.noMatchesTitle')}</strong>
              <p>{t('files.noMatchesText')}</p>
              <button type="button" className="btn btn--sm" onClick={resetFilters}>
                {t('files.resetFilters')}
              </button>
            </div>
          ) : (
            rows.map((item) => (
              <FileRow
                key={item.id}
                item={item}
                chatName={chatNameFor(item, state)}
                canModerate={canModerate}
                onOpenChat={onOpenChat}
                onRequestDelete={(target) => {
                  setDeleteError(null);
                  setDeleteTarget(target);
                }}
              />
            ))
          )}
        </div>
      )}

      {listError && rows.length > 0 ? (
        <div className="files-more" role="alert">
          <p>{t('files.loadMoreError')}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void filesStore.loadMoreFiles()}
          >
            <RefreshIcon aria-hidden="true" />
            {t('files.retryList')}
          </button>
        </div>
      ) : null}

      {(center.hasMore || center.status === 'loadingMore') && center.status !== 'error' ? (
        <div className="files-more">
          <button
            type="button"
            className="btn"
            onClick={() => void filesStore.loadMoreFiles()}
            disabled={center.status === 'loadingMore'}
            aria-busy={center.status === 'loadingMore'}
          >
            {center.status === 'loadingMore' ? t('files.loadingMore') : t('files.loadMore')}
          </button>
        </div>
      ) : null}

      {hasFilters && rows.length > 0 ? (
        <p className="pg-footnote">{t('files.filtersApplied', { count: rows.length })}</p>
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
              {quota
                ? `${usedLabel} / ${limitLabel}`
                : limits
                  ? `${storageUsed(limits)} / ${storageLimit(limits)}`
                  : '—'}
            </span>
          </div>
        </section>

        <section className="card limits-card" aria-labelledby="files-rules">
          <div className="card-head">
            <h2 className="card-title" id="files-rules">
              {t('files.rules')}
            </h2>
            <span className="chip">{rows.length}</span>
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

      {deleteTarget ? (
        <AdminConfirmDialog
          title={t('files.deleteTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('files.deleteLead', { name: fileName(deleteTarget) })}
              </p>
              <p className="admin-confirm__effect">{t('files.deleteEffect')}</p>
            </>
          }
          confirmLabel={t('files.deleteConfirm')}
          busyLabel={t('files.deleting')}
          cancelLabel={t('files.deleteCancel')}
          destructive
          busy={deleteBusy}
          error={deleteError ? deleteErrorInfo(deleteError) : null}
          errorDetails={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={closeDelete}
        />
      ) : null}
    </PageShell>
  );
}
