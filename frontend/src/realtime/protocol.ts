/**
 * Krug WebSocket protocol v1 (E3 slice).
 *
 * Source of truth: contracts/ws-protocol.md. The parser accepts only frames
 * described there. Two documented shapes are tolerated because the contract
 * uses both top-level fields and a generic `payload` object:
 *  - `typing`/`presence` as `type` (SYSTEM-ANALYSIS §7.5 frame examples) and as
 *    `event` names (ws-protocol §3 "События");
 *  - `resume.gap` fields at the top level (frame example) or inside `payload`
 *    (payload table). No extra fields are invented.
 */

import type { CallIceCandidate, CallSignalKind, CallSignalPayload } from '../calls/types';

export const WS_PROTOCOL_VERSION = 1;

export const CLOSE_CODES = {
  NORMAL: 1000,
  POLICY_VIOLATION: 1008,
  SLOW_CONSUMER: 1013,
  TICKET_INVALID: 4401,
  FORBIDDEN: 4403,
} as const;

export type RealtimeSubscription = { chat_id: string; last_seq: number };

export interface HelloFrame {
  type: 'hello';
  session_id: string;
  server_time: string;
  heartbeat_ms: number;
  protocol: string;
}

export interface SubscribedChat {
  chat_id: string;
  accepted: boolean;
  server_last_seq?: number;
  reason?: string;
}

export interface SubscribedFrame {
  type: 'subscribed';
  chats: SubscribedChat[];
}

export interface EventFrame {
  type: 'event';
  event_id: string;
  event: string;
  chat_id: string;
  seq?: number;
  ts?: string;
  payload: Record<string, unknown>;
}

export interface ResumeGapFrame {
  type: 'resume.gap';
  chat_id: string;
  from_seq: number;
  to_seq: number;
  reason: string;
}

export interface PongFrame {
  type: 'pong';
  server_time: string;
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  request_id?: string;
  chat_id?: string;
}

export interface SessionRevokedFrame {
  type: 'session.revoked';
  reason: string;
}

export interface TypingFrame {
  type: 'typing';
  chat_id: string;
  user_id: string;
  expires_at?: string;
}

export type PresenceStatus = 'ONLINE' | 'OFFLINE' | 'AWAY';

export interface PresenceFrame {
  type: 'presence';
  user_id: string;
  status: PresenceStatus;
  last_seen_at?: string;
}

/**
 * §9.2: relayed `call.signal`. The envelope carries `from_*`; the payload is
 * byte-identical to what the caller sent. No `seq`/`event_id` ever appears.
 */
export interface CallSignalFrame {
  type: 'call.signal';
  chat_id: string;
  from_user_id?: string;
  from_device_id?: string;
  ts?: string;
  payload: CallSignalPayload;
}

/** §9.3: only the calling session receives this when the peer is offline. */
export interface CallUnavailableFrame {
  type: 'call.unavailable';
  chat_id: string;
  /** #77: present when one GROUP mesh recipient has no live session. */
  from_user_id?: string;
  ts?: string;
  payload: {
    call_id: string;
    kind: CallSignalKind;
    reason: string;
  };
}

export type ServerFrame =
  | HelloFrame
  | SubscribedFrame
  | EventFrame
  | ResumeGapFrame
  | PongFrame
  | ErrorFrame
  | SessionRevokedFrame
  | TypingFrame
  | PresenceFrame
  | CallSignalFrame
  | CallUnavailableFrame;

export type ClientFrame =
  | { v: 1; type: 'subscribe'; chats: RealtimeSubscription[]; presence: true }
  | { v: 1; type: 'ack'; last_seq: number }
  | { v: 1; type: 'ping'; client_time: string }
  | { v: 1; type: 'typing'; chat_id: string }
  | { v: 1; type: 'call.signal'; chat_id: string; payload: CallSignalPayload };

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

