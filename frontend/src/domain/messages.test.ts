import { describe, expect, it } from 'vitest';
import type { ApiMessage } from '../api/types';
import {
  formatDayLabel,
  groupMessagesByDay,
  initials,
  localDayKey,
  maxSeq,
  mergeMessages,
  minSeq,
  replyPreview,
  scrollAdjustment,
  sortBySeq,
} from './messages';

function message(seq: number, overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: `id-${seq}`,
    chat_id: 'chat-1',
    seq,
    type: 'TEXT',
    sender_id: 'user-1',
    sender_display_name: 'Анна',
    text: `text ${seq}`,
    reply_to_id: null,
    created_at: `2026-11-16T09:0${seq % 10}:00.000+03:00`,
    edited_at: null,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

describe('messages domain', () => {
  it('sorts by seq, not by client time', () => {
    const sorted = sortBySeq([message(3), message(1), message(2)]);
    expect(sorted.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('dedupes by id and seq while keeping the server payload', () => {
    const first = message(1, { text: 'old' });
    const updated = message(1, { text: 'new' });
    const duplicateSeq = message(1, { id: 'other-id' });

    const merged = mergeMessages([first], [updated, duplicateSeq]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('new');
  });

  it('computes min/max seq', () => {
    const items = [message(4), message(9), message(2)];
    expect(minSeq(items)).toBe(2);
    expect(maxSeq(items)).toBe(9);
    expect(minSeq([])).toBeNull();
    expect(maxSeq([])).toBe(0);
  });

  it('groups by local day with today/yesterday labels', () => {
    const now = new Date('2026-11-16T12:00:00+03:00');
    const items = groupMessagesByDay(
      [
        message(1, { created_at: '2026-11-15T10:00:00+03:00' }),
        message(2, { created_at: '2026-11-16T09:00:00+03:00' }),
        message(3, { created_at: '2026-11-16T10:00:00+03:00' }),
      ],
      now,
    );

    expect(items.filter((item) => item.kind === 'day')).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'day', label: 'Вчера' });
  });

  it('formats a date from another year with the year', () => {
    const label = formatDayLabel(
      '2024-01-05T10:00:00+03:00',
      new Date('2026-11-16T12:00:00+03:00'),
    );
    expect(label).toContain('2024');
  });

  it('creates stable local day keys', () => {
    expect(localDayKey('2026-11-16T23:59:00+03:00')).toBe('2026-11-16');
  });

  it('keeps scroll position when older messages are prepended', () => {
    expect(scrollAdjustment(1000, 1400, 120)).toBe(520);
    expect(scrollAdjustment(1000, 800, 250)).toBe(50);
  });

  it('derives initials and truncates reply previews', () => {
    expect(initials('Дмитрий Крылов')).toBe('ДК');
    expect(initials('')).toBe('?');
    expect(replyPreview('  много   пробелов  ')).toBe('много пробелов');
    expect(replyPreview('x'.repeat(10), 5)).toBe('xxxx…');
  });
});
