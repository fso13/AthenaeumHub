import type { RealtimeTicket } from '../api/types';
import { isApiError, toApiError, type ApiError } from '../api/problem';
import type { CallSignalPayload } from '../calls/types';
import {
  backoffDelay,
  ReconnectBudget,
  type ReconnectBudget as ReconnectBudgetType,
} from './backoff';
import {
  closeDisposition,
  encodeClientFrame,
  normalizeEventFrame,
  parseServerFrame,
  subscribeFrame,
  type CallSignalFrame,
  type CallUnavailableFrame,
  type ErrorFrame,
  type EventFrame,
  type HelloFrame,
  type PresenceFrame,
  type PongFrame,
  type RealtimeSubscription,
  type ResumeGapFrame,
  type ServerFrame,
  type SessionRevokedFrame,
  type SubscribedFrame,
  type TypingFrame,
} from './protocol';
import {
  browserSocketFactory,
  resolveRealtimeUrl,
  withTicket,
  type RealtimeSocket,
  type SocketFactory,
} from './socket';

export type RealtimeStatus =
  'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'revoked';

export type RealtimeFailureKind =
  'auth' | 'forbidden' | 'network' | 'protocol' | 'rate_limited' | 'budget' | 'revoked';

export interface RealtimeFailure {
  kind: RealtimeFailureKind;
  message: string;
  code?: string;
  status?: number;
}

export interface RealtimeCallbacks {
  onStatus(status: RealtimeStatus): void;
  onHello?(frame: HelloFrame): void;
  onSubscribed?(frame: SubscribedFrame): void;
  onEvent(frame: EventFrame): void;
  onGap(frame: ResumeGapFrame): void;
  onTyping?(frame: TypingFrame): void;
  onPresence?(frame: PresenceFrame): void;
  /** §9.2: a relayed offer/answer/ICE/hangup/busy from the DIRECT peer. */
  onCallSignal?(frame: CallSignalFrame): void;
  /** §9.3: the peer has no live session; the caller ends the attempt. */
  onCallUnavailable?(frame: CallUnavailableFrame): void;
  onServerError?(frame: ErrorFrame): void;
  onFailure?(failure: RealtimeFailure): void;
  onRevoked(reason: string): void;
  /** Called before every reconnect ticket: GET /sync, update last_seq. */
  onBeforeReconnect?(): Promise<void> | void;
}

export interface RealtimeClientOptions {
  createTicket(): Promise<RealtimeTicket>;
  getSubscriptions(): RealtimeSubscription[];
  callbacks: RealtimeCallbacks;
  enabled?: boolean;
  socketFactory?: SocketFactory;
  /** Defaults to VITE_WS_URL/ticket resolution in socket.ts. */
  resolveUrl?: (ticketWsUrl: string) => string;
  now?: () => number;
  random?: () => number;
  backoff?: (attempt: number, random: () => number) => number;
  maxReconnectPerHour?: number;
  defaultHeartbeatMs?: number;
  timeoutMs?: number;
  helloTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HELLO_TIMEOUT_MS = 15_000;

/**
 * Protocol client. It owns transport/backoff only; chat state, dedupe and
 * REST catch-up live in ChatStore. This keeps reconnect behaviour testable
 * against a fake WebSocket without UI or storage dependencies.
 */
export class RealtimeClient {
  private readonly options: RealtimeClientOptions;
  private readonly socketFactory: SocketFactory;
  private readonly resolveUrl: (ticketWsUrl: string) => string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly backoff: (attempt: number, random: () => number) => number;
  private readonly budget: ReconnectBudgetType;

  private running = false;
  private enabled: boolean;
  private socket: RealtimeSocket | null = null;
  private status: RealtimeStatus = 'idle';
  private attempt = 0;
  private hasConnected = false;
  private lastReceivedAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeClientOptions) {
    this.options = options;
    this.enabled = options.enabled ?? true;
    this.socketFactory = options.socketFactory ?? browserSocketFactory;
    this.resolveUrl = options.resolveUrl ?? ((ticketWsUrl) => resolveRealtimeUrl(ticketWsUrl, ''));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.backoff = options.backoff ?? backoffDelay;
    this.budget = new ReconnectBudget({
      max: options.maxReconnectPerHour,
      now: this.now,
    });
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.attempt = 0;
    this.budget.reset();
    this.setStatus('connecting');
    void this.connect();
  }

