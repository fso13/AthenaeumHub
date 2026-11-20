import { useEffect, useState } from 'react';
import { formatBytes } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import type { AppView } from '../../router/views';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import type { Theme } from '../../theme/themePreference';
import { formatDateTime } from '../admin/format';
import { Avatar } from '../Avatar';
import {
  BellIcon,
  EyeIcon,
  LockIcon,
  LogoutIcon,
  MonitorIcon,
  MoonIcon,
  PeopleIcon,
  SettingsIcon,
  ShieldIcon,
  SmartphoneIcon,
  SunIcon,
} from '../Icons';
import { BlockedUsersCard } from '../BlockedUsersCard';
import { NotificationPreferencesDialog } from '../NotificationPreferencesDialog';
import { PageShell } from './PageShell';
import { roleLabel, securityModeLabel, storageLimit, storageUsed, tariffLabel } from './pageData';

type SettingsTab = 'profile' | 'appearance' | 'notifications' | 'workspace' | 'devices';

type TabIconName = 'profile' | 'appearance' | 'bell' | 'shield' | 'monitor';

interface TabEntry {
  id: SettingsTab;
  label: MessageKey;
  icon: TabIconName;
}

const TABS: ReadonlyArray<TabEntry> = [
  { id: 'profile', label: 'settings.nav.profile', icon: 'profile' },
  { id: 'appearance', label: 'settings.nav.appearance', icon: 'appearance' },
  { id: 'notifications', label: 'settings.nav.notifications', icon: 'bell' },
  { id: 'workspace', label: 'settings.nav.workspace', icon: 'shield' },
  { id: 'devices', label: 'settings.nav.devices', icon: 'monitor' },
];

const TYPE_LABEL: Record<string, MessageKey> = {
  MESSAGE: 'notifications.preferences.type.MESSAGE',
  MENTION: 'notifications.preferences.type.MENTION',
  SYSTEM: 'notifications.preferences.type.SYSTEM',
};
const CHANNEL_LABEL: Record<string, MessageKey> = {
  IN_APP: 'notifications.preferences.channel.IN_APP',
  EMAIL: 'notifications.preferences.channel.EMAIL',
};
const MODE_LABEL: Record<string, MessageKey> = {
  ALL: 'notifications.preferences.modeLabel.ALL',
  MENTIONS: 'notifications.preferences.modeLabel.MENTIONS',
  MUTE: 'notifications.preferences.modeLabel.MUTE',
};

function TabIcon({ icon }: { icon: TabIconName }) {
  if (icon === 'appearance') return <SunIcon aria-hidden="true" />;
  if (icon === 'bell') return <BellIcon aria-hidden="true" />;
  if (icon === 'shield') return <ShieldIcon aria-hidden="true" />;
  if (icon === 'monitor') return <MonitorIcon aria-hidden="true" />;
  return <PeopleIcon aria-hidden="true" />;
}

interface SettingsPageProps {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onBack: () => void;
  onOpenAdmin?: () => void;
  onOpenMembers: () => void;
  /** D1-FE5: opens the profile modal over the settings page. */
  onOpenProfile?: () => void;
  onLogout?: () => void;
  onNavigate?: (view: AppView) => void;
}

/**
 * D1 UX fidelity 2: left settings nav + design panes. Only settings that exist
 * in this slice are interactive (theme, notifications, members, profile modal,
 * logout); the rest is read-only or honestly disabled.
 */
