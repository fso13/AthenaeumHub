import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import {
  buildMentionIndex,
  findMentionQuery as findMentionQueryAtCaret,
  insertMention,
  matchMentionAt,
  matchMentionCandidates,
  type MentionCandidate,
  type MentionMemberLike,
  type MentionQuery,
} from '../domain/mentions';

interface UseMentionAutocompleteOptions {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly members: readonly MentionMemberLike[];
  /** Mentions are a managed-only feature; E2EE composers pass `false`. */
  readonly enabled: boolean;
  /**
   * #83: `@all` is a broadcast the server only allows to chat OWNER/ADMIN.
   * When false the candidate is not offered at all (an honest UI instead of a
   * guaranteed `403 MENTION_ALL_FORBIDDEN`).
   */
  readonly allowAll?: boolean;
  /** Lazily loads the active workspace member directory on first `@`. */
  readonly onDirectoryNeeded?: () => void;
}

export interface MentionAutocomplete {
  readonly open: boolean;
  readonly candidates: readonly MentionCandidate[];
  readonly activeIndex: number;
  readonly listboxId: string;
  readonly activeOptionId: string | null;
  readonly handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  /**
   * Returns `true` when the mention listbox consumed the key. Callers must then
   * skip their own Enter-to-send handling.
   */
  readonly handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly select: (candidate: MentionCandidate) => void;
  readonly close: () => void;
  readonly syncCaret: () => void;
  /** Pointer hover keeps the keyboard active option in sync. */
  readonly setActive: (index: number) => void;
}

function sameTrigger(left: MentionQuery | null, right: MentionQuery | null): boolean {
  if (left === null || right === null) return left === right;
  return left.start === right.start && left.query === right.query;
}

/**
 * Composer-side mention autocomplete.
 *
 * The textarea stays the only focusable element (combobox/listbox pattern):
 * arrows move the active option, Enter/Tab inserts, Escape closes. The display
 * name is inserted literally, exactly as it will be stored in the message body.
 */
export function useMentionAutocomplete({
  value,
  onChange,
  textareaRef,
  members,
  enabled,
  allowAll = true,
  onDirectoryNeeded,
}: UseMentionAutocompleteOptions): MentionAutocomplete {
  const [trigger, setTrigger] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const requestedDirectory = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const mentionIndex = useMemo(
    () => buildMentionIndex(members.map((member) => member.display_name)),
    [members],
  );

  /**
   * Only an *unfinished* mention should open the picker. Once the text already
   * contains a complete `@Display Name` before the caret, the user has moved on
   * to the message body; reopening there would show "no matches" over every
   * subsequent keystroke.
   */
  const deriveTrigger = useCallback(
    (text: string, caret: number): MentionQuery | null => {
      const query = findMentionQueryAtCaret(text, caret);
      if (query === null) return null;
      const match = matchMentionAt(text, query.start, mentionIndex);
      if (match !== null && query.start + match.length < caret) return null;
      return query;
    },
    [mentionIndex],
  );

  const open = enabled && trigger !== null;
  const candidates = useMemo(
    () =>
      trigger === null ? [] : matchMentionCandidates(trigger.query, members, undefined, allowAll),
    [allowAll, trigger, members],
  );
  const safeIndex = candidates.length === 0 ? 0 : Math.min(activeIndex, candidates.length - 1);
  const activeOptionId = open && candidates.length > 0 ? `${listboxId}-option-${safeIndex}` : null;

  // A changed query is a new search: the first option becomes active again.
  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.start, trigger?.query]);

  // Close the picker when mentions are disabled (e.g. the chat switched to E2EE).
  useEffect(() => {
    if (!enabled) setTrigger(null);
  }, [enabled]);

  // External value changes (restore failed draft, emoji insertion) must not
  // leave a stale picker pointing at an old `@`.
  useEffect(() => {
    if (!open) return;
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? value.length;
    const next = deriveTrigger(value, caret);
    if (!sameTrigger(next, trigger)) setTrigger(next);
  }, [value, open, textareaRef, trigger, deriveTrigger]);

  // Ask for the directory once per opened picker. The store no-ops when the
  // full first page is already cached, and refreshes it if a previous dialog
  // search left a filtered page behind. A failure does not retry in a loop;
  // reopening the picker (or typing `@` again) retries.
  useEffect(() => {
    if (!open) {
      requestedDirectory.current = false;
      return;
    }
    if (requestedDirectory.current || onDirectoryNeeded === undefined) return;
    requestedDirectory.current = true;
    onDirectoryNeeded();
  }, [open, onDirectoryNeeded]);

  // After insertion the caret must land after the inserted `@Name `.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const element = textareaRef.current;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    if (!element) return;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [value, textareaRef]);

  const applyOwnerChange = (nextValue: string, caret: number) => {
    onChange(nextValue);
    if (!enabled) {
      setTrigger(null);
      return;
    }
    const next = deriveTrigger(nextValue, caret);
    setTrigger((current) => (sameTrigger(current, next) ? current : next));
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    const caret = event.target.selectionStart ?? nextValue.length;
    applyOwnerChange(nextValue, caret);
  };

  const select = (candidate: MentionCandidate) => {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? value.length;
    const result = insertMention(value, caret, candidate);
    if (result === null) {
      setTrigger(null);
      return;
    }
    setTrigger(null);
    setActiveIndex(0);
    pendingCaret.current = result.caret;
    onChange(result.value);
  };

  const close = () => {
    setTrigger(null);
  };

  const syncCaret = () => {
    if (!enabled) return;
    const element = textareaRef.current;
    if (!element) return;
    const next = deriveTrigger(value, element.selectionStart ?? value.length);
    setTrigger((current) => (sameTrigger(current, next) ? current : next));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;

    if (candidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = candidates[safeIndex] ?? candidates[0];
        if (candidate !== undefined) select(candidate);
        return true;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setTrigger(null);
      return true;
    }

    return false;
  };

  return {
    open,
    candidates,
    activeIndex: safeIndex,
    listboxId,
    activeOptionId,
    handleChange,
    handleKeyDown,
    select,
    close,
    syncCaret,
    setActive: setActiveIndex,
  };
}
