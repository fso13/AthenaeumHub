import { act, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeviceId } from '../auth/session';
import type { Poll } from '../api/types';
import { insertMockPluginMessage } from '../mocks/db';
import { buildSeedPoll, buildSeedTask, IDS, messageId, SEED_POLL_SEQ } from '../mocks/fixtures';
import { mockRealtimeSubscribedChats, publishMockMessageCreated } from '../mocks/realtime';
import { createFakeE2eeBridge } from '../test/e2eeBridgeFake';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';
import { formatShortDate } from '../domain/messages';

const GROUP = IDS.groupChat;
const SEED_POLL = buildSeedPoll();
const SEED_TASK = buildSeedTask();
const POLL_QUESTION = 'Куда идём обедать?';
const TASK_TITLE = 'Собрать макеты';
const PIZZA = SEED_POLL.options.find((option) => option.text === 'Пицца')!;
const POLL_CARD = SEED_POLL.question;
const TASK_CARD = SEED_TASK.title;

type TestUser = ReturnType<typeof renderApp>['user'];

const stores: ChatStore[] = [];

function enablePlugins(...plugins: Array<'polls' | 'tasks' | 'translate'>): void {
  mockDb.chatPlugins.set(GROUP, new Map(plugins.map((plugin) => [plugin, true])));
}

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`message-${id}`);
  if (!row) throw new Error(`Message row ${id} is not rendered`);
  return row;
}

async function pollArticle(name = POLL_CARD): Promise<HTMLElement> {
  return screen.findByRole('article', { name });
}

async function taskArticle(name = TASK_CARD): Promise<HTMLElement> {
  return screen.findByRole('article', { name });
}

async function openPollDialog(user: TestUser): Promise<HTMLElement> {
  await waitForChat();
  const trigger = await screen.findByRole('button', { name: 'Создать опрос' });
  await user.click(trigger);
  return screen.findByRole('dialog', { name: 'Новый опрос' });
}

async function openTaskDialog(user: TestUser): Promise<HTMLElement> {
  await waitForChat();
  const trigger = await screen.findByRole('button', { name: 'Создать задачу' });
  await user.click(trigger);
  return screen.findByRole('dialog', { name: 'Новая задача' });
}

async function createPoll(user: TestUser, question = POLL_QUESTION): Promise<HTMLElement> {
  const dialog = await openPollDialog(user);
  await user.type(within(dialog).getByLabelText('Вопрос'), question);
  await user.type(within(dialog).getByLabelText('Вариант 1'), 'Пицца');
  await user.type(within(dialog).getByLabelText('Вариант 2'), 'Суши');
  await user.click(within(dialog).getByRole('button', { name: 'Создать опрос' }));
  return screen.findByRole('article', { name: question });
}

function seedPollRecord(question: string): Poll {
  const poll: Poll = {
    id: 'c0000000-0000-4000-8000-000000000010',
    question,
    options: [
      { id: 'c0000000-0000-4000-8000-000000000011', text: 'Да', position: 0, votes: 1 },
      { id: 'c0000000-0000-4000-8000-000000000012', text: 'Нет', position: 1, votes: 0 },
    ],
    creator_id: mockDb.me.user.id,
    closed: false,
    closed_at: null,
    created_at: '2026-11-16T09:00:00.000Z',
    my_option_id: 'c0000000-0000-4000-8000-000000000011',
    total_votes: 1,
  };
  mockDb.polls.set(poll.id, {
    chatId: GROUP,
    poll,
    votes: new Map([[mockDb.me.user.id, 'c0000000-0000-4000-8000-000000000011']]),
  });
  return poll;
}

function renderE2ee() {
  mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
  enablePlugins('polls', 'tasks', 'translate');
  const bridge = createFakeE2eeBridge({
    deviceId: () => getDeviceId() ?? IDS.device,
    snapshot: { chatId: GROUP, securityMode: 'E2EE', modeAction: 'allow_e2ee' },
  });
  return renderApp({}, { enabled: true, bridge });
}

