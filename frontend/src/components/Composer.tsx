import { useEffect, type ReactNode, type RefObject } from 'react';
import type { ApiMessage } from '../api/types';
import { replyPreview } from '../domain/messages';
import { t } from '../i18n/ru';
import { CloseIcon, MicIcon, PaperclipIcon, SendIcon, StickerIcon } from './Icons';

export type SendBlockedReason = 'offline' | 'rate_limit' | 'e2ee_blocked' | null;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  sendBlockedReason: SendBlockedReason;
  rateLimitSeconds: number;
  replyTo: ApiMessage | null;
  /** E7-F5G P2-33: E2EE context; server reply text is never rendered. */
  e2eeChat?: boolean;
  /** Decrypted reply text for the E2EE reply bar (null = unavailable). */
  replyText?: string | null;
  onCancelReply: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** E4-F: ready attachments make text optional. */
  attachmentCount: number;
  attachDisabled: boolean;
  attachHint: string;
  onAttach: () => void;
  /** E5-F: sticker picker trigger. */
  stickersOpen: boolean;
  onToggleStickers: () => void;
  stickerButtonRef: RefObject<HTMLButtonElement | null>;
  /** D1-FE2: voice recording is managed-only and never auto-starts. */
  voiceButtonRef: RefObject<HTMLButtonElement | null>;
  voiceDisabled: boolean;
  voiceHint: string;
  voiceActive: boolean;
  onStartVoice: () => void;
  /** Inline RecordingBar; rendered only while a take is active. */
  voiceBar?: ReactNode;
}

const MAX_LENGTH = 8000;
const COUNTER_VISIBLE_FROM = 1;
const COUNTER_WARN_FROM = 7600;

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  sendBlockedReason,
  rateLimitSeconds,
  replyTo,
  e2eeChat = false,
  replyText = null,
  onCancelReply,
  textareaRef,
  attachmentCount,
  attachDisabled,
  attachHint,
  onAttach,
  stickersOpen,
  onToggleStickers,
  stickerButtonRef,
  voiceButtonRef,
  voiceDisabled,
  voiceHint,
  voiceActive,
  onStartVoice,
  voiceBar,
}: ComposerProps) {
  const length = value.length;
  const canSend =
    !disabled &&
    sendBlockedReason === null &&
    (value.trim().length > 0 || attachmentCount > 0) &&
    length <= MAX_LENGTH;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    }
  }, [value, textareaRef]);

  const submit = () => {
    if (!canSend) return;
    onSend();
    textareaRef.current?.focus();
  };

  const statusNote = disabled
    ? t('composer.unavailable')
    : sendBlockedReason === 'offline'
      ? t('composer.offline')
      : sendBlockedReason === 'rate_limit'
        ? t('composer.rateLimited', { seconds: rateLimitSeconds })
        : sendBlockedReason === 'e2ee_blocked'
          ? t('composer.e2eeBlocked')
          : null;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {replyTo ? (
        <div className="reply-bar">
          <div className="reply-bar__body">
            <span className="reply-bar__label">
              {t('chat.replyTo')}: {replyTo.sender_display_name?.trim() || t('chat.unknownAuthor')}
            </span>
            <span className="reply-bar__text">
              {e2eeChat
                ? (replyText ??
                  (replyTo.deleted_at ? t('chat.deletedMessage') : t('chat.replyUnavailable')))
                : replyPreview(replyTo.text)}
            </span>
          </div>
          <button
            type="button"
            className="icon-button icon-button--small"
            onClick={onCancelReply}
            aria-label={t('chat.cancelReply')}
            title={t('chat.cancelReply')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {voiceBar}

      <div className="composer__field">
        <label className="visually-hidden" htmlFor="composer-input">
          {t('composer.label')}
        </label>
        <div className="composer__input-row">
          <button
            type="button"
            className="icon-button composer__attach"
            onClick={onAttach}
            disabled={attachDisabled || disabled}
            aria-label={t('files.attach')}
            title={attachHint}
          >
            <PaperclipIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            ref={voiceButtonRef}
            className={`icon-button composer__voice${voiceActive ? ' composer__voice--active' : ''}`}
            onClick={onStartVoice}
            disabled={voiceDisabled || disabled}
            aria-label={t('voice.record')}
            aria-pressed={voiceActive}
            title={voiceHint}
          >
            <MicIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            ref={stickerButtonRef}
            className={`icon-button composer__sticker${stickersOpen ? ' composer__sticker--active' : ''}`}
            onClick={onToggleStickers}
            disabled={disabled}
            aria-label={t('stickers.open')}
            aria-expanded={stickersOpen}
            aria-controls={stickersOpen ? 'sticker-picker' : undefined}
            title={t('stickers.open')}
          >
            <StickerIcon aria-hidden="true" />
          </button>
          <textarea
            id="composer-input"
            ref={textareaRef}
            className="composer__textarea"
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder={t('composer.placeholder')}
            aria-describedby="composer-hint composer-note"
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
        </div>

        <div className="composer__bar">
          <p className="composer__hint" id="composer-hint">
            {t('composer.hint')}
          </p>
          <div className="composer__right">
            {length >= COUNTER_VISIBLE_FROM ? (
              <span
                className={`composer__counter${length >= COUNTER_WARN_FROM ? ' composer__counter--warn' : ''}`}
                aria-label={t('composer.counterLabel', { count: length })}
              >
                {t('composer.counter', { count: length })}
              </span>
            ) : null}
            <button
              type="submit"
              className="send-button"
              aria-label={t('composer.send')}
              title={t('composer.send')}
              disabled={!canSend}
            >
              <SendIcon aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <p className="composer__note" id="composer-note" role="status" aria-live="polite">
        {statusNote}
      </p>
    </form>
  );
}
