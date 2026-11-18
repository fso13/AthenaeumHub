import { screen, waitFor, within } from '@testing-library/react';
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

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openMembers(user: TestUser): Promise<{
  dialog: HTMLElement;
  trigger: HTMLElement;
}> {
  await login(user);
  const trigger = screen.getByRole('button', { name: 'Участники' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Участники пространства' });
  await within(dialog).findByText('Анна Петрова');
  return { dialog, trigger };
}

async function submitAdd(
  dialog: HTMLElement,
  user: TestUser,
  email: string,
  role: 'ADMIN' | 'MEMBER' | 'GUEST' = 'MEMBER',
): Promise<void> {
  await user.type(within(dialog).getByLabelText('Email пользователя'), email);
  await user.selectOptions(within(dialog).getByLabelText('Роль'), role);
  await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
}

function roleSelect(dialog: HTMLElement, name: string): HTMLSelectElement {
  return within(dialog).getByRole('combobox', {
    name: `Роль участника ${name}`,
  }) as HTMLSelectElement;
}

async function openRemoveConfirm(dialog: HTMLElement, user: TestUser, name: string) {
  await user.click(within(dialog).getByRole('button', { name: `Удалить участника: ${name}` }));
  return screen.findByRole('dialog', { name: 'Удалить участника?' });
}

describe('E12-F workspace members management', () => {
  it('lets an OWNER add an existing user by email without exposing email in the list', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    expect(dialog.textContent).not.toContain('@');
    expect(within(dialog).getByText('Вы')).toBeInTheDocument();
    expect(roleSelect(dialog, 'Анна Петрова')).toHaveValue('ADMIN');
    expect(within(dialog).queryByRole('combobox', { name: /Роль участника Дмитрий/ })).toBeNull();

    await submitAdd(dialog, user, 'olga@krug.test', 'ADMIN');

    expect(await within(dialog).findByText('Ольга Смирнова')).toBeInTheDocument();
    expect(within(dialog).getByText('Участник добавлен.')).toBeInTheDocument();
    expect(mockDb.memberAddRequests).toHaveLength(1);
    expect(mockDb.memberAddRequests[0]).toMatchObject({
      workspaceId: IDS.workspace,
      email: 'olga@krug.test',
      role: 'ADMIN',
    });
    expect(mockDb.memberAddRequests[0]?.deviceId).toBeTruthy();
    expect(mockDb.workspaceMembers).toHaveLength(5);
    expect(mockDb.workspaceMembers.some((member) => member.user_id === IDS.olga)).toBe(true);

    // The form is cleared and the list never renders an email.
    expect(within(dialog).getByLabelText('Email пользователя')).toHaveValue('');
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.every((row) => !row.textContent?.includes('@'))).toBe(true);
    expect(dialog.textContent).not.toContain('olga@krug.test');
  });

  it('keeps the add form and row state on MEMBER_ALREADY_EXISTS', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    await submitAdd(dialog, user, 'anna@krug.test', 'GUEST');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Этот пользователь уже состоит в пространстве.',
    );
    expect(within(dialog).getByLabelText('Email пользователя')).toHaveValue('anna@krug.test');
    expect(within(dialog).getAllByText('Анна Петрова')).toHaveLength(1);
    expect(mockDb.workspaceMembers).toHaveLength(4);
    expect(mockDb.memberAddRequests).toHaveLength(1);
    expect(mockDb.memberAddRequests[0]?.role).toBe('GUEST');
  });

  it('shows server limit usage on WORKSPACE_MEMBER_LIMIT_REACHED and adds no row', async () => {
    mockDb.admin.maxWorkspaceMembers = 4;
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    await submitAdd(dialog, user, 'pavel@krug.test');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Достигнут лимит участников: 4 из 4.',
    );
    expect(within(dialog).queryByText('Павел Орлов')).not.toBeInTheDocument();
    expect(mockDb.workspaceMembers).toHaveLength(4);
    expect(mockDb.memberAddRequests).toHaveLength(1);
  });

  it('gives ADMIN only MEMBER/GUEST choices and hides OWNER/ADMIN targets', async () => {
    setWorkspaceRole('ADMIN');
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    expect(within(dialog).getByText('Добавить участника')).toBeInTheDocument();
    const addRoleSelect = within(dialog).getByLabelText('Роль') as HTMLSelectElement;
    expect(Array.from(addRoleSelect.options).map((option) => option.value)).toEqual([
      'MEMBER',
      'GUEST',
    ]);
    expect(
      within(dialog).queryAllByRole('option', { name: /Владелец|Администратор/ }),
    ).toHaveLength(0);

    // ADMIN cannot change/remove another ADMIN or the OWNER; MEMBER/GUEST stay editable.
    expect(
      within(dialog).queryByRole('button', { name: 'Удалить участника: Анна Петрова' }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Роль участника Анна Петрова' }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: 'Удалить участника: Дмитрий Крылов' }),
    ).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: 'Удалить участника: Марк Соколов' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('combobox', { name: 'Роль участника Лена Волкова' }),
    ).toBeInTheDocument();
  });

  it('renders a read-only list for MEMBER and no destructive controls', async () => {
    setWorkspaceRole('MEMBER');
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    expect(
      within(dialog).getByText(
        'Управлять составом могут владелец и администратор. Вам доступен просмотр.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Добавить участника')).not.toBeInTheDocument();
    expect(within(dialog).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(dialog).queryAllByRole('button', { name: /Удалить участника/ })).toHaveLength(0);
    expect(within(dialog).getByText('Анна Петрова')).toBeInTheDocument();
    expect(within(dialog).getByText('Администратор')).toBeInTheDocument();
  });

  it('maps a server 403 on add and keeps every row intact', async () => {
    mockDb.forceMemberAddError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a workspace owner/admin',
    };
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    await submitAdd(dialog, user, 'olga@krug.test');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Недостаточно прав для управления участниками.',
    );
    expect(within(dialog).getByText('Анна Петрова')).toBeInTheDocument();
    expect(within(dialog).queryByText('Ольга Смирнова')).not.toBeInTheDocument();
    expect(mockDb.workspaceMembers).toHaveLength(4);
  });

  it('applies a role change only after the 200 response', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    const select = roleSelect(dialog, 'Анна Петрова');
    await user.selectOptions(select, 'MEMBER');

    await waitFor(() => expect(mockDb.memberRoleRequests).toHaveLength(1));
    expect(mockDb.memberRoleRequests[0]).toMatchObject({
      workspaceId: IDS.workspace,
      userId: IDS.anna,
      role: 'MEMBER',
    });
    await waitFor(() => expect(select).toHaveValue('MEMBER'));
    expect(within(dialog).getByText('Роль обновлена.')).toBeInTheDocument();
    expect(mockDb.workspaceMembers.find((member) => member.user_id === IDS.anna)?.role).toBe(
      'MEMBER',
    );
  });

  it('keeps the row and explains LAST_OWNER / SELF_ACTION_FORBIDDEN conflicts', async () => {
    mockDb.forceMemberRoleError = {
      status: 409,
      code: 'LAST_OWNER',
      message: 'Last owner',
    };
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    const select = roleSelect(dialog, 'Анна Петрова');
    await user.selectOptions(select, 'MEMBER');

    await waitFor(() => expect(mockDb.memberRoleRequests).toHaveLength(1));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Нельзя удалить или понизить последнего владельца.',
    );
    expect(select).toHaveValue('ADMIN');
    expect(mockDb.workspaceMembers.find((member) => member.user_id === IDS.anna)?.role).toBe(
      'ADMIN',
    );

    // A remove conflict (self) keeps the confirm dialog and the row.
    mockDb.forceMemberRemoveError = {
      status: 409,
      code: 'SELF_ACTION_FORBIDDEN',
      message: 'Cannot remove yourself',
    };
    const confirm = await openRemoveConfirm(dialog, user, 'Марк Соколов');
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mockDb.memberRemoveRequests).toHaveLength(1));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Нельзя изменить роль или удалить себя.',
    );
    expect(within(dialog).getByText('Марк Соколов')).toBeInTheDocument();
    expect(mockDb.workspaceMembers).toHaveLength(4);

    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog', { name: 'Удалить участника?' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Марк Соколов')).toBeInTheDocument();
  });

  it('removes only after confirmation and refreshes the list from the server', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

    const cancelConfirm = await openRemoveConfirm(dialog, user, 'Марк Соколов');
    expect(within(cancelConfirm).getByText(/Марк Соколов потеряет доступ/)).toBeInTheDocument();
    await user.click(within(cancelConfirm).getByRole('button', { name: 'Отмена' }));

    expect(screen.queryByRole('dialog', { name: 'Удалить участника?' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Марк Соколов')).toBeInTheDocument();
    expect(mockDb.memberRemoveRequests).toHaveLength(0);

    const confirm = await openRemoveConfirm(dialog, user, 'Марк Соколов');
    await user.click(within(confirm).getByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(mockDb.memberRemoveRequests).toHaveLength(1));
    expect(mockDb.memberRemoveRequests[0]).toMatchObject({
      workspaceId: IDS.workspace,
      userId: IDS.mark,
    });
    expect(mockDb.memberRemoveRequests[0]?.deviceId).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).queryByText('Марк Соколов')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: 'Удалить участника?' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Участник удалён.')).toBeInTheDocument();
    expect(mockDb.workspaceMembers).toHaveLength(3);
  });

  it('searches by display name, shows the empty state and refreshes', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);
    const search = within(dialog).getByLabelText('Найти участника');

    await user.type(search, 'Марк');
    await waitFor(() => {
      expect(mockDb.memberDirectoryRequests.at(-1)?.query).toBe('Марк');
    });
    await waitFor(() => {
      expect(within(dialog).queryByText('Анна Петрова')).not.toBeInTheDocument();
    });
    expect(within(dialog).getByText('Марк Соколов')).toBeInTheDocument();

    await user.clear(search);
    await waitFor(() => {
      expect(within(dialog).getByText('Анна Петрова')).toBeInTheDocument();
    });

    await user.type(search, 'zzz');
    await waitFor(() => {
      expect(within(dialog).getByText('По запросу «zzz» никого не нашли.')).toBeInTheDocument();
    });

    const beforeRefresh = mockDb.memberDirectoryRequests.length;
    await user.click(within(dialog).getByRole('button', { name: 'Обновить список' }));
    await waitFor(() => {
      expect(mockDb.memberDirectoryRequests.length).toBeGreaterThan(beforeRefresh);
    });
  });

  it('closes on Escape, keeps the confirm over the list and returns focus', async () => {
    const { user } = renderPasswordApp();
    const { dialog, trigger } = await openMembers(user);

    const search = within(dialog).getByLabelText('Найти участника');
    await waitFor(() => expect(search).toHaveFocus());
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const remove = within(dialog).getByRole('button', {
      name: 'Удалить участника: Марк Соколов',
    });
    remove.focus();
    const confirm = await openRemoveConfirm(dialog, user, 'Марк Соколов');
    expect(within(confirm).getByRole('button', { name: 'Отмена' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Удалить участника?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Участники пространства' })).toBeInTheDocument();
    await waitFor(() => expect(remove).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Участники пространства' }),
      ).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('passes an axe audit with the members dialog open', async () => {
    const { user } = renderPasswordApp();
    const { dialog } = await openMembers(user);

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
