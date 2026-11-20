import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { FileItem, WorkspaceInvite } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_TOTP_CODE } from '../mocks/fixtures';
import { resetRouterForTests } from '../router/router';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

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

async function openWorkspaceSettings(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Настройки' }));
  await user.click(await screen.findByRole('button', { name: 'Пространство' }));
  return waitFor(() => screen.getByRole('heading', { name: 'Настройки пространства' }));
}

function imageFile(id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'): FileItem {
  return {
    id,
    filename: 'avatar.png',
    size_bytes: 2048,
    mime_type: 'image/png',
    scan_status: 'CLEAN',
    media: { kind: 'IMAGE', metadata_source: 'NONE' },
    chat_id: IDS.groupChat,
    chat_name: 'Команда «Восход»',
    message_id: '00000000-0000-4000-8000-bbbbbbbbbbbb',
    created_at: '2026-11-16T10:00:00.000Z',
  };
}

function workspaceInvite(): WorkspaceInvite {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    role: 'MEMBER',
    status: 'ACTIVE',
    used_count: 0,
    max_uses: null,
    expires_at: '2026-12-01T10:00:00.000Z',
    created_at: '2026-11-16T10:00:00.000Z',
    created_by: IDS.user,
  };
}

describe('P0-4 profile avatar', () => {
  it('sets the avatar from an existing CLEAN image and removes it again', async () => {
    mockDb.fileCenterItems = [imageFile()];
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);

    await user.click(within(dialog).getByRole('button', { name: 'Сменить аватар' }));
    await user.click(await within(dialog).findByRole('button', { name: /avatar\.png/ }));

    await waitFor(() =>
      expect(mockDb.avatarRequests.some((request) => request.action === 'SET')).toBe(true),
    );
    expect(mockDb.avatarRequests.find((request) => request.action === 'SET')).toMatchObject({
      action: 'SET',
      fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(mockDb.me.user.avatar_url).toBe('/api/v1/me/avatar');
    expect(await within(dialog).findByText('Аватар обновлён.')).toBeInTheDocument();
    expect(within(dialog).getByText('Текущий аватар')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Удалить аватар' }));
    await waitFor(() => expect(mockDb.avatarRequests.at(-1)).toMatchObject({ action: 'DELETE' }));
    expect(mockDb.me.user.avatar_url).toBeNull();
    expect(await within(dialog).findByText('Аватар удалён.')).toBeInTheDocument();
  });

  it('only offers scan-approved images and explains the empty list', async () => {
    mockDb.fileCenterItems = [
      { ...imageFile('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), scan_status: 'PENDING' },
    ];
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(within(dialog).getByRole('button', { name: 'Сменить аватар' }));

    expect(await within(dialog).findByText(/Подходящих изображений нет/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /avatar\.png/ })).toBeNull();
  });
});

describe('P0-4 TOTP authenticator', () => {
  it('sets up 2FA once, shows recovery codes, then disables it with password + code', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);

    await user.click(await within(dialog).findByRole('button', { name: 'Включить 2FA' }));
    await user.type(within(dialog).getByLabelText('Пароль аккаунта'), MOCK_DEMO_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Продолжить' }));

    const secret = await within(dialog).findByText(/^JBSWY3DPEHPK3PXP/);
    expect(secret).toBeInTheDocument();
    expect(within(dialog).getByText(/otpauth:\/\/totp\//)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Код из приложения'), MOCK_TOTP_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить и включить' }));

    expect(await within(dialog).findByText('Коды восстановления')).toBeInTheDocument();
    expect(within(dialog).getByText('AAAA-BBBB-CCCC')).toBeInTheDocument();
    expect(mockDb.twoFactor.enabled).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Я сохранил коды' }));
    await waitFor(() => expect(within(dialog).getAllByText('Включена').length).toBeGreaterThan(0));
    // The one-time secret is gone after confirmation.
    expect(dialog.textContent).not.toMatch(/JBSWY3D/);
    expect(dialog.textContent).not.toMatch(/AAAA-BBBB-CCCC/);

    await user.click(within(dialog).getByRole('button', { name: 'Отключить 2FA' }));
    const confirm = within(dialog).getByRole('alertdialog');
    await user.type(within(confirm).getByLabelText('Пароль аккаунта'), MOCK_DEMO_PASSWORD);
    await user.type(within(confirm).getByLabelText('Код из приложения'), MOCK_TOTP_CODE);
    await user.click(within(confirm).getByRole('button', { name: 'Отключить' }));

    await waitFor(() => expect(mockDb.twoFactor.enabled).toBe(false));
    expect(await within(dialog).findByRole('button', { name: 'Включить 2FA' })).toBeInTheDocument();
  });

  it('rejects a wrong password for setup without exposing a secret', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openProfile(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Включить 2FA' }));
    await user.type(within(dialog).getByLabelText('Пароль аккаунта'), 'wrong-password');
    await user.click(within(dialog).getByRole('button', { name: 'Продолжить' }));

    expect(await within(dialog).findByText('Неверный пароль.')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/JBSWY3D/);
  });

  it('passes an axe audit while the 2FA card is rendered', async () => {
    const { user } = renderPasswordApp();
    await openProfile(user);
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

describe('P0-4 login challenge', () => {
  it('shows the TOTP screen for a 202 login and continues to the session', async () => {
    mockDb.twoFactor.enabled = true;
    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('heading', { name: 'Второй фактор' })).toBeInTheDocument();
    expect(screen.getByText(/Вызов действует ещё/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Код из приложения'), '000000');
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(
      await screen.findByText('Неверный код. Проверьте цифры и попробуйте снова.'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Код из приложения'), MOCK_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
    expect(mockDb.twoFactorChallenge).toBeNull();
  });

  it('requests a fresh challenge and can return to the credentials form', async () => {
    mockDb.twoFactor.enabled = true;
    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { name: 'Второй фактор' });

    await user.click(screen.getByRole('button', { name: 'Запросить новый вызов' }));
    expect(
      await screen.findByText('Выдан новый вызов. Введите актуальный код.'),
    ).toBeInTheDocument();
    expect(mockDb.authLoginRequests).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Вернуться ко входу' }));
    expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument();
  });

  it('accepts a one-time recovery code at login', async () => {
    mockDb.twoFactor.enabled = true;
    mockDb.twoFactor.recoveryCodes = new Map([['AAAA-BBBB-CCCC', false]]);
    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { name: 'Второй фактор' });

    await user.click(screen.getByRole('button', { name: 'Код восстановления' }));
    await user.type(screen.getByLabelText('Код восстановления'), 'AAAA-BBBB-CCCC');
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
    expect(mockDb.twoFactor.recoveryCodes.get('AAAA-BBBB-CCCC')).toBe(true);
  });
});

describe('P0-4 workspace settings', () => {
  it('updates name/description and the logo from existing images', async () => {
    mockDb.fileCenterItems = [imageFile()];
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    const name = screen.getByLabelText('Название');
    await user.clear(name);
    await user.type(name, 'Студия «Восход+»');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockDb.workspaceSettingsRequests).toHaveLength(1));
    expect(mockDb.me.workspaces[0]?.name).toBe('Студия «Восход+»');
    expect(await screen.findByText('Настройки пространства сохранены.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Выбрать логотип' }));
    await user.click(await screen.findByRole('button', { name: /avatar\.png/ }));
    await waitFor(() => expect(mockDb.workspaceAvatarRequests).toHaveLength(1));
    expect(mockDb.me.workspaces[0]?.logo_file_id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(await screen.findByText('Логотип обновлён.')).toBeInTheDocument();
  });

  it('creates, copies and revokes an invite link without sending email', async () => {
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }));
    expect(await screen.findByText('Ссылка создана')).toBeInTheDocument();
    expect(mockDb.workspaceInvites).toHaveLength(1);
    expect(mockDb.workspaceInviteRequests.some((request) => request.action === 'CREATE')).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Копировать ссылку' }));
    expect(await screen.findByText('Ссылка скопирована.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await user.click(screen.getByRole('button', { name: 'Отозвать' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Отозвать ссылку-приглашение?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Отозвать' }));
    await waitFor(() => expect(mockDb.workspaceInvites[0]?.status).toBe('REVOKED'));
    expect(await screen.findByText('Ссылка отозвана.')).toBeInTheDocument();
  });

  it('keeps the OWNER row immutable and lets an OWNER change ADMIN cells', async () => {
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    const ownerCell = await screen.findByRole('checkbox', {
      name: 'Разрешить «Настройки» роли Владелец',
    });
    expect(ownerCell).toBeChecked();
    expect(ownerCell).toBeDisabled();

    const adminCell = screen.getByRole('checkbox', {
      name: 'Разрешить «Настройки» роли Администратор',
    });
    expect(adminCell).toBeEnabled();
    await user.click(adminCell);
    await user.click(screen.getByRole('button', { name: 'Сохранить права' }));

    await waitFor(() => expect(mockDb.workspacePermissions[IDS.workspace]).toBeDefined());
    const admin = mockDb.workspacePermissions[IDS.workspace]?.roles.find(
      (row) => row.role === 'ADMIN',
    );
    expect(admin?.manage_workspace).toBe(false);
    expect(await screen.findByText('Права сохранены.')).toBeInTheDocument();
  });

  it('limits an ADMIN to MEMBER cells in the permission matrix', async () => {
    mockDb.me.workspaces[0]!.role = 'ADMIN';
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    const adminCell = await screen.findByRole('checkbox', {
      name: 'Разрешить «Приглашения» роли Администратор',
    });
    expect(adminCell).toBeDisabled();
    const memberCell = screen.getByRole('checkbox', {
      name: 'Разрешить «Приглашения» роли Участник',
    });
    expect(memberCell).toBeEnabled();
    await user.click(memberCell);
    await user.click(screen.getByRole('button', { name: 'Сохранить права' }));

    const member = await waitFor(() => {
      const row = mockDb.workspacePermissions[IDS.workspace]?.roles.find(
        (entry) => entry.role === 'MEMBER',
      );
      expect(row?.manage_invites).toBe(true);
      return row;
    });
    expect(member?.manage_invites).toBe(true);
  });

  it('renders a read-only gate for a MEMBER', async () => {
    mockDb.me.workspaces[0]!.role = 'MEMBER';
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    expect(
      screen.getAllByText(/Управлять настройками пространства может владелец/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText('Название')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
  });
});

describe('P0-4 workspace invite accept', () => {
  it('joins through a copied /workspace-invite/<token> link after login', async () => {
    const invite = { ...workspaceInvite(), token: 'mock-workspace-invite-token-0001' };
    mockDb.workspaceInvites = [invite];
    resetRouterForTests(`/workspace-invite/${invite.token}`);

    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(
      await screen.findByRole('heading', { name: 'Приглашение в пространство' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Присоединиться' }));

    expect(await screen.findByText(/Вы уже участник пространства/)).toBeInTheDocument();
    expect(mockDb.workspaceInviteRequests.some((request) => request.action === 'ACCEPT')).toBe(
      true,
    );
  });
});