  /** Network went offline: close cleanly, keep subscriptions for resume. */
  suspend(): void {
    if (!this.running) {
      if (this.status !== 'idle') this.setStatus('offline');
      return;
    }
    this.running = false;
    this.teardownSocket(1000, 'offline');
    this.clearTimers();
    this.setStatus('offline');
  }

  /** Network came back: new ticket, then subscribe with fresh last_seq. */
  resume(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.attempt = 0;
    // Network came back: budget/backoff, then GET /sync → ticket → subscribe.
    this.scheduleReconnect({
      kind: 'network',
      message: 'Reconnecting after network change',
      code: 'NETWORK_RESUME',
    });
  }

  stop(): void {
    this.running = false;
    this.attempt = 0;
    this.teardownSocket(1000, 'client stop');
    this.clearTimers();
    this.setStatus('idle');
  }

  /** Ask for a fresh ticket immediately (e.g. banner "Reconnect"). */
  reconnectNow(): void {
    if (!this.enabled) return;
    if (!this.running) {
      this.resume();
      return;
    }
    this.clearReconnectTimer();
    this.teardownSocket(1000, 'manual reconnect');
    this.clearTimers();
    // Manual attempts share the same 60/hour budget as automatic ones.
    this.scheduleReconnect({
      kind: 'network',
      message: 'Manual reconnect requested',
      code: 'MANUAL_RECONNECT',
    });
  }

  updateSubscriptions(): void {
    if (this.status !== 'online' || !this.socket) return;
    this.send(subscribeFrame(this.options.getSubscriptions()));
  }

  sendTyping(chatId: string): void {
    if (this.status !== 'online') return;
    this.send({ v: 1, type: 'typing', chat_id: chatId });
  }

  sendAck(lastSeq: number): void {
    if (this.status !== 'online' || lastSeq <= 0) return;
    this.send({ v: 1, type: 'ack', last_seq: lastSeq });
  }

