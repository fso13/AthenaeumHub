import type { ApiMessage } from '../api/types';
import type { EventFrame, PresenceStatus, ServerFrame, SubscribedChat } from '../realtime/protocol';
import type { RealtimeSocket, SocketCloseEvent, SocketFactory } from '../realtime/socket';
import type { MockDb } from './db';
import { newUuid } from '../lib/ids';

/**
 * In-process E3 mock server for MSW/dev mode. It speaks the same frames as
 * contracts/ws-protocol.md, replays by seq, emits resume.gap, and can be
 * dropped to exercise the real RealtimeClient reconnect path. Only used when
 * VITE_USE_MOCKS=true or by tests; never imported by production code paths
 * unless the MSW worker is enabled.
 */

interface MockConnection {
  socket: MockRealtimeSocket;
  subscriptions: Map<string, { lastSeq: number }>;
  open: boolean;
}

const connections = new Set<MockConnection>();

export function resetMockRealtime(): void {
  for (const connection of [...connections]) {
    connection.socket.close(1000, 'mock reset');
  }
  connections.clear();
}

export function dropMockRealtimeConnections(code = 1013, reason = 'SLOW_CONSUMER'): void {
  for (const connection of [...connections]) {
    connection.socket.close(code, reason);
  }
}

export function mockRealtimeConnectionCount(): number {
  return connections.size;
}

export function publishMockMessageCreated(_db: MockDb, message: ApiMessage): void {
  const frame: EventFrame = {
    type: 'event',
    event_id: newUuid(),
    event: 'message.created',
    chat_id: message.chat_id,
    seq: message.seq,
    ts: message.created_at,
    payload: { message },
  };
  broadcastToChat(message.chat_id, frame);
}

export function publishMockReceipt(
  _db: MockDb,
  chatId: string,
  userId: string,
  lastReadSeq: number,
): void {
  broadcastToChat(chatId, {
    type: 'event',
    event_id: newUuid(),
    event: 'message.receipt',
    chat_id: chatId,
    payload: { user_id: userId, last_read_seq: lastReadSeq },
  });
}

export function publishMockTyping(
  _db: MockDb,
  chatId: string,
  userId: string,
  expiresAt = new Date(Date.now() + 5_000).toISOString(),
): void {
  broadcastToChat(chatId, {
    type: 'typing',
    chat_id: chatId,
    user_id: userId,
    expires_at: expiresAt,
  });
}

export function publishMockPresence(
  _db: MockDb,
  userId: string,
  status: PresenceStatus,
  lastSeenAt = new Date().toISOString(),
): void {
  for (const connection of connections) {
    connection.socket.deliver({
      type: 'presence',
      user_id: userId,
      status,
      last_seen_at: lastSeenAt,
    });
  }
}

/** Test-only: deliver an exact server frame to matching subscribers. */
export function publishMockServerFrame(frame: ServerFrame): void {
  if (frame.type === 'event' || frame.type === 'resume.gap' || frame.type === 'typing') {
    broadcastToChat(frame.chat_id, frame);
    return;
  }
  if (frame.type === 'presence') {
    for (const connection of connections) {
      connection.socket.deliver(frame);
    }
    return;
  }
  for (const connection of connections) {
    connection.socket.deliver(frame);
  }
}

export function createMockRealtimeSocketFactory(db: MockDb): SocketFactory {
  return (url) => new MockRealtimeSocket(db, url);
}

function broadcastToChat(chatId: string, frame: ServerFrame): void {
  for (const connection of connections) {
    if (!connection.open) continue;
    if (!connection.subscriptions.has(chatId)) continue;
    connection.socket.deliver(frame);
  }
}

class MockRealtimeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly db: MockDb;
  private readonly url: string;
  private readonly connection: MockConnection;
  private closed = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: MockDb, url: string) {
    this.db = db;
    this.url = url;
    this.connection = {
      socket: this,
      subscriptions: new Map(),
      open: false,
    };
    this.openTimer = setTimeout(() => this.open(), 0);
  }

  send(data: string): void {
    if (this.closed) return;
    setTimeout(() => this.handleClientFrame(data), 0);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    connections.delete(this.connection);
    this.connection.open = false;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  /** Server → client delivery. */
  deliver(frame: ServerFrame): void {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) });
  }

  private open(): void {
    this.openTimer = null;
    if (this.closed) return;

    const ticket = readTicket(this.url);
    const record = ticket ? this.db.realtimeTickets.get(ticket) : undefined;
    if (!record || record.used || record.expiresAt <= Date.now()) {
      this.onerror?.({ code: 'TICKET_INVALID' });
      this.close(4401, 'TICKET_INVALID');
      return;
    }
    record.used = true;

    this.connection.open = true;
    connections.add(this.connection);
    this.onopen?.();
    this.deliver({
      type: 'hello',
      session_id: `mock-${newUuid()}`,
      server_time: this.db.serverTime(),
      heartbeat_ms: 25_000,
      protocol: 'krug.ws.v1',
    });
  }

  private handleClientFrame(raw: string): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.close(1008, 'POLICY_VIOLATION');
      return;
    }
    if (!isRecord(parsed) || parsed.v !== 1) {
      this.close(1008, 'POLICY_VIOLATION');
      return;
    }

    switch (parsed.type) {
      case 'subscribe':
        this.subscribe(parsed.chats);
        break;
      case 'ping':
        this.deliver({ type: 'pong', server_time: this.db.serverTime() });
        break;
      case 'ack':
        // Backpressure/metrics only in E3.
        break;
      case 'typing':
        // No other demo participant to notify; tests publish directly.
        break;
      default:
        this.deliver({
          type: 'error',
          code: 'UNSUPPORTED_FRAME',
          message: 'Unknown client frame type',
          request_id: `mock-${newUuid()}`,
        });
    }
  }

  private subscribe(rawChats: unknown): void {
    if (!Array.isArray(rawChats)) {
      this.close(1008, 'POLICY_VIOLATION');
      return;
    }

    const acceptedChats: SubscribedChat[] = [];
    const replay: { chatId: string; afterSeq: number }[] = [];

    for (const item of rawChats) {
      if (!isRecord(item)) continue;
      const chatId = typeof item.chat_id === 'string' ? item.chat_id : '';
      if (!chatId) continue;
      const chat = this.db.chats[chatId];
      if (!chat) {
        acceptedChats.push({ chat_id: chatId, accepted: false, reason: 'FORBIDDEN' });
        continue;
      }
      const lastSeq =
        typeof item.last_seq === 'number' && item.last_seq >= 0 ? Math.floor(item.last_seq) : 0;
      this.connection.subscriptions.set(chatId, { lastSeq });
      acceptedChats.push({
        chat_id: chatId,
        accepted: true,
        server_last_seq: chat.summary.last_seq,
      });
      replay.push({ chatId, afterSeq: lastSeq });
    }

    this.deliver({ type: 'subscribed', chats: acceptedChats });

    for (const { chatId, afterSeq } of replay) {
      const chat = this.db.chats[chatId];
      if (!chat) continue;
      const maxSeq = chat.summary.last_seq;
      if (maxSeq - afterSeq > 500) {
        this.deliver({
          type: 'resume.gap',
          chat_id: chatId,
          from_seq: afterSeq,
          to_seq: maxSeq - 500,
          reason: 'REPLAY_WINDOW',
        });
        continue;
      }
      const messages = chat.messages
        .filter((message) => message.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 500);
      for (const message of messages) {
        this.deliver({
          type: 'event',
          event_id: newUuid(),
          event: 'message.created',
          chat_id: chatId,
          seq: message.seq,
          ts: message.created_at,
          payload: { message },
        });
      }
    }
  }
}

function readTicket(url: string): string | null {
  try {
    return new URL(url, 'http://localhost').searchParams.get('ticket');
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
