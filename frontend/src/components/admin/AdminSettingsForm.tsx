import { useId, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { AdminSettings, AdminSettingsPatch } from '../../api/types';
import { t } from '../../i18n/ru';
import type { TestEmailStatus } from '../../ops/store';

export type AdminSettingsMode = 'setup' | 'admin';

interface FormState {
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpStarttls: boolean;
  maxChatsPerUser: string;
  maxChatsPerWorkspace: string;
  maxWorkspaceMembers: string;
  registrationOpen: boolean;
  allowedFileExtensions: string;
  testEmail: string;
}

interface AdminSettingsFormProps {
  mode: AdminSettingsMode;
  settings: AdminSettings;
  saving: boolean;
  saveError: ApiError | null;
  testEmailStatus: TestEmailStatus;
  testEmailError: ApiError | null;
  testEmailTo: string | null;
  defaultTestEmail: string;
  onSave: (patch: AdminSettingsPatch, completeSetup: boolean) => Promise<boolean>;
  onTestEmail: (to: string) => Promise<boolean>;
}

const MAX_LIMIT = 1_000_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initialForm(settings: AdminSettings, defaultTestEmail: string): FormState {
  return {
    smtpHost: settings.smtp_host ?? '',
    smtpPort: settings.smtp_port === null ? '' : String(settings.smtp_port),
    smtpUsername: settings.smtp_username ?? '',
    // Password is write-only: it is never hydrated from the server response.
    smtpPassword: '',
    smtpFrom: settings.smtp_from ?? '',
    smtpStarttls: settings.smtp_starttls,
    maxChatsPerUser: String(settings.max_chats_per_user),
    maxChatsPerWorkspace: String(settings.max_chats_per_workspace),
    maxWorkspaceMembers: String(settings.max_workspace_members),
    registrationOpen: settings.registration_open,
    allowedFileExtensions: (settings.allowed_file_extensions ?? []).join(', '),
    testEmail: defaultTestEmail,
  };
}

function parseLimit(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return null;
  return parsed;
}

const EXTENSION_RE = /^[a-z0-9]{1,10}$/;
const DANGEROUS_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'msi',
  'ps1',
  'sh',
  'bash',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'dll',
  'sys',
  'apk',
  'jar',
  'app',
  'deb',
  'rpm',
  'hta',
  'cpl',
  'lnk',
  'html',
  'htm',
  'svg',
]);

function parseExtensions(value: string): string[] | null {
  const entries = value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter((item) => item.length > 0);
  if (entries.length === 0 || entries.length > 100) return null;
  if (new Set(entries).size !== entries.length) return null;
  if (entries.some((entry) => !EXTENSION_RE.test(entry) || DANGEROUS_EXTENSIONS.has(entry))) {
    return null;
  }
  return entries;
}

