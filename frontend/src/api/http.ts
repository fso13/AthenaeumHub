import { newUuid } from '../lib/ids';
import { ApiError, problemFromResponse } from './problem';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON body; ignored when `rawBody` is set. */
  body?: unknown;
  /** Binary contract bodies (upload parts); sent as-is, never JSON-encoded. */
  rawBody?: BodyInit | null;
  contentType?: string;
  /** Required by the contract for POST mutations. */
  idempotencyKey?: string;
  /** false for POST /dev/session (no token/device yet). */
  auth?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Caller cancellation (upload pause/cancel). */
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  getToken: () => string | null;
  getDeviceId: () => string | null;
}

export class ApiClient {
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.options = options;
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'GET', path, query });
  }

  post<T>(
    path: string,
    body?: unknown,
    options: {
      idempotencyKey?: string;
      auth?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>({
      method: 'POST',
      path,
      body,
      idempotencyKey: options.idempotencyKey,
      auth: options.auth,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  /**
   * Binary upload (PUT /uploads/{id}/parts/{n}). The SHA-256 header is part of
   * the contract and is validated by the server; bytes are never JSON-encoded.
   * `body` is optional for bodyless PUT mutations (favorite sticker).
   */
  put<T>(
    path: string,
    body?: BodyInit,
    options: {
      headers?: Record<string, string>;
      contentType?: string;
      timeoutMs?: number;
      auth?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>({
      method: 'PUT',
      path,
      rawBody: body,
      contentType: options.contentType ?? 'application/octet-stream',
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      auth: options.auth,
      signal: options.signal,
    });
  }

  /** JSON PUT mutation with an optional `Idempotency-Key` (E2EE verification). */
  putJson<T>(
    path: string,
    body: unknown,
    options: { idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>({
      method: 'PUT',
      path,
      body,
      idempotencyKey: options.idempotencyKey,
      auth: options.auth,
    });
  }

  /** JSON PATCH mutations (E6-F: notification preference). */
  patch<T>(
    path: string,
    body: unknown,
    options: { idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>({
      method: 'PATCH',
      path,
      body,
      idempotencyKey: options.idempotencyKey,
      auth: options.auth,
    });
  }

  /** Bodyless DELETE mutations (E5-F: remove a favorite). */
  delete<T>(path: string, options: { auth?: boolean } = {}): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, auth: options.auth });
  }

  async request<T>(options: RequestOptions): Promise<ApiResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': newUuid(),
      ...options.headers,
    });

    if (options.rawBody !== undefined) {
      headers.set('Content-Type', options.contentType ?? 'application/octet-stream');
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }

    if (options.auth !== false) {
      const token = this.options.getToken();
      const deviceId = this.options.getDeviceId();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (deviceId) headers.set('X-Device-Id', deviceId);
    }

    if (options.idempotencyKey) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }

    const fetchBody: BodyInit | undefined =
      options.rawBody !== undefined
        ? (options.rawBody ?? undefined)
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: fetchBody,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.signal?.aborted) throw ApiError.client('ABORTED', 'Upload was cancelled');
        throw ApiError.timeout();
      }
      throw ApiError.network(error);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw problemFromResponse(response.status, parsed, response.headers, response.statusText);
    }

    if (response.status === 204 || text.length === 0) {
      return { data: undefined as T, status: response.status, headers: response.headers };
    }

    if (parsed === undefined) {
      throw new ApiError({
        source: 'http',
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'Server returned a non-JSON response',
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }

    return { data: parsed as T, status: response.status, headers: response.headers };
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.options.baseUrl;
    const absoluteBase = /^https?:\/\//i.test(base)
      ? base
      : `${globalThis.location?.origin ?? 'http://localhost'}${base}`;
    const url = new URL(`${absoluteBase.replace(/\/+$/, '')}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