function renderRealtime() {
  const result = renderApp({ realtimeEnabled: true });
  stores.push(result.store);
  return result;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('#95 POLL/TASK cards in the flat feed', () => {
  it('renders seeded poll and task history as cards with server metadata', async () => {
    enablePlugins('polls', 'tasks');
    const { container } = renderApp();
    await waitForChat();

    const poll = await pollArticle();
    expect(poll).toHaveClass('msg-row--plugin');
    expect(within(poll).getByRole('heading', { level: 3, name: POLL_CARD })).toBeVisible();
    expect(poll).toHaveTextContent('Идёт голосование');
    expect(poll).toHaveTextContent('Голосов: 3');
    expect(within(poll).getByRole('button', { name: /^Ваш голос: «Суши»/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(poll).getByRole('button', { name: /^Проголосовать за «Пицца»/ })).toBeEnabled();
    expect(poll.querySelector('.bubble')).toBeNull();

    const task = await taskArticle();
    const toggle = within(task).getByRole('checkbox', {
      name: 'Отметить задачу выполненной',
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    await waitFor(() => expect(task).toHaveTextContent('Исполнитель: Анна Петрова'));
    expect(task).toHaveTextContent(`Срок: ${formatShortDate(SEED_TASK.due_at ?? null)}`);

    // The feed is the only place that renders the full card.
    expect(container.querySelectorAll('.poll-card')).toHaveLength(1);
    expect(container.querySelectorAll('.task-card')).toHaveLength(1);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(30);
  });

  it('votes and closes from the card, updating the embedded message in place', async () => {
    enablePlugins('polls');
    const { container } = renderApp();
    await waitForChat();

    const card = await pollArticle();
    const rowsBefore = container.querySelectorAll('.msg-row').length;
    await userEventVote(card, PIZZA.text);

    const mine = await within(card).findByRole('button', { name: /^Ваш голос: «Пицца»/ });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    // One vote per user: switching the option never doubles the total.
    expect(card).toHaveTextContent('Голосов: 3');
    expect(mockDb.pollRequests.at(-1)).toMatchObject({ action: 'vote' });
    expect(container.querySelectorAll('.msg-row')).toHaveLength(rowsBefore);
    expect(screen.getAllByRole('article', { name: POLL_CARD })).toHaveLength(1);

    const history = mockDb.chats[GROUP]!.messages.find(
      (message) => message.poll_id === SEED_POLL.id,
    );
    expect(history?.poll?.my_option_id).toBe(PIZZA.id);
    expect(history?.poll?.total_votes).toBe(3);
    expect(history?.poll?.options.find((option) => option.id === PIZZA.id)?.votes).toBe(3);

    await userEventClosePoll(card);
    expect(await within(card).findAllByText('Опрос закрыт')).not.toHaveLength(0);
    expect(within(card).getByRole('button', { name: /^Ваш голос: «Пицца»/ })).toBeDisabled();
    expect(history?.poll?.closed).toBe(true);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(rowsBefore);
  });

  it('creates a poll, closes the dialog and focuses the new feed card once', async () => {
    enablePlugins('polls');
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });
    const { user, container } = renderApp();
    const card = await createPoll(user);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(card).toHaveClass('msg-row--plugin');
    const record = [...mockDb.polls.values()].find((item) => item.poll.question === POLL_QUESTION);
    expect(record).toBeDefined();
    const messages = mockDb.chats[GROUP]!.messages.filter(
      (message) => message.poll_id === record!.poll.id,
    );
    expect(messages).toHaveLength(1);
    expect(card.id).toBe(`message-${messages[0]!.id}`);
    expect(scrollSpy).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(container.querySelectorAll('.msg-row')).toHaveLength(31);
    // No panel-only duplicate: the only article with this question is the feed row.
    expect(screen.getAllByRole('article', { name: POLL_QUESTION })).toHaveLength(1);
  });

  it('creates a task, completes and reopens it from the card', async () => {
    enablePlugins('tasks');
    const { user, container } = renderApp();
    const dialog = await openTaskDialog(user);
    await user.type(within(dialog).getByLabelText('Заголовок'), TASK_TITLE);
    await user.selectOptions(await within(dialog).findByLabelText('Исполнитель'), IDS.anna);
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));

    const card = await taskArticle(TASK_TITLE);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const toggle = within(card).getByRole('checkbox', { name: 'Отметить задачу выполненной' });
    const rowsBefore = container.querySelectorAll('.msg-row').length;

    await user.click(toggle);
    await waitFor(() => expect(within(card).getByRole('checkbox')).toBeChecked());
    expect(card).toHaveTextContent('Выполнено');
    expect(card).toHaveTextContent('Выполнил(а):');
    const record = [...mockDb.tasks.values()].find((item) => item.task.title === TASK_TITLE);
    expect(record?.task.assignee_id).toBe(IDS.anna);
    expect(record?.task.done).toBe(true);
    const message = mockDb.chats[GROUP]!.messages.find((item) => item.task_id === record!.task.id);
    expect(message?.task?.done).toBe(true);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(rowsBefore);

    await user.click(within(card).getByRole('checkbox'));
    await waitFor(() =>
      expect(
        within(card).getByRole('checkbox', { name: 'Отметить задачу выполненной' }),
      ).not.toBeChecked(),
    );
    expect(record?.task.done).toBe(false);
    expect(message?.task?.done).toBe(false);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(rowsBefore);
  });

  it('renders read-only cards and no create actions when plugins are off', async () => {
    const { container } = renderApp();
    await waitForChat();

    expect(screen.queryByRole('button', { name: 'Создать опрос' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать задачу' })).not.toBeInTheDocument();

    const poll = await pollArticle();
    const option = within(poll).getByRole('button', { name: /^Ваш голос: «Суши»/ });
    expect(option).toBeDisabled();
    expect(option).toHaveAttribute(
      'title',
      'Голосование недоступно: плагин опросов выключен в этом чате.',
    );
    expect(within(poll).queryByRole('button', { name: 'Закрыть опрос' })).not.toBeInTheDocument();

    const task = await taskArticle();
    const toggle = within(task).getByRole('checkbox');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute(
      'title',
      'Действия с задачей недоступны: плагин задач выключен в этом чате.',
    );
    expect(container.querySelectorAll('.plugin-message').length).toBeGreaterThanOrEqual(2);
  });

  it('allows reactions and delete-for-me but no reply/thread or delete-for-all', async () => {
    enablePlugins('polls');
    const { user } = renderApp();
    await waitForChat();
    await pollArticle();
    const row = rowFor(messageId(SEED_POLL_SEQ));

    await user.hover(row);
    await user.click(await within(row).findByRole('button', { name: 'Ещё действия' }));
    expect(
      within(row).queryByRole('button', { name: /Ответ на сообщение/ }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: /Начать обсуждение/ }),
    ).not.toBeInTheDocument();
    const edit = within(row).getByRole('button', { name: 'Редактировать сообщение' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Можно редактировать только текстовые сообщения');

    await user.click(within(row).getByRole('button', { name: 'Поставить реакцию' }));
    await user.click(await screen.findByRole('button', { name: '👍' }));
    expect(await within(row).findByRole('button', { name: /👍: 1/ })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Ещё действия' }));
    await user.click(within(row).getByRole('button', { name: 'Удалить сообщение' }));
    expect(await within(row).findByText('Удалить у себя')).toBeVisible();
    expect(within(row).queryByText('Удалить у всех')).not.toBeInTheDocument();
    expect(
      within(row).getByText(
        'Карточка скроется только у вас: сам опрос или задача останутся у участников.',
      ),
    ).toBeVisible();
    await user.click(within(row).getByRole('button', { name: /Удалить у себя/ }));
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: POLL_CARD })).not.toBeInTheDocument(),
    );
    expect(mockDb.chats[GROUP]!.messages.some((item) => item.poll_id === SEED_POLL.id)).toBe(true);
  });

  it('shows the details index and jumps to the feed card without a second card', async () => {
    enablePlugins('polls', 'tasks');
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Опросы/ }));

    expect(await screen.findByText('Опросы показываются карточками в ленте чата.')).toBeVisible();
    await user.click(screen.getAllByRole('button', { name: 'Показать в ленте' })[0]!);
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(`message-${messageId(SEED_POLL_SEQ)}`),
    );
    expect(screen.getAllByRole('article', { name: POLL_CARD })).toHaveLength(1);
    expect(document.querySelectorAll('.panel-expand .poll-card')).toHaveLength(0);
  });

  it('renders a live POLL message from WS once, without a reload', async () => {
    enablePlugins('polls');
    const { container, store } = renderRealtime();
    await waitForChat();
    await vi.waitFor(
      () => {
        expect(store.getSnapshot().realtimeStatus).toBe('online');
        expect(mockRealtimeSubscribedChats()).toContain(GROUP);
      },
      { timeout: 4_000 },
    );

    const poll: Poll = {
      ...buildSeedPoll(),
      id: 'd0000000-0000-4000-8000-000000000099',
      question: 'Живой опрос',
      my_option_id: null,
      total_votes: 0,
      options: buildSeedPoll().options.map((option) => ({ ...option, votes: 0 })),
    };
    const message = insertMockPluginMessage(mockDb, GROUP, { type: 'POLL', poll });
    act(() => publishMockMessageCreated(mockDb, message));

    const card = await screen.findByRole('article', { name: 'Живой опрос' });
    expect(card).toHaveClass('msg-row--plugin');
    expect(container.querySelectorAll('.msg-row')).toHaveLength(31);
    expect(screen.getAllByRole('article', { name: 'Живой опрос' })).toHaveLength(1);
  });

  it('passes axe audits on the feed cards, the panel index and the dialogs', async () => {
    enablePlugins('polls', 'tasks');
    seedPollRecord('Вопрос для индекса');
    const { user } = renderApp();
    await waitForChat();

    const audit = async () => {
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(
        results.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
    };

    await pollArticle();
    await taskArticle();
    await audit();

    await user.click(await screen.findByRole('button', { name: /^Опросы/ }));
    await screen.findByText('Опросы показываются карточками в ленте чата.');
    await audit();

    await user.click(screen.getByRole('button', { name: 'Создать опрос' }));
    await screen.findByRole('dialog', { name: 'Новый опрос' });
    await audit();
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));

    await user.click(screen.getByRole('button', { name: 'Создать задачу' }));
    await screen.findByRole('dialog', { name: 'Новая задача' });
    await audit();
  });
});

describe('#95 POLL/TASK message guards in the app shell', () => {
  it('never renders a server poll projection in an E2EE chat', async () => {
    const { container } = renderE2ee();
    await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
    await waitFor(() => expect(container.querySelectorAll('.msg-row').length).toBeGreaterThan(0));
    expect(container.querySelector('.poll-card')).toBeNull();
    expect(container.querySelector('.task-card')).toBeNull();
  });
});

async function userEventVote(card: HTMLElement, option: string): Promise<void> {
  const button = within(card).getByRole('button', {
    name: new RegExp(`^Проголосовать за «${option}»`),
  });
  await act(async () => {
    button.click();
  });
  await waitFor(() => expect(mockDb.pollRequests.at(-1)).toMatchObject({ action: 'vote' }));
}

async function userEventClosePoll(card: HTMLElement): Promise<void> {
  const button = within(card).getByRole('button', { name: 'Закрыть опрос' });
  await act(async () => {
    button.click();
  });
  await waitFor(() => expect(mockDb.pollRequests.at(-1)).toMatchObject({ action: 'close' }));
}
