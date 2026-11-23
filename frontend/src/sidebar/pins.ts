/**
 * Per-user sidebar chat pins.
 *
 * This is UI-only, non-secret state: an ordered list of chat ids the user chose
 * to keep at the top of their own sidebar. Pins are personal (they never reach
 * the server and never change the chat for other members), scoped by user id
 * and persisted in localStorage so they survive a reload.
 *
 * `scripts/check-security.mjs` allowlists `localStorage` in this module only
 * for this non-secret preference. A blocked/quota-full storage degrades to an
 * in-memory list for the current tab instead of breaking the sidebar.
 */
const KEY_PREFIX = 'krug.sidebar.pins.';
const ANONYMOUS_OWNER = 'anonymous';
/** Keep the marker next to the ids so an unbounded list cannot bloat storage. */
export const MAX_PINNED_CHATS = 100;

const memory = new Map<string, string[]>();

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ownerSuffix(userId: string | null | undefined): string {
  return userId && userId.trim().length > 0 ? userId : ANONYMOUS_OWNER;
}

function storageKey(userId: string | null | undefined): string {
  return `${KEY_PREFIX}${ownerSuffix(userId)}`;
}

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    items.push(id);
    if (items.length >= MAX_PINNED_CHATS) break;
  }
  return items;
}

/** Persisted pinned chat ids for this user, oldest pin first. */
export function readPinnedChatIds(userId: string | null | undefined): string[] {
  const key = storageKey(userId);
  const store = storage();
  if (!store) return [...(memory.get(key) ?? [])];
  try {
    const raw = store.getItem(key);
    if (raw === null) return [...(memory.get(key) ?? [])];
    return normalize(JSON.parse(raw));
  } catch {
    return [...(memory.get(key) ?? [])];
  }
}

/** Persist the ordered pin list. Failures are non-fatal and stay in memory. */
export function writePinnedChatIds(
  userId: string | null | undefined,
  chatIds: readonly string[],
): string[] {
  const key = storageKey(userId);
  const normalized = normalize(chatIds);
  memory.set(key, normalized);
  const store = storage();
  if (!store) return normalized;
  try {
    store.setItem(key, JSON.stringify(normalized));
  } catch {
    // The pins still work for the current tab.
  }
  return normalized;
}

/**
 * Toggle one chat and return the next ordered list. New pins go to the top
 * (most recently pinned first) so the section reads like a recent stack.
 */
export function togglePinnedChatId(
  userId: string | null | undefined,
  chatId: string,
  current: readonly string[],
): string[] {
  const next = current.includes(chatId)
    ? current.filter((id) => id !== chatId)
    : [chatId, ...current];
  return writePinnedChatIds(userId, next);
}

/** Test helper: seed raw storage (including corrupt JSON) without touching it. */
export function seedRawPinnedStorageForTests(userId: string | null | undefined, raw: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey(userId), raw);
  } catch {
    // ignore
  }
}

/** Test helper: localStorage survives between jsdom tests otherwise. */
export function resetPinnedChatsForTests(): void {
  memory.clear();
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // ignore
  }
}