  /**
   * Relay one call signal over the existing socket (§9.1). Returns false when
   * the socket is not online so the call engine can fail the attempt honestly.
   * `sdp`/`candidate` are never logged or persisted here.
   */
  sendCallSignal(chatId: string, payload: CallSignalPayload): boolean {
    if (this.status !== 'online' || chatId.length === 0) return false;
    this.send({ v: 1, type: 'call.signal', chat_id: chatId, payload });
    return true;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.clearTimers();
    this.setStatus(this.hasConnected ? 'reconnecting' : 'connecting');
    this.lastReceivedAt = null;

    let ticket: RealtimeTicket;
    try {
      ticket = await this.options.createTicket();
    } catch (error) {
      this.handleTicketFailure(error);
      return;
    }
    if (!this.running) return;

    let url: string;
    try {
      url = withTicket(this.resolveUrl(ticket.ws_url), ticket.ticket);
    } catch {
      this.scheduleReconnect({
        kind: 'protocol',
        message: 'WebSocket URL from the ticket is invalid',
        code: 'INVALID_WS_URL',
      });
      return;
    }

    let socket: RealtimeSocket;
    try {
      socket = this.socketFactory(url);
    } catch {
      this.scheduleReconnect({
        kind: 'network',
        message: 'Could not open the WebSocket',
        code: 'WS_CONNECT_FAILED',
      });
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastReceivedAt = this.now();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleRawFrame(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.handleClose(event.code, event.reason);
    };
    socket.onerror = () => {
      // The browser follows with a close event; reconnect is scheduled there.
    };

    this.helloTimer = setTimeout(() => {
      if (this.status === 'online') return;
      this.scheduleReconnect({
        kind: 'protocol',
        message: 'WebSocket hello timeout',
        code: 'HELLO_TIMEOUT',
      });
      this.teardownSocket(4000, 'hello timeout');
    }, this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
  }

  private handleRawFrame(data: unknown): void {
    if (typeof data !== 'string' || data.length === 0) {
      this.options.callbacks.onFailure?.({
        kind: 'protocol',
        message: 'WebSocket returned a non-text frame',
        code: 'INVALID_FRAME',
      });
      return;
    }

    const frame = parseServerFrame(data);
    if (!frame) {
      this.options.callbacks.onFailure?.({
        kind: 'protocol',
        message: 'WebSocket frame does not match protocol v1',
        code: 'INVALID_FRAME',
      });
      return;
    }

    this.lastReceivedAt = this.now();

    if (frame.type === 'hello') {
      this.handleHello(frame);
      return;
    }
    if (frame.type === 'session.revoked') {
      this.handleRevoked(frame);
      return;
    }
    if (frame.type === 'error' && this.status !== 'online') {
      this.options.callbacks.onServerError?.(frame);
      return;
    }
    if (this.status !== 'online') return;

    switch (frame.type) {
      case 'subscribed':
        this.options.callbacks.onSubscribed?.(frame);
        break;
      case 'event': {
        const normalized = normalizeEventFrame(frame);
        if (normalized.type === 'typing') {
          this.options.callbacks.onTyping?.(normalized);
        } else if (normalized.type === 'presence') {
          this.options.callbacks.onPresence?.(normalized);
        } else {
          this.options.callbacks.onEvent(normalized as EventFrame);
        }
        break;
      }
      // §9 call frames are parsed out of the `event` envelope but carry their
      // own frame type, so they are dispatched here rather than to ChatStore.
      case 'call.signal':
        this.options.callbacks.onCallSignal?.(frame);
        break;
      case 'call.unavailable':
        this.options.callbacks.onCallUnavailable?.(frame);
        break;
      case 'resume.gap':
        this.options.callbacks.onGap(frame);
        break;
      case 'pong':
        this.handlePong(frame);
        break;
      case 'error':
        this.options.callbacks.onServerError?.(frame);
        break;
      case 'typing':
        this.options.callbacks.onTyping?.(frame);
        break;
      case 'presence':
        this.options.callbacks.onPresence?.(frame);
        break;
      default:
        break;
    }
  }

  private handleHello(frame: HelloFrame): void {
    if (this.status === 'online') return;
    this.clearHelloTimer();
    this.hasConnected = true;
    this.attempt = 0;
    this.setStatus('online');
    this.options.callbacks.onHello?.(frame);
    this.updateSubscriptions();
    this.startHeartbeat(frame.heartbeat_ms);
  }

  private handlePong(_frame: PongFrame): void {
    // lastReceivedAt is updated for every frame; pong is just a liveness edge.
    this.lastReceivedAt = this.now();
  }

  private handleRevoked(frame: SessionRevokedFrame): void {
    this.running = false;
    this.teardownSocket(1000, 'revoked');
    this.clearTimers();
    this.setStatus('revoked');
    this.options.callbacks.onRevoked(frame.reason);
  }

  private startHeartbeat(serverIntervalMs: number): void {
    this.clearHeartbeat();
    const interval = Math.max(
      1_000,
      Math.min(
        serverIntervalMs > 0 ? serverIntervalMs : DEFAULT_HEARTBEAT_MS,
        this.options.defaultHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ),
    );
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.heartbeatTimer = setInterval(() => {
      if (!this.running || this.status !== 'online') return;
      const now = this.now();
      if (this.lastReceivedAt !== null && now - this.lastReceivedAt > timeout) {
        this.teardownSocket(4000, 'heartbeat timeout');
        this.scheduleReconnect({
          kind: 'network',
          message: 'WebSocket heartbeat timed out',
          code: 'HEARTBEAT_TIMEOUT',
        });
        return;
      }
      this.send({ v: 1, type: 'ping', client_time: new Date(now).toISOString() });
    }, interval);
  }

  private handleTicketFailure(error: unknown): void {
    const apiError: ApiError = isApiError(error) ? error : toApiError(error);
    const failure = failureFromTicketError(apiError);
    this.options.callbacks.onFailure?.(failure);

    if (apiError.status === 403) {
      // Authorization is not transient; retrying would hammer the server.
      this.running = false;
      this.setStatus('offline');
      return;
    }
    if (apiError.status === 401) {
      // `withReauth` already retried once. Do not loop on a dead session; the
      // store shows a clear session/auth banner.
      this.running = false;
      this.setStatus('offline');
      return;
    }
    this.scheduleReconnect(failure);
  }

  private handleClose(code: number, reason: string): void {
    if (!this.running) return;
    const disposition = closeDisposition(code, reason);

    if (disposition === 'revoked') {
      this.running = false;
      this.setStatus('revoked');
      this.options.callbacks.onRevoked(reason || 'SESSION_REVOKED');
      return;
    }
    if (disposition === 'fatal') {
      this.running = false;
      this.setStatus('offline');
      this.options.callbacks.onFailure?.({
        kind: 'protocol',
        message: 'WebSocket closed by policy (1008)',
        code: 'POLICY_VIOLATION',
      });
      return;
    }

    this.scheduleReconnect(
      disposition === 'refresh-ticket'
        ? {
            kind: 'network',
            message: 'WebSocket ticket was rejected; requesting a new one',
            code: 'TICKET_INVALID',
          }
        : {
            kind: 'network',
            message: reason || `WebSocket closed (${code})`,
            code: `WS_CLOSE_${code}`,
          },
    );
  }

  private scheduleReconnect(failure: RealtimeFailure): void {
    if (!this.running) return;
    this.clearHeartbeat();
    this.setStatus('reconnecting');
    this.options.callbacks.onFailure?.(failure);

    let delay: number;
    if (this.budget.tryConsume()) {
      delay = this.backoff(this.attempt, this.random);
      this.attempt += 1;
    } else {
      delay = Math.max(0, this.budget.nextAvailableAt() - this.now());
      this.options.callbacks.onFailure?.({
        kind: 'budget',
        message: 'Reconnect limit reached (60/hour)',
        code: 'RECONNECT_BUDGET_EXCEEDED',
      });
    }

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(true);
    }, delay);
  }

