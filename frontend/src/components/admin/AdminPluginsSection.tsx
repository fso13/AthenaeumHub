import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { AdminPluginPackage } from '../../api/types';
import { formatBytes } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import { PLUGIN_MODE_LABEL, PLUGIN_PERMISSION_LABEL } from '../../plugins/model';
import { validatePluginPackageFile, type PluginPackageClientError } from '../../plugins/assets';
import { packageClientErrorText, packageInstallErrorText } from '../../plugins/packageErrors';
import { useChatState, usePluginsState, usePluginsStore } from '../../store/ChatProvider';
import { LockIcon, PlugIcon, RefreshIcon, TrashIcon } from '../Icons';
import { AdminConfirmDialog } from './AdminConfirmDialog';
import { AdminTranslationProvider } from './AdminTranslationProvider';
import { AdminCell, AdminRow, AdminRowsHead } from './AdminListParts';
import { AdminEmptyState, AdminErrorState, AdminSkeleton } from './AdminStates';
import { formatCount, formatDateTime } from './format';
import type { AdminActionErrorInfo } from './actionErrors';

/**
 * D1.2 (#86): developer documentation lives in the repository. The app does not
 * ship a docs server, so the admin affordance links to the canonical file.
 */
export const PLUGIN_DEVELOPER_DOCS_URL =
  'https://github.com/fso13/AthenaeumHub/blob/main/docs/PLUGIN-DEVELOPMENT.md';

const COLUMNS: MessageKey[] = [
  'admin.plugins.column.name',
  'admin.plugins.column.version',
  'admin.plugins.column.author',
  'admin.plugins.column.entry',
  'admin.plugins.column.permissions',
  'admin.plugins.column.size',
  'admin.plugins.column.installed',
];

function uninstallErrorInfo(error: ApiError): AdminActionErrorInfo {
  if (error.status === 404) {
    return {
      text: t('admin.plugins.uninstallNotFound'),
      tone: 'warning',
      retryable: false,
      closeOnError: true,
    };
  }
  if (error.status === 403) {
    return {
      text: t('admin.plugins.validation.forbidden'),
      tone: 'error',
      retryable: false,
      closeOnError: false,
    };
  }
  return {
    text: t('admin.plugins.uninstallError'),
    tone: 'error',
    retryable: error.isRetryable,
    closeOnError: false,
  };
}

/**
 * `/admin?tab=plugins` (D1.2 #86).
 *
 * An administrator drops or picks a `.zip`; the bytes go to
 * `POST /admin/plugins` as `multipart/form-data` with the bearer token. Nothing
 * from the archive is parsed or executed in the host realm: the server owns
 * ZIP/manifest validation, and this screen only renders metadata and stable
 * error codes. Install is impossible for a non-admin (the route is gated in
 * `App` and the server returns 403).
 */
