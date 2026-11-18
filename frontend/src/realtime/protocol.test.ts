import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  closeDisposition,
  encodeClientFrame,
  parseServerFrame,
  subscribeFrame,
} from './protocol';

describe('ws protocol v1 parser', () => {
  it('parses hello, subscribed and event frames', () => {
    const hello = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'hello',
        session_id: 'ws_1',
        server_time: '2026-11-16T10:00:00Z',
        heartbeat_ms: 25000,
        protocol: 'krug.ws.v1',
      }),
    );
    expect(hello).toMatchObject({ type: 'hello', session_id: 'ws_1', heartbeat_ms: 25000 });

    expect(
      parseServerFrame(
        JSON.stringify({
          v: 1,
          type: 'subscribed',
          chats: [
            { chat_id: 'c1', accepted: true, server_last_seq: 42 },
            { chat_id: 'c2', accepted: false, reason: 'FORBIDDEN' },
          ],
        }),
      ),
    ).toEqual({
      type: 'subscribed',
      chats: [
        { chat_id: 'c1', accepted: true, server_last_seq: 42 },
        { chat_id: 'c2', accepted: false, reason: 'FORBIDDEN' },
      ],
    });

    expect(
      parseServerFrame(
        JSON.stringify({
          v: 1,
          type: 'event',
          event_id: 'e1',
          event: 'message.created',
          chat_id: 'c1',
          seq: 43,
          ts: '2026-11-16T10:00:01Z',
          payload: { message: { id: 'm1' } },
        }),
      ),
    ).toMatchObject({
      type: 'event',
      event: 'message.created',
      chat_id: 'c1',
      seq: 43,
      payload: { message: { id: 'm1' } },
    });
  });

  it('accepts resume.gap in the top-level and payload shapes', () => {
    const topLevel = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'resume.gap',
        chat_id: 'c1',
        from_seq: 10,
        to_seq: 20,
        reason: 'REPLAY_WINDOW',
      }),
    );
    expect(topLevel).toEqual({
      type: 'resume.gap',
      chat_id: 'c1',
      from_seq: 10,
      to_seq: 20,
      reason: 'REPLAY_WINDOW',
    });

    const inPayload = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'resume.gap',
        payload: { chat_id: 'c1', from_seq: 5, to_seq: 9, reason: 'LAG' },
      }),
    );
    expect(inPayload).toMatchObject({ chat_id: 'c1', from_seq: 5, to_seq: 9, reason: 'LAG' });
  });

  it('parses pong, error and session.revoked', () => {
    expect(parseServerFrame(JSON.stringify({ v: 1, type: 'pong', server_time: 'now' }))).toEqual({
      type: 'pong',
      server_time: 'now',
    });

    expect(
      parseServerFrame(
        JSON.stringify({
          v: 1,
          type: 'error',
          code: 'FORBIDDEN',
          message: 'no access',
          request_id: 'r1',
          chat_id: 'c1',
        }),
      ),
    ).toEqual({
      type: 'error',
      code: 'FORBIDDEN',
      message: 'no access',
      request_id: 'r1',
      chat_id: 'c1',
    });

    expect(
      parseServerFrame(JSON.stringify({ v: 1, type: 'session.revoked', reason: 'DEVICE_REVOKED' })),
    ).toEqual({ type: 'session.revoked', reason: 'DEVICE_REVOKED' });
  });

  it('normalizes typing/presence sent as top-level frames or as events', () => {
    const directTyping = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'typing',
        chat_id: 'c1',
        user_id: 'u2',
        expires_at: '2026-11-16T10:00:05Z',
      }),
    );
    expect(directTyping).toMatchObject({ type: 'typing', chat_id: 'c1', user_id: 'u2' });

    const eventTyping = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'event',
        event: 'typing',
        chat_id: 'c1',
        ts: '2026-11-16T10:00:00Z',
        payload: { user_id: 'u2', expires_at: '2026-11-16T10:00:05Z' },
      }),
    );
    expect(eventTyping).toMatchObject({
      type: 'typing',
      chat_id: 'c1',
      user_id: 'u2',
      expires_at: '2026-11-16T10:00:05Z',
    });

    const directPresence = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'presence',
        user_id: 'u2',
        status: 'ONLINE',
        last_seen_at: '2026-11-16T10:00:00Z',
      }),
    );
    expect(directPresence).toMatchObject({ type: 'presence', user_id: 'u2', status: 'ONLINE' });

    const eventPresence = parseServerFrame(
      JSON.stringify({
        v: 1,
        type: 'event',
        event: 'presence',
        chat_id: 'c1',
        ts: '2026-11-16T10:00:00Z',
        payload: { user_id: 'u2', status: 'AWAY', last_seen_at: '2026-11-16T10:00:00Z' },
      }),
    );
    expect(eventPresence).toMatchObject({
      type: 'presence',
      user_id: 'u2',
      status: 'AWAY',
    });
  });

  it('rejects malformed, unknown and wrong-version frames', () => {
    expect(parseServerFrame('not-json')).toBeNull();
    expect(parseServerFrame('')).toBeNull();
    expect(parseServerFrame(JSON.stringify({ v: 2, type: 'hello' }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ v: 1, type: 'key.skdm' }))).toBeNull();
    expect(
      parseServerFrame(JSON.stringify({ v: 1, type: 'event', event: 'message.created' })),
    ).toBeNull();
    expect(
      parseServerFrame(JSON.stringify({ v: 1, type: 'presence', user_id: 'u2', status: 'BUSY' })),
    ).toBeNull();
  });

  it('encodes client frames exactly as documented', () => {
    expect(
      JSON.parse(
        encodeClientFrame(
          subscribeFrame([
            { chat_id: 'c1', last_seq: 41 },
            { chat_id: 'c2', last_seq: 0 },
          ]),
        ),
      ),
    ).toEqual({
      v: 1,
      type: 'subscribe',
      chats: [
        { chat_id: 'c1', last_seq: 41 },
        { chat_id: 'c2', last_seq: 0 },
      ],
      presence: true,
    });
    expect(JSON.parse(encodeClientFrame({ v: 1, type: 'ack', last_seq: 42 }))).toEqual({
      v: 1,
      type: 'ack',
      last_seq: 42,
    });
    expect(
      JSON.parse(encodeClientFrame({ v: 1, type: 'ping', client_time: '2026-11-16T10:00:00Z' })),
    ).toEqual({ v: 1, type: 'ping', client_time: '2026-11-16T10:00:00Z' });
    expect(JSON.parse(encodeClientFrame({ v: 1, type: 'typing', chat_id: 'c1' }))).toEqual({
      v: 1,
      type: 'typing',
      chat_id: 'c1',
    });
  });
});

describe('ws close-code policy', () => {
  it('classifies all documented close codes', () => {
    expect(closeDisposition(CLOSE_CODES.TICKET_INVALID)).toBe('refresh-ticket');
    expect(closeDisposition(CLOSE_CODES.FORBIDDEN)).toBe('revoked');
    expect(closeDisposition(CLOSE_CODES.POLICY_VIOLATION)).toBe('fatal');
    expect(closeDisposition(CLOSE_CODES.POLICY_VIOLATION, 'HEARTBEAT_TIMEOUT')).toBe('reconnect');
    expect(closeDisposition(CLOSE_CODES.SLOW_CONSUMER)).toBe('reconnect');
    expect(closeDisposition(CLOSE_CODES.NORMAL)).toBe('reconnect');
    expect(closeDisposition(1006)).toBe('reconnect');
  });
});
