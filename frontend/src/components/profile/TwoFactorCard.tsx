import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { t } from '../../i18n/ru';
import { twoFactorErrorText } from '../../profile/twoFactorErrors';
import { useProfileWorkspaceState, useProfileWorkspaceStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { CopyIcon, RefreshIcon, ShieldIcon } from '../Icons';
import { QrCode } from '../QrCode';

type Stage = 'idle' | 'start-password' | 'setup' | 'recovery' | 'regenerate-password' | 'disable';

type CopyTarget = 'secret' | 'uri' | 'codes';

async function writeClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(value);
}

/**
 * P0-4 (#82) TOTP authenticator card.
 *
 * - Status comes from `GET /me/2fa` (never the secret/codes).
 * - Setup requires the account password, shows the secret + otpauth URI once,
 *   then confirms a 6-digit code. On confirmation the recovery codes are
 *   issued once and displayed for copying.
 * - Disable requires the password **and** a valid TOTP/recovery code.
 * - The secret and the recovery codes live only in this store's memory for the
 *   open flow; closing the profile drops them (`clearTwoFactorDraft`). Nothing
 *   is written to storage or logs.
 */
export function TwoFactorCard() {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const twoFactor = state.twoFactor;
  const status = twoFactor.value;
  const enabled = status?.enabled === true;

  const [stage, setStage] = useState<Stage>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [copyState, setCopyState] = useState<CopyTarget | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingPassword = useRef<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const passwordId = useId();
  const setupCodeId = useId();
  const disablePasswordId = useId();
  const disableCodeId = useId();

  useEffect(() => {
    void store.loadTwoFactor();
  }, [store]);

  useEffect(() => {
    if (stage !== 'setup') return;
    codeRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    if (stage === 'disable') return;
    setPassword('');
    setCode('');
    setTouched(false);
  }, [stage]);

  const resetFlow = () => {
    pendingPassword.current = null;
    setStage('idle');
    setPassword('');
    setCode('');
    setDisableCode('');
    setDisablePassword('');
    store.clearTwoFactorDraft();
  };

  const handleCopy = async (target: CopyTarget, value: string | null) => {
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

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (twoFactor.setupStatus === 'starting') return;
    if (!password) {
      setTouched(true);
      return;
    }
    const ok = await store.setupTwoFactor(password);
    if (ok) {
      pendingPassword.current = password;
      setPassword('');
      setStage('setup');
      setTouched(false);
    }
  };

  const confirmSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (twoFactor.verifyStatus === 'verifying') return;
    if (!/^[0-9]{6}$/.test(code)) return;
    const ok = await store.verifyTwoFactorSetup(code);
    if (!ok) {
      setCode('');
      return;
    }
    setCode('');
    setStage('recovery');
    setNotice(t('profile.twoFactor.enabledNotice'));
    const secretPassword = pendingPassword.current;
    if (secretPassword) {
      // Keep the password in memory until the flow closes so a failed recovery
      // issue can be retried without re-entering it; `resetFlow` drops it.
      await store.issueRecoveryCodes(secretPassword);
    }
  };

  const regenerate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (twoFactor.recoveryStatus === 'issuing') return;
    if (!password) {
      setTouched(true);
      return;
    }
    const ok = await store.issueRecoveryCodes(password);
    if (ok) {
      setPassword('');
      setStage('recovery');
    }
  };

  const retryRecovery = async () => {
    const secretPassword = pendingPassword.current;
    if (!secretPassword) return;
    await store.issueRecoveryCodes(secretPassword);
  };

  const confirmDisable = async () => {
    if (twoFactor.disableStatus === 'disabling') return;
    if (!disablePassword || !disableCode.trim()) return;
    const ok = await store.disableTwoFactor(disablePassword, disableCode.trim());
    if (ok) {
      setStage('idle');
      setDisablePassword('');
      setDisableCode('');
      setNotice(null);
    }
  };

  const setupError = twoFactor.setupStatus === 'error' ? twoFactor.setupError : null;
  const verifyError = twoFactor.verifyStatus === 'error' ? twoFactor.verifyError : null;
  const recoveryError = twoFactor.recoveryStatus === 'error' ? twoFactor.recoveryError : null;
  const disableError = twoFactor.disableStatus === 'error' ? twoFactor.disableError : null;
  const busy =
    twoFactor.setupStatus === 'starting' ||
    twoFactor.verifyStatus === 'verifying' ||
    twoFactor.recoveryStatus === 'issuing' ||
    twoFactor.disableStatus === 'disabling';

  const recoveryCodes = twoFactor.recoveryCodes;
  const recoveryText = recoveryCodes?.codes.join('\n') ?? '';

  return (
    <section className="mini-card" aria-labelledby={titleId}>
      <div className="profile-sessions__head">
        <h4 id={titleId}>
          <ShieldIcon aria-hidden="true" /> {t('profile.twoFactor.title')}
        </h4>
        {twoFactor.status === 'ready' ? (
          <span className={`mode-chip ${enabled ? 'mode-chip--ok' : 'mode-chip--mock'}`}>
            {enabled ? t('profile.twoFactor.enabled') : t('profile.twoFactor.disabled')}
          </span>
        ) : null}
      </div>

      {twoFactor.status === 'loading' || twoFactor.status === 'idle' ? (
        <p className="mini-card__text" role="status">
          {t('profile.twoFactor.loading')}
        </p>
      ) : null}

      {twoFactor.status === 'error' ? (
        <div className="mini-card__error" role="alert">
          <p>{t('profile.twoFactor.loadError')}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadTwoFactor(true)}
          >
            <RefreshIcon aria-hidden="true" />
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {notice ? (
        <p className="mini-card__note" role="status">
          {notice}
        </p>
      ) : null}

      {twoFactor.status === 'ready' && !enabled && stage === 'idle' ? (
        <>
          <p className="mini-card__text">{t('profile.twoFactor.disabledHint')}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setNotice(null);
              setStage('start-password');
            }}
          >
            <ShieldIcon aria-hidden="true" />
            {t('profile.twoFactor.start')}
          </button>
        </>
      ) : null}

      {stage === 'start-password' ? (
        <form className="profile-form" onSubmit={(event) => void startSetup(event)} noValidate>
          <p className="mini-card__note">{t('profile.twoFactor.setupHint')}</p>
          <div className="profile-field">
            <label htmlFor={passwordId}>{t('profile.twoFactor.passwordLabel')}</label>
            <input
              ref={passwordRef}
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              autoFocus
              disabled={busy}
              aria-invalid={touched && !password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small className="mini-card__note">{t('profile.twoFactor.passwordHint')}</small>
          </div>
          {setupError ? (
            <p className="profile-form__error" role="alert">
              {twoFactorErrorText(setupError)}
            </p>
          ) : null}
          <div className="profile-form__actions">
            <button type="button" className="btn btn--sm" onClick={resetFlow} disabled={busy}>
              {t('profile.twoFactor.cancel')}
            </button>
            <button type="submit" className="btn btn--accent btn--sm" disabled={busy}>
              {busy ? t('profile.twoFactor.verifying') : t('profile.twoFactor.continue')}
            </button>
          </div>
        </form>
      ) : null}

      {stage === 'setup' && twoFactor.setup ? (
        <div className="twofactor-setup">
          <h5>{t('profile.twoFactor.setupTitle')}</h5>
          <p className="mini-card__note">{t('profile.twoFactor.once')}</p>
          <div className="twofactor-qr">
            <QrCode
              value={twoFactor.setup.qr_payload.trim() || twoFactor.setup.otpauth_uri}
              label={t('profile.twoFactor.qrAlt')}
              size={176}
            />
            <p className="mini-card__note">{t('profile.twoFactor.qrHint')}</p>
          </div>
          <div className="twofactor-secret">
            <span className="mini-row mini-row--muted">{t('profile.twoFactor.secretLabel')}</span>
            <div className="twofactor-secret__row">
              <code className="mini-card__mono">{twoFactor.setup.secret}</code>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void handleCopy('secret', twoFactor.setup?.secret ?? null)}
                aria-label={t('profile.twoFactor.copy')}
              >
                <CopyIcon aria-hidden="true" />
                {t('profile.twoFactor.copy')}
              </button>
            </div>
          </div>
          <div className="twofactor-secret">
            <span className="mini-row mini-row--muted">{t('profile.twoFactor.uriLabel')}</span>
            <div className="twofactor-secret__row">
              <code className="mini-card__mono twofactor-uri">{twoFactor.setup.otpauth_uri}</code>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void handleCopy('uri', twoFactor.setup?.otpauth_uri ?? null)}
                aria-label={t('profile.twoFactor.copy')}
              >
                <CopyIcon aria-hidden="true" />
                {t('profile.twoFactor.copy')}
              </button>
            </div>
          </div>
          {copyState ? (
            <p className="mini-card__note" role="status">
              {copyError ? t('profile.twoFactor.copyFailed') : t('profile.twoFactor.copied')}
            </p>
          ) : null}

          <form className="profile-form" onSubmit={(event) => void confirmSetup(event)} noValidate>
            <div className="profile-field">
              <label htmlFor={setupCodeId}>{t('profile.twoFactor.codeLabel')}</label>
              <input
                ref={codeRef}
                id={setupCodeId}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={t('profile.twoFactor.codePlaceholder')}
                value={code}
                disabled={busy}
                aria-invalid={touched && !/^[0-9]{6}$/.test(code)}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            </div>
            {verifyError ? (
              <p className="profile-form__error" role="alert">
                {twoFactorErrorText(verifyError)}
              </p>
            ) : null}
            <div className="profile-form__actions">
              <button type="button" className="btn btn--sm" onClick={resetFlow} disabled={busy}>
                {t('profile.twoFactor.cancel')}
              </button>
              <button
                type="submit"
                className="btn btn--accent btn--sm"
                disabled={busy || !/^[0-9]{6}$/.test(code)}
              >
                {busy ? t('profile.twoFactor.verifying') : t('profile.twoFactor.verify')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {stage === 'recovery' ? (
        <div className="twofactor-recovery">
          <h5>{t('profile.twoFactor.recoveryTitle')}</h5>
          <p className="mini-card__note">{t('profile.twoFactor.recoveryHint')}</p>
          {recoveryError ? (
            <div className="mini-card__error" role="alert">
              <p>{t('profile.twoFactor.recoveryIssueError')}</p>
              <p>{twoFactorErrorText(recoveryError)}</p>
              {pendingPassword.current ? (
                <button type="button" className="btn btn--sm" onClick={() => void retryRecovery()}>
                  <RefreshIcon aria-hidden="true" />
                  {t('profile.twoFactor.regenerate')}
                </button>
              ) : null}
            </div>
          ) : null}
          {recoveryCodes ? (
            <>
              <ol className="twofactor-codes">
                {recoveryCodes.codes.map((value, index) => (
                  <li key={value}>
                    <code>{value}</code>
                    <span className="visually-hidden">
                      {t('profile.twoFactor.recoveryCode', { index: index + 1 })}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="profile-form__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void handleCopy('codes', recoveryText)}
                >
                  <CopyIcon aria-hidden="true" />
                  {t('profile.twoFactor.recoveryCopy')}
                </button>
                <button type="button" className="btn btn--accent btn--sm" onClick={resetFlow}>
                  {t('profile.twoFactor.recoveryDone')}
                </button>
              </div>
              {copyError ? (
                <p className="profile-form__error" role="alert">
                  {t('profile.twoFactor.copyFailed')}
                </p>
              ) : copyState === 'codes' ? (
                <p className="mini-card__note" role="status">
                  {t('profile.twoFactor.copied')}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {enabled && stage === 'idle' ? (
        <>
          <div className="mini-row">
            <span>{t('profile.twoFactor.enabled')}</span>
            <span>{status?.enabled_at ? formatDateTime(status.enabled_at) : '—'}</span>
          </div>
          <div className="mini-row mini-row--muted">
            <span>
              {t('profile.twoFactor.codesLeft', { count: status?.recovery_codes_remaining ?? 0 })}
            </span>
          </div>
          <div className="profile-form__actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setNotice(null);
                setStage('regenerate-password');
              }}
            >
              {t('profile.twoFactor.regenerate')}
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => {
                setDisablePassword('');
                setDisableCode('');
                setStage('disable');
              }}
            >
              {t('profile.twoFactor.disable')}
            </button>
          </div>
        </>
      ) : null}

      {stage === 'regenerate-password' ? (
        <form className="profile-form" onSubmit={(event) => void regenerate(event)} noValidate>
          <p className="mini-card__note">{t('profile.twoFactor.passwordHint')}</p>
          <div className="profile-field">
            <label htmlFor={`${passwordId}-regen`}>{t('profile.twoFactor.passwordLabel')}</label>
            <input
              id={`${passwordId}-regen`}
              type="password"
              autoComplete="current-password"
              value={password}
              autoFocus
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {recoveryError ? (
            <p className="profile-form__error" role="alert">
              {twoFactorErrorText(recoveryError)}
            </p>
          ) : null}
          <div className="profile-form__actions">
            <button type="button" className="btn btn--sm" onClick={resetFlow} disabled={busy}>
              {t('profile.twoFactor.cancel')}
            </button>
            <button type="submit" className="btn btn--accent btn--sm" disabled={busy || !password}>
              {busy ? t('profile.twoFactor.regenerating') : t('profile.twoFactor.regenerate')}
            </button>
          </div>
        </form>
      ) : null}

      {stage === 'disable' ? (
        <div
          className="twofactor-confirm"
          role="alertdialog"
          aria-labelledby={`${titleId}-disable`}
        >
          <h5 id={`${titleId}-disable`}>{t('profile.twoFactor.disableTitle')}</h5>
          <p className="mini-card__note">{t('profile.twoFactor.disableLead')}</p>
          <ul className="admin-confirm__list">
            <li>{t('profile.twoFactor.disableEffect')}</li>
          </ul>
          <div className="profile-field">
            <label htmlFor={disablePasswordId}>{t('profile.twoFactor.passwordLabel')}</label>
            <input
              id={disablePasswordId}
              type="password"
              autoComplete="current-password"
              value={disablePassword}
              disabled={busy}
              onChange={(event) => setDisablePassword(event.target.value)}
            />
          </div>
          <div className="profile-field">
            <label htmlFor={disableCodeId}>{t('profile.twoFactor.codeLabel')}</label>
            <input
              id={disableCodeId}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={20}
              value={disableCode}
              disabled={busy}
              onChange={(event) => setDisableCode(event.target.value)}
            />
          </div>
          {disableError ? (
            <p className="profile-form__error" role="alert">
              {twoFactorErrorText(disableError)}
            </p>
          ) : null}
          <div className="profile-form__actions">
            <button type="button" className="btn btn--sm" onClick={resetFlow} disabled={busy}>
              {t('profile.twoFactor.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={busy || !disablePassword || !disableCode.trim()}
              onClick={() => void confirmDisable()}
            >
              {busy ? t('profile.twoFactor.disabling') : t('profile.twoFactor.disableConfirm')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
