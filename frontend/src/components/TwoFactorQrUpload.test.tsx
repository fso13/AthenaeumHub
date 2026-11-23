import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import * as QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAuthSession } from '../auth/storage';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_TOTP_CODE } from '../mocks/fixtures';
import { setMockPlatformAdmin, setMockSetupRequired } from '../mocks/db';
import { navigate } from '../router/router';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';
import { QrCode as QrCodeView } from './QrCode';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

const GROUP = IDS.groupChat;
const QR_LABEL = 'QR-код для добавления Сова в приложение-аутентификатор';

let restoreObjectUrl: (() => void) | null = null;

afterEach(() => {
  restoreObjectUrl?.();
  restoreObjectUrl = null;
});

function stubObjectUrl(): void {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let sequence = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      sequence += 1;
      return `blob:sova-preview-${sequence}`;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  restoreObjectUrl = () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreate,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevoke,
    });
  };
}

function pngFile(name = 'sova-avatar.png', size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openProfile(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Профиль' }));
  return screen.findByRole('dialog', { name: 'Профиль' });
}

async function openChatSettings(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  return screen.findByRole('dialog', { name: 'Настройки чата' });
}

function seedAuthenticatedSession(): void {
  writeAuthSession({
    accessToken: 'mock-access-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    user: {
      id: mockDb.me.user.id,
      displayName: mockDb.me.user.display_name,
      email: mockDb.me.user.email,
    },
  });
}

