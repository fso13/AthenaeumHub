import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { getDeviceId } from '../auth/session';
import type { Task } from '../api/types';
import { IDS, messageId } from '../mocks/fixtures';
import { createFakeE2eeBridge } from '../test/e2eeBridgeFake';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const GROUP = IDS.groupChat;
const POLL_QUESTION = 'Куда идём обедать?';
const TASK_TITLE = 'Собрать макеты';

type TestUser = ReturnType<typeof renderApp>['user'];

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

function seedPoll(question = 'Вопрос для панели'): void {
  mockDb.polls.set('c0000000-0000-4000-8000-000000000010', {
    chatId: GROUP,
    poll: {
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
    },
    votes: new Map([[mockDb.me.user.id, 'c0000000-0000-4000-8000-000000000011']]),
  });
}

function seedTask(title = TASK_TITLE, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 'a0000000-0000-4000-8000-000000000001',
    title,
    creator_id: mockDb.me.user.id,
    assignee_id: null,
    due_at: null,
    done: false,
    completed_by: null,
    completed_at: null,
    created_at: '2026-11-16T09:00:00.000Z',
    ...overrides,
  };
  mockDb.tasks.set(task.id, { chatId: GROUP, task });
  return task;
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

describe('D1.1 (#76) poll actions', () => {
  it('creates a poll, lists it, votes and closes it with server state', async () => {
    enablePlugins('polls');
    const { user } = renderApp();
    const card = await createPoll(user);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const pizza = within(card).getByRole('button', { name: /^Проголосовать за «Пицца»/ });
    await user.click(pizza);

    const mine = await within(card).findByRole('button', { name: /^Ваш голос: «Пицца»/ });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveTextContent('Голосов: 1');
    expect(card).toHaveTextContent('1 · 100%');
    expect(mockDb.pollRequests.at(-1)).toMatchObject({ action: 'vote' });

    await user.click(within(card).getByRole('button', { name: 'Закрыть опрос' }));
    await within(card).findByText('Опрос закрыт');
    expect(within(card).queryByRole('button', { name: 'Закрыть опрос' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^Ваш голос: «Пицца»/ })).toBeDisabled();
    const record = [...mockDb.polls.values()].find((item) => item.poll.question === POLL_QUESTION);
    expect(record?.poll.closed).toBe(true);
  });

  it('validates the question and unique options before calling the API', async () => {
    enablePlugins('polls');
    const { user } = renderApp();
    const dialog = await openPollDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Создать опрос' }));
    expect(await within(dialog).findByText('Введите вопрос длиной до 500 символов.')).toBeVisible();

    await user.type(within(dialog).getByLabelText('Вопрос'), 'Вопрос');
    await user.type(within(dialog).getByLabelText('Вариант 1'), 'Дубль');
    await user.type(within(dialog).getByLabelText('Вариант 2'), 'Дубль');
    await user.click(within(dialog).getByRole('button', { name: 'Создать опрос' }));
    expect(await within(dialog).findAllByText('Варианты не должны повторяться.')).toHaveLength(2);
    expect(mockDb.pollRequests.filter((request) => request.action === 'create')).toHaveLength(0);
  });

  it('shows the empty state', async () => {
    enablePlugins('polls');
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Опросы/ }));
    expect(await screen.findByText('Опросов пока нет.')).toBeVisible();
  });

  it('shows an honest list error with a retry', async () => {
    enablePlugins('polls');
    mockDb.forcePollListError = {
      status: 500,
      code: 'SERVER_ERROR',
      message: 'Poll service failed',
    };
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Опросы/ }));
    expect(await screen.findByText('Не удалось загрузить опросы.')).toBeVisible();

    mockDb.forcePollListError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Опросов пока нет.')).toBeVisible();
  });
});

describe('D1.1 (#76) task actions', () => {
  it('creates a task with assignee/due, completes it and filters done/open', async () => {
    enablePlugins('tasks');
    const { user } = renderApp();
    const dialog = await openTaskDialog(user);

    await user.type(within(dialog).getByLabelText('Заголовок'), TASK_TITLE);
    await user.selectOptions(await within(dialog).findByLabelText('Исполнитель'), IDS.anna);
    fireEvent.change(within(dialog).getByLabelText('Срок'), {
      target: { value: '2026-12-01T12:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));

    const card = await screen.findByRole('article', { name: TASK_TITLE });
    const toggle = within(card).getByRole('checkbox', {
      name: 'Отметить задачу выполненной',
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    // The open filter is a view over server rows: a completed task moves out.
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: TASK_TITLE })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Выполненные' }));
    const doneCard = await screen.findByRole('article', { name: TASK_TITLE });
    expect(doneCard).toHaveTextContent('Выполнено');
    expect(doneCard).toHaveTextContent('Выполнил(а):');
    expect(within(doneCard).getByRole('checkbox')).toBeChecked();

    await user.click(within(doneCard).getByRole('checkbox'));
    expect(await screen.findByText('Выполненных задач нет.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Открытые' }));
    const reopened = await screen.findByRole('article', { name: TASK_TITLE });
    expect(within(reopened).getByRole('checkbox')).not.toBeChecked();

    const record = [...mockDb.tasks.values()].find((item) => item.task.title === TASK_TITLE);
    expect(record?.task.assignee_id).toBe(IDS.anna);
    expect(record?.task.due_at).toEqual(expect.any(String));
  });

  it('keeps the checkbox unchecked when the server rejects the update', async () => {
    enablePlugins('tasks');
    seedTask();
    mockDb.forceTaskUpdateError = {
      status: 500,
      code: 'SERVER_ERROR',
      message: 'Task service failed',
    };
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Задачи/ }));

    const card = await screen.findByRole('article', { name: TASK_TITLE });
    const toggle = within(card).getByRole('checkbox', { name: 'Отметить задачу выполненной' });
    await user.click(toggle);

    expect(await within(card).findByRole('alert')).toHaveTextContent('Не удалось обновить задачу.');
    expect(toggle).not.toBeChecked();
    expect([...mockDb.tasks.values()][0]?.task.done).toBe(false);
  });

  it('shows the empty open/done states', async () => {
    enablePlugins('tasks');
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Задачи/ }));
    expect(await screen.findByText('Открытых задач нет.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Выполненные' }));
    expect(await screen.findByText('Выполненных задач нет.')).toBeVisible();
  });

  it('shows an honest list error with a retry', async () => {
    enablePlugins('tasks');
    mockDb.forceTaskListError = {
      status: 500,
      code: 'SERVER_ERROR',
      message: 'Task service failed',
    };
    const { user } = renderApp();
    await waitForChat();
    await user.click(await screen.findByRole('button', { name: /^Задачи/ }));
    expect(await screen.findByText('Не удалось загрузить задачи.')).toBeVisible();

    mockDb.forceTaskListError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Открытых задач нет.')).toBeVisible();
  });
});