function parsePort(value: string): number | null | undefined {
  if (value.trim() === '') return undefined;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function errorText(
  mode: AdminSettingsMode,
  error: ApiError | null,
  kind: 'save' | 'test',
): string | null {
  if (!error) return null;
  if (error.status === 403) return t('admin.forbidden.text');
  if (error.status === 409 && error.code === 'SETUP_ALREADY_COMPLETED') {
    return t(mode === 'setup' ? 'setup.alreadyCompleted' : 'admin.setupAlreadyCompleted');
  }
  if (kind === 'test') {
    if (error.status === 503 || error.code === 'SMTP_UNAVAILABLE') {
      return t('admin.form.testEmailUnavailable');
    }
    return t('admin.form.testEmailError');
  }
  if (error.status === 400 || error.status === 422) return t('admin.form.validation');
  return t(mode === 'setup' ? 'setup.error' : 'admin.saveError');
}

/**
 * Shared settings form for `/setup` and `/admin`.
 *
 * The SMTP password deliberately lives only in this component's state until the
 * PATCH completes (and is then cleared); no store, storage, URL or log ever
 * receives it. Test-email first persists the SMTP fields so the server probes
 * the values the admin just typed, then calls the test operation.
 */
export function AdminSettingsForm({
  mode,
  settings,
  saving,
  saveError,
  testEmailStatus,
  testEmailError,
  testEmailTo,
  defaultTestEmail,
  onSave,
  onTestEmail,
}: AdminSettingsFormProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(settings, defaultTestEmail));
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);

  const ids = {
    extensions: useId(),
    host: useId(),
    port: useId(),
    username: useId(),
    password: useId(),
    from: useId(),
    starttls: useId(),
    maxUser: useId(),
    maxWorkspace: useId(),
    maxMembers: useId(),
    registration: useId(),
    testEmail: useId(),
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setSaved(false);
    setFormError(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const buildPatch = (smtpOnly: boolean): AdminSettingsPatch | null => {
    const port = parsePort(form.smtpPort);
    if (port === null) {
      setFormError(t('admin.form.validation'));
      return null;
    }
    if (form.smtpPassword.length > 512) {
      setFormError(t('admin.form.validation'));
      return null;
    }

    const patch: AdminSettingsPatch = {
      smtp_host: form.smtpHost.trim(),
      smtp_username: form.smtpUsername.trim(),
      smtp_from: form.smtpFrom.trim(),
      smtp_starttls: form.smtpStarttls,
    };
    // `null`/omitted means "do not change" in the contract; an empty port is
    // therefore omitted rather than sent as null.
    if (port !== undefined) patch.smtp_port = port;
    // Empty password = "keep the stored one". Never send a blank value.
    if (form.smtpPassword.length > 0) patch.smtp_password = form.smtpPassword;

    if (smtpOnly) return patch;

    const maxChatsPerUser = parseLimit(form.maxChatsPerUser);
    const maxChatsPerWorkspace = parseLimit(form.maxChatsPerWorkspace);
    const maxWorkspaceMembers = parseLimit(form.maxWorkspaceMembers);
    if (maxChatsPerUser === null || maxChatsPerWorkspace === null || maxWorkspaceMembers === null) {
      setFormError(t('admin.form.validation'));
      return null;
    }
    const allowedFileExtensions = parseExtensions(form.allowedFileExtensions);
    if (allowedFileExtensions === null) {
      setFormError(t('admin.form.extensionsInvalid'));
      return null;
    }
    return {
      ...patch,
      max_chats_per_user: maxChatsPerUser,
      max_chats_per_workspace: maxChatsPerWorkspace,
      max_workspace_members: maxWorkspaceMembers,
      registration_open: form.registrationOpen,
      allowed_file_extensions: allowedFileExtensions,
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const patch = buildPatch(false);
    if (!patch) return;
    const ok = await onSave(patch, mode === 'setup');
    if (ok) {
      setSaved(true);
      setForm((current) => ({ ...current, smtpPassword: '' }));
    }
  };

  const handleTest = async () => {
    if (saving || testing || testEmailStatus === 'sending') return;
    const email = form.testEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setFormError(t('admin.form.testEmailValidation'));
      return;
    }
    const patch = buildPatch(true);
    if (!patch) return;
    setSaved(false);
    setTesting(true);
    setFormError(null);
    try {
      const savedOk = await onSave(patch, false);
      if (!savedOk) return;
      // The email is captured before the async save, so it cannot be lost to a
      // re-render while the test request is in flight.
      await onTestEmail(email);
      setForm((current) => ({ ...current, smtpPassword: '' }));
    } finally {
      setTesting(false);
    }
  };

  const busy = saving || testing || testEmailStatus === 'sending';
  const saveMessage = errorText(mode, saveError, 'save');
  const testMessage = errorText(mode, testEmailError, 'test');
  const configured = settings.smtp_configured;

  return (
    <form className="admin-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <fieldset className="admin-form__section" disabled={saving}>
        <legend className="admin-form__legend">{t('setup.smtpSection')}</legend>
        <p className="admin-form__hint">{t('setup.smtpSectionHint')}</p>

        <div className="admin-form__grid">
          <div className="field">
            <label className="field__label" htmlFor={ids.host}>
              {t('admin.form.smtpHost')}
            </label>
            <input
              id={ids.host}
              className="field__input"
              type="text"
              maxLength={255}
              placeholder={t('admin.form.smtpHostPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              value={form.smtpHost}
              onChange={(event) => update('smtpHost', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.port}>
              {t('admin.form.smtpPort')}
            </label>
            <input
              id={ids.port}
              className="field__input"
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              placeholder={t('admin.form.smtpPortPlaceholder')}
              value={form.smtpPort}
              onChange={(event) => update('smtpPort', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.username}>
              {t('admin.form.smtpUser')}
            </label>
            <input
              id={ids.username}
              className="field__input"
              type="text"
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('admin.form.smtpUserPlaceholder')}
              value={form.smtpUsername}
              onChange={(event) => update('smtpUsername', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.password}>
              {t('admin.form.smtpPassword')}
            </label>
            <input
              id={ids.password}
              className="field__input"
              type="password"
              maxLength={512}
              autoComplete="new-password"
              placeholder={t('admin.form.smtpPasswordPlaceholder')}
              aria-describedby={`${ids.password}-hint`}
              value={form.smtpPassword}
              onChange={(event) => update('smtpPassword', event.target.value)}
            />
            <p className="field__meta" id={`${ids.password}-hint`}>
              {t('admin.form.smtpPasswordHint')}
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.from}>
              {t('admin.form.smtpFrom')}
            </label>
            <input
              id={ids.from}
              className="field__input"
              type="email"
              maxLength={254}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('admin.form.smtpFromPlaceholder')}
              value={form.smtpFrom}
              onChange={(event) => update('smtpFrom', event.target.value)}
            />
          </div>

          <div className="admin-form__check">
            <input
              id={ids.starttls}
              type="checkbox"
              checked={form.smtpStarttls}
              onChange={(event) => update('smtpStarttls', event.target.checked)}
            />
            <label htmlFor={ids.starttls}>{t('admin.form.starttls')}</label>
          </div>
        </div>

        <div className="admin-form__statusline">
          <span
            className={`admin-chip${configured ? ' admin-chip--ok' : ' admin-chip--muted'}`}
            role="status"
          >
            {t(configured ? 'admin.form.smtpConfigured' : 'admin.form.smtpNotConfigured')}
          </span>
          <span className="admin-form__hint">{t('admin.form.smtpStatusHint')}</span>
        </div>

        <div className="admin-form__test">
          <div className="field">
            <label className="field__label" htmlFor={ids.testEmail}>
              {t('admin.form.testEmailTo')}
            </label>
            <input
              id={ids.testEmail}
              className="field__input"
              type="email"
              maxLength={254}
              autoComplete="off"
              placeholder={t('admin.form.testEmailPlaceholder')}
              value={form.testEmail}
              onChange={(event) => update('testEmail', event.target.value)}
            />
            <p className="field__meta">{t('admin.form.testEmailHint')}</p>
          </div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void handleTest()}
            disabled={busy}
          >
            {testEmailStatus === 'sending' || testing
              ? t('admin.form.testEmailSending')
              : t('admin.form.testEmailButton')}
          </button>
        </div>

        {formError ? (
          <p className="admin-form__error" role="alert">
            {formError}
          </p>
        ) : null}
        {saveMessage ? (
          <p className="admin-form__error" role="alert">
            {saveMessage}
          </p>
        ) : null}
        {testMessage && !saveMessage ? (
          <p className="admin-form__error" role="alert">
            {testMessage}
          </p>
        ) : null}
        {testEmailStatus === 'sent' && testEmailTo ? (
          <p className="admin-form__success" role="status">
            {t('admin.form.testEmailSent', { email: testEmailTo })}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="admin-form__section" disabled={saving}>
        <legend className="admin-form__legend">{t('setup.businessSection')}</legend>
        <p className="admin-form__hint">{t('setup.businessSectionHint')}</p>

        <div className="admin-form__grid">
          <div className="field">
            <label className="field__label" htmlFor={ids.maxUser}>
              {t('admin.form.maxChatsPerUser')}
            </label>
            <input
              id={ids.maxUser}
              className="field__input"
              type="number"
              min={1}
              max={MAX_LIMIT}
              inputMode="numeric"
              value={form.maxChatsPerUser}
              onChange={(event) => update('maxChatsPerUser', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.maxWorkspace}>
              {t('admin.form.maxChatsPerWorkspace')}
            </label>
            <input
              id={ids.maxWorkspace}
              className="field__input"
              type="number"
              min={1}
              max={MAX_LIMIT}
              inputMode="numeric"
              value={form.maxChatsPerWorkspace}
              onChange={(event) => update('maxChatsPerWorkspace', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.maxMembers}>
              {t('admin.form.maxWorkspaceMembers')}
            </label>
            <input
              id={ids.maxMembers}
              className="field__input"
              type="number"
              min={1}
              max={MAX_LIMIT}
              inputMode="numeric"
              value={form.maxWorkspaceMembers}
              onChange={(event) => update('maxWorkspaceMembers', event.target.value)}
            />
          </div>

          <div className="admin-form__check">
            <input
              id={ids.registration}
              type="checkbox"
              checked={form.registrationOpen}
              onChange={(event) => update('registrationOpen', event.target.checked)}
            />
            <label htmlFor={ids.registration}>{t('admin.form.registrationOpen')}</label>
          </div>
        </div>
        <p className="admin-form__hint">{t('admin.form.limitsHint')}</p>
        <p className="admin-form__hint">{t('admin.form.maxMembersHint')}</p>
        <p className="admin-form__hint">{t('admin.form.registrationHint')}</p>

        <div className="field">
          <label className="field__label" htmlFor={ids.extensions}>
            {t('admin.form.allowedExtensions')}
          </label>
          <textarea
            id={ids.extensions}
            className="field__input admin-form__extensions"
            rows={4}
            value={form.allowedFileExtensions}
            onChange={(event) => update('allowedFileExtensions', event.target.value)}
            aria-describedby={`${ids.extensions}-hint`}
          />
          <p className="admin-form__hint" id={`${ids.extensions}-hint`}>
            {t('admin.form.allowedExtensionsHint')}
          </p>
        </div>
      </fieldset>

      {saved && mode === 'admin' ? (
        <p className="admin-form__success" role="status">
          {t('admin.saved')}
        </p>
      ) : null}

      <div className="admin-form__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {saving
            ? t(mode === 'setup' ? 'setup.finishing' : 'admin.saving')
            : t(mode === 'setup' ? 'setup.finish' : 'admin.save')}
        </button>
      </div>
    </form>
  );
}
