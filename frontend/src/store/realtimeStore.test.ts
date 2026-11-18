import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { getDeviceId } from '../auth/session';
import { createTestConfig, createTestStore } from '../test/renderApp';
import { createFakeE2eeBridge, makeEnvelope } from '../test/e2eeBridgeFake';
import { newUuid } from '../lib/ids';
import { mockDb, server } from '../test/server';
import { insertMockMessage } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import {
  dropMockRealtimeConnections,
  publishMockMessageCreated,
  publishMockPresence,
  publishMockReceipt,
  publishMockServerFrame,
  publishMockTyping,
} from '../mocks/realtime';
import type { ChatStore } from './chatStore';

const stores: ChatStore[] = [];

async function boot(): Promise<ChatStore> {
  const store = createTestStore(createTestConfig({ realtimeEnabled: true }));
  stores.push(store);
  await store.bootstrap();
  await vi.waitFor(
    () => {
      expect(store.getSnapshot().realtimeStatus).toBe('online');
    },
    { timeout: 4_000 },
  );
  return store;
}

function slice(store: ChatStore, chatId = IDS.groupChat) {
  const current = store.getSnapshot().slices[chatId];
  if (!current) throw new Error(`No slice ${chatId}`);
  return current;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('chat store realtime integration', () => {
  it('connects after bootstrap/sync and merges live message.created once', async () => {
    const store = await boot();
    expect(slice(store).lastSeq).toBe(45);
    expect(slice(store).messages).toHaveLength(30);

    const message = insertMockMessage(mockDb, IDS.groupChat, 'Живое сообщение');
    publishMockMessageCreated(mockDb, message);

    await vi.waitFor(() => {
      expect(slice(store).messages.some((item) => item.id === message.id)).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(slice(store).messages.filter((item) => item.id === message.id)).toHaveLength(1);
    expect(slice(store).lastSeq).toBe(message.seq);
    expect(slice(store).unread).toBe(0);
    expect(store.getSnapshot().chats.find((chat) => chat.id === IDS.groupChat)?.last_seq).toBe(
      message.seq,
    );
  });

  it('accepts the backend flat message.created payload (E3-B compatibility)', async () => {
    const store = await boot();
    const message = insertMockMessage(mockDb, IDS.groupChat, 'Flat payload');

    publishMockServerFrame({
      type: 'event',
      event_id: message.id,
      event: 'message.created',
      chat_id: IDS.groupChat,
      seq: message.seq,
      ts: message.created_at,
      // Backend E3-B currently serialises Message fields at payload level.
      payload: { ...message },
    });

    await vi.waitFor(() => {
      expect(slice(store).messages.some((item) => item.id === message.id)).toBe(true);
    });
    expect(slice(store).lastSeq).toBe(message.seq);
  });

  it('dedupes repeated event_id and stale seq without duplicating a message', async () => {
    const store = await boot();
    const message = insertMockMessage(mockDb, IDS.groupChat, 'Дедуп');
    const frame = {
      type: 'event' as const,
      event_id: 'fixed-event-id',
      event: 'message.created',
      chat_id: IDS.groupChat,
      seq: message.seq,
      ts: message.created_at,
      payload: { message },
    };

    publishMockServerFrame(frame);
    publishMockServerFrame(frame);
    await vi.waitFor(() => {
      expect(slice(store).messages.filter((item) => item.id === message.id)).toHaveLength(1);
    });

    // Replay older than last_seq is ignored even with a fresh event_id.
    publishMockServerFrame({ ...frame, event_id: 'another-event-id' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slice(store).messages.filter((item) => item.id === message.id)).toHaveLength(1);
  });

  it('reconciles an optimistic message when message.created arrives before REST 201', async () => {
    mockDb.sendDelayMs = 200;
    const store = await boot();
    const text = 'Оптимистичное live';
    await store.send(IDS.groupChat, text);

    const messages = slice(store).messages.filter((item) => item.text === text);
    expect(messages).toHaveLength(1);
    expect(slice(store).outbox).toHaveLength(0);
  });

  it('applies message.receipt monotonically for a participant', async () => {
    const store = await boot();
    publishMockReceipt(mockDb, IDS.groupChat, IDS.anna, 40);
    await vi.waitFor(() => {
      expect(slice(store).receipts[IDS.anna]).toBe(40);
    });
    publishMockReceipt(mockDb, IDS.groupChat, IDS.anna, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slice(store).receipts[IDS.anna]).toBe(40);
  });

  it('shows typing with TTL and removes it when expired', async () => {
    const store = await boot();
    publishMockTyping(mockDb, IDS.groupChat, IDS.mark, new Date(Date.now() + 120).toISOString());
    await vi.waitFor(() => {
      expect(
        store.getSnapshot().typing[IDS.groupChat]?.some((item) => item.userId === IDS.mark),
      ).toBe(true);
    });
    await vi.waitFor(
      () => {
        expect(
          store.getSnapshot().typing[IDS.groupChat]?.some((item) => item.userId === IDS.mark),
        ).toBe(false);
      },
      { timeout: 2_000 },
    );
  });

  it('tracks presence and marks a user offline on a later frame', async () => {
    const store = await boot();
    publishMockPresence(mockDb, IDS.mark, 'ONLINE');
    await vi.waitFor(() => {
      expect(store.getSnapshot().presence[IDS.mark]?.status).toBe('ONLINE');
    });
    publishMockPresence(mockDb, IDS.mark, 'OFFLINE');
    await vi.waitFor(() => {
      expect(store.getSnapshot().presence[IDS.mark]?.status).toBe('OFFLINE');
    });
  });

  it('catches up via REST on resume.gap and keeps live order', async () => {
    const store = await boot();
    const before = slice(store).lastSeq;
    const missed = [
      insertMockMessage(mockDb, IDS.groupChat, 'Пропуск 1'),
      insertMockMessage(mockDb, IDS.groupChat, 'Пропуск 2'),
      insertMockMessage(mockDb, IDS.groupChat, 'Пропуск 3'),
    ];

    publishMockServerFrame({
      type: 'resume.gap',
      chat_id: IDS.groupChat,
      from_seq: before,
      to_seq: missed[0]?.seq ?? before,
      reason: 'REPLAY_WINDOW',
    });

    await vi.waitFor(() => {
      expect(
        missed.every((message) => slice(store).messages.some((item) => item.id === message.id)),
      ).toBe(true);
    });

    const live = insertMockMessage(mockDb, IDS.groupChat, 'После gap');
    publishMockMessageCreated(mockDb, live);
    await vi.waitFor(() => {
      expect(slice(store).messages.some((item) => item.id === live.id)).toBe(true);
    });

    const ids = slice(store).messages.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(slice(store).lastSeq).toBe(live.seq);
  });

  it('decrypts E2EE messages caught up by resume.gap', async () => {
    const peerDevice = '55555555-5555-4555-8555-555555555555';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: {
        chatId: IDS.groupChat,
        securityMode: 'E2EE',
        modeAction: 'allow_e2ee',
        selfDeviceId: '33333333-3333-4333-8333-333333333333',
        peerDeviceIds: [peerDevice],
      },
    });
    mockDb.chats[IDS.groupChat]!.summary.security_mode = 'E2EE';
    const store = createTestStore(createTestConfig({ realtimeEnabled: true }), {
      enabled: true,
      bridge,
    });
    stores.push(store);
    await store.bootstrap();
    await vi.waitFor(() =>
      expect(store.getSnapshot().e2ee.chats[IDS.groupChat]?.status).toBe('ready'),
    );

    const missed = insertMockMessage(mockDb, IDS.groupChat, 'x');
    missed.text = null;
    missed.client_message_id = newUuid();
    missed.crypto = makeEnvelope(IDS.groupChat, peerDevice, '33333333-3333-4333-8333-333333333333');
    bridge.receiveQueue.push({
      kind: 'message',
      localMessageId: newUuid(),
      sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      text: 'из resume.gap',
      replyToId: null,
    });

    const before = slice(store).lastSeq;
    publishMockServerFrame({
      type: 'resume.gap',
      chat_id: IDS.groupChat,
      from_seq: before,
      to_seq: missed.seq,
      reason: 'REPLAY_WINDOW',
    });

    await vi.waitFor(() => {
      expect(slice(store).e2ee[missed.id]?.status).toBe('decrypted');
    });
    expect(slice(store).e2ee[missed.id]?.text).toBe('из resume.gap');
  });

  it('reconnects with /sync + new ticket and replays while offline without duplicates', async () => {
    const store = await boot();
    const known = slice(store).messages.length;
    dropMockRealtimeConnections(1013);

    const missed = [
      insertMockMessage(mockDb, IDS.groupChat, 'Офлайн 1'),
      insertMockMessage(mockDb, IDS.groupChat, 'Офлайн 2'),
    ];

    await vi.waitFor(
      () => {
        expect(store.getSnapshot().realtimeStatus).toBe('online');
        expect(
          missed.every((message) => slice(store).messages.some((item) => item.id === message.id)),
        ).toBe(true);
      },
      { timeout: 6_000 },
    );

    expect(slice(store).messages.length).toBe(known + missed.length);
    expect(slice(store).messages.at(-1)?.id).toBe(missed[1]?.id);
  });

  it('marks the session revoked on session.revoked and stops reconnecting', async () => {
    const store = await boot();
    publishMockServerFrame({ type: 'session.revoked', reason: 'DEVICE_REVOKED' });

    await vi.waitFor(() => {
      expect(store.getSnapshot().realtimeStatus).toBe('revoked');
    });
    expect(store.getSnapshot().sessionStatus).toBe('error');
    expect(store.getSnapshot().authExpired).toBe(true);
    expect(store.getSnapshot().realtimeIssue?.kind).toBe('revoked');
  });

  it('keeps REST data when the ticket endpoint returns 403', async () => {
    server.use(
      http.post('*/api/v1/realtime/ticket', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'no access', request_id: 'req_ws_403' },
          { status: 403 },
        ),
      ),
    );
    const store = createTestStore(createTestConfig({ realtimeEnabled: true }));
    stores.push(store);
    await store.bootstrap();

    await vi.waitFor(() => {
      expect(store.getSnapshot().realtimeStatus).toBe('offline');
    });
    expect(store.getSnapshot().realtimeIssue?.kind).toBe('forbidden');
    expect(slice(store).status).toBe('ready');
    expect(slice(store).messages.length).toBeGreaterThan(0);
  });
});
