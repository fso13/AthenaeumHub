import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ApiMessage } from '../api/types';
import type { MentionMemberLike } from '../domain/mentions';
import { replyPreview } from '../domain/messages';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import { t } from '../i18n/ru';
import {
  CloseIcon,
  EmojiIcon,
  LockIcon,
  MicIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  StickerIcon,
} from './Icons';
import { MentionPopover } from './MentionPopover';
import { MentionText } from './MentionText';

export type SendBlockedReason = 'offline' | 'rate_limit' | 'read_only' | 'e2ee_blocked' | null;

interface ComposerProps {
  value: string;
  /** D1 UX fidelity 2: placeholder addresses the active chat by name. */
  chatName?: string;
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
  /** Managed-only @mention directory and lazy loader. */
  mentionMembers?: readonly MentionMemberLike[];
  mentionsEnabled?: boolean;
  mentionDirectoryLoading?: boolean;
  onMentionDirectoryNeeded?: () => void;
}

const MAX_LENGTH = 8000;
const COUNTER_VISIBLE_FROM = 1;
const COUNTER_WARN_FROM = 7600;
const EMOJI = ['🙂', '😄', '😍', '👍', '🙏', '🔥', '🎉', '❤️', '😢', '👀', '✅', '🚀'];
const NO_MENTION_MEMBERS: readonly MentionMemberLike[] = [];

