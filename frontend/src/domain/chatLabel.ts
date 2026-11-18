import type { ChatSummary, WorkspaceMember } from '../api/types';
import { t } from '../i18n/ru';

/**
 * E10-F: `ChatSummary.name` is nullable and the backend stores DIRECT chats
 * without a name — the peer display name lives in the member directory. Resolve
 * it from the already loaded directory, falling back to a generic label instead
 * of leaking the previous/session chat name into a DIRECT header.
 */
export function chatDisplayName(
  chat: ChatSummary | null,
  members: readonly WorkspaceMember[],
  sessionChatName?: string | null,
): string {
  if (chat?.name) return chat.name;
  if (chat?.type === 'DIRECT') {
    const peer = chat.peer_id
      ? members.find((member) => member.user_id === chat.peer_id)
      : undefined;
    return peer?.display_name ?? t('chat.direct');
  }
  if (chat) return t('chat.group');
  return sessionChatName ?? t('chat.label');
}
