import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiAttachment, FileItem, WorkspaceSummary } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import type { MockUpload } from '../mocks/db';
import { setMockWorkspaces } from '../mocks/db';
import { mockDb, server } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

const GROUP = IDS.groupChat;
const AVATAR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOGO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_WORKSPACE: WorkspaceSummary = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'Второе пространство',
  slug: 'second',
  role: 'MEMBER',
  security_mode: 'MANAGED',
};

function imageFile(id = AVATAR_ID, chatId = GROUP): FileItem {
  return {
    id,
    filename: 'avatar.png',
    size_bytes: 2048,
    mime_type: 'image/png',
    scan_status: 'CLEAN',
    media: { kind: 'IMAGE', metadata_source: 'NONE' },
    chat_id: chatId,
    chat_name: 'Команда «Восход»',
    message_id: '00000000-0000-4000-8000-bbbbbbbbbbbb',
    created_at: '2026-11-16T10:00:00.000Z',
  };
}

/** Register a READY/CLEAN attachment so the presigned-download flow can serve it. */
function seedReadyAttachment(ref: ApiAttachment): void {
  const upload: MockUpload = {
    id: `${ref.id}-upload`,
    chatId: GROUP,
    filename: ref.filename ?? 'logo.png',
    size: ref.size_bytes,
    mime: ref.mime_type ?? 'image/png',
    media: ref.media ?? null,
    declaredSha256: null,
    partSize: ref.size_bytes,
    totalParts: 1,
    received: new Map(),
    status: 'READY',
    expiresAt: Date.now() + 3_600_000,
    attachmentId: ref.id,
    scanStatus: 'CLEAN',
    scanPollsRemaining: 0,
    finalizedSha256: 'a'.repeat(64),
    createdAt: Date.now(),
    reservedReleased: true,
  };
  mockDb.uploads.set(upload.id, upload);
  mockDb.attachments.set(ref.id, { ref, uploadId: upload.id, messageId: null });
}

function twoWorkspaces(): void {
  setMockWorkspaces(mockDb, [
    {
      id: IDS.workspace,
      name: 'Студия «Восход»',
      slug: 'studiya-voshod',
      role: 'OWNER',
      security_mode: 'MANAGED',
    },
    SECOND_WORKSPACE,
  ]);
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openSettings(user: TestUser): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  return screen.findByRole('dialog', { name: 'Настройки чата' });
}

beforeEach(() => {
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:avatar-${(counter += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('channel icon/avatar UI', () => {
  it('sets the icon from an existing chat image, displays it and removes it', async () => {
    mockDb.fileCenterItems = [imageFile()];
    const { user } = renderPasswordApp();
    await login(user);
    const dialog = await openSettings(user);

    const change = await within(dialog).findByRole('button', { name: 'Выбрать иконку' });
    await waitFor(() => expect(change).toBeEnabled());
    await user.click(change);
    await user.click(await within(dialog).findByRole('button', { name: /avatar\.png/ }));

    await waitFor(() =>
      expect(mockDb.chatAvatarRequests.some((request) => request.action === 'SET')).toBe(true),
    );
    expect(mockDb.chatAvatarRequests.find((request) => request.action === 'SET')).toMatchObject({
      chatId: GROUP,
      fileId: AVATAR_ID,
      action: 'SET',
    });
    expect(mockDb.chats[GROUP]?.summary.avatar_file_id).toBe(AVATAR_ID);
    expect(await within(dialog).findByText('Иконка канала обновлена.')).toBeInTheDocument();

    // Header + sidebar + settings share one deduped GET and render the blob image.
    await waitFor(() =>
      expect(document.querySelector('.chat-id .avatar--image img')).toBeInTheDocument(),
    );
    expect(document.querySelector('.chat-item .avatar--image img')).toBeInTheDocument();
    const gets = mockDb.chatAvatarRequests.filter((request) => request.action === 'GET');
    expect(gets).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: 'Удалить иконку' }));
    await waitFor(() =>
      expect(mockDb.chatAvatarRequests.at(-1)).toMatchObject({ action: 'DELETE' }),
    );
    expect(mockDb.chats[GROUP]?.summary.avatar_file_id).toBeNull();
    expect(await within(dialog).findByText(/Иконка удалена/)).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.chat-id .avatar--image img')).not.toBeInTheDocument(),
    );
  });

  it('keeps the initials fallback when no channel icon is set', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    const header = document.querySelector('.chat-id');
    expect(header?.querySelector('.avatar--image img')).not.toBeInTheDocument();
    expect(header?.querySelector('.avatar')?.textContent?.trim().length).toBeGreaterThan(0);
    expect(document.querySelector('.chat-item .avatar--image img')).not.toBeInTheDocument();
  });

  it('surfaces a translated avatar validation error and keeps the old icon', async () => {
    mockDb.fileCenterItems = [imageFile()];
    const { user } = renderPasswordApp();
    await login(user);
    const dialog = await openSettings(user);

    mockDb.forceChatAvatarError = {
      status: 422,
      code: 'CHAT_AVATAR_INVALID',
      message: 'Attachment is not an image',
    };
    await user.click(await within(dialog).findByRole('button', { name: 'Выбрать иконку' }));
    await user.click(await within(dialog).findByRole('button', { name: /avatar\.png/ }));

    expect(
      await within(dialog).findByText('Иконкой может быть только проверенное изображение.'),
    ).toBeInTheDocument();
    expect(mockDb.chats[GROUP]?.summary.avatar_file_id ?? null).toBeNull();
    mockDb.forceChatAvatarError = null;
  });
});