export function Composer({
  value,
  chatName,
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
  mentionMembers = NO_MENTION_MEMBERS,
  mentionsEnabled = false,
  mentionDirectoryLoading = false,
  onMentionDirectoryNeeded,
}: ComposerProps) {
  const length = value.length;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const mentionNames = useMemo(
    () => mentionMembers.map((member) => member.display_name),
    [mentionMembers],
  );
  const mentions = useMentionAutocomplete({
    value,
    onChange,
    textareaRef,
    members: mentionMembers,
    enabled: mentionsEnabled,
    onDirectoryNeeded: onMentionDirectoryNeeded,
  });
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

  useEffect(() => {
    if (!emojiOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEmojiOpen(false);
        emojiButtonRef.current?.focus();
      }
    };
    const handlePointer = (event: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(event.target as Node)) {
        setEmojiOpen(false);
      }
    };
    document.addEventListener('keydown', handle);
    document.addEventListener('mousedown', handlePointer);
    return () => {
      document.removeEventListener('keydown', handle);
      document.removeEventListener('mousedown', handlePointer);
    };
  }, [emojiOpen]);

  // The mention listbox and the emoji tray occupy the same anchor; only one
  // picker is useful at a time.
  useEffect(() => {
    if (mentions.open) setEmojiOpen(false);
  }, [mentions.open]);

  const submit = () => {
    if (!canSend) return;
    onSend();
    textareaRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    onChange(`${value}${emoji}`);
    setEmojiOpen(false);
    textareaRef.current?.focus();
  };

  const statusNote = disabled
    ? t('composer.unavailable')
    : sendBlockedReason === 'offline'
      ? t('composer.offline')
      : sendBlockedReason === 'rate_limit'
        ? t('composer.rateLimited', { seconds: rateLimitSeconds })
        : sendBlockedReason === 'read_only'
          ? t('composer.readOnly')
          : sendBlockedReason === 'e2ee_blocked'
            ? t('composer.e2eeBlocked')
            : null;
  const contextNote = e2eeChat ? t('chat.e2eeNote') : t('chat.managedNote');

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
              {e2eeChat ? (
                (replyText ??
                (replyTo.deleted_at ? t('chat.deletedMessage') : t('chat.replyUnavailable')))
              ) : (
                <MentionText text={replyPreview(replyTo.text)} mentions={mentionNames} />
              )}
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

      <div className="composer__row">
        <label className="visually-hidden" htmlFor="composer-input">
          {t('composer.label')}
        </label>
        <button
          type="button"
          className="round-btn composer__attach"
          onClick={onAttach}
          disabled={attachDisabled || disabled}
          aria-label={t('files.attach')}
          title={attachHint}
        >
          <PlusIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          ref={stickerButtonRef}
          className={`round-btn composer__sticker${stickersOpen ? ' is-on' : ''}`}
          onClick={onToggleStickers}
          disabled={disabled}
          aria-label={t('stickers.open')}
          aria-expanded={stickersOpen}
          aria-controls={stickersOpen ? 'sticker-picker' : undefined}
          title={t('stickers.open')}
        >
          <StickerIcon aria-hidden="true" />
        </button>

        <div className="field composer__field">
          <textarea
            id="composer-input"
            ref={textareaRef}
            className="composer__textarea"
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder={
              chatName
                ? t('composer.placeholderInChat', { chat: chatName })
                : t('composer.placeholder')
            }
            aria-describedby="composer-hint composer-note"
            aria-autocomplete={mentionsEnabled ? 'list' : undefined}
            aria-expanded={mentionsEnabled ? mentions.open : undefined}
            aria-controls={mentions.open ? mentions.listboxId : undefined}
            aria-activedescendant={mentions.activeOptionId ?? undefined}
            aria-haspopup={mentionsEnabled ? 'listbox' : undefined}
            role={mentionsEnabled ? 'combobox' : undefined}
            readOnly={disabled}
            value={value}
            onChange={mentions.handleChange}
            onClick={mentions.syncCaret}
            onBlur={mentions.close}
            onKeyDown={(event) => {
              if (mentions.handleKeyDown(event)) return;
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {mentions.open ? (
            <MentionPopover
              listboxId={mentions.listboxId}
              candidates={mentions.candidates}
              activeIndex={mentions.activeIndex}
              loading={mentionDirectoryLoading}
              onSelect={mentions.select}
              onActive={mentions.setActive}
            />
          ) : null}
          <button
            type="button"
            ref={emojiButtonRef}
            className={`field-emoji composer__emoji${emojiOpen ? ' is-on' : ''}`}
            onClick={() => setEmojiOpen((open) => !open)}
            aria-label={t('composer.emoji')}
            aria-expanded={emojiOpen}
            title={t('composer.emojiTitle')}
          >
            <EmojiIcon aria-hidden="true" />
          </button>
          {emojiOpen ? (
            <div
              className="emoji-pop"
              role="dialog"
              aria-label={t('composer.emoji')}
              ref={emojiRef}
            >
              <div className="emoji-pop__grid">
                {EMOJI.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="emoji-pop__item"
                    aria-label={emoji}
                    onClick={() => insertEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          ref={voiceButtonRef}
          className={`round-btn composer__voice${voiceActive ? ' composer__voice--active' : ''}`}
          onClick={onStartVoice}
          disabled={voiceDisabled || disabled}
          aria-label={t('voice.record')}
          aria-pressed={voiceActive}
          title={voiceHint}
        >
          <MicIcon aria-hidden="true" />
        </button>
        <button
          type="submit"
          className="send-btn"
          aria-label={t('composer.send')}
          title={t('composer.send')}
          disabled={!canSend}
        >
          <SendIcon aria-hidden="true" />
        </button>
      </div>

      <div className="composer__bar">
        <p
          className={`composer__note${e2eeChat ? ' composer__note--e2ee' : ''}`}
          id="composer-note"
          role="status"
          aria-live="polite"
        >
          {statusNote ?? (
            <>
              {e2eeChat ? <LockIcon aria-hidden="true" /> : <ShieldIcon aria-hidden="true" />}
              {contextNote}
            </>
          )}
        </p>
        <div className="composer__right">
          <p className="composer__hint" id="composer-hint">
            {t('composer.hint')}
          </p>
          {length >= COUNTER_VISIBLE_FROM ? (
            <span
              className={`composer__counter${length >= COUNTER_WARN_FROM ? ' composer__counter--warn' : ''}`}
              aria-label={t('composer.counterLabel', { count: length })}
            >
              {t('composer.counter', { count: length })}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
