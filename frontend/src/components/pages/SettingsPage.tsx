import { useState } from 'react';
import { formatBytes } from '../../files/format';
import { t } from '../../i18n/ru';
import { useChatState } from '../../store/ChatProvider';
import type { Theme } from '../../theme/themePreference';
import { LockIcon, LogoutIcon, MoonIcon, PeopleIcon, SettingsIcon, SunIcon } from '../Icons';
import { NotificationPreferencesDialog } from '../NotificationPreferencesDialog';
import { PageShell } from './PageShell';
import { roleLabel, storageLimit, storageUsed, tariffLabel } from './pageData';

interface SettingsPageProps {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onBack: () => void;
  onOpenAdmin?: () => void;
  onOpenMembers: () => void;
  /** D1-FE5: opens the profile modal over the settings page. */
  onOpenProfile?: () => void;
  onLogout?: () => void;
}

/**
 * D1-FE1: only settings that actually exist in this slice — the `/me` profile,
 * the device row, the workspace role/mode, real limits, the existing
 * notification-preferences dialog and the platform-admin console. No invented
 * toggles or fields.
 */
export function SettingsPage({
  theme,
  onThemeChange,
  onBack,
  onOpenAdmin,
  onOpenMembers,
  onOpenProfile,
  onLogout,
}: SettingsPageProps) {
  const state = useChatState();
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

  return (
    <PageShell
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      onBack={onBack}
      actions={
        onLogout ? (
          <button type="button" className="button button--secondary" onClick={onLogout}>
            <LogoutIcon aria-hidden="true" />
            {t('auth.logout')}
          </button>
        ) : undefined
      }
    >
      <div className="settings-grid">
        <section className="page-card" aria-labelledby="settings-profile">
          <header className="page-card__head">
            <h2 className="page-card__title" id="settings-profile">
              {t('settings.profile')}
            </h2>
          </header>
          <dl className="settings-list">
            <div className="settings-list__row">
              <dt>{t('settings.name')}</dt>
              <dd>{user?.display_name ?? '—'}</dd>
            </div>
            {email ? (
              <div className="settings-list__row">
                <dt>{t('settings.email')}</dt>
                <dd>{email}</dd>
              </div>
            ) : null}
            <div className="settings-list__row">
              <dt>{t('settings.workspace')}</dt>
              <dd>{workspaceName}</dd>
            </div>
            <div className="settings-list__row">
              <dt>{t('settings.role')}</dt>
              <dd>{roleLabel(workspace?.role ?? null)}</dd>
            </div>
          </dl>
          {onOpenProfile ? (
            <div className="page-card__actions">
              <button type="button" className="button button--secondary" onClick={onOpenProfile}>
                {t('settings.openProfile')}
              </button>
            </div>
          ) : null}
        </section>

        <section className="page-card" aria-labelledby="settings-appearance">
          <header className="page-card__head">
            <h2 className="page-card__title" id="settings-appearance">
              {t('settings.appearance')}
            </h2>
          </header>
          <p className="page-card__hint">{t('settings.themeHint')}</p>
          <div className="theme-switch" role="group" aria-label={t('settings.theme')}>
            <button
              type="button"
              className={`theme-switch__option${theme === 'light' ? ' theme-switch__option--active' : ''}`}
              aria-pressed={theme === 'light'}
              onClick={() => onThemeChange('light')}
            >
              <SunIcon aria-hidden="true" />
              {t('settings.themeLight')}
            </button>
            <button
              type="button"
              className={`theme-switch__option${theme === 'dark' ? ' theme-switch__option--active' : ''}`}
              aria-pressed={theme === 'dark'}
              onClick={() => onThemeChange('dark')}
            >
              <MoonIcon aria-hidden="true" />
              {t('settings.themeDark')}
            </button>
          </div>
        </section>

        <section className="page-card" aria-labelledby="settings-notifications">
          <header className="page-card__head">
            <h2 className="page-card__title" id="settings-notifications">
              {t('settings.notifications')}
            </h2>
          </header>
          <p className="page-card__hint">{t('settings.notificationsHint')}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setNotificationsOpen(true)}
          >
            {t('notifications.preferences.open')}
          </button>
        </section>

        <section className="page-card" aria-labelledby="settings-workspace">
          <header className="page-card__head">
            <h2 className="page-card__title" id="settings-workspace">
              {t('settings.workspaceSection')}
            </h2>
          </header>
          <dl className="settings-list">
            <div className="settings-list__row">
              <dt>{t('settings.securityMode')}</dt>
              <dd>
                <span className={`security-badge security-badge--${securityMode.toLowerCase()}`}>
                  <LockIcon aria-hidden="true" />
                  {securityMode === 'MANAGED' ? t('chat.managed') : t('chat.e2ee')}
                </span>
              </dd>
            </div>
            <div className="settings-list__row">
              <dt>{t('settings.tariff')}</dt>
              <dd>{tariffLabel(limits?.tariff)}</dd>
            </div>
            <div className="settings-list__row">
              <dt>{t('settings.chatsUsed')}</dt>
              <dd>{limits ? `${limits.chats_used} / ${limits.max_chats_per_user}` : '—'}</dd>
            </div>
            <div className="settings-list__row">
              <dt>{t('settings.storageUsed')}</dt>
              <dd>{limits ? `${storageUsed(limits)} / ${storageLimit(limits)}` : '—'}</dd>
            </div>
            <div className="settings-list__row">
              <dt>{t('settings.maxFile')}</dt>
              <dd>{limits ? formatBytes(limits.max_file_bytes) : '—'}</dd>
            </div>
          </dl>
          <div className="page-card__actions">
            <button type="button" className="button button--secondary" onClick={onOpenMembers}>
              <PeopleIcon aria-hidden="true" />
              {t('members.open')}
            </button>
            {isAdmin && onOpenAdmin ? (
              <button type="button" className="button button--secondary" onClick={onOpenAdmin}>
                <SettingsIcon aria-hidden="true" />
                {t('admin.open')}
              </button>
            ) : null}
          </div>
        </section>

        <section className="page-card" aria-labelledby="settings-device">
          <header className="page-card__head">
            <h2 className="page-card__title" id="settings-device">
              {t('settings.device')}
            </h2>
          </header>
          {device ? (
            <dl className="settings-list">
              <div className="settings-list__row">
                <dt>{t('settings.deviceId')}</dt>
                <dd className="settings-list__mono">{device.id}</dd>
              </div>
              <div className="settings-list__row">
                <dt>{t('settings.deviceName')}</dt>
                <dd>{device.name?.trim() || t('sidebar.device')}</dd>
              </div>
              <div className="settings-list__row">
                <dt>{t('settings.platform')}</dt>
                <dd>{device.platform}</dd>
              </div>
            </dl>
          ) : (
            <p className="page-card__empty">{t('settings.deviceUnavailable')}</p>
          )}
        </section>
      </div>

      <NotificationPreferencesDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </PageShell>
  );
}
