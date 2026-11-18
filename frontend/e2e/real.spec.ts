import { expect, test, type Request } from '@playwright/test';

/**
 * I-01 integration scenario against the real B-01 backend.
 * Run with: npm run test:e2e:real
 * Requires B-01 on http://localhost:8081 (dev profile) and Playwright browsers.
 */
test('I-01 real: dev/session → chats → history → send → idempotent replay → read → sync', async ({
  page,
}) => {
  const readRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/read')) {
      readRequests.push(request);
    }
  });

  await page.goto('/');
  await expect(page.getByLabel('Текст сообщения')).toBeVisible();
  const chatTitle = await page.locator('h1').innerText();
  expect(chatTitle.length).toBeGreaterThan(0);

  const text = `I-01 real ${Date.now()}`;
  const sendRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/messages'),
  );
  const sendResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/messages'),
  );

  await page.getByLabel('Текст сообщения').fill(text);
  await page.getByLabel('Текст сообщения').press('Enter');

  const sendRequest = await sendRequestPromise;
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status()).toBe(201);
  const sent = (await sendResponse.json()) as { id: string; seq: number };
  expect(sent.id).toBeTruthy();
  expect(sent.seq).toBeGreaterThan(0);

  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText('Отправляется…')).toHaveCount(0);

  const headers = await sendRequest.allHeaders();
  expect(headers.authorization).toMatch(/^Bearer /);
  expect(headers['x-device-id']).toBeTruthy();
  expect(headers['idempotency-key']).toBeTruthy();
  const body = sendRequest.postDataJSON();

  const pathname = new URL(sendRequest.url()).pathname;
  const chatId = pathname.split('/').filter(Boolean).at(-2);
  expect(chatId).toBeTruthy();

  // Same Idempotency-Key + same body must replay the original result.
  const replay = await page.request.post(`http://localhost:8081/api/v1/chats/${chatId}/messages`, {
    headers: {
      Authorization: headers.authorization ?? '',
      'X-Device-Id': headers['x-device-id'] ?? '',
      'Idempotency-Key': headers['idempotency-key'] ?? '',
      'Content-Type': 'application/json',
    },
    data: body,
  });
  expect(replay.status()).toBe(201);
  expect(replay.headers()['idempotent-replay']).toBe('true');
  expect(((await replay.json()) as { id: string }).id).toBe(sent.id);

  // Read receipt is sent after the debounce and covers the sent seq.
  await expect
    .poll(
      () => readRequests.some((request) => (request.postDataJSON()?.last_seq ?? 0) >= sent.seq),
      { timeout: 5_000 },
    )
    .toBe(true);

  // Reconnect/sync path.
  const syncResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/sync'),
  );
  await page.getByRole('button', { name: 'Обновить' }).click();
  const syncResponse = await syncResponsePromise;
  expect(syncResponse.status()).toBe(200);
  const sync = (await syncResponse.json()) as {
    server_time: string;
    chats: Array<{ chat_id: string; last_seq: number; unread_count: number }>;
  };
  expect(sync.server_time).toBeTruthy();
  expect(sync.chats.some((chat) => chat.chat_id === chatId && chat.last_seq >= sent.seq)).toBe(
    true,
  );

  const authHeaders = {
    Authorization: headers.authorization ?? '',
    'X-Device-Id': headers['x-device-id'] ?? '',
  };

  // Real contract error envelopes: 401, 403, 404.
  const noAuth = await page.request.get(`http://localhost:8081/api/v1/chats/${chatId}/messages`);
  expect(noAuth.status()).toBe(401);
  const noAuthProblem = (await noAuth.json()) as { code: string; request_id: string };
  expect(noAuthProblem.code).toBe('UNAUTHENTICATED');
  expect(noAuthProblem.request_id).toBeTruthy();

  const foreignWorkspace = await page.request.get(
    `http://localhost:8081/api/v1/workspaces/${crypto.randomUUID()}/chats`,
    { headers: authHeaders },
  );
  expect(foreignWorkspace.status()).toBe(403);
  const foreignProblem = (await foreignWorkspace.json()) as {
    code: string;
    request_id: string;
  };
  expect(foreignProblem.code).toBe('FORBIDDEN');
  expect(foreignProblem.request_id).toBeTruthy();

  const unknownChat = await page.request.get(
    `http://localhost:8081/api/v1/chats/${crypto.randomUUID()}/messages`,
    { headers: authHeaders },
  );
  expect(unknownChat.status()).toBe(404);
  const unknownProblem = (await unknownChat.json()) as {
    code: string;
    request_id: string;
  };
  expect(unknownProblem.code).toBe('NOT_FOUND');
  expect(unknownProblem.request_id).toBeTruthy();
});
