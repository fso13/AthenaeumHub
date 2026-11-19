import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem';
import { RealtimeClient, type RealtimeFailure, type RealtimeStatus } from './RealtimeClient';
import type { RealtimeSocket, SocketCloseEvent, SocketFactory } from './socket';

class FakeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closedByClient: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...(frame as object) }) });
  }

  serverClose(code: number, reason = ''): void {
    this.onclose?.({ code, reason });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

interface Harness {
  client: RealtimeClient;
  sockets: FakeSocket[];
  tickets: string[];
  statuses: RealtimeStatus[];
  failures: RealtimeFailure[];
  events: unknown[];
  gaps: unknown[];
  typing: unknown[];
  presence: unknown[];
  calls: unknown[];
  callUnavailable: unknown[];
  revoked: string[];
  order: string[];
  subscriptions: { chat_id: string; last_seq: number }[];
}

function createHarness(
  overrides: {
    createTicket?: () => Promise<{ ticket: string; expires_at: string; ws_url: string }>;
    maxReconnectPerHour?: number;
    backoff?: () => number;
  } = {},
): Harness {
  const harness: Harness = {
    client: undefined as unknown as RealtimeClient,
    sockets: [],
    tickets: [],
    statuses: [],
    failures: [],
    events: [],
    gaps: [],
    typing: [],
    presence: [],
    calls: [],
    callUnavailable: [],
    revoked: [],
    order: [],
    subscriptions: [{ chat_id: 'c1', last_seq: 41 }],
  };
  let ticketIndex = 0;
  const socketFactory: SocketFactory = (url) => {
    const socket = new FakeSocket(url);
    harness.sockets.push(socket);
    return socket;
  };

  harness.client = new RealtimeClient({
    createTicket:
      overrides.createTicket ??
      (() => {
        ticketIndex += 1;
        const ticket = `t${ticketIndex}`;
        harness.tickets.push(ticket);
        harness.order.push(`ticket:${ticket}`);
        return Promise.resolve({
          ticket,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
          ws_url: 'ws://realtime.test/ws',
        });
      }),
    getSubscriptions: () => harness.subscriptions,
    socketFactory,
    resolveUrl: (url) => url,
    random: () => 0.5,
    backoff: overrides.backoff ?? (() => 1_000),
    maxReconnectPerHour: overrides.maxReconnectPerHour,
    callbacks: {
      onStatus: (status) => harness.statuses.push(status),
      onEvent: (event) => harness.events.push(event),
      onGap: (gap) => harness.gaps.push(gap),
      onTyping: (frame) => harness.typing.push(frame),
      onPresence: (frame) => harness.presence.push(frame),
      onCallSignal: (frame) => harness.calls.push(frame),
      onCallUnavailable: (frame) => harness.callUnavailable.push(frame),
      onFailure: (failure) => harness.failures.push(failure),
      onRevoked: (reason) => harness.revoked.push(reason),
      onBeforeReconnect: () => {
        harness.order.push('sync');
      },
    },
  });
  return harness;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connect(harness: Harness): Promise<FakeSocket> {
  harness.client.start();
  await flush();
  const socket = harness.sockets[0];
  if (!socket) throw new Error('socket was not created');
  socket.open();
  socket.receive({
    type: 'hello',
    session_id: 'ws_1',
    server_time: new Date().toISOString(),
    heartbeat_ms: 25_000,
    protocol: 'krug.ws.v1',
  });
  await flush();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient handshake', () => {
  it('tickets, connects, sends hello/subscribe and heartbeats', async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    expect(harness.tickets).toEqual(['t1']);
    expect(socket.url).toBe('ws://realtime.test/ws?ticket=t1');
    expect(harness.statuses).toEqual(['connecting', 'online']);

    const subscribe = socket.frames().find((frame) => frame.type === 'subscribe');
    expect(subscribe).toEqual({
      v: 1,
      type: 'subscribe',
      chats: [{ chat_id: 'c1', last_seq: 41 }],
      presence: true,
    });

    harness.subscriptions = [{ chat_id: 'c1', last_seq: 42 }];
    harness.client.updateSubscriptions();
    const frames = socket.frames().filter((frame) => frame.type === 'subscribe');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ chats: [{ chat_id: 'c1', last_seq: 42 }] });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.frames().some((frame) => frame.type === 'ping')).toBe(true);
    socket.receive({ type: 'pong', server_time: new Date().toISOString() });

    harness.client.stop();
    expect(harness.statuses.at(-1)).toBe('idle');
  });

  it('dispatches events, gap and ephemeral frames', async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    socket.receive({
      type: 'event',
      event_id: 'e1',
      event: 'message.created',
      chat_id: 'c1',
      seq: 42,
      payload: { message: { id: 'm1' } },
    });
    socket.receive({
      type: 'resume.gap',
      chat_id: 'c1',
      from_seq: 10,
      to_seq: 20,
      reason: 'REPLAY_WINDOW',
    });
    socket.receive({
      type: 'event',
      event_id: 'e2',
      event: 'typing',
      chat_id: 'c1',
      payload: { user_id: 'u2' },
    });
    socket.receive({
      type: 'event',
      event_id: 'e3',
      event: 'presence',
      chat_id: 'c1',
      payload: { user_id: 'u2', status: 'ONLINE' },
    });

    expect(harness.events).toHaveLength(1);
    expect(harness.gaps).toHaveLength(1);
    expect(harness.typing).toHaveLength(1);
    expect(harness.presence).toHaveLength(1);
  });

  it('routes §9 call frames to their own callbacks and sends call.signal payloads', async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    const payload = {
      call_id: '00000000-0000-4000-8000-000000000001',
      kind: 'offer' as const,
      video: true,
      sdp: 'v=0\r\no=- offer',
    };
    expect(harness.client.sendCallSignal('c1', payload)).toBe(true);
    expect(socket.frames().at(-1)).toEqual({
      v: 1,
      type: 'call.signal',
      chat_id: 'c1',
      payload,
    });

    socket.receive({
      type: 'event',
      event: 'call.signal',
      chat_id: 'c1',
      from_user_id: 'u2',
      from_device_id: 'd2',
      payload: {
        call_id: payload.call_id,
        kind: 'answer',
        video: true,
        sdp: 'v=0\r\no=- answer',
      },
    });
    socket.receive({
      type: 'event',
      event: 'call.unavailable',
      chat_id: 'c1',
      payload: { call_id: payload.call_id, kind: 'offer', reason: 'PEER_OFFLINE' },
    });

    expect(harness.events).toHaveLength(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      type: 'call.signal',
      chat_id: 'c1',
      from_user_id: 'u2',
      payload: { kind: 'answer', video: true, sdp: 'v=0\r\no=- answer' },
    });
    expect(harness.callUnavailable).toHaveLength(1);
    expect(harness.callUnavailable[0]).toMatchObject({
      type: 'call.unavailable',
      payload: { call_id: payload.call_id, reason: 'PEER_OFFLINE' },
    });

    harness.client.stop();
    expect(harness.client.sendCallSignal('c1', payload)).toBe(false);
  });
});

