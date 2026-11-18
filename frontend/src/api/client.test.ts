import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { IDS, mockSession } from '../mocks/fixtures';
import { server } from '../test/server';
import { createApi } from './endpoints';
import { ApiClient } from './http';
import { ApiError } from './problem';
import type { MessageCreateBody } from './types';

const CONFIG = { devSession: true };

function makeClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
}

const BODY: MessageCreateBody = {
  client_message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  type: 'TEXT',
  text: 'Контрактный запрос',
};

describe('API client', () => {
  it('sends Authorization, X-Device-Id, Idempotency-Key and X-Request-Id', async () => {
    setSession(mockSession);
    let captured: Record<string, string | null> = {};

    server.use(
      http.post('*/api/v1/chats/:chatId/messages', ({ request }) => {
        captured = {
          authorization: request.headers.get('authorization'),
          deviceId: request.headers.get('x-device-id'),
          idempotencyKey: request.headers.get('idempotency-key'),
          requestId: request.headers.get('x-request-id'),
          contentType: request.headers.get('content-type'),
        };
        return HttpResponse.json(
          {
            id: '00000000-0000-4000-8000-000000000100',
            chat_id: IDS.groupChat,
            seq: 100,
            type: 'TEXT',
            sender_id: IDS.user,
            sender_display_name: 'Дмитрий Крылов',
            text: BODY.text,
            reply_to_id: null,
            created_at: '2026-11-16T10:00:00.000Z',
            edited_at: null,
            deleted_at: null,
            version: 1,
          },
          { status: 201, headers: { 'Idempotent-Replay': 'false' } },
        );
      }),
    );

    const api = createApi(makeClient(), CONFIG);
    const result = await api.sendMessage(
      IDS.groupChat,
      BODY,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );

    expect(captured.authorization).toBe(`Bearer ${mockSession.access_token}`);
    expect(captured.deviceId).toBe(mockSession.device.id);
    expect(captured.idempotencyKey).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(captured.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(captured.contentType).toContain('application/json');
    expect(result.message.seq).toBe(100);
    expect(result.replayed).toBe(false);
  });

  it('parses the contract error envelope into ApiError', async () => {
    setSession(mockSession);

    server.use(
      http.post('*/api/v1/chats/:chatId/messages', () =>
        HttpResponse.json(
          {
            code: 'MESSAGE_TOO_LONG',
            message: 'Message text is too long',
            details: { max_length: 8000 },
            request_id: 'req_test_1',
          },
          { status: 422 },
        ),
      ),
    );

    const api = createApi(makeClient(), CONFIG);
    let caught: unknown;
    try {
      await api.sendMessage(IDS.groupChat, BODY, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('MESSAGE_TOO_LONG');
    expect(apiError.requestId).toBe('req_test_1');
    expect(apiError.details).toEqual({ max_length: 8000 });
    expect(apiError.isRetryable).toBe(false);
  });

  it('re-issues a dev session and replays a 401 once', async () => {
    let sessionCalls = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/dev/session')) sessionCalls += 1;
    });

    server.use(
      http.get(
        '*/api/v1/chats/:chatId/messages',
        () =>
          HttpResponse.json(
            { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req_401' },
            { status: 401 },
          ),
        { once: true },
      ),
    );

    const api = createApi(makeClient(), CONFIG);
    const page = await api.listMessages(IDS.groupChat, { limit: 30 });

    expect(sessionCalls).toBe(1);
    expect(getSession()?.access_token).toBe(mockSession.access_token);
    expect(page.items.length).toBe(30);
  });

  it('parses Retry-After for 429', async () => {
    setSession(mockSession);
    server.use(
      http.post('*/api/v1/chats/:chatId/messages', () =>
        HttpResponse.json(
          { code: 'RATE_LIMITED', message: 'slow down', request_id: 'req_429' },
          { status: 429, headers: { 'Retry-After': '7' } },
        ),
      ),
    );

    const api = createApi(makeClient(), CONFIG);
    await expect(
      api.sendMessage(IDS.groupChat, BODY, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });
});
