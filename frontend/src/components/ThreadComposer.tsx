import type { RefObject } from 'react';
import { t } from '../i18n/ru';
import type { SendBlockedReason } from './Composer';
import { SendIcon } from './Icons';

const MAX_LENGTH = 8000;

interface ThreadComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Hard block: thread unavailable, loading, root deleted, E2EE. */
  disabled: boolean;
  disabledReason: string | null;
  sendBlockedReason: SendBlockedReason;
  rateLimitSeconds: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * D1-FE3: text-only reply composer. Attachments/stickers are out of this slice
 * and E2EE threads are unsupported, so the composer stays deliberately small
 * and never shows a control the server would reject.
 */
export function ThreadComposer({
  value,
  onChange,
  onSend,
  disabled,
  disabledReason,
  sendBlockedReason,
  rateLimitSeconds,
  textareaRef,
}: ThreadComposerProps) {
  const length = value.length;
  const canSend =
    !disabled && sendBlockedReason === null && value.trim().length > 0 && length <= MAX_LENGTH;

  const note = disabled
    ? disabledReason
    : sendBlockedReason === 'offline'
      ? t('composer.offline')
      : sendBlockedReason === 'rate_limit'
        ? t('composer.rateLimited', { seconds: rateLimitSeconds })
        : sendBlockedReason === 'e2ee_blocked'
          ? t('composer.e2eeBlocked')
          : null;

  const submit = () => {
    if (!canSend) return;
    onSend();
    textareaRef.current?.focus();
  };

  return (
    <form
      className="composer thread-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer__field">
        <label className="visually-hidden" htmlFor="thread-composer-input">
          {t('thread.composerLabel')}
        </label>
        <div className="composer__input-row">
          <textarea
            id="thread-composer-input"
            ref={textareaRef}
            className="composer__textarea"
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder={t('thread.composerPlaceholder')}
            aria-describedby="thread-composer-note"
            readOnly={disabled}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            className="send-button"
            aria-label={t('thread.send')}
            title={t('thread.send')}
            disabled={!canSend}
          >
            <SendIcon aria-hidden="true" />
          </button>
        </div>
        <p className="composer__hint" id="thread-composer-hint">
          {t('thread.composerHint')}
        </p>
      </div>
      <p className="composer__note" id="thread-composer-note" role="status" aria-live="polite">
        {note ?? ''}
      </p>
    </form>
  );
}
