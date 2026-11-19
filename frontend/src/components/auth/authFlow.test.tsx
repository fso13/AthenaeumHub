import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createAuthApi } from '../../api/authApi';
import { ApiClient } from '../../api/http';
import { getAccessToken } from '../../auth/session';
import {
  readAuthSession,
  readPendingVerification,
  readStored,
  writeAuthSession,
  writePendingVerification,
} from '../../auth/storage';
import { setMockWorkspaces } from '../../mocks/db';
import {
  IDS,
  MOCK_DEMO_EMAIL,
  MOCK_DEMO_PASSWORD,
  MOCK_DISPLAY_NAME,
  MOCK_EMAIL,
  MOCK_EMAIL_CODE,
} from '../../mocks/fixtures';
import { resetRouterForTests } from '../../router/router';
import { mockDb, server } from '../../test/server';
import { renderPasswordApp } from '../../test/renderApp';

const LOGIN_HEADING = 'Вход в Pickle';
const REGISTER_HEADING = 'Регистрация в Pickle';
const VERIFY_HEADING = 'Подтвердите email';
const CHAT_HEADING = 'Команда «Восход»';

const REGISTER_EMAIL = 'new-user@example.test';
const REGISTER_PASSWORD = 'Krug-password-2026';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(
  user: TestUser,
  email = MOCK_DEMO_EMAIL,
  password = MOCK_DEMO_PASSWORD,
): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Пароль'), password);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

async function register(
  user: TestUser,
  email = REGISTER_EMAIL,
  password = REGISTER_PASSWORD,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Регистрация' }));
  await screen.findByRole('heading', { name: REGISTER_HEADING });
  await user.type(screen.getByLabelText('Имя'), 'Новый пользователь');
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Пароль'), password);
  await user.type(screen.getByLabelText('Повторите пароль'), password);
  await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
  await screen.findByRole('heading', { name: VERIFY_HEADING });
}

function makeAuth() {
  return createAuthApi(
    new ApiClient({
      baseUrl: 'http://api.test/api/v1',
      timeoutMs: 5_000,
      getToken: () => null,
      getDeviceId: () => null,
    }),
  );
}

function requestUrls(requests: Request[]): string[] {
  return requests.map((request) => request.url);
}

