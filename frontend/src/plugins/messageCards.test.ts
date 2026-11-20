import { describe, expect, it } from 'vitest';
import type { ApiMessage, Poll, Task } from '../api/types';
import {
  canToggleTask,
  canVotePoll,
  embeddedPoll,
  embeddedTask,
  isPollMessage,
  isTaskMessage,
  pluginMessageKind,
  pluginMessageText,
  pluginTitleId,
  pollPercent,
  sortPollOptions,
} from './messageCards';

const POLL: Poll = {
  id: 'd0000000-0000-4000-8000-000000000001',
  question: 'Куда идём?',
  options: [
    { id: 'd0000000-0000-4000-8000-000000000012', text: 'Суши', position: 1, votes: 1 },
    { id: 'd0000000-0000-4000-8000-000000000011', text: 'Пицца', position: 0, votes: 2 },
  ],
  creator_id: '11111111-1111-4111-8111-111111111111',
  closed: false,
  closed_at: null,
  created_at: '2026-11-16T09:00:00.000Z',
  my_option_id: 'd0000000-0000-4000-8000-000000000011',
  total_votes: 3,
};

const TASK: Task = {
  id: 'e0000000-0000-4000-8000-000000000001',
  title: 'Подготовить демо',
  creator_id: '11111111-1111-4111-8111-111111111111',
  assignee_id: '66666666-6666-4666-8666-666666666666',
  due_at: '2026-11-25T12:00:00.000Z',
  done: false,
  completed_by: null,
  completed_at: null,
  created_at: '2026-11-16T09:00:00.000Z',
};

function message(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: '00000000-0000-4000-8000-000000000036',
    chat_id: '44444444-4444-4444-8444-444444444444',
    seq: 36,
    type: 'TEXT',
    sender_id: null,
    sender_display_name: null,
    text: null,
    created_at: '2026-11-16T09:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('#95 embedded poll guard', () => {
  it('returns a valid embedded poll and ignores other message types', () => {
    const pollMessage = message({ type: 'POLL', poll_id: POLL.id, poll: POLL });
    expect(embeddedPoll(pollMessage)).toEqual(POLL);
    expect(isPollMessage(pollMessage)).toBe(true);
    expect(pluginMessageKind(pollMessage)).toBe('POLL');
    expect(embeddedPoll(message({ type: 'TEXT' }))).toBeNull();
    expect(embeddedPoll(message({ type: 'TASK', task: TASK }))).toBeNull();
  });

  it('is fail-closed for tombstones, mismatched ids and malformed options', () => {
    expect(
      embeddedPoll(message({ type: 'POLL', deleted_at: '2026-11-16T09:00:00Z', poll: POLL })),
    ).toBeNull();
    expect(
      embeddedPoll(
        message({
          type: 'POLL',
          poll_id: 'd0000000-0000-4000-8000-000000000099',
          poll: POLL,
        }),
      ),
    ).toBeNull();
    expect(embeddedPoll(message({ type: 'POLL', poll: { ...POLL, question: '  ' } }))).toBeNull();
    expect(
      embeddedPoll(message({ type: 'POLL', poll: { ...POLL, options: [POLL.options[0]!] } })),
    ).toBeNull();
    expect(embeddedPoll(message({ type: 'POLL', poll: null }))).toBeNull();
  });

  it('sorts options by server position and computes clamped percentages', () => {
    expect(sortPollOptions(POLL).map((option) => option.text)).toEqual(['Пицца', 'Суши']);
    expect(pollPercent(2, 3)).toBe(67);
    expect(pollPercent(0, 0)).toBe(0);
    expect(pollPercent(5, 3)).toBe(100);
    expect(pollPercent(-1, 3)).toBe(0);
  });

  it('allows voting only on an open poll', () => {
    expect(canVotePoll(POLL)).toBe(true);
    expect(canVotePoll({ ...POLL, closed: true })).toBe(false);
  });
});

describe('#95 embedded task guard', () => {
  it('returns a valid embedded task and ignores other message types', () => {
    const taskMessage = message({ type: 'TASK', task_id: TASK.id, task: TASK });
    expect(embeddedTask(taskMessage)).toEqual(TASK);
    expect(isTaskMessage(taskMessage)).toBe(true);
    expect(pluginMessageKind(taskMessage)).toBe('TASK');
    expect(embeddedTask(message({ type: 'TEXT' }))).toBeNull();
    expect(embeddedTask(message({ type: 'POLL', poll: POLL }))).toBeNull();
  });

  it('is fail-closed for tombstones, mismatched ids and empty titles', () => {
    expect(
      embeddedTask(message({ type: 'TASK', deleted_at: '2026-11-16T09:00:00Z', task: TASK })),
    ).toBeNull();
    expect(
      embeddedTask(
        message({
          type: 'TASK',
          task_id: 'e0000000-0000-4000-8000-000000000099',
          task: TASK,
        }),
      ),
    ).toBeNull();
    expect(embeddedTask(message({ type: 'TASK', task: { ...TASK, title: '' } }))).toBeNull();
    expect(embeddedTask(message({ type: 'TASK', task: null }))).toBeNull();
  });

  it('allows toggling for the creator, the assignee or a manager only', () => {
    const viewer = TASK.creator_id;
    expect(canToggleTask(TASK, viewer, false)).toBe(true);
    expect(canToggleTask(TASK, TASK.assignee_id ?? null, false)).toBe(true);
    expect(canToggleTask(TASK, '77777777-7777-4777-8777-777777777777', false)).toBe(false);
    expect(canToggleTask(TASK, '77777777-7777-4777-8777-777777777777', true)).toBe(true);
    expect(canToggleTask(TASK, null, true)).toBe(false);
  });
});

describe('#95 plugin card helpers', () => {
  it('builds a stable title id and searchable text', () => {
    expect(pluginTitleId('abc')).toBe('plugin-title-abc');
    expect(pluginMessageText(message({ type: 'POLL', poll: POLL }))).toBe(POLL.question);
    expect(pluginMessageText(message({ type: 'TASK', task: TASK }))).toBe(TASK.title);
    expect(pluginMessageText(message({ text: 'обычный текст' }))).toBe('');
  });
});
