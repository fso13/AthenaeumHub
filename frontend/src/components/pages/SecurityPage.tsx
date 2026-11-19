import { useEffect } from 'react';
import { describeError } from '../../domain/errors';
import { t } from '../../i18n/ru';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { DownloadIcon, KeyIcon, LockIcon, MonitorIcon, RefreshIcon, ShieldIcon } from '../Icons';
import { PageShell } from './PageShell';
import { securityModeLabel } from './pageData';

interface SecurityPageProps {
  onBack: () => void;
}

/**
 * D1 UX fidelity 2: design page cards on top of the data that actually exists.
 * Devices come from `GET /devices`; DLP policies, the audit log, session
 * termination and the mode switch have no API in this slice and stay disabled.
 */
export function SecurityPage({ onBack }: SecurityPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const workspace = state.activeWorkspace;
  const workspaceName = workspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const securityMode =
    workspace?.security_mode ?? state.session?.workspace.security_mode ?? 'MANAGED';
  const managed = securityMode === 'MANAGED';
  const devices = state.devices;
  const deviceError = devices.error ? describeError(devices.error) : null;

  useEffect(() => {
    if (devices.status === 'idle') void store.loadDevices();
  }, [devices.status, store]);

  const deviceRows = devices.items.map((device) => (
    <div className="device-row" key={device.id}>
      <MonitorIcon aria-hidden="true" />
      <span className="name">
        <b>{device.name?.trim() || t('profile.deviceNoName')}</b>
        <small>
          {device.platform}
          {device.last_seen_at ? ` · ${formatDateTime(device.last_seen_at)}` : ''}
        </small>
      </span>
      {device.id === state.device?.id ? (
        <span className="state">{t('settings.deviceCurrent')}</span>
      ) : null}
    </div>
  ));

  return (
    <PageShell
      title={t('security.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(securityMode)}`}
      onBack={onBack}
      actions={
        <button
          type="button"
          className="btn"
          disabled
          aria-label="Экспорт"
          title={t('security.exportUnavailable')}
        >
          <DownloadIcon aria-hidden="true" />
          <span>Экспорт</span>
        </button>
      }
    >
      <div className={`mode-card${managed ? '' : ' mode-card--e2ee'}`}>
        <span className="mode-ic" aria-hidden="true">
          {managed ? <ShieldIcon /> : <LockIcon />}
        </span>
        <div>
          <h2>{managed ? t('security.modeManaged') : t('security.modeE2ee')}</h2>
          <p>{managed ? t('security.modeManagedHint') : t('security.modeE2eeHint')}</p>
        </div>
        <span className={`chip${managed ? '' : ' chip--accent'}`}>{managed ? 'DLP' : 'E2EE'}</span>
        <button type="button" className="btn" disabled title={t('security.changeUnavailable')}>
          Изменить
        </button>
      </div>

      <div className="security-grid">
        <section className="card" aria-labelledby="security-devices">
          <div className="card-head">
            <h2 className="card-title" id="security-devices">
              {managed ? t('security.devicesTitle') : t('security.devicesTitleE2ee')}
            </h2>
            <span className="chip">{devices.items.length}</span>
          </div>
          {devices.status === 'loading' && devices.items.length === 0 ? (
            <p className="card-empty" role="status">
              {t('security.devicesLoad')}
            </p>
          ) : null}
          {deviceError ? (
            <div className="pg-inline-error" role="alert">
              <p>{deviceError.message}</p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void store.loadDevices(true)}
              >
                <RefreshIcon aria-hidden="true" />
                {t('common.retry')}
              </button>
            </div>
          ) : null}
          {devices.status === 'ready' && devices.items.length === 0 ? (
            <p className="card-empty">{t('security.devicesEmpty')}</p>
          ) : null}
          {devices.items.length > 0 ? (
            <>
              {deviceRows}
              <p className="pg-footnote">{t('security.devicesHint')}</p>
            </>
          ) : null}
          {!managed ? (
            <p className="pane-sub">{t('security.keysEmpty')}</p>
          ) : (
            <p className="pane-sub">{t('security.keysHistory')} · KMS</p>
          )}
        </section>

        <section className="card" aria-labelledby="security-policies">
          <div className="card-head">
            <h2 className="card-title" id="security-policies">
              {managed ? t('security.dlpTitle') : t('security.keysHistory')}
            </h2>
            <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
          </div>
          <p className="card-empty">
            {managed ? t('security.emptyTitle') : t('security.keysEmpty')}
          </p>
          <p className="pane-sub">{managed ? t('security.dlpEmpty') : t('security.keysHistory')}</p>
          <div className="policy-row" aria-disabled="true">
            <KeyIcon aria-hidden="true" />
            <span>{t('security.dlp')}</span>
            <span className="count">—</span>
          </div>
        </section>

        <section className="card" aria-labelledby="security-audit">
          <div className="card-head">
            <h2 className="card-title" id="security-audit">
              {t('security.auditTitle')}
            </h2>
            <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
          </div>
          <p className="card-empty">{t('security.auditEmpty')}</p>
          <div className="audit-row" aria-disabled="true">
            <span className="audit-time">—</span>
            <span>{t('security.audit')}</span>
          </div>
        </section>

        <section className="card" aria-labelledby="security-sessions">
          <div className="card-head">
            <h2 className="card-title" id="security-sessions">
              {t('security.sessionsTitle')}
            </h2>
            <button type="button" className="card-link" disabled title={t('security.sessionsHint')}>
              {t('security.finish')}
            </button>
          </div>
          {devices.items.length > 0 ? (
            deviceRows
          ) : (
            <p className="card-empty">{t('security.devicesEmpty')}</p>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn--sm" disabled>
              <DownloadIcon aria-hidden="true" />
              {t('security.logoutAll')}
            </button>
          </div>
          <p className="pg-footnote">{t('security.sessionsHint')}</p>
        </section>
      </div>
    </PageShell>
  );
}
