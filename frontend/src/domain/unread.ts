import type { ChatSummary, WorkspaceSummary } from '../api/types';

/**
 * D1-FE1: the space rail badge is the sum of `ChatSummary.unread_count` over a
 * workspace's chats. The server keeps the exact number; only the display is
 * capped at `99+`, and `0` renders no badge at all.
 */
export function sumUnread(chats: readonly Pick<ChatSummary, 'unread_count'>[]): number {
  let total = 0;
  for (const chat of chats) {
    if (Number.isFinite(chat.unread_count) && chat.unread_count > 0) {
      total += Math.floor(chat.unread_count);
    }
  }
  return total;
}

/** Badge text: exact 1..99, `99+` for 100 and above, null for 0. */
export function formatUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const value = Math.floor(count);
  return value > 99 ? '99+' : String(value);
}

/** Accessible label with the exact (never capped) number. */
export function unreadLabel(count: number): string {
  return count > 99 ? `99+ (${count})` : String(count);
}

export type RailSpace = Pick<WorkspaceSummary, 'id' | 'name' | 'security_mode'> &
  Partial<Pick<WorkspaceSummary, 'slug' | 'role' | 'logo_file_id'>>;

/**
 * Workspaces normally come from `/me`; the dev session only exposes the single
 * session workspace. The rail needs the same shape in both modes.
 */
export function railSpaces(state: {
  workspaces: WorkspaceSummary[];
  session: { workspace: { id: string; name: string; security_mode: 'MANAGED' | 'E2EE' } } | null;
}): RailSpace[] {
  if (state.workspaces.length > 0) return state.workspaces;
  if (state.session) {
    return [
      {
        id: state.session.workspace.id,
        name: state.session.workspace.name,
        security_mode: state.session.workspace.security_mode,
      },
    ];
  }
  return [];
}
