import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { ChatSummary, WorkspaceSummary } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

const WORKSPACE_NAME = 'Студия «Восход»';

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openWorkspaceSettings(user: TestUser): Promise<void> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Настройки' }));
  await user.click(await screen.findByRole('button', { name: 'Пространство' }));
  await screen.findByRole('heading', { name: 'Настройки пространства' });
}

async function openLeaveConfirm(user: TestUser, source: 'settings' | 'rail' = 'settings') {
  if (source === 'settings') {
    await openWorkspaceSettings(user);
  } else {
    await login(user);
    await user.click(
      screen.getByRole('button', { name: `Покинуть пространство: ${WORKSPACE_NAME}` }),
    );
  }
  await user.click(screen.getByRole('button', { name: 'Покинуть пространство' }));
  return screen.findByRole('dialog', { name: `Покинуть пространство «${WORKSPACE_NAME}»?` });
}

async function openDeleteConfirm(user: TestUser, source: 'settings' | 'rail' = 'settings') {
  if (source === 'settings') {
    await openWorkspaceSettings(user);
  } else {
    await login(user);
    await user.click(
      screen.getByRole('button', { name: `Удалить пространство: ${WORKSPACE_NAME}` }),
    );
  }
  await user.click(screen.getByRole('button', { name: 'Удалить пространство' }));
  return screen.findByRole('dialog', { name: `Удалить пространство «${WORKSPACE_NAME}»?` });
}

function addSecondWorkspaceWithChat(): { workspace: WorkspaceSummary; chatId: string } {
  const workspace: WorkspaceSummary = {
    id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa',
    name: 'Второе пространство',
    slug: 'vtoroe-prostranstvo',
    role: 'ADMIN',
    security_mode: 'MANAGED',
  };
  mockDb.me.workspaces.push(workspace);
  const source = mockDb.chats[IDS.groupChat]!;
  const chatId = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb';
  mockDb.chats[chatId] = {
    summary: {
      ...source.summary,
      id: chatId,
      name: 'Второй чат',
      unread_count: 0,
      last_seq: 1,
      member_count: 5,
    } as ChatSummary & { member_count: number },
    workspaceId: workspace.id,
    memberIds: [],
    messages: [],
    clientMessageIds: new Map(),
    hiddenMessageIds: new Set(),
  };
  return { workspace, chatId };
}

function chatMemberCount(chat: ChatSummary | undefined): number | null {
  const value = (chat as (ChatSummary & { member_count?: number }) | undefined)?.member_count;
  return typeof value === 'number' ? value : null;
}