export function subscribeFrame(subscriptions: readonly RealtimeSubscription[]): ClientFrame {
  return {
    v: WS_PROTOCOL_VERSION,
    type: 'subscribe',
    chats: subscriptions.map((item) => ({
      chat_id: item.chat_id,
      last_seq: item.last_seq,
    })),
    presence: true,
  };
}

/** Parse a UTF-8 text frame; returns null for malformed/unknown frames. */
export function parseServerFrame(raw: string): ServerFrame | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return parseServerFrameValue(parsed);
}

export function parseServerFrameValue(value: unknown): ServerFrame | null {
  if (!isRecord(value)) return null;
  if (value.v !== undefined && value.v !== WS_PROTOCOL_VERSION) return null;

  const type = readString(value.type);
  if (!type) return null;

  switch (type) {
    case 'hello':
      return parseHello(value);
    case 'subscribed':
      return parseSubscribed(value);
    case 'event':
      return parseEvent(value);
    case 'resume.gap':
      return parseGap(value);
    case 'pong':
      return {
        type: 'pong',
        server_time: readString(value.server_time) ?? readString(payload(value).server_time) ?? '',
      };
    case 'error':
      return parseError(value);
    case 'session.revoked':
      return {
        type: 'session.revoked',
        reason: readString(value.reason) ?? readString(payload(value).reason) ?? 'SESSION_REVOKED',
      };
    case 'typing':
      return parseTyping(value);
    case 'presence':
      return parsePresence(value);
    default:
      return null;
  }
}

function parseHello(value: Record<string, unknown>): HelloFrame | null {
  const source = merge(value, payload(value));
  const sessionId = readString(source.session_id);
  if (!sessionId) return null;
  return {
    type: 'hello',
    session_id: sessionId,
    server_time: readString(source.server_time) ?? '',
    heartbeat_ms: readPositiveInt(source.heartbeat_ms) ?? 25_000,
    protocol: readString(source.protocol) ?? 'krug.ws.v1',
  };
}

function parseSubscribed(value: Record<string, unknown>): SubscribedFrame | null {
  const source = merge(value, payload(value));
  const rawChats = source.chats;
  if (!Array.isArray(rawChats)) return null;
  const chats: SubscribedChat[] = [];
  for (const item of rawChats) {
    if (!isRecord(item)) continue;
    const chatId = readString(item.chat_id);
    if (!chatId) continue;
    chats.push({
      chat_id: chatId,
      accepted: item.accepted === true,
      ...(typeof item.server_last_seq === 'number'
        ? { server_last_seq: item.server_last_seq }
        : {}),
      ...(readString(item.reason) ? { reason: readString(item.reason) } : {}),
    });
  }
  return { type: 'subscribed', chats };
}

function parseEvent(
  value: Record<string, unknown>,
): EventFrame | TypingFrame | PresenceFrame | CallSignalFrame | CallUnavailableFrame | null {
  const event = readString(value.event);
  const chatId = readString(value.chat_id) ?? readString(payload(value).chat_id);
  if (!event || !chatId) return null;
  const body = payload(value);

  // ws-protocol §2: ephemeral events may have no event_id/seq. Backend E3-B
  // sends them as `type:"event"`, event:"typing"|"presence" with payload.
  if (event === 'typing') {
    return parseTyping({ ...body, chat_id: chatId });
  }
  if (event === 'presence') {
    return parsePresence({ ...body, chat_id: chatId });
  }
  // §9.2/§9.3: call frames are ephemeral and carry no event_id/seq.
  if (event === 'call.signal') {
    return parseCallSignal(value, chatId);
  }
  if (event === 'call.unavailable') {
    return parseCallUnavailable(value, chatId);
  }

  const eventId = readString(value.event_id);
  if (!eventId) return null;
  return {
    type: 'event',
    event_id: eventId,
    event,
    chat_id: chatId,
    ...(typeof value.seq === 'number' ? { seq: value.seq } : {}),
    ...(readString(value.ts) ? { ts: readString(value.ts) } : {}),
    payload: body,
  };
}

