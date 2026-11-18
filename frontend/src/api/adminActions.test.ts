import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { IDS, mockSession } from '../mocks/fixtures';
import { server } from '../test/server';
import { createApi } from './endpoints';
import { ApiClient } from './http';
import { ApiError } from './problem';

/**
 * E11-F contract client: admin mutations are bodyless `204`s and the audit
 * read is a cursor page. Every authenticated call must carry Authorization and
 * `X-Device-Id` (the shared HTTP client attaches both from the session).
 */
function makeApi() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
  return createApi(client, { devSession: true });
}

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
  deviceId: string | null;
  contentType: string | null;
  idempotencyKey: string | null;
  body: string;
}

async function capture(
  method: 'post' | 'delete' | 'get',
  path: string,
  responder: () => Response = () => new HttpResponse(null, { status: 204 }),
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const url = `*/api/v1${path}`;
  const handler =
    method === 'post'
      ? http.post(url, async ({ request }) => {
          captured.push(await snapshot(request));
          return responder();
        })
      : method === 'delete'
        ? http.delete(url, async ({ request }) => {
            captured.push(await snapshot(request));
            return responder();
          })
        : http.get(url, async ({ request }) => {
            captured.push(await snapshot(request));
            return responder();
          });
  server.use(handler);
  return captured;

  async function snapshot(request: Request): Promise<CapturedRequest> {
    const url = new URL(request.url);
    return {
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      deviceId: request.headers.get('x-device-id'),
      contentType: request.headers.get('content-type'),
      idempotencyKey: request.headers.get('idempotency-key'),
      body: await request.text(),
    };
  }
}

describe('E11-F admin actions client', () => {
  it('POST /admin/users/{id}/suspend sends no body and returns void', async () => {
    setSession(mockSession);
    const captured = await capture('post', `/admin/users/${IDS.user}/suspend`);

    await expect(makeApi().suspendUser(IDS.user)).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/admin/users/${IDS.user}/suspend`,
      authorization: `Bearer ${mockSession.access_token}`,
      deviceId: IDS.device,
      body: '',
      idempotencyKey: null,
    });
    // The contract has no request body for this operation.
    expect(captured[0]?.contentType).toBeNull();
  });

  it('POST /admin/users/{id}/activate encodes the path and returns void', async () => {
    setSession(mockSession);
    const captured = await capture('post', `/admin/users/${IDS.user}/activate`);

    await expect(makeApi().activateUser(IDS.user)).resolves.toBeUndefined();

    expect(captured[0]?.path).toBe(`/api/v1/admin/users/${IDS.user}/activate`);
    expect(captured[0]?.deviceId).toBe(IDS.device);
  });

  it('DELETE /admin/chats/{id} sends the soft-delete request', async () => {
    setSession(mockSession);
    const captured = await capture('delete', `/admin/chats/${IDS.groupChat}`);

    await expect(makeApi().deleteChat(IDS.groupChat)).resolves.toBeUndefined();

    expect(captured[0]).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/admin/chats/${IDS.groupChat}`,
      deviceId: IDS.device,
      body: '',
    });
  });

  it('GET /admin/audit echoes the opaque cursor and exact action filter', async () => {
    setSession(mockSession);
    const page = {
      items: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          action: 'admin.user.suspended',
          actor_id: IDS.user,
          actor_email: 'admin@example.test',
          target_type: 'user',
          target_id: IDS.anna,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      next_cursor: 'cursor-2',
      has_more: true,
    };
    const requests: string[] = [];
    server.use(
      http.get('*/api/v1/admin/audit', ({ request }) => {
        requests.push(new URL(request.url).search);
        return HttpResponse.json(page);
      }),
    );

    const result = await makeApi().listAdminAudit({
      action: '  admin.user.suspended  ',
      cursor: 'cursor-1',
      limit: 25,
    });

    expect(result).toEqual(page);
    expect(requests).toHaveLength(1);
    const params = new URLSearchParams(requests[0]);
    expect(params.get('action')).toBe('admin.user.suspended');
    expect(params.get('cursor')).toBe('cursor-1');
    expect(params.get('limit')).toBe('25');
  });

  it('omits an empty action filter and surfaces documented errors', async () => {
    setSession(mockSession);
    const requests: string[] = [];
    server.use(
      http.get('*/api/v1/admin/audit', ({ request }) => {
        requests.push(new URL(request.url).search);
        return HttpResponse.json({ items: [], next_cursor: null, has_more: false });
      }),
    );
    await makeApi().listAdminAudit({ action: '   ' });
    expect(new URLSearchParams(requests[0]).has('action')).toBe(false);

    server.use(
      http.delete(`*/api/v1/admin/chats/${IDS.groupChat}`, () =>
        HttpResponse.json(
          {
            code: 'CHAT_ALREADY_DELETED',
            message: 'Chat is already deleted',
            request_id: 'req_409',
          },
          { status: 409 },
        ),
      ),
    );
    await expect(makeApi().deleteChat(IDS.groupChat)).rejects.toMatchObject({
      status: 409,
      code: 'CHAT_ALREADY_DELETED',
    });
    await expect(makeApi().deleteChat(IDS.groupChat)).rejects.toBeInstanceOf(ApiError);
  });
});