describe('#93 local QR', () => {
  it('encodes otpauth locally as a real SVG symbol with an accessible name', () => {
    const uri =
      'otpauth://totp/Сова:demo%40krug.test?secret=JBSWY3DPEHPK3PXP&issuer=Сова&algorithm=SHA1&digits=6&period=30';
    const expected = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules;
    render(<QrCodeView value={uri} label={QR_LABEL} />);

    const svg = screen.getByRole('img', { name: QR_LABEL });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg).toHaveAttribute('data-qr-modules', String(expected.size));
    const path = svg.querySelector('path');
    expect(path).not.toBeNull();
    const modules = [...expected.data].filter((value) => value === 1).length;
    expect((path?.getAttribute('d')?.match(/M/g) ?? []).length).toBe(modules);
    // No external QR service: the component renders inline geometry only.
    expect(svg.querySelector('img')).toBeNull();
    expect(svg.outerHTML).not.toMatch(/https?:\/\//);
  });

  it('shows the QR and the one-time secret in the profile setup step', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);

    await user.click(await within(dialog).findByRole('button', { name: 'Включить 2FA' }));
    await user.type(within(dialog).getByLabelText('Пароль аккаунта'), MOCK_DEMO_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Продолжить' }));

    expect(await within(dialog).findByRole('img', { name: QR_LABEL })).toBeInTheDocument();
    expect(within(dialog).getByText(/^JBSWY3DPEHPK3PXP/)).toBeInTheDocument();
    expect(within(dialog).getByText(/otpauth:\/\/totp\//)).toBeInTheDocument();
  });
});

describe('#93 login ENROLL challenge', () => {
  it('enrolls TOTP from the 202 response, shows recovery codes and then opens the app', async () => {
    mockDb.admin.require2fa = true;
    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(
      await screen.findByRole('heading', { name: 'Настройте двухфакторную защиту' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: QR_LABEL })).toBeInTheDocument();
    expect(screen.getByText(/^JBSWY3DPEHPK3PXP/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Код из приложения'), '000000');
    await user.click(screen.getByRole('button', { name: 'Подтвердить и продолжить' }));
    expect(
      await screen.findByText('Неверный код. Проверьте цифры и попробуйте снова.'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Код из приложения'), MOCK_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить и продолжить' }));

    expect(await screen.findByRole('heading', { name: 'Коды восстановления' })).toBeInTheDocument();
    expect(screen.getByText('AAAA-BBBB-CCCC')).toBeInTheDocument();
    expect(mockDb.twoFactor.enabled).toBe(true);
    expect(mockDb.twoFactorChallenge).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Я сохранил коды — продолжить' }));
    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
    // The one-time QR/secret and recovery codes are gone from the app shell.
    expect(document.body.textContent).not.toMatch(/JBSWY3D/);
    expect(document.body.textContent).not.toMatch(/AAAA-BBBB-CCCC/);
    const storageDump = JSON.stringify([
      ...Object.entries(window.localStorage),
      ...Object.entries(window.sessionStorage),
    ]);
    expect(storageDump).not.toMatch(/JBSWY3D/);
    expect(storageDump).not.toMatch(/AAAA-BBBB-CCCC/);
  });
});

describe('#93 server-wide require_2fa gate', () => {
  it('blocks an existing session until the user enrolls, then unlocks the shell', async () => {
    seedAuthenticatedSession();
    mockDb.admin.require2fa = true;
    const { user } = renderPasswordApp();

    expect(
      await screen.findByRole('heading', { name: 'Требуется двухфакторная аутентификация' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Команда «Восход»' })).toBeNull();

    await user.type(screen.getByLabelText('Пароль аккаунта'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));

    expect(await screen.findByRole('img', { name: QR_LABEL })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Код из приложения'), MOCK_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить и продолжить' }));

    await waitFor(() => expect(document.body.textContent).toContain('Коды восстановления'));
    expect(screen.getByRole('heading', { name: 'Коды восстановления' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Я сохранил коды — продолжить' }));

    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
    expect(mockDb.twoFactor.enabled).toBe(true);
  });

  it('passes an axe audit for the blocking enrollment screen', async () => {
    seedAuthenticatedSession();
    mockDb.admin.require2fa = true;
    renderPasswordApp();
    await screen.findByRole('heading', { name: 'Требуется двухфакторная аутентификация' });

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

describe('#93 admin require_2fa toggle', () => {
  it('saves the server-wide policy with an explicit warning', async () => {
    setMockSetupRequired(mockDb, false);
    setMockPlatformAdmin(mockDb, true);
    const { user } = renderPasswordApp();
    await login(user);
    navigate('/admin');
    await screen.findByRole('heading', { name: 'Администрирование' });
    await user.click(screen.getByRole('tab', { name: 'Настройки' }));

    const toggle = await screen.findByLabelText('Требовать двухфакторную аутентификацию для всех');
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(screen.getByText(/пользователи без TOTP не смогут войти/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByText('Настройки сохранены.')).toBeInTheDocument();
    expect(mockDb.admin.require2fa).toBe(true);
    expect(mockDb.adminSettingsPatches.at(-1)?.body.require_2fa).toBe(true);
  });
});

describe('#93 device image uploads', () => {
  it('uploads a profile avatar, previews it locally and applies the returned file_id', async () => {
    stubObjectUrl();
    mockDb.mediaImageDelayMs = 150;
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Сменить аватар' }));
    const input = within(dialog).getByLabelText('Выбрать файл');
    await user.upload(input, pngFile());

    expect(
      await within(dialog).findByAltText('Предпросмотр выбранного изображения'),
    ).toHaveAttribute('src', 'blob:sova-preview-1');
    expect(
      within(dialog).getByRole('progressbar', { name: 'Загрузка изображения' }),
    ).toBeInTheDocument();

    await waitFor(() => expect(mockDb.mediaImageUploadRequests).toHaveLength(1));
    expect(mockDb.mediaImageUploadRequests[0]).toMatchObject({
      filename: 'sova-avatar.png',
      mime: 'image/png',
      size: 2048,
      chatId: null,
    });
    const uploadedId = [...mockDb.mediaImages.keys()][0];
    expect(uploadedId).toBeTruthy();
    await waitFor(() =>
      expect(mockDb.avatarRequests.some((request) => request.action === 'SET')).toBe(true),
    );
    expect(mockDb.avatarRequests.find((request) => request.action === 'SET')).toMatchObject({
      fileId: uploadedId,
    });
    expect(await within(dialog).findByText('Аватар обновлён.')).toBeInTheDocument();
    expect(mockDb.profileAvatarFileId).toBe(uploadedId);
  });

  it('rejects a non-raster file and an oversized image before any request', async () => {
    stubObjectUrl();
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: 'Сменить аватар' }));
    const input = within(dialog).getByLabelText('Выбрать файл');

    // `userEvent.upload` honours `accept` and would filter the SVG out before
    // React sees it; the component's own validation is exercised directly.
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(32)], 'vector.svg', { type: 'image/svg+xml' })] },
    });
    expect(
      await within(dialog).findByText('Поддерживаются только PNG, JPEG и WebP.'),
    ).toBeInTheDocument();
    expect(mockDb.mediaImageUploadRequests).toHaveLength(0);

    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })],
      },
    });
    expect(
      await within(dialog).findByText('Файл больше 5 МБ. Выберите изображение меньше.'),
    ).toBeInTheDocument();
    expect(mockDb.mediaImageUploadRequests).toHaveLength(0);
  });

  it('surfaces an upload-service error without applying a file_id', async () => {
    stubObjectUrl();
    mockDb.forceMediaImageError = {
      status: 503,
      code: 'IMAGE_UPLOAD_UNAVAILABLE',
      message: 'storage unavailable',
    };
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: 'Сменить аватар' }));
    await user.upload(within(dialog).getByLabelText('Выбрать файл'), pngFile());

    expect(
      await within(dialog).findByText('Сервис загрузки недоступен. Повторите позже.'),
    ).toBeInTheDocument();
    expect(mockDb.avatarRequests.some((request) => request.action === 'SET')).toBe(false);
    expect(mockDb.mediaImages.size).toBe(0);
  });

  it('uploads a channel cover and a workspace logo through the same endpoint', async () => {
    stubObjectUrl();
    const { user } = renderPasswordApp();

    const dialog = await openChatSettings(user);
    const changeCover = within(dialog).getByRole('button', { name: 'Заменить обложку' });
    await waitFor(() => expect(changeCover).toBeEnabled());
    await user.click(changeCover);
    await user.upload(within(dialog).getByLabelText('Выбрать файл'), pngFile('cover.png'));

    await waitFor(() => expect(mockDb.chatCoverRequests).toHaveLength(1));
    const coverUpload = [...mockDb.mediaImages.values()][0];
    expect(coverUpload?.chatId).toBe(GROUP);
    expect(mockDb.chatCoverRequests[0]).toMatchObject({
      chatId: GROUP,
      action: 'SET',
      fileId: coverUpload?.id,
    });
    expect(mockDb.chats[GROUP]?.summary.cover_file_id).toBe(coverUpload?.id);
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть настройки чата' }));

    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await user.click(await screen.findByRole('button', { name: 'Пространство' }));
    await screen.findByRole('heading', { name: 'Настройки пространства' });
    await user.click(screen.getByRole('button', { name: 'Выбрать логотип' }));
    await user.upload(screen.getByLabelText('Выбрать файл'), pngFile('logo.png'));

    await waitFor(() => expect(mockDb.workspaceAvatarRequests).toHaveLength(1));
    const logoUpload = [...mockDb.mediaImages.values()][1];
    expect(mockDb.workspaceAvatarRequests[0]).toMatchObject({
      action: 'SET',
      fileId: logoUpload?.id,
      workspaceId: IDS.workspace,
    });
    expect(mockDb.me.workspaces[0]?.logo_file_id).toBe(logoUpload?.id);
  });
});
