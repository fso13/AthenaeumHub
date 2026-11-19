import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { setMockWorkspaces } from '../mocks/db';
import {
  IDS,
  MOCK_DEMO_EMAIL,
  MOCK_DEMO_PASSWORD,
  MOCK_DISPLAY_NAME,
  mockWorkspace,
} from '../mocks/fixtures';
import { mockDb, server } from '../test/server';
import { renderApp, renderPasswordApp } from '../test/renderApp';

const CREATE_BUTTON = 'Создать чат';

function conflict(details: Record<string, unknown>) {
  return HttpResponse.json(
    {
      code: 'CHAT_LIMIT_REACHED',
      message: 'Chat limit reached',
      details,
      request_id: 'req_chat_limit',
    },
    { status: 409 },
  );
}

function memberPage(
  items: Array<{
    user_id: string;
    display_name: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
    joined_at: string;
  }>,
  nextCursor: string | null = null,
) {
  return HttpResponse.json({
    items,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
  });
}

async function openDialog(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: CREATE_BUTTON }));
  const dialog = await screen.findByRole('dialog');
  await screen.findByRole('heading', { name: 'Новый групповой чат' });
  return dialog;
}

async function chooseDirect(dialog: HTMLElement, user: ReturnType<typeof renderApp>['user']) {
  await user.click(within(dialog).getByRole('radio', { name: /Личный чат/ }));
}

async function openDirect(user: ReturnType<typeof renderApp>['user']) {
  const dialog = await openDialog(user);
  await chooseDirect(dialog, user);
  await within(dialog).findByRole('radio', { name: /Анна Петрова/ });
  return dialog;
}