export function SettingsPage({
  theme,
  onThemeChange,
  onBack,
  onOpenAdmin,
  onOpenMembers,
  onOpenProfile,
  onLogout,
  onNavigate,
}: SettingsPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const [tab, setTab] = useState<SettingsTab>('profile');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const user = state.user ?? state.session?.user ?? null;
  const email = state.user?.email ?? null;
  const workspace = state.activeWorkspace;
  const workspaceName = workspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const securityMode =
    workspace?.security_mode ?? state.session?.workspace.security_mode ?? 'MANAGED';
  const limits = state.chatLimits;
  const isAdmin = state.me?.user.is_platform_admin === true;
  const device = state.device;
  const devices = state.devices;
  const devicesError = devices.error;

  useEffect(() => {
    if (tab !== 'devices') return;
    if (devices.status === 'idle') void store.loadDevices();
  }, [devices.status, store, tab]);

  const e2eeKeys = devices.items.filter((item) => item.e2ee_capable !== false).length;

  const securityCard = (
    <section className="card" aria-labelledby="settings-security">
      <div className="card-head">
        <h2 className="card-title" id="settings-security">
          {t('settings.security')}
        </h2>
        <button type="button" className="card-link" onClick={() => onNavigate?.('security')}>
          {t('settings.openSecurity')}
        </button>
      </div>
      <div className="setting-row">
        <div className="text">
          <b>{t('settings.twoFactor')}</b>
          <small>{t('settings.twoFactorUnavailable')}</small>
        </div>
        <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
      </div>
      <div className="setting-row">
        <div className="text">
          <b>{t('settings.keys')}</b>
          <small>{t('profile.devicesHint')}</small>
        </div>
        <span className="chip">
          {devices.status === 'ready'
            ? t('settings.keysCount', { count: e2eeKeys })
            : t('settings.keysEmpty')}
        </span>
      </div>
      <div className="setting-row">
        <div className="text">
          <b>{t('settings.sessions')}</b>
          <small>{t('settings.sessionsAvailable')}</small>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={onOpenProfile}
          disabled={!onOpenProfile}
        >
          {t('settings.openSessions')}
        </button>
      </div>
    </section>
  );

  return (
    <PageShell
      title={t('settings.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(securityMode)}`}
      onBack={onBack}
      actions={
        onLogout ? (
          <button
            type="button"
            className="btn page-action--secondary"
            aria-label={t('auth.logout')}
            onClick={onLogout}
          >
            <LogoutIcon aria-hidden="true" />
            {t('auth.logout')}
          </button>
        ) : undefined
      }
    >
      <div className="settings">
        <nav className="settings-nav" aria-label={t('nav.settings')}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'is-active' : ''}
              aria-current={tab === entry.id ? 'page' : undefined}
              onClick={() => setTab(entry.id)}
            >
              <TabIcon icon={entry.icon} />
              {t(entry.label)}
            </button>
          ))}
          {isAdmin && onOpenAdmin ? (
            <button type="button" onClick={onOpenAdmin}>
              <SettingsIcon aria-hidden="true" />
              {t('settings.nav.admin')}
            </button>
          ) : null}
        </nav>

        <div className="settings-pane">
          {tab === 'profile' ? (
            <>
              <section className="card" aria-labelledby="settings-profile">
                <h3 id="settings-profile">{t('settings.profile')}</h3>
                <p className="pane-sub">{t('settings.pane.profileSub')}</p>
                <div className="chat-settings-head">
                  <Avatar name={user?.display_name} seed={user?.id ?? 'me'} size="profile" />
                  <div>
                    <div className="cs-name">{user?.display_name ?? '—'}</div>
                    <small>
                      {t('settings.identityMeta', {
                        workspace: workspaceName,
                        role: roleLabel(workspace?.role ?? null),
                      })}
                    </small>
                  </div>
                  <button type="button" className="btn btn--sm" disabled>
                    {t('settings.changeAvatar')}
                  </button>
                </div>
                <div className="form-grid">
                  <div className="form-row">
                    <label htmlFor="settings-name">{t('settings.name')}</label>
                    <input
                      id="settings-name"
                      className="input"
                      value={user?.display_name ?? ''}
                      readOnly
                    />
                  </div>
                  <div className="form-row">
                    <label htmlFor="settings-email">{t('settings.email')}</label>
                    <input id="settings-email" className="input" value={email ?? ''} readOnly />
                  </div>
                </div>
                <div className="form-grid">
                  <div className="form-row">
                    <label htmlFor="settings-workspace-name">{t('settings.workspaceName')}</label>
                    <input
                      id="settings-workspace-name"
                      className="input"
                      value={workspaceName}
                      readOnly
                    />
                  </div>
                  <div className="form-row">
                    <label htmlFor="settings-role">{t('settings.workspaceRole')}</label>
                    <input
                      id="settings-role"
                      className="input"
                      value={roleLabel(workspace?.role ?? null)}
                      readOnly
                    />
                  </div>
                </div>
                <p className="pane-sub">{t('settings.readOnlyProfile')}</p>
                <div className="form-actions">
                  {onOpenProfile ? (
                    <button type="button" className="btn" onClick={onOpenProfile}>
                      <EyeIcon aria-hidden="true" />
                      {t('settings.openProfile')}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--accent" disabled>
                    {t('chatSettings.save')}
                  </button>
                </div>
              </section>
              {securityCard}
              <BlockedUsersCard />
            </>
          ) : null}

          {tab === 'appearance' ? (
            <section className="card" aria-labelledby="settings-appearance">
              <h3 id="settings-appearance">{t('settings.appearance')}</h3>
              <p className="pane-sub">{t('settings.pane.appearanceSub')}</p>
              <div className="setting-row">
                <div className="text">
                  <b>{t('settings.theme')}</b>
                  <small>{t('settings.themeHint')}</small>
                </div>
                <div className="seg" role="group" aria-label={t('settings.theme')}>
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-active' : ''}
                    aria-pressed={theme === 'light'}
                    onClick={() => onThemeChange('light')}
                  >
                    <SunIcon aria-hidden="true" />
                    {t('settings.themeLight')}
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-active' : ''}
                    aria-pressed={theme === 'dark'}
                    onClick={() => onThemeChange('dark')}
                  >
                    <MoonIcon aria-hidden="true" />
                    {t('settings.themeDark')}
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="text">
                  <b>{t('settings.density')}</b>
                  <small>{t('settings.densityHint')}</small>
                </div>
                <div className="seg" aria-disabled="true">
                  <button type="button" className="is-active" disabled>
                    {t('settings.densityCozy')}
                  </button>
                  <button type="button" disabled>
                    {t('settings.densityCompact')}
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="text">
                  <b>{t('settings.linkPreviews')}</b>
                  <small>{t('settings.linkPreviewsHint')}</small>
                </div>
                <span className="mode-chip mode-chip--mock">{t('settings.unavailableShort')}</span>
              </div>
              <div className="setting-row">
                <div className="text">
                  <b>{t('settings.feedAvatars')}</b>
                  <small>{t('settings.feedAvatarsHint')}</small>
                </div>
                <span className="mode-chip mode-chip--mock">{t('settings.unavailableShort')}</span>
              </div>
              <div className="setting-row">
                <div className="text">
                  <b>{t('settings.accent')}</b>
                  <small>{t('settings.accentHint')}</small>
                </div>
                <div className="swatches" aria-hidden="true">
                  <span className="swatch is-active" style={{ background: '#65BD45' }} />
                  <span className="swatch" style={{ background: '#D9A441' }} />
                  <span className="swatch" style={{ background: '#E85D4A' }} />
                  <span className="swatch" style={{ background: '#2F7A38' }} />
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'notifications' ? (
            <section className="card" aria-labelledby="settings-notifications">
              <h3 id="settings-notifications">{t('settings.notifications')}</h3>
              <p className="pane-sub">{t('settings.pane.notificationsSub')}</p>
              {state.notificationPreferences.items.length === 0 ? (
                <p className="card-empty">{t('settings.noPreferences')}</p>
              ) : (
                state.notificationPreferences.items.slice(0, 6).map((pref) => (
                  <div
                    className="setting-row"
                    key={`${pref.chat_id ?? 'global'}-${pref.type}-${pref.channel}`}
                  >
                    <div className="text">
                      <b>
                        {t('settings.preferenceRow', {
                          type: t(
                            TYPE_LABEL[pref.type] ?? 'notifications.preferences.type.MESSAGE',
                          ),
                          channel: t(
                            CHANNEL_LABEL[pref.channel] ??
                              'notifications.preferences.channel.IN_APP',
                          ),
                        })}
                      </b>
                      <small>
                        {pref.chat_id ? pref.chat_id : t('notifications.preferences.type')}
                      </small>
                    </div>
                    <span className="chip">
                      {t(MODE_LABEL[pref.mode] ?? 'notifications.preferences.modeLabel.ALL')}
                    </span>
                  </div>
                ))
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn--accent"
                  onClick={() => setNotificationsOpen(true)}
                >
                  <BellIcon aria-hidden="true" />
                  {t('notifications.preferences.open')}
                </button>
              </div>
            </section>
          ) : null}

          {tab === 'workspace' ? (
            <>
              <section className="card" aria-labelledby="settings-workspace">
                <h3 id="settings-workspace">{t('settings.workspaceSection')}</h3>
                <p className="pane-sub">{t('settings.pane.workspaceSub')}</p>
                <div className="form-row">
                  <label htmlFor="workspace-name">{t('settings.workspaceName')}</label>
                  <input id="workspace-name" className="input" value={workspaceName} readOnly />
                </div>
                <div className="form-row">
                  <label htmlFor="workspace-mode">{t('settings.workspaceMode')}</label>
                  <input
                    id="workspace-mode"
                    className="input"
                    value={securityModeLabel(securityMode)}
                    readOnly
                  />
                </div>
                <div className="setting-row">
                  <div className="text">
                    <b>{t('settings.inviteLink')}</b>
                    <small>{t('settings.inviteUnavailable')}</small>
                  </div>
                  <span className="mode-chip mode-chip--mock">
                    {t('settings.unavailableShort')}
                  </span>
                </div>
                <div className="form-grid">
                  <div className="form-row">
                    <label htmlFor="workspace-tariff">{t('settings.tariff')}</label>
                    <input
                      id="workspace-tariff"
                      className="input"
                      value={tariffLabel(limits?.tariff)}
                      readOnly
                    />
                  </div>
                  <div className="form-row">
                    <label htmlFor="workspace-storage">{t('settings.workspaceStorage')}</label>
                    <input
                      id="workspace-storage"
                      className="input"
                      value={limits ? `${storageUsed(limits)} / ${storageLimit(limits)}` : '—'}
                      readOnly
                    />
                  </div>
                  <div className="form-row">
                    <label htmlFor="workspace-chats">{t('settings.workspaceChats')}</label>
                    <input
                      id="workspace-chats"
                      className="input"
                      value={limits ? `${limits.chats_used} / ${limits.max_chats_per_user}` : '—'}
                      readOnly
                    />
                  </div>
                  <div className="form-row">
                    <label htmlFor="workspace-file">{t('settings.workspaceMaxFile')}</label>
                    <input
                      id="workspace-file"
                      className="input"
                      value={limits ? formatBytes(limits.max_file_bytes) : '—'}
                      readOnly
                    />
                  </div>
                </div>
                <div className="setting-row">
                  <div className="text">
                    <b>{t('settings.chatsUsed')}</b>
                    <small>
                      {limits
                        ? t('chat.create.limitUsage', {
                            used: limits.chats_used,
                            limit: limits.max_chats_per_user,
                          })
                        : t('files.limitsPending')}
                    </small>
                  </div>
                  <span className="chip">
                    {limits ? `${limits.chats_used}/${limits.max_chats_per_user}` : '—'}
                  </span>
                </div>
                <div className="form-actions">
                  <button type="button" className="btn" onClick={onOpenMembers}>
                    <PeopleIcon aria-hidden="true" />
                    {t('settings.workspaceMembers')}
                  </button>
                  {isAdmin && onOpenAdmin ? (
                    <button type="button" className="btn btn--accent" onClick={onOpenAdmin}>
                      <SettingsIcon aria-hidden="true" />
                      {t('settings.adminOpen')}
                    </button>
                  ) : (
                    <button type="button" className="btn" disabled title={t('settings.noAdmin')}>
                      <LockIcon aria-hidden="true" />
                      {t('settings.adminOpen')}
                    </button>
                  )}
                </div>
              </section>
            </>
          ) : null}

          {tab === 'devices' ? (
            <section className="card" aria-labelledby="settings-devices">
              <h3 id="settings-devices">{t('settings.device')}</h3>
              <p className="pane-sub">{t('settings.pane.devicesSub')}</p>
              {devices.status === 'loading' && devices.items.length === 0 ? (
                <p className="card-empty" role="status">
                  {t('settings.devicesLoad')}
                </p>
              ) : null}
              {devicesError ? (
                <div className="pg-inline-error" role="alert">
                  <p>{t('settings.devicesError')}</p>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void store.loadDevices(true)}
                  >
                    {t('common.retry')}
                  </button>
                </div>
              ) : null}
              {devices.items.length === 0 && devices.status === 'ready' ? (
                <p className="card-empty">{t('settings.devicesEmpty')}</p>
              ) : null}
              {devices.items.map((item) => (
                <div className="device-row" key={item.id}>
                  {item.platform === 'WEB' ? (
                    <MonitorIcon aria-hidden="true" />
                  ) : (
                    <SmartphoneIcon aria-hidden="true" />
                  )}
                  <span className="name">
                    <b>{item.name?.trim() || t('profile.deviceNoName')}</b>
                    <small>
                      {t('settings.deviceIdShort', { id: item.id })} ·{' '}
                      {item.last_seen_at ? formatDateTime(item.last_seen_at) : '—'}
                    </small>
                  </span>
                  {item.id === device?.id ? (
                    <span className="state">{t('settings.deviceCurrent')}</span>
                  ) : null}
                </div>
              ))}
              {device ? (
                <p className="pg-footnote">
                  {t('settings.deviceId')}: <span className="mono">{device.id}</span>
                </p>
              ) : null}
              <div className="form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={onOpenProfile}
                  disabled={!onOpenProfile}
                >
                  {t('settings.openSessions')}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <NotificationPreferencesDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </PageShell>
  );
}
