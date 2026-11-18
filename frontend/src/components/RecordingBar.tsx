import { useEffect, useRef } from 'react';
import { formatDuration } from '../files/format';
import { t, type MessageKey } from '../i18n/ru';
import { CloseIcon, SendIcon } from './Icons';
import type { VoiceStatus } from '../hooks/useVoiceRecorder';

export interface RecordingBarProps {
  status: VoiceStatus;
  elapsedMs: number;
  errorKey: MessageKey | null;
  /** Hard cap shown next to the timer (10 minutes for voice). */
  maxDurationMs?: number;
  onCancel: () => void;
  /** Stop the recorder and send the take once the upload is ready. */
  onSend: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  /** Disables send/cancel while the composer itself is unavailable. */
  disabled?: boolean;
}

/**
 * Inline recording panel. It is only mounted after an explicit mic click, so
 * no permission prompt or recording ever starts automatically. The primary
 * action receives focus, Escape cancels, and the timer is announced politely.
 */
export function RecordingBar({
  status,
  elapsedMs,
  errorKey,
  maxDurationMs,
  onCancel,
  onSend,
  onRetry,
  onDismiss,
  disabled = false,
}: RecordingBarProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (status === 'recording' || status === 'error') {
      primaryRef.current?.focus();
    }
  }, [status]);

  const time = formatDuration(elapsedMs);
  const limit = maxDurationMs ? formatDuration(maxDurationMs) : null;
  const failed = status === 'error';
  const busy = status === 'requesting' || status === 'stopping';

  const label = failed
    ? errorKey
      ? t(errorKey)
      : t('voice.errorGeneric')
    : status === 'requesting'
      ? t('voice.requesting')
      : status === 'stopping'
        ? t('voice.stopping')
        : t('voice.recording');

  return (
    <div
      className={`recording-bar${failed ? ' recording-bar--error' : ''}`}
      role="group"
      aria-label={t('voice.recordingBar')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (failed) onDismiss();
          else onCancel();
        }
      }}
    >
      <span
        className={`recording-bar__dot${status === 'recording' ? ' recording-bar__dot--live' : ''}`}
        aria-hidden="true"
      />
      <div className="recording-bar__body">
        <p className="recording-bar__label" role="status" aria-live="polite" aria-atomic="true">
          {label}
        </p>
        {!failed ? (
          <p className="recording-bar__time">
            <span
              role="timer"
              aria-label={t('voice.elapsed', { time })}
              className="recording-bar__timer"
            >
              {time}
            </span>
            {limit ? (
              <span className="recording-bar__limit">{t('voice.limit', { limit })}</span>
            ) : null}
          </p>
        ) : null}
        {failed ? (
          <p className="recording-bar__hint" role="status">
            {t('voice.retryHint')}
          </p>
        ) : null}
      </div>

      <div className="recording-bar__actions">
        {failed ? (
          <>
            <button
              ref={primaryRef}
              type="button"
              className="button button--small"
              onClick={onRetry}
            >
              {t('voice.retry')}
            </button>
            <button type="button" className="button button--small" onClick={onDismiss}>
              {t('voice.dismiss')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button button--small"
              onClick={onCancel}
              disabled={disabled}
              aria-label={t('voice.cancel')}
              title={t('voice.cancel')}
            >
              <CloseIcon aria-hidden="true" />
              {t('voice.cancel')}
            </button>
            <button
              ref={primaryRef}
              type="button"
              className="button button--small button--primary"
              onClick={onSend}
              disabled={disabled || busy}
              aria-busy={busy}
              aria-label={t('voice.send')}
              title={t('voice.send')}
            >
              <SendIcon aria-hidden="true" />
              {busy ? t('voice.saving') : t('voice.send')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