describe('E8/R-01 + E10-F chat creation', () => {
  it('creates a GROUP chat with an idempotency key, refreshes the list and opens it', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const dialog = await openDialog(user);
    expect(within(dialog).getByText(/Чат один на один/)).toBeInTheDocument();
    expect(within(dialog).getByText('Чатов: 2 из 100')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Групповой чат/ })).toBeChecked();

    await user.type(within(dialog).getByLabelText('Название чата'), 'Проект «Новый»');
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(await screen.findByRole('heading', { name: 'Проект «Новый»' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: CREATE_BUTTON })).toHaveFocus());
    expect(mockDb.chatCreateRequests).toHaveLength(1);
    expect(mockDb.chatCreateRequests[0]?.body).toEqual({ type: 'GROUP', name: 'Проект «Новый»' });
    expect(mockDb.chatCreateRequests[0]?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Object.keys(mockDb.chats)).toHaveLength(3);
  });

  it('replays the same Idempotency-Key without creating a duplicate chat', async () => {
    const { store } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const key = '11111111-2222-4333-8444-555555555555';
    expect(await store.createChat('Идемпотентный чат', key)).toBe(true);
    expect(await store.createChat('Идемпотентный чат', key)).toBe(true);

    expect(Object.keys(mockDb.chats)).toHaveLength(3);
    expect(mockDb.chatCreateRequests).toHaveLength(1);
  });

  it('loads the member directory for DIRECT, excludes self and never renders emails', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const dialog = await openDirect(user);
    expect(within(dialog).getByRole('radio', { name: /Анна Петрова/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Марк Соколов/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Лена Волкова/ })).toBeInTheDocument();
    // The API returns the caller too; the picker removes self from the list.
    expect(within(dialog).queryByText(MOCK_DISPLAY_NAME)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: new RegExp(MOCK_DISPLAY_NAME) })).toBeNull();

    // The details panel may already have loaded the directory for its count;
    // the picker always issues its own request. Assert the latest one.
    expect(mockDb.memberDirectoryRequests.length).toBeGreaterThanOrEqual(1);
    expect(mockDb.memberDirectoryRequests.at(-1)).toMatchObject({
      workspaceId: IDS.workspace,
      query: null,
      limit: 50,
    });
    expect(mockDb.chatCreateRequests).toHaveLength(0);
    expect(dialog.textContent).not.toContain('@');
  });

  it('searches members server-side with the literal query and updates the list', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const dialog = await openDirect(user);
    await user.type(within(dialog).getByLabelText('Найти участника'), 'Марк');

    await waitFor(() =>
      expect(mockDb.memberDirectoryRequests.some((request) => request.query === 'Марк')).toBe(true),
    );
    expect(await within(dialog).findByRole('radio', { name: /Марк Соколов/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).queryByRole('radio', { name: /Анна Петрова/ })).not.toBeInTheDocument(),
    );
  });

  it('creates a DIRECT chat with peer_id and no name, then opens it without optimistic rows', async () => {
    const { user, store } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    const before = Object.keys(mockDb.chats).length;

    const dialog = await openDirect(user);
    await user.click(within(dialog).getByRole('radio', { name: /Марк Соколов/ }));
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Марк Соколов' })).toBeInTheDocument();
    expect(mockDb.chatCreateRequests).toHaveLength(1);
    expect(mockDb.chatCreateRequests[0]?.body).toEqual({
      type: 'DIRECT',
      peer_id: IDS.mark,
    });
    expect(mockDb.chatCreateRequests[0]?.body).not.toHaveProperty('name');
    expect(Object.keys(mockDb.chats)).toHaveLength(before + 1);

    const state = store.getSnapshot();
    const created = state.chats.find((chat) => chat.type === 'DIRECT' && chat.peer_id === IDS.mark);
    expect(created).toBeDefined();
    expect(state.activeChatId).toBe(created?.id);
  });

  it('uses a fresh Idempotency-Key for every dialog opening', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const first = await openDirect(user);
    await user.click(within(first).getByRole('radio', { name: /Марк Соколов/ }));
    await user.click(within(first).getByRole('button', { name: CREATE_BUTTON }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const second = await openDirect(user);
    await user.click(within(second).getByRole('radio', { name: /Марк Соколов/ }));
    await user.click(within(second).getByRole('button', { name: CREATE_BUTTON }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(mockDb.chatCreateRequests).toHaveLength(2);
    const [firstRequest, secondRequest] = mockDb.chatCreateRequests;
    expect(firstRequest?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondRequest?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondRequest?.idempotencyKey).not.toBe(firstRequest?.idempotencyKey);
  });

  it('surfaces a 400 peer validation error and keeps the dialog open', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    server.use(
      http.post('*/api/v1/workspaces/:workspaceId/chats', () =>
        HttpResponse.json(
          {
            code: 'VALIDATION_FAILED',
            message: 'peer_id is invalid',
            details: { field: 'peer_id' },
            request_id: 'req_peer_invalid',
          },
          { status: 400 },
        ),
      ),
    );

    const dialog = await openDirect(user);
    await user.click(within(dialog).getByRole('radio', { name: /Марк Соколов/ }));
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(await within(dialog).findByText(/Не удалось выбрать участника/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockDb.chatCreateRequests).toHaveLength(0);
  });

  it('shows the empty member state when there are no other active members', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    server.use(
      http.get('*/api/v1/workspaces/:workspaceId/members', () =>
        memberPage([
          {
            user_id: IDS.user,
            display_name: MOCK_DISPLAY_NAME,
            role: 'OWNER',
            joined_at: '2026-01-01T09:00:00.000Z',
          },
        ]),
      ),
    );

    const dialog = await openDialog(user);
    await chooseDirect(dialog, user);

    expect(
      await within(dialog).findByText(/В пространстве пока нет других активных участников/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: CREATE_BUTTON })).toBeDisabled();
  });

  it('retries a failed member load and keeps rows visible on a later error', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    let calls = 0;
    server.use(
      http.get('*/api/v1/workspaces/:workspaceId/members', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            {
              code: 'INTERNAL',
              message: 'boom',
              request_id: 'req_members',
            },
            { status: 500 },
          );
        }
        return memberPage([
          {
            user_id: IDS.anna,
            display_name: 'Анна Петрова',
            role: 'ADMIN',
            joined_at: '2026-01-02T09:00:00.000Z',
          },
        ]);
      }),
    );

    const dialog = await openDialog(user);
    await chooseDirect(dialog, user);
    expect(await within(dialog).findByText('Не удалось загрузить участников.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByRole('radio', { name: /Анна Петрова/ })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('appends the next cursor page with a load-more button', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    let calls = 0;
    server.use(
      http.get('*/api/v1/workspaces/:workspaceId/members', ({ request }) => {
        calls += 1;
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (calls === 1) {
          return memberPage(
            [
              {
                user_id: IDS.anna,
                display_name: 'Анна Петрова',
                role: 'ADMIN',
                joined_at: '2026-01-02T09:00:00.000Z',
              },
            ],
            'cursor-page-2',
          );
        }
        expect(cursor).toBe('cursor-page-2');
        return memberPage([
          {
            user_id: IDS.mark,
            display_name: 'Марк Соколов',
            role: 'MEMBER',
            joined_at: '2026-01-03T09:00:00.000Z',
          },
        ]);
      }),
    );

    const dialog = await openDialog(user);
    await chooseDirect(dialog, user);
    expect(await within(dialog).findByRole('radio', { name: /Анна Петрова/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Показать ещё' }));
    expect(await within(dialog).findByRole('radio', { name: /Марк Соколов/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Анна Петрова/ })).toBeInTheDocument();
  });

  it('allows DIRECT creation for a MEMBER while disabling GROUP', async () => {
    setMockWorkspaces(mockDb, [{ ...mockWorkspace, role: 'MEMBER' }]);

    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    await user.click(await screen.findByRole('button', { name: CREATE_BUTTON }));
    const dialog = await screen.findByRole('dialog');
    expect(await screen.findByRole('heading', { name: 'Новый личный чат' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Групповой чат/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Личный чат/ })).toBeChecked();
    expect(await within(dialog).findByRole('radio', { name: /Анна Петрова/ })).toBeInTheDocument();
  });

  it('disables creation at the user limit and shows used/limit in Settings', async () => {
    mockDb.admin.maxChatsPerUser = 2;

    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    await waitFor(() => expect(screen.getByRole('button', { name: CREATE_BUTTON })).toBeDisabled());

    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await screen.findByRole('heading', { name: 'Настройки' });
    await user.click(screen.getByRole('button', { name: 'Пространство' }));
    expect(await screen.findByText('Чатов: 2 из 2')).toBeInTheDocument();
  });

  it('updates the dialog limit counter and disables submit after a limit refresh', async () => {
    mockDb.admin.maxChatsPerUser = 3;
    const { user, store } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const dialog = await openDialog(user);
    expect(within(dialog).getByText('Чатов: 2 из 3')).toBeInTheDocument();

    mockDb.admin.maxChatsPerUser = 2;
    await store.loadChatLimits(true);

    expect(await within(dialog).findByText(/Достигнут лимит чатов/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: CREATE_BUTTON })).toBeDisabled();
  });

  it('surfaces 409 scope/limit/used and keeps the dialog open without an optimistic chat', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    const before = Object.keys(mockDb.chats).length;

    server.use(
      http.post('*/api/v1/workspaces/:workspaceId/chats', () =>
        conflict({ scope: 'USER', limit: 5, used: 5 }),
      ),
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Название чата'), 'Сверх лимита');
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Достигнут лимит чатов пользователя: 5 из 5.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(Object.keys(mockDb.chats)).toHaveLength(before);

    server.use(
      http.post('*/api/v1/workspaces/:workspaceId/chats', () =>
        conflict({ scope: 'WORKSPACE', limit: 7, used: 6 }),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Достигнут лимит чатов пространства: 6 из 7.',
    );
    expect(Object.keys(mockDb.chats)).toHaveLength(before);
  });

  it('surfaces 409 for DIRECT creation as well', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    server.use(
      http.post('*/api/v1/workspaces/:workspaceId/chats', () =>
        conflict({ scope: 'USER', limit: 3, used: 3 }),
      ),
    );

    const dialog = await openDirect(user);
    await user.click(within(dialog).getByRole('radio', { name: /Марк Соколов/ }));
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Достигнут лимит чатов пользователя: 3 из 3.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockDb.chatCreateRequests).toHaveLength(0);
  });

  it('surfaces 422 validation from the server and does not close the dialog', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    server.use(
      http.post('*/api/v1/workspaces/:workspaceId/chats', () =>
        HttpResponse.json(
          {
            code: 'VALIDATION_FAILED',
            message: 'name must be 1..120 characters for GROUP',
            details: { field: 'name', max_length: 120 },
            request_id: 'req_chat_validation',
          },
          { status: 422 },
        ),
      ),
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Название чата'), 'Плохое имя');
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Введите название от 1 до 120 символов.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('validates the name locally and never calls the API for an empty group name', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: CREATE_BUTTON }));

    expect(within(dialog).getByText('Введите название от 1 до 120 символов.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: CREATE_BUTTON })).toBeDisabled();
    expect(mockDb.chatCreateRequests).toHaveLength(0);
  });

  it('passes an axe audit for the DIRECT member picker', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await openDirect(user);

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
