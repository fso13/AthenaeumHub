import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { TwoFactorSetup } from '../../api/types';
import { t } from '../../i18n/ru';
import { CopyIcon, RefreshIcon } from '../Icons';
import { QrCode } from '../QrCode';

export type EnrollmentPanelStatus = 'starting' | 'ready' | 'verifying' | 'recovery' | 'error';

export interface TwoFactorEnrollPanelProps {
  setup: TwoFactorSetup | null;
  status: EnrollmentPanelStatus;
  recoveryCodes: string[] | null;
  errorText: string | null;
  /** Shown when the setup request failed before a secret existed. */
  onRetry: () => void;
  /** Confirms the first TOTP code; resolving `true` advances the flow. */
  onVerify: (code: string) => void | Promise<void>;
  /** Leaves the recovery step and commits/unlocks the session. */
  onFinish: () => void;
  finishLabel?: string;
}

async function writeClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(value);
}

/**
 * #93 shared TOTP enrollment surface for the login `ENROLL` challenge and the
 * server-policy gate. It renders the locally generated QR, the one-time secret
 * with copy, the 6-digit confirmation and the one-time recovery codes.
 *
 * The secret/URI/codes arrive as props from memory-only provider/store state:
 * this component never writes storage, logs a value or requests an external QR
 * image. Unmounting the flow is enough to forget everything.
 */
export function TwoFactorEnrollPanel({
  setup,
  status,
  recoveryCodes,
  errorText,
  onRetry,
  onVerify,
  onFinish,
  finishLabel,
}: TwoFactorEnrollPanelProps) {
  const titleId = useId();
  const codeId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [copyState, setCopyState] = useState<'secret' | 'codes' | null>(null);
  const [copyError, setCopyError] = useState(false);

  const busy = status === 'starting' || status === 'verifying';
  const verifying = status === 'verifying';
  const recovery = status === 'recovery';
  const codeValid = /^[0-9]{6}$/.test(code);

  useEffect(() => {
    if (status !== 'ready') return;
    codeRef.current?.focus();
  }, [status]);

  useEffect(() => {
    // A consumed/restarted flow must not keep the previous code on screen.
    if (status === 'starting' || recovery) setCode('');
  }, [recovery, status]);

  const copy = async (target: 'secret' | 'codes', value: string | null) => {
    if (!value) return;
    setCopyError(false);
    try {
      await writeClipboard(value);
      setCopyState(target);
    } catch {
      setCopyState(null);
      setCopyError(true);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || recovery || !codeValid) return;
    const submitted = code;
    // Clear immediately so a rejected code is replaced by the next attempt
    // instead of being appended to six existing digits.
    setCode('');
    void Promise.resolve(onVerify(submitted)).catch(() => undefined);
  };

  if (recovery) {
    const codes = recoveryCodes ?? [];
    return (
      <div className="twofactor-enroll" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('auth.enroll.recoveryTitle')}</h2>
        <p className="login-lead">{t('auth.enroll.recoveryLead')}</p>
        {codes.length > 0 ? (
          <>
            <ol className="twofactor-codes" aria-label={t('auth.enroll.recoveryList')}>
              {codes.map((value, index) => (
                <li key={value}>
                  <code>{value}</code>
                  <span className="visually-hidden">
                    {t('auth.enroll.recoveryCode', { index: index + 1 })}
                  </span>
                </li>
              ))}
            </ol>
            <div className="twofactor-enroll__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void copy('codes', codes.join('\n'))}
              >
                <CopyIcon aria-hidden="true" />
                {t('auth.enroll.copyCodes')}
              </button>
              <button type="button" className="login-submit" onClick={onFinish}>
                {finishLabel ?? t('auth.enroll.finish')}
              </button>
            </div>
            {copyError ? (
              <p className="login-error" role="alert">
                {t('auth.enroll.copyFailed')}
              </p>
            ) : copyState === 'codes' ? (
              <p className="login-hint" role="status">
                {t('auth.enroll.copied')}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="login-status login-status--error" role="alert">
              {t('auth.enroll.recoveryMissing')}
            </p>
            <button type="button" className="login-submit" onClick={onFinish}>
              {finishLabel ?? t('auth.enroll.finish')}
            </button>
          </>
        )}
      </div>
    );
  }

  if (status === 'error' && !setup) {
    return (
      <div className="twofactor-enroll" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('auth.enroll.title')}</h2>
        <p className="login-status login-status--error" role="alert">
          {errorText ?? t('auth.enroll.startError')}
        </p>
        <button type="button" className="login-submit" onClick={onRetry}>
          <RefreshIcon aria-hidden="true" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (status === 'starting' || !setup) {
    return (
      <div className="twofactor-enroll" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('auth.enroll.title')}</h2>
        <p className="login-status" role="status">
          {t('auth.enroll.preparing')}
        </p>
      </div>
    );
  }

  const qrValue = setup.qr_payload.trim() || setup.otpauth_uri;
  return (
    <div className="twofactor-enroll" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('auth.enroll.title')}</h2>
      <p className="login-lead">{t('auth.enroll.lead')}</p>

      <div className="twofactor-enroll__qr">
        <QrCode value={qrValue} label={t('auth.enroll.qrAlt')} />
      </div>
      <p className="login-hint">{t('auth.enroll.scanHint')}</p>

      <div className="twofactor-secret">
        <span className="mini-row mini-row--muted">{t('auth.enroll.secretLabel')}</span>
        <div className="twofactor-secret__row">
          <code className="mini-card__mono twofactor-enroll__secret">{setup.secret}</code>
          <button
            type="button"
            className="btn btn--sm"
            aria-label={t('auth.enroll.copySecret')}
            onClick={() => void copy('secret', setup.secret)}
          >
            <CopyIcon aria-hidden="true" />
            {t('common.copy')}
          </button>
        </div>
      </div>
      {copyError ? (
        <p className="login-error" role="alert">
          {t('auth.enroll.copyFailed')}
        </p>
      ) : copyState === 'secret' ? (
        <p className="login-hint" role="status">
          {t('auth.enroll.copied')}
        </p>
      ) : null}

      <form className="login-form" onSubmit={handleSubmit} noValidate>
        <div className="login-field">
          <label className="login-label" htmlFor={codeId}>
            {t('auth.enroll.codeLabel')}
          </label>
          <input
            ref={codeRef}
            id={codeId}
            className="login-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={t('auth.enroll.codePlaceholder')}
            value={code}
            disabled={busy}
            aria-invalid={errorText ? true : undefined}
            aria-describedby={`${codeId}-hint`}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <p className="login-hint" id={`${codeId}-hint`}>
            {t('auth.enroll.codeHint')}
          </p>
        </div>
        {errorText ? (
          <p className="login-status login-status--error" role="alert">
            {errorText}
          </p>
        ) : null}
        <button type="submit" className="login-submit" disabled={busy || !codeValid}>
          {verifying ? t('auth.enroll.verifying') : t('auth.enroll.verify')}
        </button>
      </form>
    </div>
  );
}
