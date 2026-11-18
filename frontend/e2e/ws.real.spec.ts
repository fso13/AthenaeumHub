import { expect, test, type Response } from '@playwright/test';

/**
 * E3 real WS smoke (E3-AC-02/04/06 shape) against backend E3.
 *
 * A second REST sender is used instead of a second browser user because the
 * dev profile has no public "add member" flow. The page must still receive
 * `message.created` without reload; reload then re-subscribes with last_seq
 * and history must not duplicate the message.
 *
 * Requires backend E3 on 8081 and a free 5173:
 *   E3_WS_REAL=1 npm run test:e2e:ws
 */
const API = 'http://localhost:8081/api/v1';

interface SessionResponse {
  access_token: string;
  device: { id: string };
  chat: { id: string };
}

test.skip(
  process.env.E3_WS_REAL !== '1',
  'Backend E3 WebSocket is not available yet; mock WS covers E3-F behaviour',
);

test('E3 real WS: ticket → live message → reload/reconnect without duplicates', async ({
  page,
}) => {
  const sessionPromise = page.waitForResponse(
    (response: Response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/dev/session'),
  );

  await page.goto('/');
  const sessionResponse = await sessionPromise;
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()) as SessionResponse;

  await expect(page.getByLabel('Текст сообщения')).toBeVisible();
  await expect(page.getByTitle('Онлайн')).toBeVisible({ timeout: 15_000 });

  const authHeaders = {
    Authorization: `Bearer ${session.access_token}`,
    'X-Device-Id': session.device.id,
    'Content-Type': 'application/json',
  };

  const ticketResponse = await page.request.post(`${API}/realtime/ticket`, {
    headers: { Authorization: authHeaders.Authorization, 'X-Device-Id': session.device.id },
  });
  expect(ticketResponse.status()).toBe(200);
  const ticket = (await ticketResponse.json()) as {
    ticket: string;
    expires_at: string;
    ws_url: string;
  };
  expect(ticket.ticket).toBeTruthy();
  expect(Date.parse(ticket.expires_at)).toBeGreaterThan(Date.now());
  expect(ticket.ws_url).toMatch(/^wss?:\/\//);

  const noAuth = await page.request.post(`${API}/realtime/ticket`, {
    headers: { 'X-Device-Id': session.device.id },
  });
  expect(noAuth.status()).toBe(401);

  const text = `E3 real live ${Date.now()}`;
  const sendResponse = await page.request.post(`${API}/chats/${session.chat.id}/messages`, {
    headers: { ...authHeaders, 'Idempotency-Key': crypto.randomUUID() },
    data: {
      client_message_id: crypto.randomUUID(),
      type: 'TEXT',
      text,
    },
  });
  expect(sendResponse.status()).toBe(201);

  // Second sender → page sees message.created without reload.
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);

  // Reload is a hard reconnect: history/sync + a fresh ticket must not duplicate.
  await page.reload();
  await expect(page.getByLabel('Текст сообщения')).toBeVisible();
  await expect(page.getByTitle('Онлайн')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});
