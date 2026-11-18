import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createE2eeDeviceApi, toDeviceApiError } from './e2eeDeviceApi';
import { ApiClient } from './http';
import { DeviceApiError } from './e2eeDeviceApi';
import { server } from '../test/server';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CHAT_ID = '66666666-6666-4666-8666-666666666666';
const IDEMPOTENCY = '77777777-7777-4777-8777-777777777777';

function makeClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => 'test-token',
    getDeviceId: () => DEVICE_ID,
  });
}

function api() {
  return createE2eeDeviceApi(makeClient());
}

function errorResponse(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): Response {
  return HttpResponse.json(
    { code, message: 'server message', details, request_id: 'req_test' },
    { status },
  );
}

const DEVICE_BODY = {
  id: DEVICE_ID,
  name: 'Test device',
  platform: 'WEB' as const,
  status: 'ACTIVE' as const,
  e2ee_capable: true,
  key_generation: 1,
  created_at: '2026-11-16T10:00:00.000Z',
};

describe('E2EE device API adapter', () => {
  it('POST /devices sends the exact body, idempotency key and auth headers', async () => {
    let captured: { headers: Headers | null; body: unknown } = { headers: null, body: undefined };
    server.use(
      http.post('*/api/v1/devices', async ({ request }) => {
        captured = { headers: request.headers, body: await request.json() };
        return HttpResponse.json(DEVICE_BODY, {
          status: 201,
          headers: { 'Idempotent-Replay': 'true' },
        });
      }),
    );
    const body = {
      name: 'Test device',
      platform: 'WEB' as const,
      app_version: '0.7.0',
      identity_signing_key: 'x',
    };
    const result = await api().registerDevice(body, IDEMPOTENCY);

    expect(result.replayed).toBe(true);
    expect(result.device.id).toBe(DEVICE_ID);
    expect(captured.body).toEqual(body);
    expect(captured.headers?.get('idempotency-key')).toBe(IDEMPOTENCY);
    expect(captured.headers?.get('authorization')).toBe('Bearer test-token');
    expect(captured.headers?.get('x-device-id')).toBe(DEVICE_ID);
  });

  it('POST /devices/{id}/prekeys uses the encoded device path', async () => {
    let path = '';
    server.use(
      http.post('*/api/v1/devices/:deviceId/prekeys', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({
          device_id: DEVICE_ID,
          key_generation: 1,
          one_time_prekeys_available: 1,
        });
      }),
    );
    const result = await api().uploadPrekeys(
      DEVICE_ID,
      { signed_prekey: { key_id: 'spk-1', public_key: 'a', signature: 'b' } },
      IDEMPOTENCY,
    );
    expect(path).toBe(`/api/v1/devices/${DEVICE_ID}/prekeys`);
    expect(result.one_time_prekeys_available).toBe(1);
  });

  it('GET /devices and GET /chats/{id}/keys are typed reads without a body', async () => {
    const calls: string[] = [];
    server.use(
      http.get('*/api/v1/devices', ({ request }) => {
        calls.push(new URL(request.url).pathname);
        return HttpResponse.json({ items: [DEVICE_BODY] });
      }),
      http.get('*/api/v1/chats/:chatId/keys', ({ request }) => {
        calls.push(new URL(request.url).pathname);
        return HttpResponse.json({
          chat_id: CHAT_ID,
          security_mode: 'E2EE',
          my_device_id: DEVICE_ID,
          verifier_device_id: DEVICE_ID,
          devices: [],
        });
      }),
    );
    await expect(api().listDevices()).resolves.toMatchObject({ items: [DEVICE_BODY] });
    await expect(api().getChatKeys(CHAT_ID)).resolves.toMatchObject({ chat_id: CHAT_ID });
    expect(calls).toEqual(['/api/v1/devices', `/api/v1/chats/${CHAT_ID}/keys`]);
  });

  it('PUT /chats/{id}/keys/verification sends the contract body and Idempotency-Key', async () => {
    let captured: { headers: Headers | null; body: unknown; path: string } = {
      headers: null,
      body: undefined,
      path: '',
    };
    const body = {
      device_id: DEVICE_ID,
      method: 'MANUAL' as const,
      vh_version: 2 as const,
      safety_number_hash: 'a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw',
      expected_key_generation: 1,
    };
    server.use(
      http.put('*/api/v1/chats/:chatId/keys/verification', async ({ request }) => {
        captured = {
          headers: request.headers,
          body: await request.json(),
          path: new URL(request.url).pathname,
        };
        return HttpResponse.json(
          {
            chat_id: CHAT_ID,
            verifier_device_id: DEVICE_ID,
            device_id: DEVICE_ID,
            key_generation: 1,
            verified: true,
            verified_at: '2026-11-18T10:00:00.000Z',
            method: 'MANUAL',
          },
          { status: 201 },
        );
      }),
    );

    const result = await api().verifyDevice(CHAT_ID, body, IDEMPOTENCY);
    expect(captured.path).toBe(`/api/v1/chats/${CHAT_ID}/keys/verification`);
    expect(captured.body).toEqual(body);
    expect(captured.headers?.get('idempotency-key')).toBe(IDEMPOTENCY);
    expect(captured.headers?.get('x-device-id')).toBe(DEVICE_ID);
    expect(captured.headers?.get('content-type')).toContain('application/json');
    expect(result).toMatchObject({ verified: true, method: 'MANUAL', chat_id: CHAT_ID });
  });

  it('maps 409 KEY_CHANGED from verification to a non-retryable key_changed error', async () => {
    server.use(
      http.put('*/api/v1/chats/:chatId/keys/verification', () => errorResponse(409, 'KEY_CHANGED')),
    );
    await expect(
      api().verifyDevice(
        CHAT_ID,
        {
          device_id: DEVICE_ID,
          method: 'MANUAL',
          vh_version: 2,
          safety_number_hash: 'a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw',
        },
        IDEMPOTENCY,
      ),
    ).rejects.toMatchObject({ kind: 'key_changed', status: 409, retryable: false });
  });

  it('POST /keys/claim never sends an Idempotency-Key', async () => {
    const captured: { headers: Headers | null } = { headers: null };
    server.use(
      http.post('*/api/v1/keys/claim', ({ request }) => {
        captured.headers = request.headers;
        return HttpResponse.json({
          bundles: [],
          unavailable: [{ device_id: DEVICE_ID, reason: 'NO_KEYS' }],
        });
      }),
    );
    await api().claimPrekeys({
      chat_id: CHAT_ID,
      devices: [{ device_id: DEVICE_ID, user_id: '22222222-2222-4222-8222-222222222222' }],
    });
    expect(captured.headers?.get('idempotency-key')).toBeNull();
    expect(captured.headers?.get('x-device-id')).toBe(DEVICE_ID);
  });

  describe('error mapping', () => {
    const cases: Array<[number, string, string, boolean]> = [
      [409, 'IDENTITY_KEY_CONFLICT', 'identity_key_conflict', false],
      [409, 'IDEMPOTENCY_KEY_REUSED', 'idempotency_key_reused', false],
      [409, 'IDEMPOTENCY_IN_PROGRESS', 'idempotency_in_progress', true],
      [409, 'DEVICE_LIMIT_REACHED', 'device_limit_reached', false],
      [409, 'PREKEY_ID_CONFLICT', 'prekey_id_conflict', false],
      [409, 'NO_PREKEYS', 'no_prekeys', false],
      [409, 'KEY_CHANGED', 'key_changed', false],
      [409, 'MODE_NOT_SUPPORTED', 'mode_not_supported', false],
      [410, 'DEVICE_REVOKED', 'device_revoked', false],
      [422, 'INVALID_KEY_FORMAT', 'invalid_key_format', false],
      [422, 'INVALID_SPK_SIGNATURE', 'invalid_spk_signature', false],
      [422, 'INVALID_IDENTITY_BINDING', 'invalid_identity_binding', false],
      [422, 'INVALID_PREKEY', 'invalid_prekey', false],
      [422, 'PREKEY_LIMIT_EXCEEDED', 'prekey_limit_exceeded', false],
      [422, 'E2EE_LEGACY_DEVICE', 'legacy_device', false],
      [422, 'NO_KEYS', 'legacy_device', false],
      [422, 'UNKNOWN_DEVICE', 'unknown_device', false],
      [422, 'KEY_GENERATION_MISMATCH', 'key_generation_mismatch', false],
      [422, 'TOO_MANY_DEVICES', 'too_many_devices', false],
    ];

    it.each(cases)('maps %i %s to %s', async (status, code, kind, retryable) => {
      server.use(http.post('*/api/v1/devices', () => errorResponse(status, code)));
      let caught: DeviceApiError | undefined;
      try {
        await api().registerDevice({ name: 'x', platform: 'WEB', app_version: '1' }, IDEMPOTENCY);
      } catch (error) {
        caught = error as DeviceApiError;
      }
      expect(caught).toBeInstanceOf(DeviceApiError);
      expect(caught?.kind).toBe(kind);
      expect(caught?.status).toBe(status);
      expect(caught?.code).toBe(code);
      expect(caught?.retryable).toBe(retryable);
    });

    it('maps 429 and 5xx as retryable and 400 as non-retryable', async () => {
      server.use(http.post('*/api/v1/devices', () => errorResponse(429, 'RATE_LIMITED', {})));
      await expect(
        api().registerDevice({ name: 'x', platform: 'WEB', app_version: '1' }, IDEMPOTENCY),
      ).rejects.toMatchObject({ kind: 'rate_limited', retryable: true });

      server.use(http.post('*/api/v1/devices', () => errorResponse(503, 'UNAVAILABLE')));
      await expect(
        api().registerDevice({ name: 'x', platform: 'WEB', app_version: '1' }, IDEMPOTENCY),
      ).rejects.toMatchObject({ kind: 'server', retryable: true });

      server.use(http.post('*/api/v1/devices', () => errorResponse(400, 'VALIDATION_FAILED')));
      await expect(
        api().registerDevice({ name: 'x', platform: 'WEB', app_version: '1' }, IDEMPOTENCY),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false });
    });

    it('keeps only allow-listed details and never echoes the request body', async () => {
      server.use(
        http.post('*/api/v1/devices', () =>
          errorResponse(422, 'INVALID_IDENTITY_BINDING', {
            field: 'identity_binding_signature',
            device_id: DEVICE_ID,
            devices: [DEVICE_ID],
            secret: 'TOP-SECRET-KEY',
          }),
        ),
      );
      let caught: DeviceApiError | undefined;
      try {
        await api().registerDevice(
          {
            name: 'x',
            platform: 'WEB',
            app_version: '1',
            identity_signing_key: 'PRIVATE-MATERIAL',
          },
          IDEMPOTENCY,
        );
      } catch (error) {
        caught = error as DeviceApiError;
      }
      expect(caught?.field).toBe('identity_binding_signature');
      expect(caught?.deviceId).toBe(DEVICE_ID);
      expect(caught?.devices).toEqual([DEVICE_ID]);
      expect(caught?.message).not.toContain('TOP-SECRET-KEY');
      expect(caught?.message).not.toContain('PRIVATE-MATERIAL');
      expect(JSON.stringify(caught)).not.toContain('PRIVATE-MATERIAL');
    });

    it('normalises non-API errors to a non-retryable unknown failure', () => {
      const mapped = toDeviceApiError(new Error('boom'));
      expect(mapped.kind).toBe('unknown');
      expect(mapped.retryable).toBe(false);
      expect(mapped.cause).toBeInstanceOf(Error);
    });
  });

  it('retries once after 401 through the provided re-authentication hook', async () => {
    let calls = 0;
    let reauth = 0;
    server.use(
      http.post('*/api/v1/devices', () => {
        calls += 1;
        if (calls === 1) return errorResponse(401, 'UNAUTHENTICATED');
        return HttpResponse.json(DEVICE_BODY, { status: 201 });
      }),
    );
    const client = new ApiClient({
      baseUrl: 'http://api.test/api/v1',
      timeoutMs: 5_000,
      getToken: () => 'test-token',
      getDeviceId: () => DEVICE_ID,
    });
    const deviceApi = createE2eeDeviceApi(client, {
      onUnauthorized: async () => {
        reauth += 1;
        return true;
      },
    });
    const result = await deviceApi.registerDevice(
      { name: 'x', platform: 'WEB', app_version: '1' },
      IDEMPOTENCY,
    );
    expect(result.device.id).toBe(DEVICE_ID);
    expect(calls).toBe(2);
    expect(reauth).toBe(1);
  });

  it('does not retry after 401 without a hook', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/v1/devices', () => {
        calls += 1;
        return errorResponse(401, 'UNAUTHENTICATED');
      }),
    );
    await expect(
      api().registerDevice({ name: 'x', platform: 'WEB', app_version: '1' }, IDEMPOTENCY),
    ).rejects.toMatchObject({ kind: 'unauthenticated', retryable: false });
    expect(calls).toBe(1);
  });
});
