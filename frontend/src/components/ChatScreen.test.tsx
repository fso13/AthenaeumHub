import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { insertMockMessage } from '../mocks/db';
import { IDS, messageId } from '../mocks/fixtures';
import { mockDb, server } from '../test/server';
import { renderApp } from '../test/renderApp';

async function waitForChat(container: HTMLElement): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await waitFor(() => {
    expect(container.querySelectorAll('.msg-row').length).toBeGreaterThan(0);
  });
}

async function sendText(user: ReturnType<typeof renderApp>['user'], text: string): Promise<void> {
  const textarea = screen.getByLabelText('Текст сообщения');
  await user.click(textarea);
  await user.type(textarea, text);
  await user.keyboard('{Enter}');
}

const MESSAGES_URL = '*/api/v1/chats/:chatId/messages';

describe('managed chat screen', () => {
  it('loads history ordered by seq, groups days, shows author/reply and escapes HTML', async () => {
    const { container } = renderApp();
    await waitForChat(container);

    const rows = [...container.querySelectorAll('.msg-row')];
    expect(rows).toHaveLength(30);
    expect(rows[0]?.id).toBe(`message-${messageId(16)}`);
    expect(rows[rows.length - 1]?.id).toBe(`message-${messageId(45)}`);

    expect(screen.getAllByRole('separator').length).toBeGreaterThanOrEqual(2);

    const log = screen.getByRole('log');
    expect(within(log).getAllByText('Анна Петрова').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Ответ на сообщение/ }).length).toBeGreaterThan(0);

    const htmlMessage = within(log).getByText(/Проверка экранирования/);
    expect(htmlMessage).toBeInTheDocument();
    expect(htmlMessage.querySelector('b')).toBeNull();
    expect(container.querySelector('.msg-text script')).toBeNull();
    expect(container.querySelector('.msg-text b')).toBeNull();
  });

  it('shows the optimistic message immediately and replaces it with the server one', async () => {
    mockDb.sendDelayMs = 200;
    const { user, container } = renderApp();
    await waitForChat(container);

    const text = 'Оптимистичное сообщение';
    await sendText(user, text);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Отправляется…')).toBeInTheDocument();
    expect(screen.getByLabelText('Текст сообщения')).toHaveValue('');

    await waitFor(
      () => {
        expect(screen.queryByText('Отправляется…')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(mockDb.sendAttempts).toHaveLength(1);
    expect(screen.getAllByRole('article').some((row) => row.textContent?.includes(text))).toBe(
      true,
    );
  });

  it('does not send empty text and keeps Shift+Enter as a newline', async () => {
    const { user, container } = renderApp();
    await waitForChat(container);

    const textarea = screen.getByLabelText('Текст сообщения');
    await user.click(textarea);
    await user.keyboard('{Enter}');
    expect(mockDb.sendAttempts).toHaveLength(0);

    await user.keyboard('Строка');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(textarea).toHaveValue('Строка\n');
    expect(mockDb.sendAttempts).toHaveLength(0);

    await user.keyboard('Вторая');
    expect(textarea).toHaveValue('Строка\nВторая');
  });

  it('retries a 500 with the same client_message_id and Idempotency-Key', async () => {
    mockDb.failNextSend = 1;
    const { user, container } = renderApp();
    await waitForChat(container);

    const text = 'Сообщение с ошибкой';
    await sendText(user, text);

    await screen.findByText('Не отправлено');
    expect(screen.getAllByText(text)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(
      () => {
        expect(screen.queryByText('Не отправлено')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(mockDb.sendAttempts).toHaveLength(2);
    const first = mockDb.sendAttempts[0];
    const second = mockDb.sendAttempts[1];
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.clientMessageId).toBe(first?.clientMessageId);
  });

  it('shows a 409 IDEMPOTENCY_KEY_REUSED conflict and restores the text', async () => {
    mockDb.forceSendError = {
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Idempotency key reused',
    };
    const { user, container } = renderApp();
    await waitForChat(container);

    const text = 'Конфликтное сообщение';
    await sendText(user, text);

    await screen.findByText('Ключ повтора уже использован');
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Вернуть текст' }));
    expect(screen.getByLabelText('Текст сообщения')).toHaveValue(text);
    expect(screen.queryByText(text, { selector: '.msg-text' })).not.toBeInTheDocument();

    mockDb.forceSendError = null;
  });

  it('shows a 422 MESSAGE_TOO_LONG error and restores the text', async () => {
    mockDb.forceSendError = {
      status: 422,
      code: 'MESSAGE_TOO_LONG',
      message: 'Message text is too long',
      details: { max_length: 8000 },
    };
    const { user, container } = renderApp();
    await waitForChat(container);

    const text = 'Текст, который сервер посчитал длинным';
    await sendText(user, text);

    await screen.findByText('Слишком длинное сообщение');
    await user.click(screen.getByRole('button', { name: 'Вернуть текст' }));
    expect(screen.getByLabelText('Текст сообщения')).toHaveValue(text);
    expect(screen.queryByText(text, { selector: '.msg-text' })).not.toBeInTheDocument();

    mockDb.forceSendError = null;
  });

  it('loads older messages via before_seq without duplicates', async () => {
    const { user, container } = renderApp();
    await waitForChat(container);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(30);

    await user.click(screen.getByRole('button', { name: 'Загрузить ещё' }));

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '.messages__inner > .msg-row, .messages__inner > .system-message',
        ),
      ).toHaveLength(45);
    });
    expect(screen.getByText('Чат создан')).toBeInTheDocument();
    expect(container.querySelector(`#message-${messageId(1)}`)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Загрузить ещё' })).not.toBeInTheDocument();

    const ids = [...container.querySelectorAll('.msg-row')].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('anchors the scroll position when older messages are prepended', async () => {
    const { user, container } = renderApp();
    await waitForChat(container);

    const scroller = container.querySelector('.messages');
    expect(scroller).not.toBeNull();
    const element = scroller as HTMLElement;
    let heightReads = 0;
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => {
        heightReads += 1;
        return heightReads === 1 ? 1000 : 1600;
      },
    });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 });
    element.scrollTop = 400;

    await user.click(screen.getByRole('button', { name: 'Загрузить ещё' }));

    await waitFor(() => {
      expect(container.querySelectorAll('.msg-row').length).toBe(44);
    });
    expect(element.scrollTop).toBe(400 + (1600 - 1000));
  });

  it('renders the empty state', async () => {
    server.use(
      http.get(MESSAGES_URL, () =>
        HttpResponse.json({ items: [], page: { next_cursor: null, has_more: false } }),
      ),
    );

    renderApp();
    expect(await screen.findByText('Пока нет сообщений')).toBeInTheDocument();
    expect(screen.getByLabelText('Текст сообщения')).toBeInTheDocument();
  });

  it('renders the forbidden state without a composer', async () => {
    server.use(
      http.get(MESSAGES_URL, () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'forbidden', request_id: 'req_403' },
          { status: 403 },
        ),
      ),
    );

    renderApp();
    expect(await screen.findByText('Нет доступа к чату')).toBeInTheDocument();
    expect(screen.queryByLabelText('Текст сообщения')).not.toBeInTheDocument();
  });

  it('surfaces 429 with Retry-After and blocks sending', async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(
          { code: 'RATE_LIMITED', message: 'slow down', request_id: 'req_429' },
          { status: 429, headers: { 'Retry-After': '2' } },
        ),
      ),
    );

    const { user, container } = renderApp();
    await waitForChat(container);

    await sendText(user, 'Слишком часто');

    expect((await screen.findAllByText(/Слишком много запросов/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Отправка возобновится через/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Текст сообщения'), 'ещё одно');
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
  });

  it('sends a debounced read receipt for the last visible seq', async () => {
    const { container } = renderApp();
    await waitForChat(container);

    await waitFor(
      () => {
        expect(mockDb.readReceipts[IDS.groupChat]).toBe(45);
      },
      { timeout: 3000 },
    );
  });

  it('catches up via GET /sync after reconnect', async () => {
    const { container } = renderApp();
    await waitForChat(container);

    insertMockMessage(mockDb, IDS.groupChat, 'Сообщение после реконнекта');
    act(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });

    expect(await screen.findByText('Сообщение после реконнекта')).toBeInTheDocument();
    expect(container.querySelectorAll('.msg-row')).toHaveLength(31);
  });

  it('re-issues the dev session and replays history after a 401', async () => {
    server.use(
      http.get(
        MESSAGES_URL,
        () =>
          HttpResponse.json(
            { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req_401' },
            { status: 401 },
          ),
        { once: true },
      ),
    );

    const { container } = renderApp();
    await waitForChat(container);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(30);
  });
});
