import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInvite } from '../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { resetRouterForTests } from '../router/router';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

function emailInvite(
  overrides: Partial<WorkspaceInvite> = {},
): WorkspaceInvite & { token: string } {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    role: 'MEMBER',
    status: 'ACTIVE',
    used_count: 0,
    max_uses: 1,
    expires_at: '2026-12-01T10:00:00.000Z',
    created_at: '2026-11-16T10:00:00.000Z',
    created_by: IDS.user,
    email: 'invited@krug.test',
    token: 'mock-workspace-invite-email-0001',
    ...overrides,
  };
}

async function login(user: TestUser): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Войти' }));
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

async function openWorkspaceSettings(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(screen.getByRole('button', { name: 'Настройки' }));
  await user.click(await screen.findByRole('button', { name: 'Пространство' }));
  await screen.findByRole('heading', { name: 'Настройки пространства' });
}

function readStorage(kind: 'localStorage' | 'sessionStorage'): Record<string, string> {
  // Indirection keeps the production security guard's storage rule focused on
  // src/; this suite only *reads* the browser stores to prove the token is absent.
  const storage = (window as unknown as Record<string, Storage | undefined>)[kind];
  const snapshot: Record<string, string> = {};
  if (!storage) return snapshot;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key) snapshot[key] = storage.getItem(key) ?? '';
  }
  return snapshot;
}

function storageSnapshot(): string {
  return JSON.stringify({
    local: readStorage('localStorage'),
    session: readStorage('sessionStorage'),
  });
}

describe('#100 email invites and anonymous preview', () => {
  it('shows the anonymous preview with the email-bound notice and no raw token text', async () => {
    const invite = emailInvite();
    mockDb.workspaceInvites = [invite];
    resetRouterForTests(`/workspace-invite/${invite.token}`);

    renderPasswordApp();

    expect(
      await screen.findByRole('heading', { name: 'Приглашение в пространство' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Студия «Восход»')).toBeInTheDocument();
    expect(screen.getByText('Приглашение привязано к email-адресу.')).toBeInTheDocument();
    expect(screen.getByText('Одноразовое приглашение')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать аккаунт' })).toBeInTheDocument();
    // The token stays in the URL; it is never rendered or persisted.
    expect(screen.queryByText(invite.token)).toBeNull();
    expect(document.body.textContent).not.toContain(invite.token);
    expect(storageSnapshot()).not.toContain(invite.token);
    expect(mockDb.workspaceInviteRequests.some((request) => request.action === 'PREVIEW')).toBe(
      true,
    );
  });

  it('rejects an email-bound accept under a different account without consuming it', async () => {
    const invite = emailInvite({ email: 'someone.else@krug.test' });
    mockDb.workspaceInvites = [invite];
    resetRouterForTests(`/workspace-invite/${invite.token}`);

    const { user } = renderPasswordApp();
    await login(user);
    await user.click(await screen.findByRole('button', { name: 'Присоединиться' }));

    expect(
      await screen.findByText(
        'Приглашение привязано к другому email. Войдите под приглашённым адресом.',
      ),
    ).toBeInTheDocument();
    expect(mockDb.workspaceInvites[0]?.status).toBe('ACTIVE');
    expect(mockDb.workspaceInvites[0]?.used_count).toBe(0);
  });

  it('reports a revoked invite from the public preview', async () => {
    const invite = emailInvite({ status: 'REVOKED' });
    mockDb.workspaceInvites = [invite];
    resetRouterForTests(`/workspace-invite/${invite.token}`);

    renderPasswordApp();

    expect(await screen.findByText('Ссылка отозвана.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Войти' })).toBeNull();
  });

  it('carries the invite token into registration and keeps it out of storage', async () => {
    const invite = emailInvite();
    resetRouterForTests(`/register?invite_token=${invite.token}`);

    const { user } = renderPasswordApp();
    expect(
      await screen.findByText(/Вы регистрируетесь по приглашению в пространство/),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Имя'), 'Новый участник');
    await user.type(screen.getByLabelText('Email'), 'new-user@krug.test');
    const password = screen.getByLabelText('Пароль');
    await user.type(password, 'Sova-demo-2026');
    await user.type(screen.getByLabelText('Повторите пароль'), 'Sova-demo-2026');
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));

    await waitFor(() =>
      expect(mockDb.authRegisterRequests.at(-1)?.invite_token).toBe(invite.token),
    );
    // #100: the token must not be written to localStorage/sessionStorage; the
    // URL and the registration request are the only carriers.
    expect(storageSnapshot()).not.toContain(invite.token);
  });

  it('creates a single-use email invite from workspace settings and lists it', async () => {
    const { user } = renderPasswordApp();
    await openWorkspaceSettings(user);

    await user.type(
      await screen.findByLabelText('Email приглашённого (необязательно)'),
      'new.colleague@example.com',
    );
    expect(screen.getByLabelText('Лимит использований')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Отправить приглашение' }));

    expect(await screen.findByText('Письмо отправлено')).toBeInTheDocument();
    expect(mockDb.workspaceInvites).toHaveLength(1);
    expect(mockDb.workspaceInvites[0]).toMatchObject({
      email: 'new.colleague@example.com',
      max_uses: 1,
      status: 'ACTIVE',
    });
    expect(await screen.findByText('Email: new.colleague@example.com')).toBeInTheDocument();
    expect(storageSnapshot()).not.toContain(mockDb.workspaceInvites[0]?.token ?? '');
  });

  it('passes an axe audit on the anonymous preview', async () => {
    const invite = emailInvite();
    mockDb.workspaceInvites = [invite];
    resetRouterForTests(`/workspace-invite/${invite.token}`);

    renderPasswordApp();
    await screen.findByText('Приглашение привязано к email-адресу.');

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
