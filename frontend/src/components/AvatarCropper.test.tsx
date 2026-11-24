import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

const ORIGINAL_GET_CONTEXT = HTMLCanvasElement.prototype.getContext;
const ORIGINAL_TO_BLOB = HTMLCanvasElement.prototype.toBlob;
const ORIGINAL_CREATE_OBJECT_URL = URL.createObjectURL;
const ORIGINAL_REVOKE_OBJECT_URL = URL.revokeObjectURL;

function pngFile(name: string): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type: 'image/png',
  });
}

function stubCanvas() {
  const drawImage = vi.fn();
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low' as ImageSmoothingQuality,
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => context as unknown as CanvasRenderingContext2D,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10])], { type: 'image/png' }));
  }) as typeof HTMLCanvasElement.prototype.toBlob;
  return { context, drawImage };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

/**
 * Select a device file, load its preview in the cropper (jsdom never fires
 * image `load` on its own) and apply the square crop.
 */
async function chooseAndCrop(
  user: TestUser,
  input: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  await user.upload(input, pngFile(name));
  const dialog = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
  const image = dialog.querySelector<HTMLImageElement>(
    '.image-cropper__stage .image-cropper__image',
  );
  if (!image) throw new Error('cropper image not rendered');
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 900 });
  fireEvent.load(image);
  await user.click(within(dialog).getByRole('button', { name: 'Применить' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Кадрирование изображения' })).toBeNull(),
  );
  return dialog;
}

function roomCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const card = heading.closest('li');
  if (!(card instanceof HTMLElement)) throw new Error(`room card not found: ${name}`);
  return card;
}

beforeEach(() => {
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:cropper-${(counter += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  stubCanvas();
});

afterEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: ORIGINAL_CREATE_OBJECT_URL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: ORIGINAL_REVOKE_OBJECT_URL,
  });
  HTMLCanvasElement.prototype.getContext = ORIGINAL_GET_CONTEXT;
  HTMLCanvasElement.prototype.toBlob = ORIGINAL_TO_BLOB;
});

describe('#106 cropper integration', () => {
  it('crops the profile avatar and uploads the PNG through POST /media/images', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Профиль' }));
    const profile = await screen.findByRole('dialog', { name: 'Профиль' });

    await user.click(within(profile).getByRole('button', { name: 'Сменить аватар' }));
    const input = await within(profile).findByLabelText('Выбрать файл');
    await chooseAndCrop(user, input, 'portrait.png');

    await waitFor(() => expect(mockDb.avatarRequests.some((r) => r.action === 'SET')).toBe(true));
    const upload = mockDb.mediaImageUploadRequests.at(-1);
    expect(upload).toMatchObject({
      filename: 'portrait-crop.png',
      mime: 'image/png',
      chatId: null,
    });
    expect(mockDb.mediaImageUploadRequests).toHaveLength(1);
    expect(mockDb.profileAvatarFileId).toBeTruthy();
    expect(await within(profile).findByText('Аватар обновлён.')).toBeInTheDocument();
  });

  it('crops the workspace logo and applies it through the existing setter', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await user.click(await screen.findByRole('button', { name: 'Пространство' }));
    await screen.findByRole('heading', { name: 'Настройки пространства' });

    await user.click(screen.getByRole('button', { name: 'Выбрать логотип' }));
    const input = await screen.findByLabelText('Выбрать файл');
    await chooseAndCrop(user, input, 'studio.png');

    await waitFor(() =>
      expect(mockDb.workspaceAvatarRequests.some((request) => request.action === 'SET')).toBe(true),
    );
    expect(mockDb.mediaImageUploadRequests.at(-1)).toMatchObject({
      filename: 'studio-crop.png',
      mime: 'image/png',
      chatId: null,
    });
    expect(mockDb.me.workspaces[0]?.logo_file_id).toBeTruthy();
    expect(await screen.findByText('Логотип обновлён.')).toBeInTheDocument();
  });

  it('crops a channel icon and keeps the chat-scoped upload binding', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'О чате' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });

    const change = await within(dialog).findByRole('button', { name: 'Выбрать иконку' });
    await waitFor(() => expect(change).toBeEnabled());
    await user.click(change);
    const input = await within(dialog).findByLabelText('Выбрать файл');
    await chooseAndCrop(user, input, 'team.png');

    await waitFor(() =>
      expect(
        mockDb.chatAvatarRequests.some(
          (request) => request.action === 'SET' && request.chatId === IDS.groupChat,
        ),
      ).toBe(true),
    );
    expect(mockDb.mediaImageUploadRequests.at(-1)).toMatchObject({
      filename: 'team-crop.png',
      mime: 'image/png',
      chatId: IDS.groupChat,
    });
    expect(mockDb.chats[IDS.groupChat]?.summary.avatar_file_id).toBeTruthy();
  });

  it('shows and updates a room avatar through its backing chat channel', async () => {
    mockDb.roomChatAvatars.set(IDS.roomStandupChat, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Открыть комнаты' }));
    await screen.findByRole('heading', { name: 'Комнаты', level: 1 });
    await screen.findByRole('heading', { name: 'Планёрка' });

    // The existing channel icon is rendered on the room card.
    await waitFor(() =>
      expect(roomCard('Планёрка').querySelector('.avatar--image img')).toBeInTheDocument(),
    );

    const before = mockDb.roomListRequests.length;
    await user.click(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Изменить аватар комнаты «Планёрка»',
      }),
    );
    const editor = await screen.findByRole('region', { name: 'Аватар комнаты «Планёрка»' });
    const input = within(editor).getByLabelText('Выбрать файл');
    await chooseAndCrop(user, input, 'standup.png');

    await waitFor(() =>
      expect(
        mockDb.chatAvatarRequests.some(
          (request) => request.action === 'SET' && request.chatId === IDS.roomStandupChat,
        ),
      ).toBe(true),
    );
    expect(mockDb.mediaImageUploadRequests.at(-1)).toMatchObject({
      filename: 'standup-crop.png',
      mime: 'image/png',
      chatId: IDS.roomStandupChat,
    });
    await waitFor(() => expect(mockDb.roomChatAvatars.get(IDS.roomStandupChat)).toBeTruthy());
    // The room list is refreshed after the chat avatar response.
    await waitFor(() => expect(mockDb.roomListRequests.length).toBeGreaterThan(before));
    expect(await screen.findByText('Аватар комнаты «Планёрка» обновлён.')).toBeInTheDocument();
  });

  it('has no serious or critical axe violations with the cropper open', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Профиль' }));
    const profile = await screen.findByRole('dialog', { name: 'Профиль' });
    await user.click(within(profile).getByRole('button', { name: 'Сменить аватар' }));
    const input = await within(profile).findByLabelText('Выбрать файл');
    await user.upload(input, pngFile('axe.png'));
    const cropper = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    const image = cropper.querySelector<HTMLImageElement>(
      '.image-cropper__stage .image-cropper__image',
    );
    if (image) {
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 900 });
      fireEvent.load(image);
    }

    // axe's icon-ligature check only needs a null 2D context in jsdom.
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