const CALL_KINDS: readonly CallSignalKind[] = ['offer', 'answer', 'ice', 'hangup', 'busy'];

function isCallKind(value: string | undefined): value is CallSignalKind {
  return value !== undefined && (CALL_KINDS as readonly string[]).includes(value);
}

function parseCallSignal(value: Record<string, unknown>, chatId: string): CallSignalFrame | null {
  const body = payload(value);
  const callId = readString(body.call_id);
  const kind = readString(body.kind);
  if (!callId || !isCallKind(kind) || typeof body.video !== 'boolean') return null;

  const sdp = body.sdp === undefined ? undefined : readString(body.sdp);
  if (body.sdp !== undefined && sdp === undefined) return null;
  const candidate = body.candidate === undefined ? undefined : parseIceCandidate(body.candidate);
  if (body.candidate !== undefined && candidate === undefined) return null;

  if (kind === 'offer' || kind === 'answer') {
    if (sdp === undefined || candidate !== undefined) return null;
  } else if (kind === 'ice') {
    if (candidate === undefined || sdp !== undefined) return null;
  } else if (sdp !== undefined || candidate !== undefined) {
    return null;
  }

  const recipients = readCallRecipients(body.recipients);
  return {
    type: 'call.signal',
    chat_id: chatId,
    ...(readString(value.from_user_id) ? { from_user_id: readString(value.from_user_id) } : {}),
    ...(readString(value.from_device_id)
      ? { from_device_id: readString(value.from_device_id) }
      : {}),
    ...(readString(value.ts) ? { ts: readString(value.ts) } : {}),
    payload: {
      call_id: callId,
      kind,
      video: body.video,
      ...(body.conference === true ? { conference: true } : {}),
      ...(recipients !== undefined ? { recipients } : {}),
      ...(sdp !== undefined ? { sdp } : {}),
      ...(candidate !== undefined ? { candidate } : {}),
    },
  };
}

/** #77: GROUP mesh routing list. Empty/invalid arrays are dropped, not fatal. */
function readCallRecipients(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const recipients = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return recipients.length > 0 ? recipients : undefined;
}

function parseIceCandidate(value: unknown): CallIceCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = readString(value.candidate);
  if (!candidate) return undefined;

  // Accept both the browser shape (`sdpMid`/`sdpMLineIndex`) and the contract
  // example's snake_case (`sdp_mid`/`sdp_mline_index`); the backend relays the
  // object unchanged, so a non-browser client may send either.
  const sdpMid = readString(value.sdpMid) ?? readString(value.sdp_mid);
  const sdpMLineIndex =
    readNonNegativeInt(value.sdpMLineIndex) ??
    readNonNegativeInt(value.sdp_mline_index) ??
    undefined;
  const usernameFragment =
    readString(value.usernameFragment) ?? readString(value.username_fragment);

  return {
    candidate,
    ...(sdpMid !== undefined ? { sdpMid } : {}),
    ...(sdpMLineIndex !== undefined ? { sdpMLineIndex } : {}),
    ...(usernameFragment !== undefined ? { usernameFragment } : {}),
  };
}

function parseCallUnavailable(
  value: Record<string, unknown>,
  chatId: string,
): CallUnavailableFrame | null {
  const body = payload(value);
  const callId = readString(body.call_id);
  const kind = readString(body.kind);
  const reason = readString(body.reason);
  if (!callId || !isCallKind(kind) || !reason) return null;
  return {
    type: 'call.unavailable',
    chat_id: chatId,
    ...(readString(value.from_user_id) ? { from_user_id: readString(value.from_user_id) } : {}),
    ...(readString(value.ts) ? { ts: readString(value.ts) } : {}),
    payload: { call_id: callId, kind, reason },
  };
}