export function AdminPluginsSection() {
  const store = usePluginsStore();
  const plugins = usePluginsState();
  const chat = useChatState();
  const isAdmin = chat.me?.user.is_platform_admin === true;

  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<PluginPackageClientError | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<AdminPluginPackage | null>(null);
  const [uninstallSuccess, setUninstallSuccess] = useState(false);

  const install = plugins.installState;
  const uninstall = plugins.uninstallState;
  const busy = install.status === 'uploading' || install.status === 'verifying';
  const forbidden = plugins.adminPackagesError?.status === 403;

  useEffect(() => {
    if (!isAdmin) return;
    void store.ensureAdminPackages();
  }, [isAdmin, store]);

  // Clear the picked file once the server confirms the install; the success
  // card remains visible until the next selection.
  useEffect(() => {
    if (install.status !== 'done') return;
    setFile(null);
    setClientError(null);
    if (inputRef.current) inputRef.current.value = '';
  }, [install.status, install.installed]);

  useEffect(() => {
    if (!confirming) return;
    if (uninstall.status !== 'done' || uninstall.pluginId !== confirming.id) return;
    setConfirming(null);
    setUninstallSuccess(true);
    store.resetPackageFeedback();
  }, [confirming, store, uninstall.pluginId, uninstall.status]);

  const pickFile = (candidate: File | null) => {
    setUninstallSuccess(false);
    if (!busy) store.resetPackageFeedback();
    if (!candidate) {
      setFile(null);
      setClientError(null);
      return;
    }
    const validation = validatePluginPackageFile(candidate);
    setClientError(validation);
    setFile(validation ? null : candidate);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!isAdmin || busy) return;
    const dropped = event.dataTransfer.files.item(0);
    pickFile(dropped);
  };

  const percent =
    install.totalBytes > 0
      ? Math.min(100, Math.max(0, Math.round((install.loadedBytes / install.totalBytes) * 100)))
      : 0;

  if (!isAdmin) {
    return (
      <section className="admin-card admin-section" aria-labelledby="admin-plugins-title">
        <div className="admin-card__head">
          <div>
            <h2 className="admin-card__title" id="admin-plugins-title">
              {t('admin.plugins.title')}
            </h2>
            <p className="admin-card__lead">{t('admin.plugins.readOnly')}</p>
          </div>
        </div>
        <AdminEmptyState title={t('admin.plugins.title')} text={t('admin.plugins.readOnly')} />
      </section>
    );
  }

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-plugins-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-plugins-title">
            {t('admin.plugins.title')}
          </h2>
          <p className="admin-card__lead">{t('admin.plugins.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadAdminPackages(true)}
          disabled={plugins.adminPackagesStatus === 'loading'}
        >
          <RefreshIcon aria-hidden="true" />
          {t('admin.plugins.refresh')}
        </button>
      </div>

      <p className="admin-card__hint admin-plugins__docs">
        <a href={PLUGIN_DEVELOPER_DOCS_URL} target="_blank" rel="noopener noreferrer">
          {t('admin.plugins.docs')}
        </a>{' '}
        — {t('admin.plugins.docsHint')}
      </p>

      <AdminTranslationProvider />

      <div className="admin-plugins__upload">
        <h3 className="admin-plugins__subtitle">{t('admin.plugins.uploadTitle')}</h3>
        <p className="admin-card__hint">{t('admin.plugins.uploadLead')}</p>

        <div
          className={`package-drop${dragging ? ' package-drop--active' : ''}${busy ? ' package-drop--busy' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={handleDrop}
        >
          <PlugIcon aria-hidden="true" />
          <input
            ref={inputRef}
            id="admin-plugin-package-file"
            className="visually-hidden"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            aria-label={t('admin.plugins.uploadLabel')}
            disabled={busy}
            onChange={(event) => pickFile(event.target.files?.item(0) ?? null)}
          />
          <label htmlFor="admin-plugin-package-file" className="package-drop__label">
            {dragging ? t('admin.plugins.dropActive') : t('admin.plugins.dropIdle')}
          </label>
          <p className="package-drop__limits">{t('admin.plugins.limits')}</p>
        </div>

        {clientError ? (
          <p className="admin-confirm__notice admin-confirm__notice--error" role="alert">
            {packageClientErrorText(clientError)}
          </p>
        ) : null}

        {file ? (
          <div className="admin-plugins__selected">
            <p>
              {t('admin.plugins.selected', {
                name: file.name,
                size: formatBytes(file.size),
              })}
            </p>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => pickFile(null)}
              disabled={busy}
            >
              {t('admin.plugins.clearFile')}
            </button>
          </div>
        ) : null}

        {busy ? (
          <div className="admin-plugins__progress">
            <div
              className="admin-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={
                install.totalBytes > 0
                  ? t('admin.plugins.progress', { percent })
                  : t('admin.plugins.progressUnknown')
              }
            >
              <span className="admin-bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <p role="status">
              {install.status === 'verifying'
                ? t('admin.plugins.verifying')
                : t('admin.plugins.uploading')}
            </p>
          </div>
        ) : null}

        <div className="admin-plugins__install">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              if (file) void store.installPackage(file);
            }}
            disabled={!file || busy}
          >
            {t('admin.plugins.install')}
          </button>
          <span className="admin-card__hint">{t('admin.plugins.installHint')}</span>
        </div>

        {install.status === 'done' && install.installed ? (
          <p className="plugin-feedback" role="status">
            {t('admin.plugins.installed', { name: install.installed.name })}
          </p>
        ) : null}

        {install.status === 'error' && install.error ? (
          <div className="admin-state admin-state--error" role="alert">
            <div className="admin-state__body">
              <p>{t('admin.plugins.installErrorTitle')}</p>
              <p>{packageInstallErrorText(install.error)}</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="admin-plugins__installed">
        <h3 className="admin-plugins__subtitle">{t('admin.plugins.listTitle')}</h3>
        <p className="admin-card__hint">{t('admin.plugins.listLead')}</p>

        {uninstallSuccess ? (
          <p className="plugin-feedback" role="status">
            {t('admin.plugins.uninstalled')}
          </p>
        ) : null}

        {plugins.adminPackagesStatus === 'loading' && plugins.adminPackages.length === 0 ? (
          <AdminSkeleton label={t('admin.plugins.loading')} rows={3} />
        ) : null}

        {plugins.adminPackagesStatus === 'error' && plugins.adminPackages.length === 0 ? (
          <AdminErrorState
            text={forbidden ? t('admin.forbidden.text') : t('admin.plugins.error')}
            error={plugins.adminPackagesError}
            retryLabel={t('admin.plugins.retry')}
            onRetry={() => void store.loadAdminPackages(true)}
          />
        ) : null}

        {plugins.adminPackagesStatus === 'ready' && plugins.adminPackages.length === 0 ? (
          <AdminEmptyState
            title={t('admin.plugins.emptyTitle')}
            text={t('admin.plugins.emptyText')}
          />
        ) : null}

        {plugins.adminPackages.length > 0 ? (
          <div className="admin-rows admin-rows--plugins">
            <AdminRowsHead labels={COLUMNS.map((key) => t(key))} />
            <ul className="admin-rows__items">
              {plugins.adminPackages.map((pkg) => (
                <AdminRow key={pkg.id}>
                  <AdminCell label={t('admin.plugins.column.name')} primary>
                    <span className="admin-cell__strong">{pkg.name}</span>
                    <span className="admin-cell__sub">{pkg.id}</span>
                  </AdminCell>
                  <AdminCell label={t('admin.plugins.column.version')}>
                    <span className="admin-chip admin-chip--ok">v{pkg.version}</span>
                  </AdminCell>
                  <AdminCell label={t('admin.plugins.column.author')}>{pkg.author}</AdminCell>
                  <AdminCell label={t('admin.plugins.column.entry')}>
                    <code>{pkg.entry}</code>
                  </AdminCell>
                  <AdminCell label={t('admin.plugins.column.permissions')}>
                    <span className="admin-plugins__chips">
                      {pkg.permissions.length === 0 ? (
                        <span className="perm">{t('plugins.external.noPermissions')}</span>
                      ) : (
                        pkg.permissions.map((permission) => (
                          <span className="perm" key={permission}>
                            {t(PLUGIN_PERMISSION_LABEL[permission])}
                          </span>
                        ))
                      )}
                      {pkg.modes.map((mode) => (
                        <span
                          className={`mode-chip mode-chip--${mode === 'E2EE' ? 'e2ee' : 'managed'}`}
                          key={mode}
                        >
                          {t(PLUGIN_MODE_LABEL[mode])}
                        </span>
                      ))}
                    </span>
                  </AdminCell>
                  <AdminCell label={t('admin.plugins.column.size')}>
                    <span>{formatBytes(pkg.size_bytes)}</span>
                    <span className="admin-cell__sub">
                      {t('admin.plugins.fileCount', { count: formatCount(pkg.file_count) })}
                    </span>
                    <span className="admin-cell__sub admin-plugins__sha" title={pkg.sha256}>
                      {pkg.sha256.slice(0, 12)}…
                    </span>
                  </AdminCell>
                  <AdminCell label={t('admin.plugins.column.installed')}>
                    <time dateTime={pkg.installed_at}>{formatDateTime(pkg.installed_at)}</time>
                    <button
                      type="button"
                      className="button button--danger button--small admin-plugins__remove"
                      onClick={() => {
                        setUninstallSuccess(false);
                        store.resetPackageFeedback();
                        setConfirming(pkg);
                      }}
                      disabled={uninstall.status === 'running'}
                      aria-label={t('admin.plugins.uninstallNamed', { name: pkg.name })}
                    >
                      <TrashIcon aria-hidden="true" />
                      {t('admin.plugins.uninstall')}
                    </button>
                  </AdminCell>
                </AdminRow>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <p className="plugin-note">
        <LockIcon aria-hidden="true" />
        <span>{t('admin.plugins.lockNote')}</span>
      </p>

      {confirming ? (
        <AdminConfirmDialog
          title={t('admin.plugins.uninstallTitle', { name: confirming.name })}
          description={<p>{t('admin.plugins.uninstallLead')}</p>}
          confirmLabel={t('admin.plugins.uninstallConfirm')}
          busyLabel={t('admin.plugins.uninstalling')}
          cancelLabel={t('admin.plugins.cancel')}
          destructive
          busy={uninstall.status === 'running'}
          error={
            uninstall.status === 'error' && uninstall.error
              ? uninstallErrorInfo(uninstall.error)
              : null
          }
          errorDetails={uninstall.error}
          onConfirm={() => void store.uninstallPackage(confirming.id)}
          onClose={() => {
            if (uninstall.status === 'running') return;
            setConfirming(null);
            store.resetPackageFeedback();
          }}
        />
      ) : null}
    </section>
  );
}
