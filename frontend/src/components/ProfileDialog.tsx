import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../api/problem';
import type { Device, ProfileSession, ProfileUpdate } from '../api/types';
import { describeError } from '../domain/errors';
import { t, type MessageKey } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import type { Theme } from '../theme/themePreference';
import { formatDateTime } from './admin/format';
import { AdminConfirmDialog } from './admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from './admin/actionErrors';
import { Avatar } from './Avatar';
import { BlockedUsersCard } from './BlockedUsersCard';
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

type ProfileField = 'display_name' | 'bio' | 'phone';
type ProfileFieldErrors = Partial<Record<ProfileField, string>>;

interface ProfileFormState {
  display_name: string;
  bio: string;
  phone: string;
}

const EMPTY_FORM: ProfileFormState = { display_name: '', bio: '', phone: '' };

/**
 * Client-side mirror of the server bounds (display_name 1..80, bio ≤280,
 * phone ≤32) after the same `trim()` the value objects apply. The server stays
 * authoritative: its `details.field` is surfaced on the matching control.
 */
function validateProfile(form: ProfileFormState): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};
  const displayName = form.display_name.trim();
  if (!displayName) {
    errors.display_name = t('profile.validation.nameRequired');
  } else if (displayName.length > 80) {
    errors.display_name = t('profile.validation.nameTooLong');
  }
  if (form.bio.trim().length > 280) {
    errors.bio = t('profile.validation.bioTooLong');
  }
  if (form.phone.trim().length > 32) {
    errors.phone = t('profile.validation.phoneTooLong');
  }
  return errors;
}

function isProfileField(value: unknown): value is ProfileField {
  return value === 'display_name' || value === 'bio' || value === 'phone';
}

function sessionName(session: ProfileSession): string {
  return session.name?.trim() || t('profile.sessionNoName');
}

function revokeErrorInfo(error: ApiError): AdminActionErrorInfo {
  if (error.status === 503) {
    return {
      text: t('profile.sessions.unavailable'),
      tone: 'error',
      retryable: true,
      closeOnError: false,
    };
  }
  if (error.isNetwork || error.status >= 500) {
    return {
      text: describeError(error).message,
      tone: 'error',
      retryable: true,
      closeOnError: false,
    };
  }
  return {
    text: t('profile.sessions.revokeError'),
    tone: 'error',
    retryable: false,
    closeOnError: false,
  };
}

export interface ProfileDialogProps {
  open: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
  onLogout?: () => void;
}

