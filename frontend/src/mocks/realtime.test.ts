import { afterEach, describe, expect, it } from 'vitest';
import { parseServerFrame, type ServerFrame } from '../realtime/protocol';
import { createMockDb, insertMockMessage, type MockDb } from './db';
import {
  createMockRealtimeSocketFactory,
  publishMockMessageCreated,
  resetMockRealtime,
} from './realtime';
import { IDS } from './fixtures';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function issueTicket(db: MockDb, ticket = 'ticket-1'): string {
  db.realtimeTickets.set(ticket, {
    deviceId: IDS.device,
    expiresAt: Date.now() + 30_000,
    used: false,
  });
  return ticket;
}

async function openSocket(db: MockDb, ticket: string) {
  const factory = createMockRealtimeSocketFactory(db);
  const socket = factory(`ws://localhost:8081/ws?ticket=${ticket}`);
  const frames: ServerFrame[] = [];
  const closes: { code: number; reason: string }[] = [];
  socket.onmessage = (event) => {
    const frame = parseServerFrame(String(event.data));
    if (frame) frames.push(frame);
  };
  socket.onclose = (event) => closes.push({ code: event.code, reason: event.reason });
  await tick();
  return { socket, frames, closes };
}

async function subscribe(
  socket: { send(data: string): void },
  chats: Array<{ chat_id: string; last_seq: number }>,
): Promise<void> {
  socket.send(JSON.stringify({ v: 1, type: 'subscribe', chats, presence: true }));
  await tick();
}

afterEach(() => {
  resetMockRealtime();
});

describe('mock WebSocket server', () => {
  it('replays by seq after subscribe and then delivers live events', async () => {
    const db = createMockDb();
    const { socket, frames } = await openSocket(db, issueTicket(db));

    expect(frames[0]).toMatchObject({ type: 'hello', protocol: 'krug.ws.v1' });

    await subscribe(socket, [{ chat_id: IDS.groupChat, last_seq: 40 }]);
    const replay = frames.filter((frame) => frame.type === 'event');
    expect(frames.some((frame) => frame.type === 'subscribed')).toBe(true);
    expect(replay.map((frame) => (frame.type === 'event' ? frame.seq : 0))).toEqual([
      41, 42, 43, 44, 45,
    ]);

    const live = insertMockMessage(db, IDS.groupChat, 'live after replay');
    publishMockMessageCreated(db, live);
    await tick();
    expect(frames.at(-1)).toMatchObject({
      type: 'event',
      event: 'message.created',
      seq: live.seq,
      payload: { message: { id: live.id, text: 'live after replay' } },
    });
  });

  it('emits resume.gap when the replay window is exceeded', async () => {
    const db = createMockDb();
    const chat = db.chats[IDS.groupChat];
    if (!chat) throw new Error('fixture chat missing');
    chat.summary.last_seq = 600;

    const { socket, frames } = await openSocket(db, issueTicket(db, 'ticket-gap'));
    await subscribe(socket, [{ chat_id: IDS.groupChat, last_seq: 0 }]);

    expect(frames.some((frame) => frame.type === 'resume.gap')).toBe(true);
    expect(frames.find((frame) => frame.type === 'resume.gap')).toMatchObject({
      chat_id: IDS.groupChat,
      from_seq: 0,
      to_seq: 100,
      reason: 'REPLAY_WINDOW',
    });
    expect(frames.some((frame) => frame.type === 'event')).toBe(false);
  });

  it('accepts a one-time ticket only once', async () => {
    const db = createMockDb();
    const ticket = issueTicket(db, 'ticket-once');

    const first = await openSocket(db, ticket);
    expect(first.closes).toHaveLength(0);
    expect(first.frames[0]?.type).toBe('hello');
    first.socket.close(1000, 'done');
    await tick();

    const second = await openSocket(db, ticket);
    expect(second.frames).toHaveLength(0);
    expect(second.closes[0]).toMatchObject({ code: 4401, reason: 'TICKET_INVALID' });
  });
});
