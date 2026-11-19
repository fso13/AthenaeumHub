import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

function setWorkspaceRole(role: WorkspaceRole): void {
  const workspace = mockDb.me.workspaces[0];
  if (!workspace) throw new Error('Mock workspace is missing');
  workspace.role = role;
}

/** Replace the server-side workspace objects, leaving the loaded UI state intact. */
function setServerWorkspaceRole(role: WorkspaceRole): void {
  mockDb.me = {
    ...mockDb.me,
    workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role })),
  };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openSettings(
  user: TestUser,
): Promise<{ dialog: HTMLElement; trigger: HTMLElement }> {
  await login(user);
  const trigger = screen.getByRole('button', { name: 'О чате' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
  return { dialog, trigger };
}

function groupSummary() {
  const chat = mockDb.chats[IDS.groupChat];
  if (!chat) throw new Error('Mock group chat is missing');
  return chat.summary;
}

describe('D1-FE5 chat settings', () => {
  it('saves trimmed name/description after the server responds and refreshes header/list', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue(
      'Команда «Восход»',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Описание' })).toHaveValue('');

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Название' }),
      '  Продуктовая   команда  ',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Описание' }),
      '  Описание команды  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(
      await within(dialog).findByText('Настройки сохранены. Заголовок и список чатов обновлены.'),
    ).toBeInTheDocument();
    expect(mockDb.chatSettingsRequests).toHaveLength(1);
    expect(mockDb.chatSettingsRequests[0]?.chatId).toBe(IDS.groupChat);
    expect(mockDb.chatSettingsRequests[0]?.body).toEqual({
      name: 'Продуктовая команда',
      description: 'Описание команды',
    });
    expect(mockDb.chatSettingsRequests[0]?.deviceId).toBeTruthy();
    expect(groupSummary().name).toBe('Продуктовая команда');
    expect(groupSummary().description).toBe('Описание команды');

    // Header and sidebar derive from the same server-confirmed summary.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Продуктовая команда' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Продуктовая команда').length).toBeGreaterThan(1);
  });

  it('never applies an optimistic update while the PATCH is in flight', async () => {
    mockDb.chatSettingsDelayMs = 80;
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), 'Новое имя');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.chatSettingsRequests).toHaveLength(1));
    expect(screen.getByRole('heading', { level: 1, name: 'Команда «Восход»' })).toBeInTheDocument();
    expect(groupSummary().name).toBe('Команда «Восход»');
    expect(within(dialog).getByRole('button', { name: 'Сохраняем…' })).toBeDisabled();

    expect(await screen.findByRole('heading', { level: 1, name: 'Новое имя' })).toBeInTheDocument();
  });

  it('validates name/description before sending and explains the rules', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(within(dialog).getByText('Введите название чата.')).toBeInTheDocument();
    expect(mockDb.chatSettingsRequests).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'a'.repeat(121) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      within(dialog).getByText('Название должно быть не длиннее 120 символов.'),
    ).toBeInTheDocument();
    expect(mockDb.chatSettingsRequests).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: '<b>команда</b>' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      within(dialog).getByText('Название не может содержать <, > и управляющие символы.'),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Команда «Восход»' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Описание' }), {
      target: { value: 'x'.repeat(501) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      within(dialog).getByText('Описание должно быть не длиннее 500 символов.'),
    ).toBeInTheDocument();
    expect(mockDb.chatSettingsRequests).toHaveLength(0);
  });

  it('allows name but disables description in an E2EE chat with an honest note', async () => {
    mockDb.chats[IDS.groupChat]!.summary.security_mode = 'E2EE';
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    const description = within(dialog).getByRole('textbox', { name: 'Описание' });
    expect(description).toBeDisabled();
    expect(
      within(dialog).getByText(
        'В чате со сквозным шифрованием сервер не хранит описание: оно было бы открытым текстом. Название менять можно.',
      ),
    ).toBeInTheDocument();

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), 'E2EE label');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.chatSettingsRequests).toHaveLength(1));
    expect(mockDb.chatSettingsRequests[0]?.body).toEqual({ name: 'E2EE label' });
    expect(mockDb.chatSettingsRequests[0]?.body).not.toHaveProperty('description');
    expect(groupSummary().name).toBe('E2EE label');
  });

  it('renders MEMBER/GUEST controls read-only and never sends a PATCH', async () => {
    setWorkspaceRole('MEMBER');
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'Описание' })).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Менять название и описание могут владелец и администратор пространства. Вам доступен просмотр.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Сохранить' })).toBeNull();
    expect(mockDb.chatSettingsRequests).toHaveLength(0);
  });

  it('shows a translated 403 and leaves the chat unchanged when the server denies the role', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    // The UI still believes OWNER (loaded at bootstrap); the server uses its
    // own role and rejects the request.
    setServerWorkspaceRole('MEMBER');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), 'Нельзя');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(
      await within(dialog).findByText(
        'Недостаточно прав: менять настройки могут владелец и администратор пространства.',
      ),
    ).toBeInTheDocument();
    expect(groupSummary().name).toBe('Команда «Восход»');
  });

  it('shows a translated 404 when the chat disappeared', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), 'Новое имя');
    delete mockDb.chats[IDS.groupChat];
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      await within(dialog).findByText('Чат не найден или недоступен. Обновите список чатов.'),
    ).toBeInTheDocument();
  });

  it('maps a server 422 field error to the matching message', async () => {
    mockDb.forceChatSettingsError = {
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'description is invalid',
      details: { field: 'description', max_length: 500 },
    };
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.type(within(dialog).getByRole('textbox', { name: 'Описание' }), 'Описание');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(
      await within(dialog).findByText(
        'Проверьте описание: до 500 символов, без <, > и управляющих символов.',
      ),
    ).toBeInTheDocument();
    expect(groupSummary().description).toBeUndefined();
  });

  it('maps a server 409 conflict without losing the draft', async () => {
    mockDb.forceChatSettingsError = {
      status: 409,
      code: 'CONFLICT',
      message: 'Chat was modified',
    };
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.clear(within(dialog).getByRole('textbox', { name: 'Название' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), 'Черновик');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(
      await within(dialog).findByText(
        'Чат изменился на сервере. Обновите данные и попробуйте снова.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue('Черновик');
    expect(groupSummary().name).toBe('Команда «Восход»');
  });

  it('surfaces the server E2EE 422 if policy rejects a description after the UI state is stale', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    mockDb.chats[IDS.groupChat]!.summary.security_mode = 'E2EE';
    await user.type(within(dialog).getByRole('textbox', { name: 'Описание' }), 'Открытый текст');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(
      await within(dialog).findByText(
        'Описание недоступно в E2EE-чате. Название можно сохранить отдельно.',
      ),
    ).toBeInTheDocument();
    expect(groupSummary().description).toBeUndefined();
  });

  it('delegates members to the existing E12 dialog without duplicating its API', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    const before = mockDb.memberDirectoryRequests.length;
    await user.click(
      within(dialog).getByRole('button', { name: 'Открыть участников пространства' }),
    );

    const members = await screen.findByRole('dialog', { name: 'Участники пространства' });
    await within(members).findByText('Анна Петрова');
    expect(screen.queryByRole('dialog', { name: 'Настройки чата' })).toBeNull();
    expect(mockDb.memberDirectoryRequests.length).toBeGreaterThan(before);
    expect(mockDb.memberDirectoryRequests.at(-1)).toMatchObject({
      workspaceId: IDS.workspace,
      query: null,
    });
  });

  it('keeps archive/leave/delete explicitly disabled until the backend exists', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Опасная зона' }));
    expect(within(dialog).getByRole('button', { name: 'Архивировать чат' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Покинуть чат' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Удалить чат' })).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Недоступно: в этом срезе нет API архивации, выхода или удаления чата.',
      ),
    ).toBeInTheDocument();
    expect(mockDb.adminDirectory.chatDeleteRequests).toHaveLength(0);
  });

  it('traps focus, closes on Escape and returns focus to the header trigger', async () => {
    const { user } = renderPasswordApp();
    const { dialog, trigger } = await openSettings(user);

    const name = within(dialog).getByRole('textbox', { name: 'Название' });
    await waitFor(() => expect(name).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройки чата' })).toBeNull(),
    );
    expect(trigger).toHaveFocus();
  });

  it('passes an axe audit with chat settings open', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openSettings(user);

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    expect(dialog).toBeInTheDocument();
  });
});
