import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PINNED_CHATS,
  readPinnedChatIds,
  resetPinnedChatsForTests,
  seedRawPinnedStorageForTests,
  togglePinnedChatId,
  writePinnedChatIds,
} from './pins';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '77777777-7777-4777-8777-777777777777';
const CHAT_A = '44444444-4444-4444-8444-444444444444';
const CHAT_B = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  resetPinnedChatsForTests();
});

describe('sidebar pins storage', () => {
  it('starts empty and toggles the most recent pin to the top', () => {
    expect(readPinnedChatIds(USER)).toEqual([]);

    let next = togglePinnedChatId(USER, CHAT_A, []);
    expect(next).toEqual([CHAT_A]);
    next = togglePinnedChatId(USER, CHAT_B, next);
    expect(next).toEqual([CHAT_B, CHAT_A]);
    expect(readPinnedChatIds(USER)).toEqual([CHAT_B, CHAT_A]);

    next = togglePinnedChatId(USER, CHAT_B, next);
    expect(next).toEqual([CHAT_A]);
    expect(readPinnedChatIds(USER)).toEqual([CHAT_A]);
  });

  it('scopes pins per user and never leaks one list into another', () => {
    writePinnedChatIds(USER, [CHAT_A]);
    writePinnedChatIds(OTHER, [CHAT_B]);

    expect(readPinnedChatIds(USER)).toEqual([CHAT_A]);
    expect(readPinnedChatIds(OTHER)).toEqual([CHAT_B]);
    expect(readPinnedChatIds(null)).toEqual([]);
  });

  it('normalizes hostile/duplicated input and caps the list', () => {
    const many = Array.from({ length: MAX_PINNED_CHATS + 25 }, (_, index) => `chat-${index}`);
    const stored = writePinnedChatIds(USER, [CHAT_A, '', '   ', CHAT_A, ...(many as string[])]);

    expect(stored[0]).toBe(CHAT_A);
    expect(stored).toHaveLength(MAX_PINNED_CHATS);
    expect(new Set(stored).size).toBe(MAX_PINNED_CHATS);
    expect(readPinnedChatIds(USER)).toEqual(stored);
  });

  it('survives corrupt JSON instead of breaking the sidebar', () => {
    seedRawPinnedStorageForTests(USER, '{not-json');
    expect(readPinnedChatIds(USER)).toEqual([]);
  });
});
