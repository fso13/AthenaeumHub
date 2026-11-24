/** Last selected chat per user + workspace; non-secret navigation state. */
function key(userId: string | null, workspaceId: string | null): string {
  return `krug.last-chat.${userId ?? 'anonymous'}.${workspaceId ?? 'none'}`;
}

export function readLastChat(userId: string | null, workspaceId: string | null): string | null {
  try {
    const value = window.localStorage.getItem(key(userId, workspaceId));
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastChat(
  userId: string | null,
  workspaceId: string | null,
  chatId: string,
): void {
  try {
    window.localStorage.setItem(key(userId, workspaceId), chatId);
  } catch {
    // Private mode/quota: selection simply is not remembered.
  }
}

/** Test isolation: forget every remembered selection. */
export function resetLastChatForTests(): void {
  try {
    for (const keyName of Object.keys(window.localStorage)) {
      if (keyName.startsWith('krug.last-chat.')) window.localStorage.removeItem(keyName);
    }
  } catch {
    // no storage in this environment
  }
}
