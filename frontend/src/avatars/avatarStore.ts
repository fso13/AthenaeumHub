import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';

/**
 * Authenticated avatar/logo images kept as per-id object URLs.
 *
 * The backend exposes the bytes behind an authenticated or short-lived URL:
 *
 * - `GET /chats/{chatId}/avatar` → `302` presigned (followed by `fetch`);
 * - `GET /me/avatar` → the same flow, resolved by `ProfileWorkspaceStore`;
 * - workspace logo → `logo_file_id` is an existing managed attachment, so the
 *   image is resolved through the regular attachment-download flow.
 *
 * One entry per chat/workspace, one in-flight request per id (opening the
 * header, the sidebar and the settings dialog must not cause a fetch storm),
 * and the object URL is revoked when the id changes or the session resets.
 */
export type AvatarEntryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface AvatarEntry {
  status: AvatarEntryStatus;
  url: string | null;
  error: ApiError | null;
  /** Workspace logo attachment the URL was resolved from (`null` when unset). */
  fileId?: string | null;
}

export interface AvatarsState {
  chats: Record<string, AvatarEntry>;
  workspaces: Record<string, AvatarEntry>;
}

export interface AvatarStoreDeps {
  api: Pick<ChatApi, 'getChatAvatarBlob' | 'getWorkspaceAvatarBlob' | 'attachmentDownloadUrl'>;
}

const EMPTY_STATE: AvatarsState = { chats: {}, workspaces: {} };

function idleEntry(fileId: string | null = null): AvatarEntry {
  return { status: 'idle', url: null, error: null, ...(fileId === null ? {} : { fileId }) };
}

export class AvatarStore {
  private readonly api: AvatarStoreDeps['api'];
  private state: AvatarsState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Object URLs created from blobs, keyed by `chat:<id>` / `workspace:<id>`. */
  private readonly objectUrls = new Map<string, string>();
  /** Per-key request tokens: an invalidated load must never write its result. */
  private readonly tokens = new Map<string, object>();
  private generation = 0;
  private disposed = false;

