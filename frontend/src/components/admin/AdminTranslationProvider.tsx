import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { TranslationProviderUpdate } from '../../api/types';
import { t } from '../../i18n/ru';
import {
  translationDraftChanged,
  validateTranslationUrl,
  type TranslationUrlIssue,
} from '../../ops/translation';
import { useOpsState, useOpsStore } from '../../store/ChatProvider';
import { ErrorDetails } from '../ErrorDetails';
import { RefreshIcon } from '../Icons';

const URL_ISSUE_KEY: Record<TranslationUrlIssue, Parameters<typeof t>[0]> = {
  tooLong: 'admin.translate.invalidTooLong',
  whitespace: 'admin.translate.invalidWhitespace',
  notAbsolute: 'admin.translate.invalidAbsolute',
  notHttps: 'admin.translate.invalidHttps',
  noHost: 'admin.translate.invalidHost',
  credentials: 'admin.translate.invalidCredentials',
  query: 'admin.translate.invalidQuery',
  fragment: 'admin.translate.invalidFragment',
  dotSegments: 'admin.translate.invalidDotSegments',
  port: 'admin.translate.invalidPort',
};

function saveErrorText(error: ApiError): string {
  if (error.status === 403) return t('admin.forbidden.text');
  if (error.code === 'TRANSLATION_URL_INVALID') return t('admin.translate.invalidGeneric');
  if (error.code === 'TRANSLATION_URL_REQUIRED') return t('admin.translate.required');
  if (error.status === 400 || error.status === 422) return t('admin.form.validation');
  if (error.status === 503 || error.isNetwork) return t('admin.translate.unavailable');
  return t('admin.translate.saveError');
}

/**
 * #84 translation-provider installation settings inside `/admin?tab=plugins`.
 *
 * The contract stores only `enabled` and an https URL — there is no API-key or
 * credential field, and this form never collects one. The health probe returns
 * `status`/`latency_ms` only, so no provider content can appear. Both changing
 * the switch/URL and probing are audited with counters/flags only.
 */
