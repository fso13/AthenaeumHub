import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '../api/types';
import { chatMemberCount } from './chatMembers';

function chat(extra: Record<string, unknown> = {}): ChatSummary {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Команда «Восход»',
    type: 'GROUP',
    security_mode: 'MANAGED',
    unread_count: 0,
    last_seq: 1,
    ...extra,
  } as ChatSummary;
}

describe('chatMemberCount (#99 additive contract field)', () => {
  it('returns the chat member count when the contract carries it', () => {
    expect(chatMemberCount(chat({ member_count: 12 }))).toBe(12);
    // A real empty channel is still an honest 0, not the workspace fallback.
    expect(chatMemberCount(chat({ member_count: 0 }))).toBe(0);
  });

  it('returns null for absent or malformed values', () => {
    expect(chatMemberCount(chat())).toBeNull();
    expect(chatMemberCount(chat({ member_count: null }))).toBeNull();
    expect(chatMemberCount(chat({ member_count: -1 }))).toBeNull();
    expect(chatMemberCount(chat({ member_count: 1.5 }))).toBeNull();
    expect(chatMemberCount(chat({ member_count: '12' }))).toBeNull();
    expect(chatMemberCount(null)).toBeNull();
    expect(chatMemberCount(undefined)).toBeNull();
  });
});
