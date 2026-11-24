import { useEffect } from 'react';
import { describeError } from '../../domain/errors';
import { t } from '../../i18n/ru';
import {
  useChatState,
  useChatStore,
  useSecurityState,
  useSecurityStore,
} from '../../store/ChatProvider';
import type { WorkspaceRole } from '../../api/types';
import { formatDateTime } from '../admin/format';
import { LockIcon, MonitorIcon, RefreshIcon, ShieldIcon } from '../Icons';
import { AuditCard } from '../security/AuditCard';
import { DlpEventsCard } from '../security/DlpEventsCard';
import { DlpPoliciesCard } from '../security/DlpPoliciesCard';
import { SecuritySettingsCard } from '../security/SecuritySettingsCard';
import { SessionsCard } from '../security/SessionsCard';
import { PageShell } from './PageShell';
import { securityModeLabel } from './pageData';

interface SecurityPageProps {
  onBack: () => void;
  embedded?: boolean;
}

function DeviceRows() {
  const state = useChatState();
  return (
    <>
      {state.devices.items.map((device) => (
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
      ))}
    </>
  );
}

function DevicesCard({ mode }: { mode: 'MANAGED' | 'E2EE' }) {
  const store = useChatStore();
  const state = useChatState();
  const devices = state.devices;
  const deviceError = devices.error ? describeError(devices.error) : null;
  const title = mode === 'MANAGED' ? t('security.devicesTitle') : t('security.devicesTitleE2ee');

  return (
    <section className="card" aria-labelledby="security-devices">
      <div className="card-head">
        <h2 className="card-title" id="security-devices">
          {title}
        </h2>
        <div className="sec-head-actions">
          <span className="chip" aria-label={`${title}: ${devices.items.length}`}>
            {devices.items.length}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadDevices(true)}
            disabled={devices.status === 'loading'}
          >
            <RefreshIcon aria-hidden="true" />
            {t('security.refresh')}
          </button>
        </div>
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
          <DeviceRows />
          <p className="pg-footnote">{t('security.devicesHint')}</p>
        </>
      ) : null}
      {mode === 'E2EE' ? <p className="pane-sub">{t('security.keysEmpty')}</p> : null}
    </section>
  );
}

/**
 * P0-3 (#81) workspace security surface.
 *
 * Manager data (DLP, audit, sessions, settings) is fetched only after the
 * workspace role resolves to OWNER/ADMIN. MEMBER/GUEST see an honest access
 * notice and their own device list; the manager endpoints are never called, so
 * the 403 path is not used as a data-loading strategy.
 */
export function SecurityPage({ onBack, embedded = false }: SecurityPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const security = useSecurityStore();
  const securityState = useSecurityState();
  const workspace = state.activeWorkspace;
  const workspaceId =
    workspace?.id ?? state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  const workspaceName = workspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const securityMode =
    workspace?.security_mode ?? state.session?.workspace.security_mode ?? 'MANAGED';
  const role: WorkspaceRole | null =
    workspace?.role ?? state.me?.workspaces.find((item) => item.id === workspaceId)?.role ?? null;
  const manager = role === 'OWNER' || role === 'ADMIN';
  const managed = securityMode === 'MANAGED';

  useEffect(() => {
    if (state.devices.status === 'idle') void store.loadDevices();
  }, [state.devices.status, store]);

  useEffect(() => {
    if (!manager || workspaceId === null) {
      security.close();
      return;
    }
    void security.open(workspaceId, securityMode);
  }, [manager, securityMode, security, workspaceId]);

  const refreshing =
    securityState.policies.status === 'loading' ||
    securityState.events.status === 'loading' ||
    securityState.audit.status === 'loading' ||
    securityState.sessions.status === 'loading' ||
    securityState.settings.status === 'loading';

  return (
    <PageShell
      embedded={embedded}
      title={t('security.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(securityMode)}`}
      subtitle={t('security.subtitle')}
      onBack={onBack}
      actions={
        manager ? (
          <button
            type="button"
            className="btn"
            onClick={() => void security.refreshAll()}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon aria-hidden="true" />
            {refreshing ? t('security.refreshing') : t('security.refresh')}
          </button>
        ) : null
      }
    >
      <div className={`mode-card${managed ? '' : ' mode-card--e2ee'}`}>
        <span className="mode-ic" aria-hidden="true">
          {managed ? <ShieldIcon /> : <LockIcon />}
        </span>
        <div>
          <h2>{managed ? t('security.modeManaged') : t('security.modeE2ee')}</h2>
          <p>{managed ? t('security.modeManagedHint') : t('security.modeE2eeHint')}</p>
          <p className="pg-footnote">{t('security.modeImmutable')}</p>
        </div>
        <span className={`chip${managed ? '' : ' chip--accent'}`}>
          {managed ? 'MANAGED' : 'E2EE'}
        </span>
        <button
          type="button"
          className="btn"
          disabled
          title={t('security.changeUnavailable')}
          aria-describedby="security-mode-immutable"
        >
          {t('security.change')}
        </button>
        <span className="visually-hidden" id="security-mode-immutable">
          {t('security.modeImmutable')}
        </span>
      </div>

      {!manager ? (
        <>
          <section className="card card--wide" aria-labelledby="security-manager-only">
            <div className="card-head">
              <h2 className="card-title" id="security-manager-only">
                {t('security.managerOnly.title')}
              </h2>
              <span className="chip">{role ?? '—'}</span>
            </div>
            <p className="pane-sub">{t('security.managerOnly.text')}</p>
          </section>
          <div className="security-grid">
            <DevicesCard mode={securityMode} />
          </div>
        </>
      ) : (
        <>
          {managed ? (
            <>
              <DlpPoliciesCard />
              <DlpEventsCard />
            </>
          ) : (
            <section className="card card--wide" aria-labelledby="security-dlp-e2ee">
              <div className="card-head">
                <h2 className="card-title" id="security-dlp-e2ee">
                  {t('security.dlp.title')}
                </h2>
                <span className="chip chip--accent">E2EE</span>
              </div>
              <p className="pane-sub">{t('security.e2eeDlp.text')}</p>
              <p className="pg-footnote">{t('security.e2eeDlp.title')}</p>
            </section>
          )}

          <AuditCard />
          <SessionsCard />

          <div className="security-grid">
            <SecuritySettingsCard mode={securityMode} />
            <DevicesCard mode={securityMode} />
          </div>
        </>
      )}
    </PageShell>
  );
}