describe('RealtimeClient reconnect', () => {
  it('runs /sync before a fresh ticket and subscribes with the updated last_seq', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    harness.subscriptions = [{ chat_id: 'c1', last_seq: 99 }];

    socket.serverClose(1013, 'SLOW_CONSUMER');
    expect(harness.statuses).toContain('reconnecting');
    expect(harness.order.filter((step) => step.startsWith('ticket'))).toEqual(['ticket:t1']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.order.filter((step) => step === 'sync')).toHaveLength(1);
    expect(harness.order.at(-2)).toBe('sync');
    expect(harness.order.at(-1)).toBe('ticket:t2');

    const second = harness.sockets[1];
    if (!second) throw new Error('second socket was not created');
    second.open();
    second.receive({
      type: 'hello',
      session_id: 'ws_2',
      server_time: new Date().toISOString(),
      heartbeat_ms: 25_000,
      protocol: 'krug.ws.v1',
    });
    await flush();

    expect(harness.statuses.at(-1)).toBe('online');
    expect(second.url).toBe('ws://realtime.test/ws?ticket=t2');
    expect(second.frames().find((frame) => frame.type === 'subscribe')).toMatchObject({
      chats: [{ chat_id: 'c1', last_seq: 99 }],
    });
  });

  it('runs /sync before the ticket when the network comes back', async () => {
    const harness = createHarness();
    await connect(harness);
    harness.client.suspend();
    expect(harness.statuses.at(-1)).toBe('offline');

    harness.client.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.order).toContain('sync');
    expect(harness.order.at(-1)).toBe('ticket:t2');
    expect(harness.sockets).toHaveLength(2);
  });

  it('requests a new ticket after 4401 and reconnects after 1013', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.serverClose(4401, 'TICKET_INVALID');
    expect(harness.failures.at(-1)).toMatchObject({ kind: 'network', code: 'TICKET_INVALID' });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.tickets).toEqual(['t1', 't2']);
    expect(harness.sockets).toHaveLength(2);
  });

  it('does not reconnect after 1008 policy violation', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.serverClose(1008, 'POLICY_VIOLATION');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.tickets).toEqual(['t1']);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.statuses.at(-1)).toBe('offline');
    expect(harness.failures.at(-1)).toMatchObject({ kind: 'protocol' });
  });

  it('stops on 4403/session.revoked', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.serverClose(4403, 'DEVICE_REVOKED');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.revoked).toEqual(['DEVICE_REVOKED']);
    expect(harness.statuses.at(-1)).toBe('revoked');
    expect(harness.tickets).toEqual(['t1']);
  });

  it('handles session.revoked frame without a subsequent close', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.receive({ type: 'session.revoked', reason: 'SESSION_REVOKED' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.revoked).toEqual(['SESSION_REVOKED']);
    expect(harness.tickets).toEqual(['t1']);
  });

  it('reconnects on heartbeat timeout', async () => {
    const harness = createHarness();
    await connect(harness);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(harness.statuses).toContain('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.tickets).toEqual(['t1', 't2']);
  });

  it('respects the 60/hour budget by pausing instead of hammering', async () => {
    const harness = createHarness({ maxReconnectPerHour: 1 });
    const socket = await connect(harness);
    socket.serverClose(1013);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.tickets).toEqual(['t1', 't2']);

    const second = harness.sockets[1];
    if (!second) throw new Error('second socket was not created');
    second.open();
    second.receive({ type: 'hello', session_id: 'ws_2', server_time: '', heartbeat_ms: 25_000 });
    second.serverClose(1013);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.tickets).toEqual(['t1', 't2']);
    expect(harness.failures.at(-1)).toMatchObject({ kind: 'budget' });
  });
});

describe('RealtimeClient ticket failures', () => {
  it('does not retry 401/403 ticket failures', async () => {
    const harness = createHarness({
      createTicket: () => Promise.reject(ApiError.client('UNAUTHENTICATED', 'expired', 401)),
    });
    harness.client.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.statuses.at(-1)).toBe('offline');
    expect(harness.failures.at(-1)).toMatchObject({ kind: 'auth', status: 401 });

    const forbidden = createHarness({
      createTicket: () => Promise.reject(ApiError.client('FORBIDDEN', 'no access', 403)),
    });
    forbidden.client.start();
    await flush();
    expect(forbidden.statuses.at(-1)).toBe('offline');
    expect(forbidden.failures.at(-1)).toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('retries transient ticket failures with backoff', async () => {
    let attempts = 0;
    const harness = createHarness({
      createTicket: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(ApiError.network(new Error('offline')));
        return Promise.resolve({
          ticket: `t${attempts}`,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
          ws_url: 'ws://realtime.test/ws',
        });
      },
    });
    harness.client.start();
    await flush();
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(1);
  });
});