function parseGap(value: Record<string, unknown>): ResumeGapFrame | null {
  const source = merge(value, payload(value));
  const chatId = readString(source.chat_id);
  const fromSeq = readNonNegativeInt(source.from_seq);
  const toSeq = readNonNegativeInt(source.to_seq);
  if (!chatId || fromSeq === null || toSeq === null) return null;
  return {
    type: 'resume.gap',
    chat_id: chatId,
    from_seq: fromSeq,
    to_seq: toSeq,
    reason: readString(source.reason) ?? 'REPLAY_WINDOW',
  };
}

function parseError(value: Record<string, unknown>): ErrorFrame | null {
  const source = merge(value, payload(value));
  const code = readString(source.code);
  if (!code) return null;
  return {
    type: 'error',
    code,
    message: readString(source.message) ?? code,
    ...(readString(source.request_id) ? { request_id: readString(source.request_id) } : {}),
    ...(readString(source.chat_id) ? { chat_id: readString(source.chat_id) } : {}),
  };
}

function parseTyping(value: Record<string, unknown>): TypingFrame | null {
  const source = merge(value, payload(value));
  const chatId = readString(source.chat_id);
  const userId = readString(source.user_id);
  if (!chatId || !userId) return null;
  return {
    type: 'typing',
    chat_id: chatId,
    user_id: userId,
    ...(readString(source.expires_at) ? { expires_at: readString(source.expires_at) } : {}),
  };
}

function parsePresence(value: Record<string, unknown>): PresenceFrame | null {
  const source = merge(value, payload(value));
  const userId = readString(source.user_id);
  const status = readString(source.status)?.toUpperCase();
  if (!userId || !status) return null;
  if (status !== 'ONLINE' && status !== 'OFFLINE' && status !== 'AWAY') return null;
  return {
    type: 'presence',
    user_id: userId,
    status,
    ...(readString(source.last_seen_at) ? { last_seen_at: readString(source.last_seen_at) } : {}),
  };
}

/** `event`-wrapped ephemeral frames are normalized to their frame types. */
export function normalizeEventFrame(frame: EventFrame): ServerFrame | TypingFrame | PresenceFrame {
  if (frame.event === 'typing') {
    const parsed = parseTyping({
      ...frame.payload,
      chat_id: frame.payload.chat_id ?? frame.chat_id,
    });
    if (parsed) return parsed;
  }
  if (frame.event === 'presence') {
    const parsed = parsePresence(frame.payload);
    if (parsed) return parsed;
  }
  return frame;
}

function payload(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value.payload) ? value.payload : {};
}

function merge(
  outer: Record<string, unknown>,
  inner: Record<string, unknown>,
): Record<string, unknown> {
  return { ...inner, ...outer };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/* ------------------------------------------------------------------ */
/* Close-code policy                                                    */
/* ------------------------------------------------------------------ */

export type CloseDisposition =
  | 'refresh-ticket' // 4401: ticket invalid/expired/used; get a fresh one
  | 'revoked' // 4403: session/device revoked; do not reconnect
  | 'fatal' // 1008: policy violation; reconnect would repeat the bad frame
  | 'reconnect'; // 1000/1013/network/unknown: backoff + resume

export function closeDisposition(code: number, reason = ''): CloseDisposition {
  if (code === CLOSE_CODES.FORBIDDEN) return 'revoked';
  if (code === CLOSE_CODES.TICKET_INVALID) return 'refresh-ticket';
  // E3-B uses 1008 for a server-side heartbeat timeout; that is transient,
  // unlike a malformed-frame policy violation.
  if (code === CLOSE_CODES.POLICY_VIOLATION && /HEARTBEAT_TIMEOUT/i.test(reason)) {
    return 'reconnect';
  }
  if (code === CLOSE_CODES.POLICY_VIOLATION) return 'fatal';
  return 'reconnect';
}

export function isProtocolFrame(value: ServerFrame | null): value is ServerFrame {
  return value !== null;
}
