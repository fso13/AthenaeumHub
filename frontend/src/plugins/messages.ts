/**
 * D1.2 (#86): minimal host side of the iframe postMessage contract from
 * `docs/PLUGIN-DEVELOPMENT.md` §6.
 *
 * Only `ready`, `rpc` and `log` messages are accepted from a plugin. There is no
 * server RPC broker in this slice, so every `rpc` is answered with a stable
 * `METHOD_NOT_FOUND` error instead of inventing data or a capability grant.
 */
export const PLUGIN_PROTOCOL_VERSION = 1;
export const PLUGIN_MESSAGE_MAX_BYTES = 64 * 1024;
export const PLUGIN_MESSAGE_MAX_DEPTH = 8;
export const PLUGIN_RPC_ID_MAX_LENGTH = 64;
export const PLUGIN_LOG_MESSAGE_MAX_LENGTH = 2_000;

export type PluginLogLevel = 'debug' | 'info' | 'warn';

export type PluginIncomingMessage =
  | { type: 'ready' }
  | { type: 'rpc'; id: string; method: string; params?: unknown }
  | { type: 'log'; level: PluginLogLevel; message: string };

export interface PluginInitMessage {
  v: typeof PLUGIN_PROTOCOL_VERSION;
  type: 'init';
  plugin_id: string;
  version: string;
  chat_id?: string;
  permissions: string[];
  locale: string;
  theme: 'light' | 'dark';
}

export interface PluginRpcError {
  code: 'METHOD_NOT_FOUND' | 'INVALID_PARAMS' | 'FORBIDDEN' | 'RATE_LIMITED' | 'TIMEOUT';
  message: string;
}

export interface PluginRpcResultMessage {
  v: typeof PLUGIN_PROTOCOL_VERSION;
  type: 'rpc_result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: PluginRpcError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exceedsDepth(value: unknown, depth: number): boolean {
  if (depth > PLUGIN_MESSAGE_MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => exceedsDepth(item, depth + 1));
  if (isRecord(value)) return Object.values(value).some((item) => exceedsDepth(item, depth + 1));
  return false;
}

function jsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Validate an untrusted `MessageEvent.data` value. Returns `null` for anything
 * outside the documented envelope (wrong version/type, oversize, too deep,
 * malformed ids/methods). Payload text is never inserted into the host DOM.
 */
export function parsePluginMessage(data: unknown): PluginIncomingMessage | null {
  if (!isRecord(data)) return null;
  if (data.v !== PLUGIN_PROTOCOL_VERSION) return null;
  if (exceedsDepth(data, 0)) return null;
  if (jsonSize(data) > PLUGIN_MESSAGE_MAX_BYTES) return null;

  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'rpc': {
      const id = data.id;
      const method = data.method;
      if (typeof id !== 'string' || id.length === 0 || id.length > PLUGIN_RPC_ID_MAX_LENGTH) {
        return null;
      }
      if (typeof method !== 'string' || method.length === 0 || method.length > 128) return null;
      return {
        type: 'rpc',
        id,
        method,
        ...(data.params === undefined ? {} : { params: data.params }),
      };
    }
    case 'log': {
      const level = data.level;
      const message = data.message;
      if (level !== 'debug' && level !== 'info' && level !== 'warn') return null;
      if (typeof message !== 'string' || message.length > PLUGIN_LOG_MESSAGE_MAX_LENGTH)
        return null;
      return { type: 'log', level, message };
    }
    default:
      return null;
  }
}

export function buildPluginInitMessage(input: {
  pluginId: string;
  version: string;
  permissions: readonly string[];
  locale: string;
  theme: 'light' | 'dark';
  chatId?: string | null;
}): PluginInitMessage {
  return {
    v: PLUGIN_PROTOCOL_VERSION,
    type: 'init',
    plugin_id: input.pluginId,
    version: input.version,
    ...(input.chatId ? { chat_id: input.chatId } : {}),
    permissions: [...input.permissions],
    locale: input.locale,
    theme: input.theme,
  };
}

/** This slice has no RPC broker: the only honest answer is a stable error. */
export function buildPluginRpcErrorResult(
  id: string,
  error: PluginRpcError = {
    code: 'METHOD_NOT_FOUND',
    message: 'Plugin RPC is not available in this build',
  },
): PluginRpcResultMessage {
  return {
    v: PLUGIN_PROTOCOL_VERSION,
    type: 'rpc_result',
    id,
    ok: false,
    error,
  };
}
