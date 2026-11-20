import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { ChatMemberRole, FileItem } from '../api/types';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

const GROUP = IDS.groupChat;
const COVER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function groupRecord() {
  const chat = mockDb.chats[GROUP];
  if (!chat) throw new Error('Mock group chat is missing');
  return chat;
}

function setViewerChatRole(role: ChatMemberRole): void {
  const members = mockDb.chatMembers[GROUP];
  if (!members) throw new Error('Mock group members are missing');
  const viewer = members.find((member) => member.user_id === mockDb.me.user.id);
  if (!viewer) throw new Error('Viewer is not a group participant');
  viewer.role = role;
}

function coverImage(scanStatus: FileItem['scan_status'] = 'CLEAN'): FileItem {
  return {
    id: COVER_ID,
    filename: 'atlas-cover.png',
    size_bytes: 2048,
    mime_type: 'image/png',
    scan_status: scanStatus,
    media: {
      kind: 'IMAGE',
      width: 320,
      height: 180,
      metadata_source: 'NONE',
    },
    chat_id: GROUP,
    chat_name: 'Команда «Восход»',
    message_id: '00000000-0000-4000-8000-aaaaaaaaaaaa',
    created_at: '2026-11-16T10:00:00.000Z',
  };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), 'demo@krug.test');
  await user.type(screen.getByLabelText('Пароль'), 'Sova-demo-2026');
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openSettings(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  return screen.findByRole('dialog', { name: 'Настройки чата' });
}

