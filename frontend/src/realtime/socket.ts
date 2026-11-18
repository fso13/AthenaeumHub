/**
 * Minimal WebSocket adapter so the realtime client is testable with a fake
 * socket and can also be backed by an in-process mock server in MSW mode.
 */

export interface SocketCloseEvent {
  code: number;
  reason: string;
  wasClean?: boolean;
}

export interface SocketMessageEvent {
  data: unknown;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RealtimeSocket;

/** Browser implementation; throws synchronously on malformed URLs. */
export const browserSocketFactory: SocketFactory = (url) => {
  const socket = new WebSocket(url);
  const adapter: RealtimeSocket = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => adapter.onopen?.();
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onclose = (event) => {
    adapter.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
  };
  socket.onerror = (event) => adapter.onerror?.(event);
  return adapter;
};

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function isWsAbsolute(value: string): boolean {
  return /^wss?:\/\//i.test(value);
}

function wsOrigin(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

export interface LocationLike {
  protocol: string;
  host: string;
  hostname: string;
}

/**
 * Resolve the endpoint from (in order): VITE_WS_URL, the ticket `ws_url`.
 *
 * The contract says to connect to `ticket.ws_url`. In local dev the backend
 * advertises `ws://localhost:8081/ws` while the page is on 5173; connecting to
 * the same-origin `/ws` Vite proxy avoids a second origin and keeps CSP/CORS
 * behaviour aligned with `/api`. Remote/hosted `ws_url` values are used as-is.
 */
export function resolveRealtimeUrl(
  ticketWsUrl: string,
  configuredWsUrl = '',
  location: LocationLike | null = typeof window === 'undefined' ? null : window.location,
): string {
  const configured = configuredWsUrl.trim();
  if (configured) {
    if (isWsAbsolute(configured)) return configured;
    if (/^https?:\/\//i.test(configured)) {
      return new URL(configured).toString().replace(/^http/i, 'ws');
    }
    if (location) {
      const origin = wsOrigin(location);
      return new URL(configured.startsWith('/') ? configured : `/${configured}`, origin).toString();
    }
    return configured;
  }

  const ticket = ticketWsUrl.trim();
  if (!isWsAbsolute(ticket)) {
    if (location) {
      const origin = wsOrigin(location);
      return new URL(ticket.startsWith('/') ? ticket : `/${ticket}`, origin).toString();
    }
    return ticket;
  }

  const parsed = new URL(ticket);
  if (!location) return parsed.toString();

  const pageProtocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const ticketProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const sameOrigin = ticketProtocol === pageProtocol && parsed.host === location.host;
  if (sameOrigin) return parsed.toString();

  // Mixed content: an https page cannot open ws://. Keep the same host/path
  // and let the reverse proxy terminate TLS.
  if (location.protocol === 'https:' && parsed.protocol === 'ws:') {
    parsed.protocol = 'wss:';
    return parsed.toString();
  }

  if (isLoopbackHostname(parsed.hostname) && isLoopbackHostname(location.hostname)) {
    return new URL(parsed.pathname + parsed.search, wsOrigin(location)).toString();
  }

  return parsed.toString();
}

/** Append the one-time ticket as a query parameter (never an access token). */
export function withTicket(url: string, ticket: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('ticket', ticket);
  return parsed.toString();
}
