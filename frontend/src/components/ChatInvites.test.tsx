import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_INVITE_TOKENS, IDS } from '../mocks/fixtures';
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

async function openInvitesTab(user: TestUser): Promise<HTMLElement> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'О чате' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
  await user.click(within(dialog).getByRole('tab', { name: 'Участники' }));
  await within(dialog).findByText('Все ссылки');
  return dialog;
}

async function loginToInvite(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { level: 1, name: 'Приглашение в канал' });
}

function openInviteRoute(token: string): ReturnType<typeof renderPasswordApp> {
  resetRouterForTests(`/invite/${token}`);
  return renderPasswordApp();
}

describe('#79 invite links', () => {
  it('lists ACTIVE/EXPIRED/EXHAUSTED/REVOKED links without exposing tokens and revokes after confirmation', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openInvitesTab(user);

    expect(within(dialog).getByText('Активна')).toBeInTheDocument();
    expect(within(dialog).getByText('Истекла')).toBeInTheDocument();
    expect(within(dialog).getByText('Исчерпана')).toBeInTheDocument();
    expect(within(dialog).getByText('Отозвана')).toBeInTheDocument();
    expect(within(dialog).getByText(/1 из 5/)).toBeInTheDocument();
    expect(within(dialog).getByText(/0, без лимита/)).toBeInTheDocument();
    // The metadata list never carries the raw token or its hash.
    expect(dialog.textContent).not.toContain(MOCK_INVITE_TOKENS.active);
    expect(dialog.textContent).not.toMatch(/[a-f0-9]{64}/);

    await user.click(within(dialog).getByRole('button', { name: /Отозвать ссылку от/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Отозвать ссылку?' });
    await user.click(within(confirm).getByRole('button', { name: 'Отозвать' }));

    expect(await within(dialog).findByText('Ссылка отозвана.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByText('Отозвана')).toHaveLength(2));
    expect(mockDb.chatInviteRequests).toContainEqual(
      expect.objectContaining({
        chatId: IDS.groupChat,
        action: 'revoke',
        inviteId: IDS.inviteActive,
      }),
    );
  });

  it('creates a link with role/expiry/max uses, shows the token URL once and copies it', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openInvitesTab(user);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await user.selectOptions(within(dialog).getByLabelText('Роль по ссылке'), 'ADMIN');
    await user.selectOptions(within(dialog).getByLabelText('Срок действия'), '86400');
    await user.selectOptions(within(dialog).getByLabelText('Лимит вступлений'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Создать ссылку' }));

    expect(
      await within(dialog).findByText(
        'Ссылка создана. Скопируйте её сейчас — повторно сервер её не покажет.',
      ),
    ).toBeInTheDocument();
    const link = within(dialog).getByRole('textbox', { name: 'Ссылка-приглашение' });
    const url = (link as HTMLInputElement).value;
    expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,128}$/);
    expect(url).not.toContain('demo@krug.test');

    expect(mockDb.chatInviteRequests).toContainEqual(
      expect.objectContaining({
        chatId: IDS.groupChat,
        action: 'create',
        body: { role: 'ADMIN', expires_in_seconds: 86400, max_uses: 5 },
      }),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Копировать' }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(await within(dialog).findByText('Ссылка скопирована.')).toBeInTheDocument();
    // The one-time token is not duplicated into the metadata list.
    const list = dialog.querySelector('.chat-invites__items');
    expect(list?.textContent ?? '').not.toContain(url);
  });

  it('explains a 403 on create and keeps the form usable', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openInvitesTab(user);

    mockDb.forceChatInviteCreateError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a chat manager',
    };
    await user.click(within(dialog).getByRole('button', { name: 'Создать ссылку' }));
    expect(await within(dialog).findByText('Недостаточно прав канала.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Ссылка-приглашение' })).toBeNull();
    expect(within(dialog).getByLabelText('Роль по ссылке')).toHaveValue('MEMBER');
  });

  it('offers the invite form in the main tab through the members section', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await user.click(screen.getByRole('button', { name: 'О чате' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки чата' });
    const openLinks = await within(dialog).findByRole('button', {
      name: 'Открыть ссылки-приглашения',
    });
    expect(
      within(dialog).getByText(
        'Роль, срок действия и лимит вступлений настраиваются в разделе «Участники».',
      ),
    ).toBeInTheDocument();
    await user.click(openLinks);
    expect(await within(dialog).findByText('Все ссылки')).toBeInTheDocument();
  });

  it('accepts a link for an existing member idempotently', async () => {
    const { user } = openInviteRoute(MOCK_INVITE_TOKENS.active);
    await loginToInvite(user);

    await user.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByText('Вы уже участник этого канала.')).toBeInTheDocument();
    expect(screen.getByText('Ваша роль: Владелец')).toBeInTheDocument();
    expect(mockDb.inviteAcceptRequests.at(-1)).toMatchObject({
      token: MOCK_INVITE_TOKENS.active,
      result: 'ALREADY_MEMBER',
    });
    // Idempotent accept consumed no use.
    const invite = mockDb.chatInvites[IDS.groupChat]?.find((item) => item.id === IDS.inviteActive);
    expect(invite?.used_count).toBe(1);
  });

  it('joins with the invite role and opens the channel', async () => {
    mockDb.chatMembers[IDS.groupChat] = (mockDb.chatMembers[IDS.groupChat] ?? []).filter(
      (member) => member.user_id !== IDS.user,
    );
    const { user } = openInviteRoute(MOCK_INVITE_TOKENS.active);
    await loginToInvite(user);

    await user.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByText('Вы вступили в канал.')).toBeInTheDocument();
    expect(screen.getByText('Ваша роль: Участник')).toBeInTheDocument();
    const joined = mockDb.chatMembers[IDS.groupChat]?.find((member) => member.user_id === IDS.user);
    expect(joined).toMatchObject({ role: 'MEMBER', status: 'ACTIVE' });
    expect(mockDb.inviteAcceptRequests.at(-1)).toMatchObject({ result: 'OK' });

    await user.click(screen.getByRole('button', { name: 'Открыть канал' }));
    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
  });

  it.each([
    [MOCK_INVITE_TOKENS.expired, 'Срок действия ссылки истёк. Попросите новую.'],
    [MOCK_INVITE_TOKENS.revoked, 'Ссылка отозвана владельцем канала.'],
    [MOCK_INVITE_TOKENS.exhausted, 'Лимит вступлений по этой ссылке исчерпан.'],
  ])('maps the %s link to its distinct 410 message', async (token, message) => {
    mockDb.chatMembers[IDS.groupChat] = (mockDb.chatMembers[IDS.groupChat] ?? []).filter(
      (member) => member.user_id !== IDS.user,
    );
    const { user } = openInviteRoute(token);
    await loginToInvite(user);
    await user.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('rejects a malformed URL without an accept request', async () => {
    resetRouterForTests('/invite/short');
    const { user } = renderPasswordApp();
    await loginToInvite(user);
    expect(
      screen.getByText('Ссылка повреждена: код приглашения не распознан.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Принять приглашение' })).toBeNull();
    expect(mockDb.inviteAcceptRequests).toHaveLength(0);
  });

  it('shows 404 for a well-formed but unknown token', async () => {
    const { user } = openInviteRoute('unknown-token-123456789012345');
    await loginToInvite(user);
    await user.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(
      await screen.findByText('Ссылка не найдена. Проверьте, что она скопирована полностью.'),
    ).toBeInTheDocument();
    expect(mockDb.inviteAcceptRequests.at(-1)).toMatchObject({ result: 'ERROR' });
  });

  it('passes an axe audit on the accept screen', async () => {
    const { user } = openInviteRoute(MOCK_INVITE_TOKENS.expired);
    await loginToInvite(user);

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
