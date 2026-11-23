import { useEffect, useId, useState, type FormEvent } from 'react';
import type { SecurityMode } from '../../api/types';
import { t, type MessageKey } from '../../i18n/ru';
import { securityErrorMessage } from '../../security/errors';
import {
  RETENTION_MAX,
  RETENTION_MIN,
  SESSION_TIMEOUT_MAX,
  SESSION_TIMEOUT_MIN,
  draftFromSecurity,
  securityPatchFromDraft,
  validateSecurityDraft,
  type SecurityDraft,
  type SecurityFieldErrors,
} from '../../security/model';
import { useSecurityState, useSecurityStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { ErrorDetails } from '../ErrorDetails';
import { RefreshIcon } from '../Icons';
import { SectionError, SectionLoading } from './SecurityUi';

interface SecuritySettingsCardProps {
  mode: SecurityMode;
}

/**
 * Workspace security policy form. Only changed fields are sent, so a same-value
 * save is a no-op on the server. `security_mode` is deliberately absent: the
 * mode is immutable and the disabled control explains why instead of pretending
 * a switch exists. DLP is disabled in E2EE because the server has no plaintext.
 */
export function SecuritySettingsCard({ mode }: SecuritySettingsCardProps) {
  const store = useSecurityStore();
  const { settings } = useSecurityState();
  const [draft, setDraft] = useState<SecurityDraft | null>(null);
  const [errors, setErrors] = useState<SecurityFieldErrors>({});
  const [noChanges, setNoChanges] = useState(false);
  const twoFaId = useId();
  const timeoutId = useId();
  const timeoutErrorId = useId();
  const dlpId = useId();
  const retentionId = useId();
  const retentionErrorId = useId();
  const e2ee = mode === 'E2EE';

  useEffect(() => {
    if (settings.data) {
      setDraft(
        e2ee
          ? { ...draftFromSecurity(settings.data), dlpEnabled: false }
          : draftFromSecurity(settings.data),
      );
      setErrors({});
      setNoChanges(false);
    }
  }, [settings.data, e2ee]);

  const patch = settings.data && draft ? securityPatchFromDraft(draft, settings.data) : {};
  const changed = Object.keys(patch).length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !settings.data) return;
    const nextErrors = validateSecurityDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (e2ee && draft.dlpEnabled) return;
    if (!changed) {
      setNoChanges(true);
      return;
    }
    setNoChanges(false);
    await store.saveSettings(patch);
  };

  const edit = (next: Partial<SecurityDraft>) => {
    store.clearSettingsSave();
    setNoChanges(false);
    setDraft((current) => (current ? { ...current, ...next } : current));
  };

  return (
    <section className="card" aria-labelledby="security-settings">
      <div className="card-head">
        <h2 className="card-title" id="security-settings">
          {t('security.settings.title')}
        </h2>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void store.loadSettings(true)}
          disabled={settings.status === 'loading'}
        >
          <RefreshIcon aria-hidden="true" />
          {t('security.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('security.settings.lead')}</p>

      {settings.status === 'loading' && !settings.data ? (
        <SectionLoading label={t('security.settings.loading')} />
      ) : null}

      {settings.error ? (
        <SectionError
          text={t('security.settings.error')}
          error={settings.error}
          onRetry={() => void store.loadSettings(true)}
          retryLabel={t('security.settings.retry')}
        />
      ) : null}

      {settings.data && draft ? (
        <form
          className="sec-form sec-form--settings"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <div className="form-row">
            <label className="sec-switch" htmlFor={twoFaId}>
              <input
                id={twoFaId}
                type="checkbox"
                checked={draft.require2fa}
                onChange={(event) => edit({ require2fa: event.target.checked })}
              />
              <span>{t('security.settings.require2fa')}</span>
            </label>
            <p className="field__meta">{t('security.settings.require2faHint')}</p>
          </div>

          <div className="form-row">
            <label htmlFor={timeoutId}>{t('security.settings.timeout')}</label>
            <input
              id={timeoutId}
              className="input"
              type="number"
              min={SESSION_TIMEOUT_MIN}
              max={SESSION_TIMEOUT_MAX}
              step={1}
              value={draft.sessionTimeoutMinutes}
              aria-invalid={errors.sessionTimeoutMinutes !== undefined}
              aria-describedby={`${timeoutId}-hint${
                errors.sessionTimeoutMinutes ? ` ${timeoutErrorId}` : ''
              }`}
              onChange={(event) => edit({ sessionTimeoutMinutes: event.target.value })}
            />
            <p className="field__meta" id={`${timeoutId}-hint`}>
              {t('security.settings.timeoutHint')}
            </p>
            {errors.sessionTimeoutMinutes ? (
              <p className="sec-field-error" id={timeoutErrorId}>
                {t(errors.sessionTimeoutMinutes as MessageKey)}
              </p>
            ) : null}
          </div>

          <div className="form-row">
            <label className="sec-switch" htmlFor={dlpId}>
              <input
                id={dlpId}
                type="checkbox"
                checked={e2ee ? false : draft.dlpEnabled}
                disabled={e2ee}
                onChange={(event) => edit({ dlpEnabled: event.target.checked })}
              />
              <span>{t('security.settings.dlp')}</span>
            </label>
            <p className="field__meta">
              {e2ee ? t('security.settings.dlpE2ee') : t('security.settings.dlpHint')}
            </p>
          </div>

          <div className="form-row">
            <label htmlFor={retentionId}>{t('security.settings.retention')}</label>
            <input
              id={retentionId}
              className="input"
              type="number"
              min={RETENTION_MIN}
              max={RETENTION_MAX}
              step={1}
              value={draft.retentionDays}
              aria-invalid={errors.retentionDays !== undefined}
              aria-describedby={`${retentionId}-hint${
                errors.retentionDays ? ` ${retentionErrorId}` : ''
              }`}
              onChange={(event) => edit({ retentionDays: event.target.value })}
            />
            <p className="field__meta" id={`${retentionId}-hint`}>
              {t('security.settings.retentionHint')}
            </p>
            {errors.retentionDays ? (
              <p className="sec-field-error" id={retentionErrorId}>
                {t(errors.retentionDays as MessageKey)}
              </p>
            ) : null}
          </div>

          <div className="sec-immutable">
            <span>{t('security.mode')}</span>
            <span className="chip">{mode}</span>
            <p className="pg-footnote">{t('security.settings.modeNote')}</p>
          </div>

          <div
            className="sec-immutable"
            role="note"
            aria-label={t('security.settings.enforcementTitle')}
          >
            <span>{t('security.settings.enforcementTitle')}</span>
            <p className="pg-footnote">{t('security.settings.dlpEnforced')}</p>
            <p className="pg-footnote">{t('security.settings.sessionEnforced')}</p>
            <p className="pg-footnote">{t('security.settings.retentionEnforced')}</p>
          </div>

          {settings.saveStatus === 'error' && settings.saveError ? (
            <div className="pg-inline-error" role="alert">
              <div>
                <p>{securityErrorMessage(settings.saveError, 'security.settings.saveError')}</p>
                <ErrorDetails error={settings.saveError} />
              </div>
            </div>
          ) : null}

          {settings.saveStatus === 'saved' ? (
            <p className="sec-saved" role="status">
              {t('security.settings.saved')}
            </p>
          ) : null}
          {noChanges ? (
            <p className="sec-saved" role="status">
              {t('security.settings.noChanges')}
            </p>
          ) : null}

          <div className="form-actions">
            <button
              type="submit"
              className="btn btn--accent"
              disabled={settings.saveStatus === 'saving'}
              aria-busy={settings.saveStatus === 'saving'}
            >
              {settings.saveStatus === 'saving'
                ? t('security.settings.saving')
                : t('security.settings.save')}
            </button>
          </div>

          <p className="pg-footnote">
            {t('security.settings.updatedAt', {
              date: formatDateTime(settings.data.updated_at),
            })}
          </p>
        </form>
      ) : null}
    </section>
  );
}