export function AdminTranslationProvider() {
  const store = useOpsStore();
  const ops = useOpsState();
  const settings = ops.translation;
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [url, setUrl] = useState(settings?.url ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = { enabled: useId(), url: useId(), hint: useId() };

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setUrl(settings.url);
    setSaved(false);
    setFormError(null);
  }, [settings]);

  const dirty = translationDraftChanged(settings, enabled, url);
  const busy = ops.translationSaving || ops.translationTestStatus === 'testing';
  const loaded = ops.translationStatus === 'ready' && settings !== null;
  const forbidden = ops.translationError?.status === 403;
  const test = ops.translationTest;
  const testing = ops.translationTestStatus === 'testing';

  const validate = (): TranslationProviderUpdate | null => {
    const trimmed = url.trim();
    const issue = validateTranslationUrl(trimmed);
    if (issue) {
      setFormError(t(URL_ISSUE_KEY[issue]));
      return null;
    }
    if (enabled && trimmed.length === 0 && (settings?.url ?? '').length === 0) {
      setFormError(t('admin.translate.required'));
      return null;
    }
    const patch: TranslationProviderUpdate = {};
    if (!settings || enabled !== settings.enabled) patch.enabled = enabled;
    if (!settings || trimmed !== settings.url) patch.url = trimmed;
    if (Object.keys(patch).length === 0) {
      setFormError(t('admin.translate.noChanges'));
      return null;
    }
    return patch;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setSaved(false);
    const patch = validate();
    if (!patch) return;
    setFormError(null);
    const result = await store.saveTranslation(patch);
    if (result) setSaved(true);
  };

  const testConnection = async () => {
    if (busy) return;
    setFormError(null);
    setSaved(false);
    if (dirty) {
      const patch = validate();
      if (!patch) return;
      const savedSettings = await store.saveTranslation(patch);
      if (!savedSettings) return;
    }
    await store.testTranslation();
  };

  return (
    <section className="admin-translate" aria-labelledby="admin-translate-title">
      <div className="admin-card__head">
        <div>
          <h3 className="admin-plugins__subtitle" id="admin-translate-title">
            {t('admin.translate.title')}
          </h3>
          <p className="admin-card__hint">{t('admin.translate.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => void store.loadTranslation(true)}
          disabled={ops.translationStatus === 'loading' || busy}
        >
          <RefreshIcon aria-hidden="true" />
          {t('admin.refresh')}
        </button>
      </div>

      {!loaded && ops.translationStatus !== 'error' ? (
        <p className="admin-state" role="status" aria-busy="true">
          {t('admin.translate.loading')}
        </p>
      ) : null}

      {!loaded && ops.translationStatus === 'error' ? (
        <div className="admin-state admin-state--error" role="alert">
          <div className="admin-state__body">
            <p>{forbidden ? t('admin.forbidden.text') : t('admin.translate.loadError')}</p>
            {ops.translationError ? <ErrorDetails error={ops.translationError} /> : null}
          </div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void store.loadTranslation(true)}
          >
            {t('admin.translate.retry')}
          </button>
        </div>
      ) : null}

      {settings ? (
        <form
          className="admin-form admin-translate__form"
          onSubmit={(event) => void save(event)}
          noValidate
        >
          <div className="admin-form__statusline">
            <span
              className={`admin-chip${settings.enabled ? ' admin-chip--ok' : ' admin-chip--muted'}`}
              role="status"
            >
              {t(settings.enabled ? 'admin.translate.enabled' : 'admin.translate.disabled')}
            </span>
            <span className="admin-form__hint">{t('admin.translate.statusHint')}</span>
          </div>

          <div className="admin-form__check">
            <input
              id={ids.enabled}
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setSaved(false);
                setFormError(null);
                setEnabled(event.target.checked);
              }}
            />
            <label htmlFor={ids.enabled}>{t('admin.translate.enable')}</label>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.url}>
              {t('admin.translate.url')}
            </label>
            <input
              id={ids.url}
              className="field__input"
              type="url"
              inputMode="url"
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://translate.example.com/v1"
              value={url}
              aria-describedby={ids.hint}
              onChange={(event) => {
                setSaved(false);
                setFormError(null);
                setUrl(event.target.value);
              }}
            />
            <p className="field__meta" id={ids.hint}>
              {t('admin.translate.urlHint')}
            </p>
          </div>

          {formError ? (
            <p className="admin-form__error" role="alert">
              {formError}
            </p>
          ) : null}

          {ops.translationSaveError ? (
            <div className="admin-state admin-state--error" role="alert">
              <div className="admin-state__body">
                <p>{saveErrorText(ops.translationSaveError)}</p>
                <ErrorDetails error={ops.translationSaveError} />
              </div>
            </div>
          ) : null}

          <div className="admin-form__actions admin-translate__actions">
            <button type="submit" className="button button--primary" disabled={busy || !dirty}>
              {ops.translationSaving ? t('admin.saving') : t('admin.translate.save')}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void testConnection()}
              disabled={busy}
            >
              {testing ? t('admin.translate.testing') : t('admin.translate.test')}
            </button>
          </div>

          {saved ? (
            <p className="admin-form__success" role="status">
              {t('admin.translate.saved')}
            </p>
          ) : null}

          {test ? (
            <p
              className={`admin-translate__result admin-translate__result--${test.status.toLowerCase()}`}
              role={test.status === 'UNAVAILABLE' ? 'alert' : 'status'}
            >
              {test.status === 'OK'
                ? t('admin.translate.testOk', { latency: test.latency_ms })
                : test.status === 'DISABLED'
                  ? t('admin.translate.testDisabled')
                  : t('admin.translate.testUnavailable', { latency: test.latency_ms })}
            </p>
          ) : null}

          {ops.translationTestStatus === 'error' && ops.translationTestError ? (
            <div className="admin-state admin-state--error" role="alert">
              <div className="admin-state__body">
                <p>{t('admin.translate.testError')}</p>
                <ErrorDetails error={ops.translationTestError} />
              </div>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.testTranslation()}
              >
                {t('admin.translate.testRetry')}
              </button>
            </div>
          ) : null}

          <p className="admin-card__hint">{t('admin.translate.auditHint')}</p>
        </form>
      ) : null}
    </section>
  );
}
