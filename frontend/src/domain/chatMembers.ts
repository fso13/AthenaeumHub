import type { ChatSummary } from '../api/types';

/**
 * Backend #99 adds an additive `member_count` to `ChatSummary`. The field is
 * optional in the contract window while the client/backend roll out, so read it
 * defensively and never invent a number: `null` means "fall back to the
 * workspace directory".
 */
export type ChatSummaryWithMemberCount = ChatSummary & { member_count?: unknown };

export function chatMemberCount(chat: ChatSummary | null | undefined): number | null {
  if (!chat) return null;
  const value = (chat as ChatSummaryWithMemberCount).member_count;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}
