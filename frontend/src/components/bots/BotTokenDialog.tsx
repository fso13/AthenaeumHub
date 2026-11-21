import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BotToken } from '../../api/types';
import { t } from '../../i18n/ru';
import { CloseIcon, CopyIcon } from '../Icons';

export interface BotTokenDialogProps {
  token: BotToken;
  reason: 'created' | 'rotated';
  /** Drops the in-memory token; the dialog unmounts on the next render. */
  onClose: () => void;
}

/**
 * The only place a raw bot token exists in the UI. It is rendered from the
 * one-time `BotToken` response, copied on explicit user action and dropped by
 * the parent on close. Nothing is written to storage and the token is not
 * repeated after the dialog is dismissed (rotate issues a new one).
 */
export function BotTokenDialog({ token, reason, onClose }: BotTokenDialogProps) {
  const [copied, setCopied] = useState<'token' | 'curl' | null>(null);
  const [copyError, setCopyError] = useState(false);
  const titleId = useId();
  const leadId = useId();
  const warningId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const bot = token.bot;
  const tokenValue = token.token;
  const curl = buildCurl(tokenValue, bot.id);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // The chat/settings dialog behind this modal also listens for Escape.
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const copy = async (value: string, kind: 'token' | 'curl') => {
    setCopyError(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied(null);
      setCopyError(true);
    }
  };

  return createPortal(
    <div className="modal-layer">
      <div
        className="modal modal--sm bot-token-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${leadId} ${warningId}`}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {t('bots.tokenTitle')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <p className="bot-token__lead" id={leadId}>
            {t(reason === 'created' ? 'bots.tokenLeadCreated' : 'bots.tokenLeadRotated', {
              name: bot.name,
            })}
          </p>
          <p className="bot-token__warning" id={warningId}>
            {t('bots.tokenWarning')}
          </p>

          <div className="bot-token__row">
            <label className="visually-hidden" htmlFor={`${titleId}-token`}>
              {t('bots.tokenLabel')}
            </label>
            <input
              id={`${titleId}-token`}
              className="input bot-token__value"
              readOnly
              value={tokenValue}
              spellCheck={false}
              autoComplete="off"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void copy(tokenValue, 'token')}
            >
              <CopyIcon aria-hidden="true" />
              {copied === 'token' ? t('bots.copied') : t('bots.copyToken')}
            </button>
          </div>
          <p className="field__meta" role="status">
            {copyError
              ? t('bots.copyError')
              : copied === 'token'
                ? t('bots.copied')
                : t('bots.tokenNotice')}
          </p>

          <div className="bot-token__curl-block">
            <div className="bot-token__curl-head">
              <h3 className="bot-token__curl-title">{t('bots.curlTitle')}</h3>
              <button type="button" className="btn btn--sm" onClick={() => void copy(curl, 'curl')}>
                <CopyIcon aria-hidden="true" />
                {copied === 'curl' ? t('bots.curlCopied') : t('bots.copyCurl')}
              </button>
            </div>
            <p className="field__meta">{t('bots.curlHint')}</p>
            <pre className="bot-token__curl">
              <code>{curl}</code>
            </pre>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn--accent" ref={closeRef} onClick={onClose}>
            {t('bots.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Copy-paste starter for the only bot-token endpoint. The token is the raw
 * in-memory value; the example idempotency key is a fixed UUID placeholder,
 * not a generated/session value.
 */
export function buildCurl(token: string, botId: string): string {
  const base =
    typeof window === 'undefined'
      ? 'https://sova.example/api/v1'
      : `${window.location.origin.replace(/\/$/, '')}/api/v1`;
  return [
    `curl -X POST '${base}/bots/${botId}/messages' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Idempotency-Key: 6f1c0f9a-6c1f-4f7e-9f43-2b8c1d7e5a01' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"chat_id":"<chat-id>","text":"Привет от бота"}'`,
  ].join('\n');
}