describe('#80 channel settings UI', () => {
  it('sets the cover from an existing chat image and removes it again', async () => {
    mockDb.fileCenterItems = [coverImage()];
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    const change = within(dialog).getByRole('button', { name: 'Заменить обложку' });
    await waitFor(() => expect(change).toBeEnabled());
    await user.click(change);

    await user.click(await within(dialog).findByRole('button', { name: /atlas-cover\.png/ }));

    await waitFor(() => expect(mockDb.chatCoverRequests).toHaveLength(1));
    expect(mockDb.chatCoverRequests[0]).toMatchObject({
      chatId: GROUP,
      fileId: COVER_ID,
      action: 'SET',
    });
    expect(groupRecord().summary.cover_file_id).toBe(COVER_ID);
    expect(await within(dialog).findByText('Обложка обновлена.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Удалить обложку' }));
    await waitFor(() => expect(mockDb.chatCoverRequests).toHaveLength(2));
    expect(mockDb.chatCoverRequests[1]).toMatchObject({ chatId: GROUP, action: 'DELETE' });
    expect(groupRecord().summary.cover_file_id).toBeNull();
    expect(
      await within(dialog).findByText('Обложка удалена. Само вложение осталось в файлах чата.'),
    ).toBeInTheDocument();
  });

  it('saves a changed role right through the permissions matrix', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Права' }));
    const postMember = await within(dialog).findByRole('checkbox', {
      name: 'Отправка сообщений: Участник',
    });
    expect(postMember).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: 'Отправка сообщений: Владелец' }),
    ).toBeDisabled();

    await user.click(postMember);
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить права' }));

    await waitFor(() =>
      expect(
        mockDb.chatPermissionsRequests.some(
          (request) => request.action === 'PATCH' && request.chatId === GROUP,
        ),
      ).toBe(true),
    );
    const patch = mockDb.chatPermissionsRequests.find(
      (request) => request.action === 'PATCH' && request.chatId === GROUP,
    );
    expect(patch?.body).toEqual({ member: { post_messages: false } });
    expect(mockDb.chatPermissions[GROUP]?.member?.post_messages).toBe(false);
    expect(await within(dialog).findByText('Права канала сохранены.')).toBeInTheDocument();
  });

  it('saves the read-only toggle and the visibility/join policy in one PATCH', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    const readOnlyToggle = within(dialog).getByRole('checkbox', { name: /Только чтение/ });
    await waitFor(() => expect(readOnlyToggle).toBeEnabled());
    await user.click(readOnlyToggle);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Видимость' }), 'PUBLIC');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.chatSettingsRequests).toHaveLength(1));
    expect(mockDb.chatSettingsRequests[0]?.body).toEqual({
      read_only: true,
      visibility: 'PUBLIC',
      join_policy: 'OPEN',
    });
    expect(groupRecord().summary.read_only).toBe(true);
    expect(groupRecord().summary.visibility).toBe('PUBLIC');
    expect(groupRecord().summary.join_policy).toBe('OPEN');
  });

  it('shows honest E2EE cover restrictions and no channel matrix for DIRECT', async () => {
    groupRecord().summary.security_mode = 'E2EE';
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Заменить обложку' })).toBeDisabled(),
    );
    expect(
      within(dialog).getByText(
        'В чате со сквозным шифрованием обложка недоступна: сервер не хранит такие метаданные.',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть настройки чата' }));

    await user.click(screen.getByRole('button', { name: 'Анна Петрова, Личный чат' }));
    await user.click(screen.getByRole('button', { name: 'О чате' }));
    const direct = await screen.findByRole('dialog', { name: 'Настройки чата' });
    expect(within(direct).queryByRole('tab', { name: 'Права' })).toBeNull();
    expect(within(direct).getByRole('button', { name: 'Заменить обложку' })).toBeDisabled();
    await user.click(within(direct).getByRole('tab', { name: 'Опасная зона' }));
    expect(within(direct).queryByRole('button', { name: 'Удалить чат' })).toBeNull();
  });

  it('lets a MEMBER with delegated change_info edit the name but not structural settings', async () => {
    mockDb.me = {
      ...mockDb.me,
      workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role: 'MEMBER' })),
    };
    setViewerChatRole('MEMBER');
    mockDb.chatPermissions[GROUP] = {
      ...mockDb.chatPermissions[GROUP],
      member: { ...mockDb.chatPermissions[GROUP]?.member, change_info: true },
    };
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    const name = within(dialog).getByRole('textbox', { name: 'Название' });
    await waitFor(() => expect(name).toBeEnabled());
    expect(within(dialog).getByRole('checkbox', { name: /Только чтение/ })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'Делегированное имя');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockDb.chatSettingsRequests).toHaveLength(1));
    expect(mockDb.chatSettingsRequests[0]?.body).toEqual({ name: 'Делегированное имя' });
    expect(groupRecord().summary.name).toBe('Делегированное имя');
  });

  it('keeps the matrix read-only for a MEMBER and never sends a PATCH', async () => {
    setViewerChatRole('MEMBER');
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Права' }));
    const memberCheckbox = await within(dialog).findByRole('checkbox', {
      name: 'Приглашения: Участник',
    });
    expect(memberCheckbox).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Матрица доступна только для чтения: менять права могут владелец и администратор канала.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить права' })).toBeDisabled();
    expect(
      mockDb.chatPermissionsRequests.filter((request) => request.action === 'PATCH'),
    ).toHaveLength(0);
  });

  it('shows a translated 403 when the server rejects a rights change', async () => {
    mockDb.forceChatPermissionsUpdateError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a channel owner/admin',
    };
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Права' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Опросы: Участник' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить права' }));

    expect(
      await within(dialog).findByText('Менять матрицу прав могут владелец и администратор канала.'),
    ).toBeInTheDocument();
    expect(mockDb.chatPermissions[GROUP]?.member?.create_polls).toBe(true);
  });

  it('disables sending in a read-only channel for a MEMBER and explains why', async () => {
    groupRecord().summary.read_only = true;
    setViewerChatRole('MEMBER');
    const { user } = renderPasswordApp();
    await login(user);
    expect(
      await screen.findByText(
        'Канал переведён в режим «только чтение»: писать могут только владелец и администратор канала.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('archives a chat user-locally and returns it from the sidebar archive', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Опасная зона' }));
    await user.click(within(dialog).getByRole('button', { name: 'Архивировать чат' }));

    await waitFor(() => expect(mockDb.chatArchiveRequests).toHaveLength(1));
    expect(mockDb.chatArchiveRequests[0]).toMatchObject({ chatId: GROUP, action: 'ARCHIVE' });
    expect(groupRecord().summary.archived).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройки чата' })).toBeNull(),
    );

    await user.click(screen.getByRole('button', { name: /^Архив/ }));
    const unarchive = await screen.findByRole('button', { name: 'Вернуть' });
    await user.click(unarchive);

    await waitFor(() => expect(mockDb.chatArchiveRequests).toHaveLength(2));
    expect(mockDb.chatArchiveRequests[1]).toMatchObject({ chatId: GROUP, action: 'UNARCHIVE' });
    expect(groupRecord().summary.archived).toBe(false);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Команда «Восход», Групповой чат' }),
      ).toBeInTheDocument(),
    );
  });

  it('deletes the channel after an OWNER confirmation', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.click(within(dialog).getByRole('tab', { name: 'Опасная зона' }));
    await user.click(within(dialog).getByRole('button', { name: 'Удалить чат' }));

    const confirm = await screen.findByRole('dialog', { name: 'Удалить канал?' });
    await user.click(within(confirm).getByRole('button', { name: 'Удалить канал' }));

    await waitFor(() => expect(mockDb.chatDeleteRequests).toHaveLength(1));
    expect(mockDb.chatDeleteRequests[0]?.chatId).toBe(GROUP);
    expect(mockDb.chats[GROUP]).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Настройки чата' })).toBeNull(),
    );
  });

  it('lists pinned messages and pins/unpins from MessageActions', async () => {
    const { user } = renderPasswordApp();
    await login(user);

    const pinsRow = await screen.findByRole('button', { name: /Закреплённые сообщения/ });
    await user.click(pinsRow);
    await waitFor(() =>
      expect(mockDb.chatPinRequests).toContainEqual(
        expect.objectContaining({ chatId: GROUP, action: 'LIST' }),
      ),
    );
    expect(
      screen.getAllByText('Отлично, тогда я обновлю статус в задаче.').length,
    ).toBeGreaterThanOrEqual(2);

    const targetId = '00000000-0000-4000-8000-000000000038';
    const row = document.getElementById(`message-${targetId}`);
    if (!row) throw new Error('Message row 38 is not rendered');
    await user.hover(row);
    await user.click(await within(row).findByRole('button', { name: 'Закрепить сообщение' }));

    await waitFor(() =>
      expect(mockDb.chatPinRequests).toContainEqual(
        expect.objectContaining({
          chatId: GROUP,
          messageId: targetId,
          action: 'PIN',
        }),
      ),
    );
    expect(
      await within(row).findByRole('button', { name: 'Открепить сообщение' }),
    ).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Открепить сообщение' }));
    await waitFor(() =>
      expect(mockDb.chatPinRequests).toContainEqual(
        expect.objectContaining({
          chatId: GROUP,
          messageId: targetId,
          action: 'UNPIN',
        }),
      ),
    );
  });

  it('explains the 50-pin cap when the server rejects a pin', async () => {
    mockDb.forceChatPinError = {
      status: 409,
      code: 'CHAT_PIN_LIMIT',
      message: 'Pin limit reached',
    };
    const { user } = renderPasswordApp();
    await login(user);

    const targetId = '00000000-0000-4000-8000-000000000038';
    const row = document.getElementById(`message-${targetId}`);
    if (!row) throw new Error('Message row 38 is not rendered');
    await user.hover(row);
    await user.click(await within(row).findByRole('button', { name: 'Закрепить сообщение' }));

    expect(
      await within(row).findByText(
        'Достигнут лимит: в канале можно закрепить не более 50 сообщений.',
      ),
    ).toBeInTheDocument();
  });

  it('passes an axe audit on the rights tab', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Права' }));
    await within(dialog).findByRole('checkbox', { name: 'Отправка сообщений: Участник' });

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