/**
 * D1 UX fidelity 2 profile modal (+ #72).
 *
 * - Identity/workspace from `/me`; devices from `GET /devices`.
 * - Profile edit is a partial `PATCH /me` (display_name/bio/phone only, no
 *   email/password/2FA). Bounds are mirrored client-side; the server result
 *   replaces the store's user, and nothing is patched optimistically.
 * - Sessions come from `GET /me/sessions`; revoke is `DELETE` with an explicit
 *   confirmation and a list re-read (no optimistic row removal).
 * - 2FA stays an honest disabled row: the contract has no authenticator API.
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
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const titleId = useId();
  const leadId = useId();
  const nameId = useId();
  const bioId = useId();
  const phoneId = useId();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  const [sessions, setSessions] = useState<ProfileSession[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [sessionsError, setSessionsError] = useState<ApiError | null>(null);
  const [sessionsReload, setSessionsReload] = useState(0);
  const [sessionsNotice, setSessionsNotice] = useState<MessageKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ProfileSession | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<ApiError | null>(null);

  const profileUser = state.me?.user ?? state.user ?? null;
  const user = profileUser ?? state.session?.user ?? null;
  const email = state.me?.user.email ?? null;
  const workspace = state.activeWorkspace;
  const workspaceName = workspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const role = workspace?.role ?? null;
  const isPlatformAdmin = state.me?.user.is_platform_admin === true;
  const currentDeviceId = state.device?.id ?? null;
  const e2eeDevices = devices.items.filter((device) => device.e2ee_capable !== false).length;
  const handle = email ? `@${email.split('@')[0]}` : t('profile.title');
  const bio = profileUser?.bio?.trim() ?? '';
  const phone = profileUser?.phone?.trim() ?? '';

  function startEditing() {
    setForm({
      display_name: user?.display_name ?? '',
      bio: bio,
      phone: phone,
    });
    setFieldErrors({});
    setSaveError(null);
    setSaved(false);
    setEditing(true);
  }

  const cancelEditing = useCallback(() => {
    if (saving) return;
    setEditing(false);
    setFieldErrors({});
    setSaveError(null);
  }, [saving]);

  useEffect(() => {
    if (!open) return;
    void store.loadProfile();
    void store.loadDevices();
  }, [open, store]);

  // #72: one sessions read per open/retry; the component owns list state.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setSessionsStatus('loading');
    setSessionsError(null);
    void store.listMySessions().then((result) => {
      if (!active) return;
      if (result.error) {
        setSessions([]);
        setSessionsStatus('error');
        setSessionsError(result.error);
        return;
      }
      setSessions(result.sessions);
      setSessionsStatus('ready');
    });
    return () => {
      active = false;
    };
  }, [open, sessionsReload, store]);

  useEffect(() => {
    if (!open) {
      setNotificationsOpen(false);
      setConfirmLogout(false);
      setLoggingOut(false);
      setEditing(false);
      setFieldErrors({});
      setSaveError(null);
      setSaving(false);
      setSaved(false);
      setRevokeTarget(null);
      setRevokeError(null);
      setRevoking(false);
      setSessionsNotice(null);
      setSessionsStatus('idle');
      setSessionsError(null);
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

  // Return focus to the edit trigger after save/cancel, never on first render.
  useEffect(() => {
    if (wasEditing.current && !editing) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  // Opening the form focuses the first field so keyboard users land in it.
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Nested dialogs own focus/Escape while they are mounted.
      if (notificationsOpen || confirmLogout || revokeTarget) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (editing) {
          cancelEditing();
          return;
        }
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
  }, [
    cancelEditing,
    confirmLogout,
    editing,
    notificationsOpen,
    onClose,
    open,
    revokeTarget,
    saving,
  ]);

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

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    const nextErrors = validateProfile(form);
    setFieldErrors(nextErrors);
    setSaveError(null);
    if (Object.keys(nextErrors).length > 0) {
      const first = (['display_name', 'bio', 'phone'] as const).find((field) => nextErrors[field]);
      if (first === 'display_name') nameRef.current?.focus();
      else if (first === 'bio') bioRef.current?.focus();
      else if (first === 'phone') phoneRef.current?.focus();
      return;
    }

    // Incremental patch: only changed fields; empty bio/phone clear to null.
    const patch: ProfileUpdate = {};
    const nextName = form.display_name.trim();
    const nextBio = form.bio.trim();
    const nextPhone = form.phone.trim();
    if (nextName !== (user?.display_name ?? '').trim()) patch.display_name = nextName;
    if (nextBio !== bio) patch.bio = nextBio || null;
    if (nextPhone !== phone) patch.phone = nextPhone || null;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    const result = await store.updateProfile(patch);
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
      const field = result.error.details?.field;
      if (isProfileField(field)) {
        setFieldErrors({ [field]: t('profile.validation.rejected') });
      }
      return;
    }

    setSaved(true);
    setEditing(false);
    setFieldErrors({});
  };

  const handleRevoke = async () => {
    const target = revokeTarget;
    if (!target || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    const error = await store.revokeMySession(target.id);
    setRevoking(false);

    if (!error) {
      setRevokeTarget(null);
      setSessionsNotice(
        target.current ? 'profile.sessionCurrentRevoked' : 'profile.sessionRevoked',
      );
      setSessionsReload((value) => value + 1);
      return;
    }
    if (error.status === 404) {
      // Already revoked on the server: reconcile by re-reading the list.
      setRevokeTarget(null);
      setSessionsNotice('profile.sessions.alreadyRevoked');
      setSessionsReload((value) => value + 1);
      return;
    }
    setRevokeError(error);
  };

  const deviceStatus = (device: Device): string =>
    device.status ? t(DEVICE_STATUS_LABEL[device.status]) : '—';

  const sessionsMessage = sessionsError
    ? sessionsError.status === 503
      ? t('profile.sessions.unavailable')
      : t('profile.sessionsLoadError')
    : null;
  const saveErrorText = saveError
    ? saveError.status === 503
      ? t('profile.saveUnavailable')
      : t('profile.saveError')
    : null;
  const revokeInfo = revokeError ? revokeErrorInfo(revokeError) : null;

  return (
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !confirmLogout && !revokeTarget && !editing) {
          onClose();
        }
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
            {!editing ? (
              <button
                ref={editButtonRef}
                type="button"
                className="btn btn--sm"
                onClick={startEditing}
              >
                {t('profile.edit')}
              </button>
            ) : null}
          </div>

          {saved && !editing ? (
            <p className="profile-saved" role="status">
              {t('profile.saved')}
            </p>
          ) : null}

          {editing ? (
            <form className="profile-form" onSubmit={(event) => void handleSave(event)} noValidate>
              <div className="profile-form__grid">
                <div className="profile-field">
                  <label htmlFor={nameId}>{t('profile.field.displayName')}</label>
                  <input
                    ref={nameRef}
                    id={nameId}
                    name="display_name"
                    type="text"
                    autoComplete="name"
                    value={form.display_name}
                    aria-invalid={fieldErrors.display_name ? true : undefined}
                    aria-describedby={`${nameId}-hint`}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, display_name: event.target.value }))
                    }
                  />
                  {fieldErrors.display_name ? (
                    <small className="profile-field__error" id={`${nameId}-hint`}>
                      {fieldErrors.display_name}
                    </small>
                  ) : (
                    <small className="profile-field__hint" id={`${nameId}-hint`}>
                      {t('profile.field.nameHint', { count: form.display_name.trim().length })}
                    </small>
                  )}
                </div>

                <div className="profile-field">
                  <label htmlFor={phoneId}>{t('profile.field.phone')}</label>
                  <input
                    ref={phoneRef}
                    id={phoneId}
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={form.phone}
                    aria-invalid={fieldErrors.phone ? true : undefined}
                    aria-describedby={`${phoneId}-hint`}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, phone: event.target.value }))
                    }
                  />
                  {fieldErrors.phone ? (
                    <small className="profile-field__error" id={`${phoneId}-hint`}>
                      {fieldErrors.phone}
                    </small>
                  ) : (
                    <small className="profile-field__hint" id={`${phoneId}-hint`}>
                      {t('profile.field.phoneHint', { count: form.phone.trim().length })}
                    </small>
                  )}
                </div>

                <div className="profile-field profile-field--wide">
                  <label htmlFor={bioId}>{t('profile.field.bio')}</label>
                  <textarea
                    ref={bioRef}
                    id={bioId}
                    name="bio"
                    rows={3}
                    value={form.bio}
                    aria-invalid={fieldErrors.bio ? true : undefined}
                    aria-describedby={`${bioId}-hint`}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, bio: event.target.value }))
                    }
                  />
                  {fieldErrors.bio ? (
                    <small className="profile-field__error" id={`${bioId}-hint`}>
                      {fieldErrors.bio}
                    </small>
                  ) : (
                    <small className="profile-field__hint" id={`${bioId}-hint`}>
                      {t('profile.field.bioHint', { count: form.bio.trim().length })}
                    </small>
                  )}
                </div>
              </div>

              {saveErrorText ? (
                <p className="profile-form__error" role="alert">
                  {saveErrorText}
                </p>
              ) : null}

              <div className="profile-form__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={cancelEditing}
                  disabled={saving}
                >
                  {t('profile.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn btn--accent btn--sm"
                  disabled={saving}
                  aria-busy={saving}
                >
                  {saving ? t('profile.saving') : t('profile.save')}
                </button>
              </div>
            </form>
          ) : (
            <div className="profile-cards">
              <section className="mini-card" aria-labelledby="profile-about">
                <h4 id="profile-about">{t('profile.about')}</h4>
                <p className="mini-card__text">{bio || t('profile.aboutEmpty')}</p>
              </section>

              <section className="mini-card" aria-labelledby="profile-contacts">
                <h4 id="profile-contacts">{t('profile.contacts')}</h4>
                <div className="mini-row">
                  <span>{t('profile.email')}</span>
                  <span>{email ?? '—'}</span>
                </div>
                <div className="mini-row">
                  <span>{t('profile.phone')}</span>
                  <span>{phone || t('profile.phoneEmpty')}</span>
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
                  <span>{t('profile.sessionsHint')}</span>
                </div>
              </section>

              <BlockedUsersCard />
            </div>
          )}

          <section className="mini-card profile-sessions" aria-labelledby="profile-sessions-card">
            <div className="profile-sessions__head">
              <h4 id="profile-sessions-card">{t('profile.sessions')}</h4>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setSessionsReload((value) => value + 1)}
                disabled={sessionsStatus === 'loading'}
              >
                <RefreshIcon aria-hidden="true" />
                {t('profile.sessionsRefresh')}
              </button>
            </div>

            {sessionsNotice ? (
              <p className="mini-card__note" role="status">
                {t(sessionsNotice)}
              </p>
            ) : null}

            {sessionsStatus === 'loading' ? (
              <p className="mini-card__text" role="status">
                {t('profile.sessionsLoading')}
              </p>
            ) : null}

            {sessionsStatus === 'error' ? (
              <div className="mini-card__error" role="alert">
                <p>{sessionsMessage ?? t('profile.sessionsLoadError')}</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setSessionsReload((value) => value + 1)}
                >
                  <RefreshIcon aria-hidden="true" />
                  {t('common.retry')}
                </button>
              </div>
            ) : null}

            {sessionsStatus === 'ready' && sessions.length === 0 ? (
              <p className="mini-card__text">{t('profile.sessionsEmpty')}</p>
            ) : null}

            {sessions.map((session) => (
              <div className="mini-session" key={session.id}>
                <div className="mini-row">
                  <span>{sessionName(session)}</span>
                  {session.current ? (
                    <span className="mode-chip mode-chip--mock">{t('profile.sessionCurrent')}</span>
                  ) : null}
                </div>
                <div className="mini-row mini-row--muted">
                  <span>{t('profile.sessionLastAccess')}</span>
                  <span>{formatDateTime(session.last_access_at)}</span>
                </div>
                <div className="mini-row mini-row--muted">
                  <span>{t('profile.sessionCreated')}</span>
                  <span>{formatDateTime(session.created_at)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label={t('profile.sessionRevokeAria', { name: sessionName(session) })}
                  onClick={() => {
                    setRevokeError(null);
                    setRevokeTarget(session);
                  }}
                >
                  {t('profile.sessionRevoke')}
                </button>
              </div>
            ))}
          </section>

          {!editing ? (
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
          ) : null}
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

      {revokeTarget ? (
        <AdminConfirmDialog
          title={t('profile.confirm.revokeTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('profile.confirm.revokeLead', { name: sessionName(revokeTarget) })}
              </p>
              <ul className="admin-confirm__list">
                <li>
                  {revokeTarget.current
                    ? t('profile.confirm.revokeCurrent')
                    : t('profile.confirm.revokeOther')}
                </li>
              </ul>
            </>
          }
          confirmLabel={t('profile.confirm.revokeConfirm')}
          busyLabel={t('profile.confirm.revoking')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={revoking}
          error={revokeInfo}
          errorDetails={revokeError}
          onConfirm={() => void handleRevoke()}
          onClose={() => {
            if (revoking) return;
            setRevokeTarget(null);
            setRevokeError(null);
          }}
        />
      ) : null}
    </div>
  );
}
