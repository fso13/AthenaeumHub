import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openMembersTab(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
  await user.click(within(dialog).getByRole('tab', { name: 'Участники' }));
  await within(dialog).findByText('Анна Петрова');
  return dialog;
}

function setChatRole(userId: string, role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST') {
  const rows = mockDb.chatMembers[IDS.groupChat] ?? [];
  const row = rows.find((member) => member.user_id === userId);
  if (!row) throw new Error('Mock chat member is missing');
  row.role = role;
}

/**
 * The default workspace seed has exactly the four chat participants. The add
 * tests need ACTIVE workspace members outside the channel, which is the real
 * backend state; they are added to the mock directory explicitly.
 */
function seedWorkspaceCandidates(): void {
  mockDb.workspaceMembers.push(
    {
      user_id: IDS.olga,
      display_name: 'Ольга Смирнова',
      role: 'MEMBER',
      joined_at: '2026-01-05T09:00:00.000Z',
    },
    {
      user_id: IDS.pavel,
      display_name: 'Павел Орлов',
      role: 'MEMBER',
      joined_at: '2026-01-06T09:00:00.000Z',
    },
  );
}

describe('#79 chat member management', () => {
  it('lists display_name/role/status/joined_at and offers add/role/remove to the OWNER', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    expect(within(dialog).getByText('Дмитрий Крылов')).toBeInTheDocument();
    expect(within(dialog).getByText('Марк Соколов')).toBeInTheDocument();
    expect(within(dialog).getByText('Лена Волкова')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Активен')).toHaveLength(4);
    expect(within(dialog).getAllByText(/^В канале с /)).toHaveLength(4);
    expect(dialog.textContent).not.toContain('@');

    // Self never gets role/remove controls; MANAGER rules apply to the rest.
    expect(
      within(dialog).queryByRole('combobox', { name: 'Роль участника Дмитрий Крылов' }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: 'Удалить участника: Дмитрий Крылов' }),
    ).toBeNull();
    expect(
      within(dialog).getByRole('combobox', { name: 'Роль участника Марк Соколов' }),
    ).toHaveValue('MEMBER');
    expect(
      within(dialog).getByRole('button', { name: 'Удалить участника: Марк Соколов' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Найти участника пространства')).toBeInTheDocument();
  });

  it('searches the ACTIVE workspace directory, adds with the chosen role and reloads server rows', async () => {
    seedWorkspaceCandidates();
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    await user.type(within(dialog).getByLabelText('Найти участника пространства'), 'Ольга');
    // Wait for the debounced server search, not just the initial directory
    // snapshot (which already contains Ольга in this fixture).
    await waitFor(() => {
      expect(mockDb.memberDirectoryRequests.at(-1)?.query).toBe('Ольга');
    });
    await waitFor(async () => {
      expect(within(dialog).getByLabelText('Кандидат')).toHaveTextContent('Ольга Смирнова');
    });
    await user.selectOptions(within(dialog).getByLabelText('Кандидат'), IDS.olga);
    await user.selectOptions(within(dialog).getByLabelText('Роль'), 'ADMIN');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    expect(await within(dialog).findByText('Участник добавлен в канал.')).toBeInTheDocument();
    expect(within(dialog).getByText('Ольга Смирнова')).toBeInTheDocument();
    expect(mockDb.chatMemberRequests).toContainEqual(
      expect.objectContaining({
        chatId: IDS.groupChat,
        action: 'add',
        userId: IDS.olga,
        role: 'ADMIN',
      }),
    );
    expect(mockDb.chatMembers[IDS.groupChat]?.some((m) => m.user_id === IDS.olga)).toBe(true);
    expect(
      within(dialog).getByRole('combobox', { name: 'Роль участника Ольга Смирнова' }),
    ).toHaveValue('ADMIN');
    // The added participant is no longer offered as a candidate.
    expect(within(dialog).getByLabelText('Кандидат')).not.toHaveTextContent('Ольга Смирнова');
  });

  it('applies a role change only from the server response and explains 409/403 honestly', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Роль участника Марк Соколов' }),
      'ADMIN',
    );
    expect(await within(dialog).findByText('Роль участника изменена.')).toBeInTheDocument();
    expect(mockDb.chatMemberRequests).toContainEqual(
      expect.objectContaining({ action: 'role', userId: IDS.mark, role: 'ADMIN' }),
    );
    expect(
      within(dialog).getByRole('combobox', { name: 'Роль участника Марк Соколов' }),
    ).toHaveValue('ADMIN');

    mockDb.forceChatMemberRoleError = {
      status: 409,
      code: 'LAST_OWNER',
      message: 'Cannot demote the last owner',
    };
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Роль участника Лена Волкова' }),
      'MEMBER',
    );
    expect(
      await within(dialog).findByText(
        'Нельзя снять последнего владельца канала. Сначала назначьте другого владельца.',
      ),
    ).toBeInTheDocument();
    // The rejected change is not applied locally.
    expect(
      within(dialog).getByRole('combobox', { name: 'Роль участника Лена Волкова' }),
    ).toHaveValue('GUEST');

    mockDb.forceChatMemberRoleError = {
      status: 403,
      code: 'ROLE_CHANGE_FORBIDDEN',
      message: 'Role change forbidden',
    };
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Роль участника Лена Волкова' }),
      'MEMBER',
    );
    expect(
      await within(dialog).findByText(
        'Администратор не может менять владельцев и администраторов и назначать эти роли.',
      ),
    ).toBeInTheDocument();
  });

  it('gives ADMIN only MODERATOR/MEMBER/GUEST and hides OWNER/ADMIN targets', async () => {
    setChatRole(IDS.user, 'ADMIN');
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    const markSelect = within(dialog).getByRole('combobox', {
      name: 'Роль участника Марк Соколов',
    }) as HTMLSelectElement;
    expect(Array.from(markSelect.options).map((option) => option.value)).toEqual([
      'MODERATOR',
      'MEMBER',
      'GUEST',
    ]);
    expect(
      within(dialog).queryByRole('combobox', { name: 'Роль участника Анна Петрова' }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: 'Удалить участника: Анна Петрова' }),
    ).toBeNull();

    const addRole = within(dialog).getByLabelText('Роль') as HTMLSelectElement;
    expect(Array.from(addRole.options).map((option) => option.value)).toEqual([
      'MODERATOR',
      'MEMBER',
      'GUEST',
    ]);
  });

  it('removes only after confirmation and keeps the row on a server 403', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'Удалить участника: Марк Соколов' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Удалить участника канала?' });
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));

    expect(await within(dialog).findByText('Участник удалён из канала.')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Роль участника Марк Соколов' }),
    ).toBeNull();
    expect(mockDb.chatMemberRequests).toContainEqual(
      expect.objectContaining({ action: 'remove', userId: IDS.mark }),
    );

    mockDb.forceChatMemberRemoveError = {
      status: 403,
      code: 'ROLE_CHANGE_FORBIDDEN',
      message: 'Cannot remove this member',
    };
    await user.click(
      within(dialog).getByRole('button', { name: 'Удалить участника: Лена Волкова' }),
    );
    const second = await screen.findByRole('dialog', { name: 'Удалить участника канала?' });
    await user.click(within(second).getByRole('button', { name: 'Удалить' }));
    expect(
      await within(second).findByText(
        'Администратор не может менять владельцев и администраторов и назначать эти роли.',
      ),
    ).toBeInTheDocument();
    // The row is not lost on failure.
    expect(within(dialog).getByText('Лена Волкова')).toBeInTheDocument();
  });

  it('explains LAST_OWNER on leave and removes the chat only after a successful leave', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    await user.click(within(dialog).getByRole('button', { name: 'Покинуть канал' }));
    const confirm = await screen.findByRole('dialog', { name: 'Покинуть канал?' });
    await user.click(within(confirm).getByRole('button', { name: 'Покинуть' }));
    expect(
      await within(confirm).findByText(
        'Нельзя снять последнего владельца канала. Сначала назначьте другого владельца.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Настройки чата' })).toBeInTheDocument();

    // A second OWNER makes the leave legal; the server 204 then drops the chat.
    setChatRole(IDS.anna, 'OWNER');
    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    await user.click(within(dialog).getByRole('button', { name: 'Покинуть канал' }));
    const second = await screen.findByRole('dialog', { name: 'Покинуть канал?' });
    mockDb.forceChatMemberLeaveError = null;
    await user.click(within(second).getByRole('button', { name: 'Покинуть' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Настройки чата' })).toBeNull();
    });
    expect(mockDb.chatMemberRequests).toContainEqual(
      expect.objectContaining({ action: 'leave', chatId: IDS.groupChat }),
    );
    expect(screen.queryByRole('button', { name: 'Команда «Восход», Групповой чат' })).toBeNull();
  });

  it('keeps the add form and rows on a forced 403 and passes an axe audit', async () => {
    seedWorkspaceCandidates();
    const { user } = renderPasswordApp();
    const dialog = await openMembersTab(user);

    mockDb.forceChatMemberAddError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a chat manager',
    };
    await user.selectOptions(within(dialog).getByLabelText('Кандидат'), IDS.pavel);
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('Недостаточно прав канала.')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Роль участника Павел Орлов' }),
    ).toBeNull();

    mockDb.forceChatMemberAddError = {
      status: 422,
      code: 'CHAT_MEMBERSHIP_UNSUPPORTED',
      message: 'DIRECT chats have no membership management',
    };
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(
      await within(dialog).findByText('Для личных чатов управление участниками недоступно.'),
    ).toBeInTheDocument();

    mockDb.forceChatMemberAddError = null;
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
  });
});
