import type { ApiMessage, Poll, PollOption, Task } from '../api/types';

/**
 * #95: POLL/TASK messages are server-created projections of a poll/task. The
 * embedded object is nullable (non-plugin rows, tombstones) and the mobile
 * client never reconstructs it from the id alone — a missing/inconsistent
 * object renders an honest "unavailable" card instead of a fabricated poll.
 */
export type PluginMessageKind = 'POLL' | 'TASK';

export type PollMessage = ApiMessage & { type: 'POLL'; poll: Poll };
export type TaskMessage = ApiMessage & { type: 'TASK'; task: Task };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type discriminator only; the embedded object may still be missing. */
export function pluginMessageKind(message: ApiMessage): PluginMessageKind | null {
  if (message.type === 'POLL' || message.type === 'TASK') return message.type;
  return null;
}

function validPoll(value: unknown): value is Poll {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.question !== 'string' || value.question.trim().length === 0) return false;
  if (typeof value.total_votes !== 'number' || !Number.isFinite(value.total_votes)) return false;
  if (typeof value.closed !== 'boolean') return false;
  if (!Array.isArray(value.options) || value.options.length < 2) return false;
  return value.options.every(
    (option) =>
      isRecord(option) &&
      typeof option.id === 'string' &&
      option.id.length > 0 &&
      typeof option.text === 'string' &&
      option.text.length > 0 &&
      typeof option.votes === 'number' &&
      Number.isFinite(option.votes) &&
      typeof option.position === 'number' &&
      Number.isFinite(option.position),
  );
}

function validTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.title !== 'string' || value.title.trim().length === 0) return false;
  if (typeof value.done !== 'boolean') return false;
  return true;
}

/**
 * The poll embedded in a live POLL message, or `null`.
 *
 * A tombstone never carries content, and a `poll_id`/`poll.id` mismatch is
 * treated as malformed (the same defensive rule as the rest of the store).
 */
export function embeddedPoll(message: ApiMessage): Poll | null {
  if (message.type !== 'POLL' || message.deleted_at) return null;
  if (!validPoll(message.poll)) return null;
  if (message.poll_id && message.poll_id !== message.poll.id) return null;
  return message.poll;
}

/** The task embedded in a live TASK message, or `null` (see `embeddedPoll`). */
export function embeddedTask(message: ApiMessage): Task | null {
  if (message.type !== 'TASK' || message.deleted_at) return null;
  if (!validTask(message.task)) return null;
  if (message.task_id && message.task_id !== message.task.id) return null;
  return message.task;
}

export function isPollMessage(message: ApiMessage): message is PollMessage {
  return embeddedPoll(message) !== null;
}

export function isTaskMessage(message: ApiMessage): message is TaskMessage {
  return embeddedTask(message) !== null;
}

/** Card heading id shared by the row label and the card title. */
export function pluginTitleId(messageId: string): string {
  return `plugin-title-${messageId}`;
}

/** Server order is `position`, but a stable tie-break keeps renders deterministic. */
export function sortPollOptions(poll: Poll): PollOption[] {
  return [...poll.options].sort((a, b) => {
    const position = a.position - b.position;
    return position !== 0 ? position : a.id.localeCompare(b.id);
  });
}

/** Whole percent, clamped to 0..100 (server totals can be stale mid-request). */
export function pollPercent(votes: number, total: number): number {
  if (!Number.isFinite(votes) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((votes / total) * 100)));
}

/** Voting is allowed only on an open poll; the server still re-checks. */
export function canVotePoll(poll: Poll): boolean {
  return !poll.closed;
}

/**
 * Same rule as the task panel: the creator, the assignee, or a chat
 * OWNER/ADMIN may complete/reopen. The server remains authoritative.
 */
export function canToggleTask(task: Task, viewerId: string | null, canManage: boolean): boolean {
  if (viewerId === null) return false;
  return canManage || task.creator_id === viewerId || task.assignee_id === viewerId;
}

/** Searchable text for the in-chat filter (question/title included). */
export function pluginMessageText(message: ApiMessage): string {
  const poll = embeddedPoll(message);
  if (poll) return poll.question;
  const task = embeddedTask(message);
  return task?.title ?? '';
}