describe('Auth BFF password flow', () => {
  it('guards an anonymous visitor with the login form and never contacts Keycloak', async () => {
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => requests.push(request));

    renderPasswordApp();

    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Регистрация' })).toBeInTheDocument();
    expect(screen.getByText(/браузер обращается только к защищённому BFF/)).toBeInTheDocument();

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByLabelText('Текст сообщения')).not.toBeInTheDocument();

    expect(requestUrls(requests).some((url) => url.includes('8180'))).toBe(false);
    expect(requestUrls(requests).some((url) => url.includes('/realms'))).toBe(false);
  });

  it('shows a generic error for wrong credentials and stores no tokens', async () => {
    const { user } = renderPasswordApp();
    await login(user, MOCK_DEMO_EMAIL, 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный email или пароль.');
    expect(readAuthSession()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(window.location.pathname).toBe('/login');
    expect(mockDb.authLoginRequests).toHaveLength(1);
  });

  it('registers, verifies the 6-digit code, opens the chat and keeps secrets out of storage', async () => {
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => requests.push(request));

    const { user } = renderPasswordApp();
    await register(user);

    expect(screen.getByText(/new-user@example\.test/)).toBeInTheDocument();
    const resend = screen.getByRole('button', { name: /Повторить можно через/ });
    expect(resend).toBeDisabled();

    await user.type(screen.getByLabelText('Код из письма'), MOCK_EMAIL_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');

    const session = readAuthSession();
    expect(session).not.toBeNull();
    expect(session?.accessToken).toBe(getAccessToken());
    expect(session?.refreshToken).toMatch(/^mock-refresh-/);
    expect(session?.user.email).toBe(REGISTER_EMAIL);
    expect(mockDb.authVerifyRequests).toHaveLength(1);
    expect(mockDb.authVerifyRequests[0]?.code).toBe(MOCK_EMAIL_CODE);
    expect(mockDb.authVerifyRequests[0]?.verification_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockDb.devices).toHaveLength(1);

    const stored = readStored('krug.auth.session') ?? '';
    expect(stored).not.toContain(REGISTER_PASSWORD);
    expect(stored).not.toContain(MOCK_EMAIL_CODE);

    const urls = requestUrls(requests);
    expect(urls.some((url) => url.includes('8180'))).toBe(false);
    expect(urls.some((url) => url.includes('/realms'))).toBe(false);
  });

  it('validates registration fields on the client and does not call the API', async () => {
    const { user } = renderPasswordApp();
    await user.click(await screen.findByRole('button', { name: 'Регистрация' }));
    await screen.findByRole('heading', { name: REGISTER_HEADING });

    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByText('Введите имя.')).toBeInTheDocument();
    expect(screen.getByText('Введите email.')).toBeInTheDocument();
    expect(screen.getByText('Введите пароль.')).toBeInTheDocument();
    expect(screen.getByText('Повторите пароль.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Имя'), 'Новый пользователь');
    await user.type(screen.getByLabelText('Email'), 'new@example.test');
    await user.type(screen.getByLabelText('Пароль'), 'short');
    await user.type(screen.getByLabelText('Повторите пароль'), 'different');
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));

    expect(screen.getByText('Пароль должен быть не короче 10 символов.')).toBeInTheDocument();
    expect(screen.getByText('Пароли не совпадают.')).toBeInTheDocument();
    expect(mockDb.authRegisterRequests).toHaveLength(0);
  });

  it('routes an unverified login to the verify screen using verification_id', async () => {
    const api = makeAuth();
    const registration = await api.register({
      email: 'pending@example.test',
      display_name: 'Pending',
      password: REGISTER_PASSWORD,
    });

    const { user } = renderPasswordApp();
    await login(user, 'pending@example.test', REGISTER_PASSWORD);

    expect(await screen.findByRole('heading', { name: VERIFY_HEADING })).toBeInTheDocument();
    expect(screen.getByText(/pending@example\.test/)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/verify');
    expect(readAuthSession()).toBeNull();
    expect(readPendingVerification()?.id).toBe(registration.verification_id);
  });

  it('shows the remaining attempts for a wrong code, then accepts the correct one', async () => {
    const { user } = renderPasswordApp();
    await register(user);

    await user.type(screen.getByLabelText('Код из письма'), '000000');
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный код. Осталось попыток: 4.',
    );
    expect(readAuthSession()).toBeNull();

    const input = screen.getByLabelText('Код из письма');
    await user.clear(input);
    await user.type(input, MOCK_EMAIL_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();
    expect(readAuthSession()?.user.email).toBe(REGISTER_EMAIL);
  });

  it('surfaces an expired code (410) and does not create a session', async () => {
    const { user } = renderPasswordApp();
    await register(user);

    const pending = readPendingVerification();
    const verification = pending ? mockDb.authVerifications.get(pending.id) : undefined;
    if (!verification) throw new Error('verification is missing');
    verification.expiresAt = Date.now() - 1_000;

    await user.type(screen.getByLabelText('Код из письма'), MOCK_EMAIL_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Срок действия кода истёк. Запросите новый код.',
    );
    expect(readAuthSession()).toBeNull();
  });

  it('surfaces exhausted attempts (429) even for the correct code', async () => {
    const { user } = renderPasswordApp();
    await register(user);

    const pending = readPendingVerification();
    const verification = pending ? mockDb.authVerifications.get(pending.id) : undefined;
    if (!verification) throw new Error('verification is missing');
    verification.attempts = 5;

    await user.type(screen.getByLabelText('Код из письма'), MOCK_EMAIL_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Слишком много попыток/);
    expect(screen.getByRole('heading', { name: VERIFY_HEADING })).toBeInTheDocument();
    expect(readAuthSession()).toBeNull();
  });

  it('persists the pending verification and allows resend after the countdown', async () => {
    const first = renderPasswordApp();
    await register(first.user);
    expect(screen.getByRole('button', { name: /Повторить можно через/ })).toBeDisabled();
    first.unmount();

    const pending = readPendingVerification();
    if (!pending) throw new Error('pending verification is missing');
    writePendingVerification({ ...pending, resendUntil: 0 });
    const verification = mockDb.authVerifications.get(pending.id);
    if (!verification) throw new Error('verification is missing');
    verification.lastSentAt = Date.now() - 61_000;
    resetRouterForTests('/verify');

    const second = renderPasswordApp();
    expect(await screen.findByRole('heading', { name: VERIFY_HEADING })).toBeInTheDocument();
    const resend = screen.getByRole('button', { name: 'Отправить код повторно' });
    expect(resend).toBeEnabled();

    await second.user.click(resend);

    expect(await screen.findByRole('status')).toHaveTextContent('Новый код отправлен на email.');
    expect(mockDb.authResendRequests).toEqual([pending.id]);
  });

  it('bootstraps from the stored session via /me without a login screen', async () => {
    writeAuthSession({
      accessToken: 'stored-access-token',
      refreshToken: 'stored-refresh-token',
      expiresAt: Date.now() + 60_000,
      user: { id: IDS.user, displayName: MOCK_DISPLAY_NAME, email: MOCK_EMAIL },
    });
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => requests.push(request));

    renderPasswordApp();

    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: LOGIN_HEADING })).not.toBeInTheDocument();

    const me = requests.find((request) => request.url.endsWith('/api/v1/me'));
    expect(me?.headers.get('authorization')).toBe('Bearer stored-access-token');
  });

  it('refreshes once on 401 and replays the failed /me request', async () => {
    let meCalls = 0;
    server.use(
      http.get('*/api/v1/me', () => {
        meCalls += 1;
        if (meCalls === 1) {
          return HttpResponse.json(
            { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req_401' },
            { status: 401 },
          );
        }
        return HttpResponse.json(mockDb.me);
      }),
    );

    const { user } = renderPasswordApp();
    await login(user);

    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();
    expect(meCalls).toBe(2);
    expect(mockDb.authRefreshRequests).toHaveLength(1);
    expect(readAuthSession()?.refreshToken).toMatch(/^mock-refresh-/);
  });

  it('returns to the login screen and clears tokens when refresh fails', async () => {
    server.use(
      http.get('*/api/v1/me', () =>
        HttpResponse.json(
          { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req_401' },
          { status: 401 },
        ),
      ),
      http.post('*/api/v1/auth/refresh', () =>
        HttpResponse.json(
          { code: 'INVALID_CREDENTIALS', message: 'refresh invalid', request_id: 'req_refresh' },
          { status: 401 },
        ),
      ),
    );

    const { user } = renderPasswordApp();
    await login(user);

    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(readAuthSession()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('revokes the refresh token on logout, clears auth storage and returns to /login', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: CHAT_HEADING });
    const stored = readAuthSession();
    expect(stored).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByText('Вы вышли из аккаунта.')).toBeInTheDocument();
    expect(mockDb.authLogoutRequests).toEqual([stored?.refreshToken]);
    expect(mockDb.authRefreshTokens.has(stored?.refreshToken ?? '')).toBe(false);
    expect(readAuthSession()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('registers a device and sends X-Device-Id on protected requests', async () => {
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => requests.push(request));

    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: CHAT_HEADING });

    const devicePosts = requests.filter((request) => request.url.endsWith('/devices'));
    expect(devicePosts).toHaveLength(1);
    expect(devicePosts[0]?.headers.get('authorization')).toMatch(/^Bearer mock-access-/);
    expect(devicePosts[0]?.headers.get('idempotency-key')).toBeTruthy();

    const chatList = requests.find((request) => request.url.includes('/workspaces/'));
    expect(chatList?.headers.get('x-device-id')).toBe(mockDb.devices[0]?.id);

    const messages = requests.find((request) => request.url.includes('/messages'));
    expect(messages?.headers.get('x-device-id')).toBe(mockDb.devices[0]?.id);
  });

  it('opens onboarding when /me has no workspaces and creates the first workspace', async () => {
    setMockWorkspaces(mockDb, []);

    const { user } = renderPasswordApp();
    await login(user);

    expect(
      await screen.findByRole('heading', { name: 'Создайте пространство' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Название пространства'), 'Тестовое пространство');
    await user.click(screen.getByRole('button', { name: 'Создать пространство' }));

    expect(await screen.findByRole('heading', { name: 'Общий чат' })).toBeInTheDocument();
    expect(mockDb.me.workspaces[0]?.name).toBe('Тестовое пространство');
  });

  it('shows a clear forbidden screen for a workspace 403 and can log out', async () => {
    server.use(
      http.get('*/api/v1/workspaces/:workspaceId/chats', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'forbidden', request_id: 'req_403' },
          { status: 403 },
        ),
      ),
    );

    const { user } = renderPasswordApp();
    await login(user);

    expect(
      await screen.findByRole('heading', { name: 'Нет доступа к пространству' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
  });

  it('runs the full lifecycle: register → verify → logout → login → refresh → logout', async () => {
    const { user } = renderPasswordApp();
    await register(user);
    await user.type(screen.getByLabelText('Код из письма'), MOCK_EMAIL_CODE);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
    expect(readAuthSession()).toBeNull();

    // The next login hits one expired /me: refresh rotates the pair and the
    // request is replayed once, then logout revokes the refreshed token.
    let meCalls = 0;
    server.use(
      http.get('*/api/v1/me', () => {
        meCalls += 1;
        if (meCalls === 1) {
          return HttpResponse.json(
            { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req_lifecycle' },
            { status: 401 },
          );
        }
        return HttpResponse.json(mockDb.me);
      }),
    );

    await login(user, REGISTER_EMAIL, REGISTER_PASSWORD);
    expect(await screen.findByRole('heading', { name: CHAT_HEADING })).toBeInTheDocument();
    expect(meCalls).toBe(2);
    expect(mockDb.authRefreshRequests).toHaveLength(1);
    const session = readAuthSession();
    expect(session).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: LOGIN_HEADING })).toBeInTheDocument();
    expect(mockDb.authLogoutRequests).toHaveLength(2);
    expect(readAuthSession()).toBeNull();
  });

  it('uses the workspace switcher when more than one workspace is available', async () => {
    setMockWorkspaces(mockDb, [
      {
        id: IDS.workspace,
        name: 'Студия «Восход»',
        slug: 'studiya-voshod',
        role: 'OWNER',
        security_mode: 'MANAGED',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Второе пространство',
        slug: 'second',
        role: 'MEMBER',
        security_mode: 'MANAGED',
      },
    ]);

    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: CHAT_HEADING });

    expect(screen.getByLabelText(/Выбрать пространство/)).toBeInTheDocument();
  });
});
