import type { ApiMessage } from '../api/types';
import { t } from '../i18n/ru';

export function sortBySeq(messages: readonly ApiMessage[]): ApiMessage[] {
  return [...messages].sort((a, b) => a.seq - b.seq);
}

/**
 * Dedupe by server id (retry/replay/sync can deliver the same message twice)
 * and by seq (contract: seq is unique per chat). Server message is the source
 * of truth, so an existing id is replaced by the incoming payload.
 */
export function mergeMessages(
  current: readonly ApiMessage[],
  incoming: readonly ApiMessage[],
): ApiMessage[] {
  const byId = new Map<string, ApiMessage>();
  const seenSeq = new Set<number>();

  for (const message of current) {
    if (byId.has(message.id)) continue;
    if (seenSeq.has(message.seq)) continue;
    byId.set(message.id, message);
    seenSeq.add(message.seq);
  }

  for (const message of incoming) {
    if (byId.has(message.id)) {
      byId.set(message.id, message);
      continue;
    }
    if (seenSeq.has(message.seq)) continue;
    byId.set(message.id, message);
    seenSeq.add(message.seq);
  }

  return sortBySeq([...byId.values()]);
}

export function maxSeq(messages: readonly ApiMessage[]): number {
  let max = 0;
  for (const message of messages) {
    if (message.seq > max) max = message.seq;
  }
  return max;
}

export function minSeq(messages: readonly ApiMessage[]): number | null {
  let min: number | null = null;
  for (const message of messages) {
    if (min === null || message.seq < min) min = message.seq;
  }
  return min;
}

export function findMessageById(
  messages: readonly ApiMessage[],
  id: string | null | undefined,
): ApiMessage | undefined {
  if (!id) return undefined;
  return messages.find((message) => message.id === id);
}

export type MessageListItem =
  { kind: 'day'; key: string; label: string } | { kind: 'message'; message: ApiMessage };

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function localDayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays === 0) return t('date.today');
  if (diffDays === 1) return t('date.yesterday');

  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return timeFormatter.format(date);
}

const shortDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});

export function formatShortDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (localDayKey(iso) === localDayKey(now.toISOString())) return formatTime(iso);
  return shortDateFormatter.format(date);
}

/**
 * Groups a seq-ordered list into day separators and messages.
 * Grouping is by the user's local calendar day.
 */
export function groupMessagesByDay(
  messages: readonly ApiMessage[],
  now: Date = new Date(),
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let lastDay: string | null = null;

  for (const message of sortBySeq(messages)) {
    const day = localDayKey(message.created_at);
    if (day !== lastDay) {
      items.push({ kind: 'day', key: day, label: formatDayLabel(message.created_at, now) });
      lastDay = day;
    }
    items.push({ kind: 'message', message });
  }

  return items;
}

export function initials(displayName: string | null | undefined): string {
  const name = displayName?.trim();
  if (!name) return '?';
  const words = name
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((part) => part.length > 0);

  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${words[0]?.charAt(0) ?? ''}${words[1]?.charAt(0) ?? ''}`.toUpperCase();
}

export function avatarHue(seed: string | null | undefined): number {
  const value = seed ?? '';
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

export function replyPreview(text: string | null | undefined, maxLength = 140): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

/**
 * Scroll anchoring for "load older": keep the visual position by adding the
 * height delta to scrollTop.
 */
export function scrollAdjustment(
  previousScrollHeight: number,
  nextScrollHeight: number,
  previousScrollTop: number,
): number {
  return Math.max(0, previousScrollTop + (nextScrollHeight - previousScrollHeight));
}
