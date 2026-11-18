import { t } from '../i18n/ru';
import type { TypingEntry } from '../store/chatStore';

interface TypingIndicatorProps {
  entries: TypingEntry[];
}

/**
 * Ephemeral "typing…" line. One polite live region, capped names, no history:
 * the store removes entries by TTL and the server never replays them.
 */
export function TypingIndicator({ entries }: TypingIndicatorProps) {
  if (entries.length === 0) return null;

  const names = [...new Set(entries.map((entry) => entry.displayName).filter(Boolean))] as string[];
  const text =
    names.length === 0
      ? t('chat.typingUnknown')
      : names.length === 1
        ? t('chat.typingOne', { name: names[0] ?? '' })
        : t('chat.typingMany', { names: names.slice(0, 3).join(', ') });

  return (
    <div className="typing-indicator" role="status" aria-live="polite" aria-atomic="true">
      <span className="typing-indicator__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{text}</span>
    </div>
  );
}