describe('workspace logo and user avatar', () => {
  it('renders the workspace logo in the rail/switcher and the me avatar from /me/avatar', async () => {
    twoWorkspaces();
    seedReadyAttachment({
      id: LOGO_ID,
      filename: 'logo.png',
      size_bytes: 1024,
      mime_type: 'image/png',
      scan_status: 'CLEAN',
      media: { kind: 'IMAGE', metadata_source: 'NONE' },
    });
    mockDb.me.workspaces[0]!.logo_file_id = LOGO_ID;
    mockDb.profileAvatarFileId = AVATAR_ID;
    mockDb.me = { ...mockDb.me, user: { ...mockDb.me.user, avatar_url: '/api/v1/me/avatar' } };

    const { user } = renderPasswordApp();
    await login(user);

    await waitFor(() =>
      expect(document.querySelector('.space-rail .avatar--image img')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.querySelector('.me-btn .avatar--image img')).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Выбрать пространство/ }));
    const menu = await screen.findByRole('menu', { name: 'Пространства' });
    expect(
      within(menu).getAllByRole('menuitemradio')[0]?.querySelector('.avatar--image img'),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Профиль' }));
    const profile = await screen.findByRole('dialog', { name: 'Профиль' });
    await waitFor(() =>
      expect(profile.querySelector('.profile-hero .avatar--image img')).toBeInTheDocument(),
    );
  });

  it('refreshes the own avatar in the sidebar and profile after /me/avatar', async () => {
    mockDb.fileCenterItems = [imageFile()];
    const { user } = renderPasswordApp();
    await login(user);

    await user.click(screen.getByRole('button', { name: 'Профиль' }));
    const profile = await screen.findByRole('dialog', { name: 'Профиль' });
    await user.click(within(profile).getByRole('button', { name: 'Сменить аватар' }));
    await user.click(await within(profile).findByRole('button', { name: /avatar\.png/ }));

    await waitFor(() =>
      expect(mockDb.avatarRequests.some((request) => request.action === 'SET')).toBe(true),
    );
    expect(await within(profile).findByText('Аватар обновлён.')).toBeInTheDocument();
    await waitFor(() =>
      expect(profile.querySelector('.profile-hero .avatar--image img')).toBeInTheDocument(),
    );
    expect(document.querySelector('.me-btn .avatar--image img')).toBeInTheDocument();
  });

  it('passes an axe audit with the avatar controls in the settings dialog', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    const dialog = await openSettings(user);
    await within(dialog).findByRole('button', { name: 'Выбрать иконку' });
    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const original = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    } finally {
      canvas.getContext = original;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

describe('create workspace entry points', () => {
  it('opens the dialog from the rail plus, creates a space and selects it', async () => {
    const { user, store } = renderPasswordApp();
    await login(user);

    await user.click(screen.getByRole('button', { name: 'Создать пространство' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новое пространство' });
    await user.type(within(dialog).getByLabelText('Название пространства'), 'Новая студия');
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(store.getSnapshot().activeWorkspace?.name).toBe('Новая студия'));
    expect(store.getSnapshot().activeWorkspace?.role).toBe('OWNER');
    expect(screen.getAllByText('Новая студия').length).toBeGreaterThan(0);
  });

  it('opens the same dialog from the switcher and keeps it open on an error', async () => {
    twoWorkspaces();
    const { user, store } = renderPasswordApp();
    await login(user);
    const previous = store.getSnapshot().activeWorkspaceId;

    await user.click(await screen.findByRole('button', { name: /Выбрать пространство/ }));
    const menu = await screen.findByRole('menu', { name: 'Пространства' });
    await user.click(within(menu).getByRole('menuitem', { name: /Создать пространство/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Новое пространство' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    server.use(
      http.post('*/api/v1/workspaces', () =>
        HttpResponse.json(
          { code: 'VALIDATION_FAILED', message: 'bad name', request_id: 'req-1' },
          { status: 422 },
        ),
      ),
    );
    await user.type(within(dialog).getByLabelText('Название пространства'), 'Плохое имя');
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }));

    expect(
      await within(dialog).findByText('Проверьте название: от 1 до 120 символов.'),
    ).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(store.getSnapshot().activeWorkspaceId).toBe(previous);
  });
});
