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

export interface FormDataRequestOptions {
  /** Overrides the client timeout for large uploads. */
  timeoutMs?: number;
  /** Caller cancellation (dialog close / retry). */
  signal?: AbortSignal;
  /**
   * Upload progress from `XMLHttpRequest.upload`. `total` is 0 when the
   * browser cannot compute the multipart length; consumers must treat that as
   * indeterminate instead of dividing by zero.
   */
  onProgress?: (loaded: number, total: number) => void;
  auth?: boolean;
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

  /**
   * P0-3 (#81): binary/text download (`GET .../audit/export`). The regular
   * `get` always parses JSON; an export is CSV or JSON and must stay a `Blob`
   * so the browser downloads exactly the bytes the server produced. Error
   * responses still use the contract JSON envelope and become `ApiError`.
   */
  async getBlob(
    path: string,
    query?: RequestOptions['query'],
  ): Promise<{ blob: Blob; status: number; headers: Headers }> {
    const url = this.buildUrl(path, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    const headers = new Headers({
      Accept: 'text/csv, application/json',
      'X-Request-Id': newUuid(),
    });
    const token = this.options.getToken();
    const deviceId = this.options.getDeviceId();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (deviceId) headers.set('X-Device-Id', deviceId);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (error) {
      if (controller.signal.aborted) throw ApiError.timeout();
      throw ApiError.network(error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      throw problemFromResponse(
        response.status,
        parseJson(text),
        response.headers,
        response.statusText,
      );
    }

    const raw = await response.blob();
    // `fetch` may return a Blob from another realm (Node/undici in tests, a
    // service worker in the browser). Re-wrap the bytes in the current realm so
    // FileReader/ObjectURL consumers always receive a native Blob.
    let blob = raw;
    if (typeof raw.arrayBuffer === 'function') {
      try {
        blob = new Blob([await raw.arrayBuffer()], { type: raw.type });
      } catch {
        // Keep the original bytes if the realm cannot re-wrap them.
      }
    }

    return {
      blob,
      status: response.status,
      headers: response.headers,
    };
  }

  post<T>(
    path: string,
    body?: unknown,
    options: {
      idempotencyKey?: string;
      auth?: boolean;
      headers?: Record<string, string>;
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
      headers: options.headers,
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

  /**
   * D1.2 (#86): `multipart/form-data` upload (admin plugin ZIP). `fetch` has no
   * upload progress, so this path uses `XMLHttpRequest` when available and
   * falls back to `fetch` for non-browser runtimes. The `Content-Type` header is
   * deliberately not set: the browser adds the multipart boundary.
   */
  async postFormData<T>(
    path: string,
    form: FormData,
    options: FormDataRequestOptions = {},
  ): Promise<ApiResponse<T>> {
    // `XMLHttpRequest` reports upload progress, but jsdom's FormData is not a
    // native `BodyInit` for the interceptor used by tests. Encode the multipart
    // bytes once; both transports then send the same body and the server still
    // receives a standards-compliant `multipart/form-data` request.
    const encoded = await encodeFormData(form);
    if (typeof XMLHttpRequest === 'undefined') {
      return this.postFormDataWithFetch<T>(path, encoded, options);
    }

    const url = this.buildUrl(path);
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const xhr = new XMLHttpRequest();
    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': newUuid(),
      'Content-Type': encoded.contentType,
    });
    if (options.auth !== false) {
      const token = this.options.getToken();
      const deviceId = this.options.getDeviceId();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (deviceId) headers.set('X-Device-Id', deviceId);
    }

    return new Promise<ApiResponse<T>>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', handleAbort);
        action();
      };
      const handleAbort = () => {
        xhr.abort();
        finish(() => reject(ApiError.client('ABORTED', 'Upload was cancelled')));
      };

      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs;
      for (const [name, value] of headers.entries()) xhr.setRequestHeader(name, value);

      xhr.upload.onprogress = (event) => {
        options.onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        const responseHeaders = headersFromXhr(xhr);
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        const parsed = parseJson(text);
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(() =>
            reject(
              problemFromResponse(
                xhr.status,
                parsed,
                responseHeaders,
                xhr.statusText || `HTTP ${xhr.status}`,
              ),
            ),
          );
          return;
        }
        if (xhr.status === 204 || text.length === 0) {
          finish(() =>
            resolve({ data: undefined as T, status: xhr.status, headers: responseHeaders }),
          );
          return;
        }
        if (parsed === undefined) {
          finish(() =>
            reject(
              new ApiError({
                source: 'http',
                status: xhr.status,
                code: 'INVALID_RESPONSE',
                message: 'Server returned a non-JSON response',
                requestId: responseHeaders.get('x-request-id') ?? undefined,
              }),
            ),
          );
          return;
        }
        finish(() => resolve({ data: parsed as T, status: xhr.status, headers: responseHeaders }));
      };
      xhr.onerror = () => finish(() => reject(ApiError.network()));
      xhr.ontimeout = () => finish(() => reject(ApiError.timeout()));
      xhr.onabort = () => finish(() => reject(ApiError.client('ABORTED', 'Upload was cancelled')));

      if (options.signal) {
        if (options.signal.aborted) {
          finish(() => reject(ApiError.client('ABORTED', 'Upload was cancelled')));
          return;
        }
        options.signal.addEventListener('abort', handleAbort, { once: true });
      }

      xhr.send(encoded.body);
    });
  }

  private async postFormDataWithFetch<T>(
    path: string,
    encoded: EncodedFormData,
    options: FormDataRequestOptions,
  ): Promise<ApiResponse<T>> {
    const url = this.buildUrl(path);
    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': newUuid(),
      'Content-Type': encoded.contentType,
    });
    if (options.auth !== false) {
      const token = this.options.getToken();
      const deviceId = this.options.getDeviceId();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (deviceId) headers.set('X-Device-Id', deviceId);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: encoded.body,
        signal: options.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (error) {
      if (options.signal?.aborted) throw ApiError.client('ABORTED', 'Upload was cancelled');
      throw ApiError.network(error);
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

  /** Bodyless DELETE mutations (E5-F: remove a favorite). */
  /**
   * `DELETE` with an optional JSON body: the contract's `DELETE /me/2fa`
   * carries a password + code re-auth body (P0-4 / #82). Every other DELETE
   * stays bodyless.
   */
  delete<T>(
    path: string,
    options: { auth?: boolean; body?: unknown } = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, auth: options.auth, body: options.body });
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

interface EncodedFormData {
  body: ArrayBuffer;
  contentType: string;
}

function escapeMultipartName(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

/**
 * Serialize a `FormData` into multipart bytes with a fresh boundary. Text parts
 * are UTF-8, file parts keep their filename/MIME. Sizes are bounded by the
 * only caller (one ZIP file); no recursion and no object keys.
 */
/** Bytes of a Blob/File; jsdom's Blob has no `arrayBuffer()` in older builds. */
async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('FileReader did not return bytes'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(blob);
  });
}

async function encodeFormData(form: FormData): Promise<EncodedFormData> {
  const boundary = `----SovaBoundary${newUuid().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (text: string) => chunks.push(encoder.encode(text));

  for (const [name, value] of form.entries()) {
    push(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      push(`Content-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n`);
      push(value);
      push('\r\n');
      continue;
    }
    const fileName = typeof (value as File).name === 'string' ? (value as File).name : 'blob';
    push(
      `Content-Disposition: form-data; name="${escapeMultipartName(name)}"; ` +
        `filename="${escapeMultipartName(fileName)}"\r\n`,
    );
    push(`Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`);
    chunks.push(new Uint8Array(await readBlobBytes(value)));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    body: body.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** XHR exposes raw header lines; normalize them into a `Headers` instance. */
function headersFromXhr(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  const raw = xhr.getAllResponseHeaders();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name) headers.append(name, value);
  }
  return headers;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