  constructor(deps: AvatarStoreDeps) {
    this.api = deps.api;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AvatarsState => this.state;

  getChat(chatId: string): AvatarEntry | null {
    return this.state.chats[chatId] ?? null;
  }

  getWorkspace(workspaceId: string): AvatarEntry | null {
    return this.state.workspaces[workspaceId] ?? null;
  }

  /**
   * `GET /chats/{id}/avatar`. A `404` means "no avatar" (direct/unset) and is
   * stored as `empty` so the initials fallback is final, not an error banner.
   */
  ensureChat(chatId: string, force = false): Promise<void> {
    const key = `chat:${chatId}`;
    const current = this.state.chats[chatId];
    if (!force && current) {
      if (current.status === 'ready' || current.status === 'empty') return Promise.resolve();
      if (current.status === 'loading') {
        const pending = this.inFlight.get(key);
        if (pending) return pending;
      }
    }
    if (!force) {
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }
    const generation = this.generation;
    const token = {};
    this.tokens.set(key, token);
    this.setChat(chatId, { status: 'loading', url: null, error: null });
    const promise = (async () => {
      try {
        const blob = await this.api.getChatAvatarBlob(chatId);
        if (this.isStale(generation) || this.tokens.get(key) !== token) return;
        const url = this.createObjectUrl(key, blob);
        this.setChat(chatId, {
          status: url ? 'ready' : 'empty',
          url,
          error: null,
        });
      } catch (error) {
        if (this.isStale(generation) || this.tokens.get(key) !== token) return;
        const apiError = toApiError(error);
        this.setChat(
          chatId,
          apiError.status === 404
            ? { status: 'empty', url: null, error: null }
            : { status: 'error', url: null, error: apiError },
        );
      } finally {
        if (this.tokens.get(key) === token) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Resolve the workspace logo. The contract has no `GET /workspaces/{id}/avatar`:
   * `logo_file_id` is an existing attachment, so the image comes from the regular
   * attachment-download URL (cached by the files store). The authenticated blob
   * helper is tried first and the presigned URL is the fallback, so a browser
   * without CORS access to the object storage still renders the logo.
   */
  ensureWorkspace(workspaceId: string, logoFileId: string | null, force = false): Promise<void> {
    const key = `workspace:${workspaceId}`;
    const current = this.state.workspaces[workspaceId];
    if (!logoFileId) {
      if (current && (current.status !== 'empty' || current.fileId !== null)) {
        this.revokeObjectUrl(key);
        this.setWorkspace(workspaceId, { status: 'empty', url: null, error: null, fileId: null });
      }
      return Promise.resolve();
    }
    if (!force && current?.fileId === logoFileId) {
      if (current.status === 'ready' || current.status === 'empty') return Promise.resolve();
      if (current.status === 'loading') {
        const pending = this.inFlight.get(key);
        if (pending) return pending;
      }
    }
    if (!force) {
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }
    const generation = this.generation;
    const token = {};
    this.tokens.set(key, token);
    this.revokeObjectUrl(key);
    this.setWorkspace(workspaceId, {
      status: 'loading',
      url: null,
      error: null,
      fileId: logoFileId,
    });
    const promise = (async () => {
      let url: string | null = null;
      try {
        const blob = await this.api.getWorkspaceAvatarBlob(workspaceId, logoFileId);
        if (this.isStale(generation) || this.tokens.get(key) !== token) return;
        url = this.createObjectUrl(key, blob);
      } catch {
        // Fall through to the presigned URL below; a missing blob is not fatal.
      }
      if (this.isStale(generation) || this.tokens.get(key) !== token) return;
      if (!url) {
        try {
          const download = await this.api.attachmentDownloadUrl(logoFileId);
          if (this.isStale(generation) || this.tokens.get(key) !== token) return;
          url = download.url;
        } catch (error) {
          if (this.isStale(generation) || this.tokens.get(key) !== token) return;
          this.setWorkspace(workspaceId, {
            status: 'error',
            url: null,
            error: toApiError(error),
            fileId: logoFileId,
          });
          return;
        }
      }
      this.setWorkspace(workspaceId, {
        status: url ? 'ready' : 'empty',
        url,
        error: null,
        fileId: logoFileId,
      });
    })()
      .catch((error) => {
        if (this.isStale(generation) || this.tokens.get(key) !== token) return;
        this.setWorkspace(workspaceId, {
          status: 'error',
          url: null,
          error: toApiError(error),
          fileId: logoFileId,
        });
      })
      .finally(() => {
        if (this.tokens.get(key) === token) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** The chat avatar changed (or was removed): drop the cached bytes/URL. */
  invalidateChat(chatId: string): void {
    const key = `chat:${chatId}`;
    this.revokeObjectUrl(key);
    this.inFlight.delete(key);
    this.tokens.delete(key);
    if (!(chatId in this.state.chats)) return;
    const chats = { ...this.state.chats };
    delete chats[chatId];
    this.state = { ...this.state, chats };
    this.emit();
  }

  invalidateWorkspace(workspaceId: string): void {
    const key = `workspace:${workspaceId}`;
    this.revokeObjectUrl(key);
    this.inFlight.delete(key);
    this.tokens.delete(key);
    if (!(workspaceId in this.state.workspaces)) return;
    const workspaces = { ...this.state.workspaces };
    delete workspaces[workspaceId];
    this.state = { ...this.state, workspaces };
    this.emit();
  }

  /** Logout/workspace switch: revoke every object URL and forget every entry. */
  reset(): void {
    this.generation += 1;
    for (const url of this.objectUrls.values()) this.revokeUrl(url);
    this.objectUrls.clear();
    this.inFlight.clear();
    this.tokens.clear();
    this.state = EMPTY_STATE;
    this.emit();
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
    this.listeners.clear();
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private setChat(chatId: string, entry: AvatarEntry): void {
    this.state = {
      ...this.state,
      chats: { ...this.state.chats, [chatId]: entry },
    };
    this.emit();
  }

  private setWorkspace(workspaceId: string, entry: AvatarEntry): void {
    this.state = {
      ...this.state,
      workspaces: { ...this.state.workspaces, [workspaceId]: entry },
    };
    this.emit();
  }

  private createObjectUrl(key: string, blob: Blob): string | null {
    this.revokeObjectUrl(key);
    if (typeof URL.createObjectURL !== 'function') return null;
    try {
      const url = URL.createObjectURL(blob);
      this.objectUrls.set(key, url);
      return url;
    } catch {
      return null;
    }
  }

  private revokeObjectUrl(key: string): void {
    const url = this.objectUrls.get(key);
    if (!url) return;
    this.revokeUrl(url);
    this.objectUrls.delete(key);
  }

  private revokeUrl(url: string): void {
    if (typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Revocation is best-effort; the entry is dropped either way.
      }
    }
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

export function createAvatarStore(deps: AvatarStoreDeps): AvatarStore {
  return new AvatarStore(deps);
}

export { idleEntry };