  private async reconnect(runSync: boolean): Promise<void> {
    if (!this.running) return;
    if (runSync) {
      try {
        await this.options.callbacks.onBeforeReconnect?.();
      } catch {
        // A failed /sync must not block reconnect: subscribe still uses the
        // last known last_seq and resume.gap will trigger REST catch-up.
      }
    }
    if (!this.running) return;
    await this.connect();
  }

  private send(frame: Parameters<typeof encodeClientFrame>[0]): void {
    if (!this.socket) return;
    try {
      this.socket.send(encodeClientFrame(frame));
    } catch {
      this.teardownSocket(4000, 'send failed');
      this.scheduleReconnect({
        kind: 'network',
        message: 'Could not send a WebSocket frame',
        code: 'WS_SEND_FAILED',
      });
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.callbacks.onStatus(status);
  }

  private teardownSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearHelloTimer();
    this.clearReconnectTimer();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function failureFromTicketError(error: ApiError): RealtimeFailure {
  if (error.status === 401) {
    return {
      kind: 'auth',
      message: 'Realtime ticket rejected: session expired',
      code: error.code,
      status: 401,
    };
  }
  if (error.status === 403) {
    return {
      kind: 'forbidden',
      message: 'Realtime ticket rejected: no access',
      code: error.code,
      status: 403,
    };
  }
  if (error.status === 429) {
    return {
      kind: 'rate_limited',
      message: 'Realtime ticket rate limited',
      code: error.code,
      status: 429,
    };
  }
  return {
    kind: 'network',
    message: error.message || 'Could not obtain a realtime ticket',
    code: error.code,
    status: error.status,
  };
}

export type { ServerFrame };
