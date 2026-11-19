import { useEffect, useId, useRef, useState } from 'react';
import type { Device } from '../api/types';
import { describeError } from '../domain/errors';
import { t, type MessageKey } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import type { Theme } from '../theme/themePreference';
import { formatDateTime } from './admin/format';
import { AdminConfirmDialog } from './admin/AdminConfirmDialog';
import { Avatar } from './Avatar';
import { BellIcon, CloseIcon, LogoutIcon, MoonIcon, RefreshIcon, SunIcon } from './Icons';
import { NotificationPreferencesDialog } from './NotificationPreferencesDialog';
import { roleLabel } from './pages/pageData';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const DEVICE_STATUS_LABEL: Record<NonNullable<Device['status']>, MessageKey> = {
  ACTIVE: 'profile.deviceStatus.ACTIVE',
  PENDING: 'profile.deviceStatus.PENDING',
  REVOKED: 'profile.deviceStatus.REVOKED',
};

export interface ProfileDialogProps {
  open: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
  onLogout?: () => void;
}

/**
 * D1 UX fidelity 2 profile modal.
 *
 * - 540 px / r18 / 58 px header from `design/dashboard`, 2×2 mini-cards.
 * - Identity and workspace come from `/me`; devices from `GET /devices`.
 * - 2FA and session termination have no API and are honest disabled rows.
 * - Theme and notification preferences are the settings that already exist;
 *   they live in an extra compact section below the design's four cards.
 * - Modal semantics: focus trap, Escape, focus return, nested dialogs.
 */