describe('#99 workspace lifecycle UI', () => {
  it('lets a MEMBER leave after a named confirmation and opens onboarding', async () => {
    mockDb.me.workspaces[0]!.role = 'MEMBER';
    const { user, store } = renderPasswordApp();
    const dialog = await openLeaveConfirm(user);

    expect(within(dialog).getByText(/Вы перестанете видеть чаты/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Покинуть' }));

    expect(await screen.findByRole('heading', { name: 'Создайте пространство' })).toBeVisible();
    expect(mockDb.workspaceLifecycleRequests).toHaveLength(1);
    expect(mockDb.workspaceLifecycleRequests[0]).toMatchObject({
      action: 'LEAVE',
      workspaceId: IDS.workspace,
      role: 'MEMBER',
    });
    expect(mockDb.me.workspaces).toHaveLength(0);

    const snapshot = store.getSnapshot();
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.activeWorkspaceId).toBeNull();
    expect(snapshot.activeWorkspace).toBeNull();
    expect(snapshot.chats).toEqual([]);
    expect(snapshot.activeChatId).toBeNull();
    expect(snapshot.slices).toEqual({});
    expect(snapshot.realtimeStatus).toBe('idle');
    expect(snapshot.onboardingRequired).toBe(true);
    expect(snapshot.workspaceUnread[IDS.workspace]).toBeUndefined();
  });

  it('disables leave for the sole OWNER and explains LAST_OWNER', async () => {
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    const leave = screen.getByRole('button', { name: 'Покинуть пространство' });
    const remove = screen.getByRole('button', { name: 'Удалить пространство' });
    expect(leave).toBeDisabled();
    expect(remove).toBeEnabled();
    expect(screen.getByText(/Вы последний владелец пространства/)).toBeInTheDocument();
    expect(mockDb.workspaceLifecycleRequests).toHaveLength(0);
  });

  it('keeps the dialog open and shows an honest 409 LAST_OWNER error', async () => {
    mockDb.me.workspaces[0]!.role = 'MEMBER';
    mockDb.forceWorkspaceLeaveError = {
      status: 409,
      code: 'LAST_OWNER',
      message: 'The last owner cannot leave',
    };
    const { user, store } = renderPasswordApp();
    const dialog = await openLeaveConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: 'Покинуть' }));

    expect(
      await within(dialog).findByText(
        'Вы последний владелец: выйти нельзя. Передайте владение или удалите пространство.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Покинуть' })).toBeEnabled();
    expect(mockDb.me.workspaces).toHaveLength(1);
    expect(store.getSnapshot().workspaces).toHaveLength(1);
    expect(store.getSnapshot().workspaceLifecycle.status).toBe('error');
  });

  it('lets the OWNER delete only after typing the exact workspace name', async () => {
    const { user, store } = renderPasswordApp();
    const dialog = await openDeleteConfirm(user);
    const confirm = within(dialog).getByRole('button', { name: 'Удалить навсегда' });
    const input = within(dialog).getByLabelText('Введите название пространства для подтверждения');

    expect(confirm).toBeDisabled();
    await user.type(input, 'Студия');
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText('Название не совпадает.')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, WORKSPACE_NAME);
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(await screen.findByRole('heading', { name: 'Создайте пространство' })).toBeVisible();
    expect(mockDb.workspaceLifecycleRequests[0]).toMatchObject({
      action: 'DELETE',
      workspaceId: IDS.workspace,
      role: 'OWNER',
    });
    expect(store.getSnapshot().workspaces).toEqual([]);
    expect(store.getSnapshot().chats).toEqual([]);
    expect(store.getSnapshot().onboardingRequired).toBe(true);
  });

  it('offers leave but not delete to an ADMIN', async () => {
    mockDb.me.workspaces[0]!.role = 'ADMIN';
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    expect(screen.getByRole('button', { name: 'Покинуть пространство' })).toBeEnabled();
    const remove = screen.getByRole('button', { name: 'Удалить пространство' });
    expect(remove).toBeDisabled();
    expect(screen.getByText('Удалить пространство может только владелец.')).toBeInTheDocument();
  });

  it('hides the rail leave action for the sole OWNER and exposes delete', async () => {
    const { user } = renderPasswordApp();
    await login(user);

    expect(
      screen.queryByRole('button', { name: `Покинуть пространство: ${WORKSPACE_NAME}` }),
    ).toBeNull();
    const remove = screen.getByRole('button', {
      name: `Удалить пространство: ${WORKSPACE_NAME}`,
    });
    await user.click(remove);
    expect(
      await screen.findByRole('dialog', { name: `Удалить пространство «${WORKSPACE_NAME}»?` }),
    ).toBeInTheDocument();
  });

  it('exposes leave (not delete) in the rail and switcher for a MEMBER', async () => {
    mockDb.me.workspaces[0]!.role = 'MEMBER';
    const second: WorkspaceSummary = {
      id: 'cccc1111-1111-4111-8111-cccccccccccc',
      name: 'Резервное',
      slug: 'rezervnoe',
      role: 'ADMIN',
      security_mode: 'MANAGED',
    };
    mockDb.me.workspaces.push(second);
    const { user } = renderPasswordApp();
    await login(user);

    expect(
      screen.queryByRole('button', { name: `Удалить пространство: ${WORKSPACE_NAME}` }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: `Покинуть пространство: ${WORKSPACE_NAME}` }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Выбрать пространство/ }));
    const menu = await screen.findByRole('menu', { name: 'Пространства' });
    const leave = within(menu).getByRole('menuitem', { name: 'Покинуть пространство' });
    expect(within(menu).queryByRole('menuitem', { name: 'Удалить пространство' })).toBeNull();
    await user.click(leave);
    expect(
      await screen.findByRole('dialog', { name: `Покинуть пространство «${WORKSPACE_NAME}»?` }),
    ).toBeInTheDocument();
  });

  it('switches to the next workspace and reloads its chats/member_count', async () => {
    const second = addSecondWorkspaceWithChat();
    const { user, store } = renderPasswordApp();
    const dialog = await openDeleteConfirm(user);
    await user.type(
      within(dialog).getByLabelText('Введите название пространства для подтверждения'),
      WORKSPACE_NAME,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Удалить навсегда' }));

    await waitFor(() => expect(store.getSnapshot().activeWorkspaceId).toBe(second.workspace.id));
    await waitFor(() => expect(store.getSnapshot().chats).toHaveLength(1));
    const snapshot = store.getSnapshot();
    expect(snapshot.workspaces.map((workspace) => workspace.id)).toEqual([second.workspace.id]);
    expect(snapshot.activeWorkspace?.name).toBe(second.workspace.name);
    expect(snapshot.workspaceUnread[IDS.workspace]).toBeUndefined();
    expect(chatMemberCount(snapshot.chats[0])).toBe(5);
  });

  it('passes an axe audit with the typed delete confirmation open', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openDeleteConfirm(user);

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