describe('D1.1 (#76) translation action', () => {
  it('translates a managed TEXT message to the chosen target and hides the block', async () => {
    enablePlugins('translate');
    const { user } = renderApp();
    await waitForChat();

    const message = mockDb.chats[GROUP]!.messages.find((item) => item.id === messageId(37));
    if (!message) throw new Error('TEXT fixture missing');
    const row = rowFor(message.id);
    await user.hover(row);
    const trigger = await within(row).findByRole('button', { name: /Перевести сообщение/ });
    await user.click(trigger);

    const menu = await screen.findByRole('dialog', { name: 'Перевести на' });
    await user.click(within(menu).getByRole('button', { name: 'English' }));

    const block = await within(row).findByText('Перевод: English');
    expect(block).toBeVisible();
    expect(within(row).getByText(new RegExp(`\\[en\\]`))).toBeVisible();
    expect(mockDb.translationRequests[0]).toMatchObject({
      chatId: GROUP,
      messageId: message.id,
      body: { target: 'en' },
    });

    await user.click(within(row).getByRole('button', { name: /Перевести сообщение/ }));
    await user.click(screen.getByRole('button', { name: 'Русский' }));
    expect(await within(row).findByText('Перевод: Русский')).toBeVisible();
    expect(within(row).getByText(/\[ru\]/)).toBeVisible();

    await user.click(within(row).getByRole('button', { name: 'Скрыть перевод' }));
    expect(within(row).queryByText(/Перевод: Русский/)).not.toBeInTheDocument();
  });

  it('shows an honest 503 state and retries without a fake translation', async () => {
    enablePlugins('translate');
    mockDb.translationAvailable = false;
    const { user } = renderApp();
    await waitForChat();

    const row = rowFor(messageId(37));
    await user.hover(row);
    await user.click(await within(row).findByRole('button', { name: /Перевести сообщение/ }));
    await user.click(await screen.findByRole('button', { name: 'English' }));

    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('Перевод временно недоступен');
    expect(within(row).queryByText(/\[en\]/)).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Повторить перевод' })).toBeVisible();
  });

  it('never offers translation for a sticker row or in an E2EE chat', async () => {
    enablePlugins('translate');
    const first = renderApp();
    await waitForChat();
    const sticker = rowFor(messageId(34));
    await first.user.hover(sticker);
    expect(
      within(sticker).queryByRole('button', { name: /Перевести сообщение/ }),
    ).not.toBeInTheDocument();
    first.unmount();

    renderE2ee();
    await waitForChat();
    expect(screen.queryByRole('button', { name: /Перевести сообщение/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать опрос' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать задачу' })).not.toBeInTheDocument();
  });
});

describe('D1.1 (#76) plugin gate', () => {
  it('renders no action buttons when the plugins are disabled', async () => {
    const { user } = renderApp();
    await waitForChat();
    await waitFor(() => expect(mockDb.chatPluginListRequests.length).toBeGreaterThan(0));

    expect(screen.queryByRole('button', { name: 'Создать опрос' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать задачу' })).not.toBeInTheDocument();
    const row = rowFor(messageId(37));
    await user.hover(row);
    expect(
      within(row).queryByRole('button', { name: /Перевести сообщение/ }),
    ).not.toBeInTheDocument();
  });

  it('passes axe audits on the poll/task panels and the translated block', async () => {
    enablePlugins('polls', 'tasks', 'translate');
    seedPoll();
    seedTask();
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

    await user.click(await screen.findByRole('button', { name: /^Опросы/ }));
    await screen.findByRole('article', { name: 'Вопрос для панели' });
    await audit();

    await user.click(screen.getByRole('button', { name: /^Задачи/ }));
    await screen.findByRole('article', { name: TASK_TITLE });
    await audit();

    const row = rowFor(messageId(37));
    await user.hover(row);
    await user.click(await within(row).findByRole('button', { name: /Перевести сообщение/ }));
    await user.click(await screen.findByRole('button', { name: 'English' }));
    await within(row).findByText('Перевод: English');
    await audit();
  });

  it('passes axe audits on the poll and task dialogs', async () => {
    enablePlugins('polls', 'tasks');
    const { user } = renderApp();
    await openPollDialog(user);

    const pollResults = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      pollResults.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    await openTaskDialog(user);
    const taskResults = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      taskResults.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });
});
