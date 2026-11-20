import { act, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { insertMockMessage, insertMockStickerMessage } from '../mocks/db';
import { builtinSticker, IDS } from '../mocks/fixtures';
import {
  dropMockRealtimeConnections,
  publishMockMessageCreated,
  publishMockReceipt,
  publishMockTyping,
  mockRealtimeSubscribedChats,
} from '../mocks/realtime';
import { mockDb, server } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];

function renderRealtime() {
  const result = renderApp({ realtimeEnabled: true });
  stores.push(result.store);
  return result;
}

async function waitForOnline(store: ChatStore): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await vi.waitFor(
    () => {
      expect(store.getSnapshot().realtimeStatus).toBe('online');
      expect(mockRealtimeSubscribedChats()).toContain(IDS.groupChat);
    },
    { timeout: 4_000 },
  );
  expect(await screen.findByTitle('Онлайн')).toBeInTheDocument();
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('realtime chat UI', () => {
  it('shows a live message without reload, marks read receipts and renders typing TTL', async () => {
    const { container, store } = renderRealtime();
    await waitForOnline(store);

    const message = insertMockMessage(mockDb, IDS.groupChat, 'Сообщение по WebSocket');
    act(() => publishMockMessageCreated(mockDb, message));

    expect(await screen.findByText('Сообщение по WebSocket')).toBeInTheDocument();
    expect(container.querySelectorAll('.msg-row')).toHaveLength(31);
    expect(screen.queryByText('Отправляется…')).not.toBeInTheDocument();

    act(() => publishMockReceipt(mockDb, IDS.groupChat, IDS.mark, 45));
    await waitFor(() => {
      expect(screen.getAllByText('Прочитано').length).toBeGreaterThan(0);
    });

    act(() =>
      publishMockTyping(mockDb, IDS.groupChat, IDS.mark, new Date(Date.now() + 200).toISOString()),
    );
    expect(
      await screen.findByText(/Марк Соколов печатает…/, {}, { timeout: 5_000 }),
    ).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByText(/печатает…/)).not.toBeInTheDocument();
      },
      { timeout: 2_000 },
    );
  });

  it('renders a live STICKER message from another participant without a bubble', async () => {
    const { container, store } = renderRealtime();
    await waitForOnline(store);

    const message = insertMockStickerMessage(mockDb, IDS.groupChat, builtinSticker('cats', 0));
    act(() => publishMockMessageCreated(mockDb, message));

    const image = await screen.findByRole('img', { name: 'Кот: привет' });
    expect(image).toHaveAttribute('src', '/stickers/cats/01.png?v=2');
    expect(image.closest('.bubble')).toBeNull();
    expect(container.querySelectorAll('.msg-row')).toHaveLength(31);
  });

  it('shows a reconnect banner, keeps REST working and recovers without duplicates', async () => {
    const { container, store } = renderRealtime();
    await waitForOnline(store);

    const delivered = insertMockMessage(mockDb, IDS.groupChat, 'До разрыва');
    act(() => publishMockMessageCreated(mockDb, delivered));
    await screen.findByText('До разрыва');

    act(() => dropMockRealtimeConnections(1013));
    expect(await screen.findByText(/Нет live-обновлений. Отправка работает/)).toBeInTheDocument();
    expect(screen.getByLabelText('Текст сообщения')).toBeInTheDocument();

    const missed = insertMockMessage(mockDb, IDS.groupChat, 'После разрыва');
    act(() => publishMockMessageCreated(mockDb, missed));

    await waitFor(
      () => {
        expect(screen.getByText('После разрыва')).toBeInTheDocument();
      },
      { timeout: 6_000 },
    );
    await waitFor(() => {
      expect(screen.getByTitle('Онлайн')).toBeInTheDocument();
    });
    expect(screen.getAllByText('После разрыва')).toHaveLength(1);
    expect(container.querySelectorAll('.msg-row')).toHaveLength(32);
  });

  it('renders an auth banner when the ticket endpoint keeps returning 401', async () => {
    server.use(
      http.post('*/api/v1/realtime/ticket', () =>
        HttpResponse.json(
          { code: 'UNAUTHENTICATED', message: 'expired', request_id: 'req_ws_401' },
          { status: 401 },
        ),
      ),
    );
    renderRealtime();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(await screen.findByText(/Сессия live-обновлений истекла/)).toBeInTheDocument();
    expect(screen.getByLabelText('Текст сообщения')).toBeInTheDocument();
  });

  it('renders a clear 403 ticket banner without hiding history or composer', async () => {
    server.use(
      http.post('*/api/v1/realtime/ticket', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'no access', request_id: 'req_ws_403' },
          { status: 403 },
        ),
      ),
    );
    renderRealtime();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(
      await screen.findByText(/Нет доступа к live-обновлениям этого чата/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Текст сообщения')).toBeInTheDocument();
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
  });
});