export function ProfileDialog({
  open,
  theme,
  onThemeChange,
  onClose,
  onLogout,
}: ProfileDialogProps) {
  const store = useChatStore();
  const state = useChatState();
  const devices = state.devices;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leadId = useId();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const user = state.me?.user ?? state.user ?? state.session?.user ?? null;
  const email = state.me?.user.email ?? null;
  const workspace = state.activeWorkspace;
  const workspaceName = workspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const role = workspace?.role ?? null;
  const isPlatformAdmin = state.me?.user.is_platform_admin === true;
  const currentDeviceId = state.device?.id ?? null;
  const e2eeDevices = devices.items.filter((device) => device.e2ee_capable !== false).length;
  const handle = email ? `@${email.split('@')[0]}` : t('profile.title');

  useEffect(() => {
    if (!open) return;
    void store.loadDevices();
  }, [open, store]);

  useEffect(() => {
    if (!open) {
      setNotificationsOpen(false);
      setConfirmLogout(false);
      setLoggingOut(false);
      return;
    }
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Nested dialogs own focus/Escape while they are mounted.
      if (notificationsOpen || confirmLogout) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [confirmLogout, notificationsOpen, onClose, open]);

  if (!open) return null;

  const handleConfirmLogout = async () => {
    if (!onLogout || loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  const deviceStatus = (device: Device): string =>
    device.status ? t(DEVICE_STATUS_LABEL[device.status]) : '—';

  return (
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !confirmLogout) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal--sm profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {t('profile.title')}
          </h2>
          <span className="modal-sub">{handle}</span>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label={t('profile.close')}
            title={t('profile.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <div className="profile-hero">
            <Avatar name={user?.display_name} seed={user?.id ?? 'me'} size="profile" />
            <div>
              <h3>{user?.display_name ?? '—'}</h3>
              <p id={leadId}>
                {state.online ? t('profile.connected') : t('profile.disconnected')} ·{' '}
                <span>{roleLabel(role)}</span>
              </p>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled
              title={t('profile.editUnavailable')}
            >
              {t('profile.edit')}
            </button>
          </div>

          <div className="profile-cards">
            <section className="mini-card" aria-labelledby="profile-about">
              <h4 id="profile-about">{t('profile.about')}</h4>
              <p className="mini-card__text">{t('profile.aboutEmpty')}</p>
            </section>

            <section className="mini-card" aria-labelledby="profile-contacts">
              <h4 id="profile-contacts">{t('profile.contacts')}</h4>
              <div className="mini-row">
                <span>{t('profile.email')}</span>
                <span>{email ?? '—'}</span>
              </div>
              <div className="mini-row">
                <span>{t('profile.contactWorkspace')}</span>
                <span>{workspaceName}</span>
              </div>
              <div className="mini-row">
                <span>{t('profile.contactAdmin')}</span>
                <span>{isPlatformAdmin ? t('common.yes') : '—'}</span>
              </div>
            </section>

            <section className="mini-card" aria-labelledby="profile-devices">
              <h4 id="profile-devices">{t('profile.devices')}</h4>
              {devices.status === 'loading' && devices.items.length === 0 ? (
                <p className="mini-card__text" role="status">
                  {t('profile.devicesLoading')}
                </p>
              ) : null}
              {devices.status === 'error' ? (
                <div className="mini-card__error" role="alert">
                  <p>
                    {devices.error
                      ? describeError(devices.error).message
                      : t('profile.devicesError')}
                  </p>
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
                <p className="mini-card__text">{t('profile.devicesEmpty')}</p>
              ) : null}
              {devices.items.map((device) => (
                <div className="mini-device" key={device.id}>
                  <div className="mini-row">
                    <span>{device.name?.trim() || t('profile.deviceNoName')}</span>
                    <span>
                      {device.id === currentDeviceId
                        ? t('profile.deviceCurrent')
                        : deviceStatus(device)}
                    </span>
                  </div>
                  <div className="mini-row mini-row--muted">
                    <span>{device.platform}</span>
                    <span>{device.last_seen_at ? formatDateTime(device.last_seen_at) : '—'}</span>
                  </div>
                  <span className="mini-card__mono">{device.id}</span>
                </div>
              ))}
            </section>

            <section className="mini-card" aria-labelledby="profile-security">
              <h4 id="profile-security">{t('profile.security')}</h4>
              <div className="mini-row">
                <span>{t('profile.twoFactor')}</span>
                <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
              </div>
              <p className="mini-card__note">{t('profile.twoFactorUnavailable')}</p>
              <div className="mini-row">
                <span>{t('profile.securityKeys')}</span>
                <span>
                  {devices.status === 'ready'
                    ? t('profile.keysDevices', { count: e2eeDevices })
                    : t('profile.keysEmpty')}
                </span>
              </div>
              <div className="mini-row">
                <span>{t('profile.sessions')}</span>
                <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
              </div>
              <p className="mini-card__note">{t('profile.sessionsUnavailable')}</p>
            </section>
          </div>

          <div className="profile-cards profile-cards--secondary">
            <section className="mini-card" aria-labelledby="profile-appearance">
              <h4 id="profile-appearance">{t('profile.appearanceSection')}</h4>
              <div className="seg" role="group" aria-label={t('profile.theme')}>
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
            </section>
            <section className="mini-card" aria-labelledby="profile-notifications">
              <h4 id="profile-notifications">{t('profile.notificationsSection')}</h4>
              <p className="mini-card__note">{t('profile.notificationsHint')}</p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setNotificationsOpen(true)}
              >
                <BellIcon aria-hidden="true" />
                {t('profile.openNotifications')}
              </button>
            </section>
          </div>
        </div>

        <div className="modal-foot">
          {onLogout ? (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setConfirmLogout(true)}
            >
              <LogoutIcon aria-hidden="true" />
              {t('auth.logout')}
            </button>
          ) : (
            <button type="button" className="btn btn--danger" disabled>
              <LogoutIcon aria-hidden="true" />
              {t('auth.logout')}
            </button>
          )}
          <button type="button" className="btn btn--accent" onClick={onClose}>
            {t('profile.done')}
          </button>
        </div>
      </div>

      <NotificationPreferencesDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />

      {confirmLogout ? (
        <AdminConfirmDialog
          title={t('profile.confirm.logoutTitle')}
          description={
            <>
              <p className="admin-confirm__lead">{t('profile.confirm.logoutLead')}</p>
              <ul className="admin-confirm__list">
                <li>{t('profile.confirm.logoutEffect')}</li>
              </ul>
            </>
          }
          confirmLabel={t('profile.confirm.logoutConfirm')}
          busyLabel={t('profile.confirm.loggingOut')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={loggingOut}
          error={null}
          onConfirm={() => void handleConfirmLogout()}
          onClose={() => {
            if (loggingOut) return;
            setConfirmLogout(false);
          }}
        />
      ) : null}
    </div>
  );
}
