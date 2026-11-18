import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, resolveRealtimeUrl, withTicket } from './socket';

const local = { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' };
const remote = { protocol: 'https:', host: 'app.krug.example', hostname: 'app.krug.example' };

describe('realtime URL resolution', () => {
  it('maps a loopback ticket ws_url to the same-origin Vite proxy', () => {
    expect(resolveRealtimeUrl('ws://localhost:8081/ws', '', local)).toBe('ws://localhost:5173/ws');
    expect(resolveRealtimeUrl('ws://127.0.0.1:8081/ws', '', local)).toBe('ws://localhost:5173/ws');
  });

  it('uses a remote ticket ws_url as advertised', () => {
    expect(resolveRealtimeUrl('wss://rt.krug.example/ws', '', remote)).toBe(
      'wss://rt.krug.example/ws',
    );
  });

  it('prefers VITE_WS_URL and supports relative/absolute values', () => {
    expect(resolveRealtimeUrl('ws://localhost:8081/ws', '/ws', local)).toBe(
      'ws://localhost:5173/ws',
    );
    expect(resolveRealtimeUrl('ws://localhost:8081/ws', 'wss://edge.example/rt', local)).toBe(
      'wss://edge.example/rt',
    );
    expect(resolveRealtimeUrl('ws://localhost:8081/ws', 'https://edge.example/rt', local)).toBe(
      'wss://edge.example/rt',
    );
  });

  it('upgrades ws to wss on an https page', () => {
    expect(resolveRealtimeUrl('ws://rt.krug.example/ws', '', remote)).toBe(
      'wss://rt.krug.example/ws',
    );
  });

  it('appends the one-time ticket without exposing an access token', () => {
    const url = withTicket('wss://rt.krug.example/ws', 'jwt-ticket');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('ticket')).toBe('jwt-ticket');
    expect(parsed.searchParams.get('access_token')).toBeNull();
  });

  it('recognizes loopback hostnames', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('rt.krug.example')).toBe(false);
  });
});
