import type { AdminAuditExportResult, ChatApi, ListAdminChatsQuery } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type {
  AdminAuditEvent,
  AdminAuditExportFormat,
  AdminAuditPage,
  AdminChat,
  AdminChatPage,
  AdminSessionPage,
  AdminSessionRevokeAll,
  AdminStorage,
  AdminUser,
  AdminUserPage,
  AdminUserStatus,
} from '../api/types';

/**
 * E9-F admin directory state: users, chats and the storage dashboard.
 *
 * Contract rules encoded here:
 *  * `cursor`/`next_cursor` is opaque and only ever echoed back verbatim;
 *  * pages are appended in server order and de-duplicated by id (a repeated
 *    cursor can legally return an overlapping boundary row);
 *  * search/filter changes start a new page chain — an in-flight response from
 *    the previous chain is discarded, never mixed into the new one;
 *  * storage is a single snapshot (one row per workspace, no pagination), as
 *    documented in `docs/TASKS-ADMIN-V2.md` and `backend/E9-B-REPORT.md`.
 */

export type AdminListStatus = 'idle' | 'loading' | 'ready' | 'error';
export type AdminChatTypeFilter = 'ALL' | 'DIRECT' | 'GROUP';

export interface AdminListState<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  status: AdminListStatus;
  error: ApiError | null;
  /** `true` while the next page is loading; the loaded rows stay visible. */
  loadingMore: boolean;
  moreError: ApiError | null;
}

export interface AdminUsersState extends AdminListState<AdminUser> {
  /** Debounced, trimmed search over email/display name. */
  query: string;
}

export interface AdminChatsState extends AdminListState<AdminChat> {
  query: string;
  workspaceId: string | null;
  type: AdminChatTypeFilter;
}

export interface AdminStorageState {
  data: AdminStorage | null;
  status: AdminListStatus;
  error: ApiError | null;
}

/**
 * E11-F audit page chain. `action` is an exact match filter (`''` = all);
 * pages are appended in server order and deduplicated by event id.
 */
export interface AdminAuditState extends AdminListState<AdminAuditEvent> {
  action: string;
  /** #84 bounded export: `X-Export-Rows`/`X-Export-Truncated` are authoritative. */
  exportStatus: 'idle' | 'exporting' | 'done' | 'error';
  exportFormat: AdminAuditExportFormat | null;
  exportRows: number | null;
  exportTruncated: boolean;
  exportFilename: string | null;
  exportError: ApiError | null;
}

/**
 * #84 sessions of the selected user. The dialog opens one user at a time; a
 * late response for another user is discarded through `userId`.
 */
export interface AdminSessionsState {
  userId: string | null;
  items: AdminSessionPage['items'];
  nextCursor: string | null;
  hasMore: boolean;
  status: AdminListStatus;
  error: ApiError | null;
  loadingMore: boolean;
  moreError: ApiError | null;
  revokeStatus: 'idle' | 'revoking' | 'error';
  revokingId: string | null;
  revokeError: ApiError | null;
  /** Session whose revoke failed; enables an honest retry of that exact row. */
  revokeErrorId: string | null;
  revokeAllStatus: 'idle' | 'revoking' | 'done' | 'error';
  revokeAllError: ApiError | null;
  revokeAllResult: AdminSessionRevokeAll | null;
}

export interface AdminDirectoryState {
  users: AdminUsersState;
  chats: AdminChatsState;
  audit: AdminAuditState;
  storage: AdminStorageState;
  sessions: AdminSessionsState;
}

export interface AdminDirectoryApi {
  listAdminUsers: ChatApi['listAdminUsers'];
  listAdminChats: ChatApi['listAdminChats'];
  getAdminStorage: ChatApi['getAdminStorage'];
  suspendUser: ChatApi['suspendUser'];
  activateUser: ChatApi['activateUser'];
  deleteChat: ChatApi['deleteChat'];
  listAdminAudit: ChatApi['listAdminAudit'];
  exportAdminAudit: ChatApi['exportAdminAudit'];
  listAdminSessions: ChatApi['listAdminSessions'];
  revokeAdminSession: ChatApi['revokeAdminSession'];
  revokeAdminUserSessions: ChatApi['revokeAdminUserSessions'];
}

/**
 * Outcome of an admin mutation. `alreadyApplied` is set for the documented
 * `409` codes that mean "the desired state is already in effect" (repeat
 * suspend/activate, repeat chat delete): the server rejected the call, but the
 * list was refreshed because the UI must not keep a stale row/status.
 */
export interface AdminActionResult {
  ok: boolean;
  error: ApiError | null;
  alreadyApplied: boolean;
}

export interface AdminDirectoryStoreDeps {
  api: AdminDirectoryApi;
}

/** Page size sent with every request; the server caps it at 100. */
export const ADMIN_PAGE_SIZE = 25;

export function createInitialAdminDirectoryState(): AdminDirectoryState {
  return {
    users: {
      items: [],
      nextCursor: null,
      hasMore: false,
      status: 'idle',
      error: null,
      loadingMore: false,
      moreError: null,
      query: '',
    },
    chats: {
      items: [],
      nextCursor: null,
      hasMore: false,
      status: 'idle',
      error: null,
      loadingMore: false,
      moreError: null,
      query: '',
      workspaceId: null,
      type: 'ALL',
    },
    storage: { data: null, status: 'idle', error: null },
    audit: {
      items: [],
      nextCursor: null,
      hasMore: false,
      status: 'idle',
      error: null,
      loadingMore: false,
      moreError: null,
      action: '',
      exportStatus: 'idle',
      exportFormat: null,
      exportRows: null,
      exportTruncated: false,
      exportFilename: null,
      exportError: null,
    },
    sessions: {
      userId: null,
      items: [],
      nextCursor: null,
      hasMore: false,
      status: 'idle',
      error: null,
      loadingMore: false,
      moreError: null,
      revokeStatus: 'idle',
      revokingId: null,
      revokeError: null,
      revokeErrorId: null,
      revokeAllStatus: 'idle',
      revokeAllError: null,
      revokeAllResult: null,
    },
  };
}

function appendUnique<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export class AdminDirectoryStore {
  private readonly api: AdminDirectoryApi;
  private state: AdminDirectoryState;
  private listeners = new Set<() => void>();
  /** Invalidates every in-flight response after reset/logout. */
  private generation = 0;
  private disposed = false;

  private usersToken = 0;
  private chatsToken = 0;
  private storageToken = 0;
  private auditToken = 0;
  private sessionsToken = 0;
  private exportToken = 0;
  private usersInFlight: Promise<void> | null = null;
  private chatsInFlight: Promise<void> | null = null;
  private storageInFlight: Promise<void> | null = null;
  private auditInFlight: Promise<void> | null = null;
  private sessionsInFlight: Promise<void> | null = null;

  constructor(deps: AdminDirectoryStoreDeps) {
    this.api = deps.api;
    this.state = createInitialAdminDirectoryState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AdminDirectoryState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  reset(): void {
    this.generation += 1;
    this.usersToken += 1;
    this.chatsToken += 1;
    this.storageToken += 1;
    this.auditToken += 1;
    this.sessionsToken += 1;
    this.exportToken += 1;
    this.usersInFlight = null;
    this.chatsInFlight = null;
    this.storageInFlight = null;
    this.auditInFlight = null;
    this.sessionsInFlight = null;
    this.state = createInitialAdminDirectoryState();
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(next: AdminDirectoryState): void {
    this.state = next;
    this.emit();
  }

  /* ---------------------------------------------------------------------- */
  /* Users                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Search change: keeps the raw input, reloads from the first page. */
  setUsersQuery(query: string): void {
    const normalized = query.trim();
    if (normalized === this.state.users.query) return;
    this.usersToken += 1;
    this.usersInFlight = null;
    this.patch({
      ...this.state,
      users: {
        ...this.state.users,
        query: normalized,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
      },
    });
    void this.loadUsers();
  }

  async loadUsers(options: { force?: boolean } = {}): Promise<void> {
    if (this.usersInFlight) return this.usersInFlight;
    if (!options.force && this.state.users.status === 'ready') return;

    const generation = this.generation;
    const token = ++this.usersToken;
    this.patch({
      ...this.state,
      users: { ...this.state.users, status: 'loading', error: null, moreError: null },
    });

    this.usersInFlight = (async () => {
      try {
        const page: AdminUserPage = await this.api.listAdminUsers({
          query: this.state.users.query || undefined,
          limit: ADMIN_PAGE_SIZE,
        });
        if (this.disposed || generation !== this.generation || token !== this.usersToken) return;
        this.patch({
          ...this.state,
          users: {
            ...this.state.users,
            items: page.items,
            nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
            hasMore: page.has_more && page.next_cursor !== null,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation || token !== this.usersToken) return;
        this.patch({
          ...this.state,
          users: { ...this.state.users, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && token === this.usersToken) {
          this.usersInFlight = null;
        }
      }
    })();
    return this.usersInFlight;
  }

  async loadMoreUsers(): Promise<void> {
    const { users } = this.state;
    if (users.status === 'loading' || users.loadingMore || !users.hasMore) return;
    const cursor = users.nextCursor;
    if (!cursor) return;

    const generation = this.generation;
    const token = this.usersToken;
    this.patch({
      ...this.state,
      users: { ...users, loadingMore: true, moreError: null },
    });

    try {
      const page: AdminUserPage = await this.api.listAdminUsers({
        query: users.query || undefined,
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      if (this.disposed || generation !== this.generation || token !== this.usersToken) return;
      this.patch({
        ...this.state,
        users: {
          ...this.state.users,
          items: appendUnique(this.state.users.items, page.items),
          nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
          hasMore: page.has_more && page.next_cursor !== null,
          loadingMore: false,
          status: 'ready',
          moreError: null,
        },
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation || token !== this.usersToken) return;
      this.patch({
        ...this.state,
        users: {
          ...this.state.users,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* E11-F mutations                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Suspends/activates a user (FR-ADM-15). The row status is only changed
   * after a `204`: on any error the list keeps the previous data and is
   * refreshed instead (no optimistic flip that could lie about the state).
   */
  async changeUserStatus(
    userId: string,
    status: Extract<AdminUserStatus, 'ACTIVE' | 'SUSPENDED'>,
  ): Promise<AdminActionResult> {
    try {
      if (status === 'SUSPENDED') await this.api.suspendUser(userId);
      else await this.api.activateUser(userId);
    } catch (error) {
      const apiError = toApiError(error);
      // A repeat action means the server is already in the requested state;
      // reload so the chip reflects the truth instead of the stale row. A 404
      // means the user is gone/DELETED: the status is unknown, so only reload.
      if (isAlreadyApplied(apiError)) {
        this.patchUserStatus(userId, status);
        void this.loadUsers({ force: true });
      } else if (apiError.status === 404) {
        void this.loadUsers({ force: true });
      }
      return { ok: false, error: apiError, alreadyApplied: isAlreadyApplied(apiError) };
    }

    this.patchUserStatus(userId, status);
    void this.loadUsers({ force: true });
    return { ok: true, error: null, alreadyApplied: false };
  }

  /**
   * Soft-deletes a chat (FR-ADM-16). The server excludes deleted chats from
   * every list, so a successful (or already-deleted) call removes the row and
   * reloads the current cursor chain.
   */
  async deleteChat(chatId: string): Promise<AdminActionResult> {
    try {
      await this.api.deleteChat(chatId);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status === 409 && apiError.code === 'CHAT_ALREADY_DELETED') {
        this.removeChatRow(chatId);
        void this.loadChats({ force: true });
        return { ok: false, error: apiError, alreadyApplied: true };
      }
      if (apiError.status === 404) {
        this.removeChatRow(chatId);
        void this.loadChats({ force: true });
      }
      return { ok: false, error: apiError, alreadyApplied: false };
    }

    this.removeChatRow(chatId);
    void this.loadChats({ force: true });
    return { ok: true, error: null, alreadyApplied: false };
  }

  private patchUserStatus(userId: string, status: AdminUserStatus): void {
    const { users } = this.state;
    if (!users.items.some((user) => user.id === userId)) return;
    this.patch({
      ...this.state,
      users: {
        ...users,
        items: users.items.map((user) => (user.id === userId ? { ...user, status } : user)),
      },
    });
  }

  private removeChatRow(chatId: string): void {
    const { chats } = this.state;
    if (!chats.items.some((chat) => chat.id === chatId)) return;
    this.patch({
      ...this.state,
      chats: { ...chats, items: chats.items.filter((chat) => chat.id !== chatId) },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Chats                                                                  */
  /* ---------------------------------------------------------------------- */

  setChatsFilters(patch: Partial<Pick<AdminChatsState, 'query' | 'workspaceId' | 'type'>>): void {
    const nextQuery = patch.query !== undefined ? patch.query.trim() : this.state.chats.query;
    const nextWorkspace =
      patch.workspaceId !== undefined ? patch.workspaceId : this.state.chats.workspaceId;
    const nextType = patch.type !== undefined ? patch.type : this.state.chats.type;
    if (
      nextQuery === this.state.chats.query &&
      nextWorkspace === this.state.chats.workspaceId &&
      nextType === this.state.chats.type
    ) {
      return;
    }
    this.chatsToken += 1;
    this.chatsInFlight = null;
    this.patch({
      ...this.state,
      chats: {
        ...this.state.chats,
        query: nextQuery,
        workspaceId: nextWorkspace,
        type: nextType,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
      },
    });
    void this.loadChats();
  }

  async loadChats(options: { force?: boolean } = {}): Promise<void> {
    if (this.chatsInFlight) return this.chatsInFlight;
    if (!options.force && this.state.chats.status === 'ready') return;

    const generation = this.generation;
    const token = ++this.chatsToken;
    this.patch({
      ...this.state,
      chats: { ...this.state.chats, status: 'loading', error: null, moreError: null },
    });

    this.chatsInFlight = (async () => {
      try {
        const page: AdminChatPage = await this.api.listAdminChats(this.chatsQuery());
        if (this.disposed || generation !== this.generation || token !== this.chatsToken) return;
        this.patch({
          ...this.state,
          chats: {
            ...this.state.chats,
            items: page.items,
            nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
            hasMore: page.has_more && page.next_cursor !== null,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation || token !== this.chatsToken) return;
        this.patch({
          ...this.state,
          chats: { ...this.state.chats, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && token === this.chatsToken) {
          this.chatsInFlight = null;
        }
      }
    })();
    return this.chatsInFlight;
  }

  async loadMoreChats(): Promise<void> {
    const { chats } = this.state;
    if (chats.status === 'loading' || chats.loadingMore || !chats.hasMore) return;
    const cursor = chats.nextCursor;
    if (!cursor) return;

    const generation = this.generation;
    const token = this.chatsToken;
    this.patch({
      ...this.state,
      chats: { ...chats, loadingMore: true, moreError: null },
    });

    try {
      const page: AdminChatPage = await this.api.listAdminChats({
        ...this.chatsQuery(),
        cursor,
      });
      if (this.disposed || generation !== this.generation || token !== this.chatsToken) return;
      this.patch({
        ...this.state,
        chats: {
          ...this.state.chats,
          items: appendUnique(this.state.chats.items, page.items),
          nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
          hasMore: page.has_more && page.next_cursor !== null,
          loadingMore: false,
          status: 'ready',
          moreError: null,
        },
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation || token !== this.chatsToken) return;
      this.patch({
        ...this.state,
        chats: {
          ...this.state.chats,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  private chatsQuery(): ListAdminChatsQuery {
    const { query, workspaceId, type } = this.state.chats;
    return {
      query: query || undefined,
      workspaceId: workspaceId ?? undefined,
      type: type === 'ALL' ? undefined : type,
      limit: ADMIN_PAGE_SIZE,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Storage (single snapshot, no cursor — documented)                      */
  /* ---------------------------------------------------------------------- */

  async loadStorage(options: { force?: boolean } = {}): Promise<void> {
    if (this.storageInFlight) return this.storageInFlight;
    if (!options.force && this.state.storage.status === 'ready') return;

    const generation = this.generation;
    const token = ++this.storageToken;
    this.patch({
      ...this.state,
      storage: { ...this.state.storage, status: 'loading', error: null },
    });

    this.storageInFlight = (async () => {
      try {
        const data = await this.api.getAdminStorage();
        if (this.disposed || generation !== this.generation || token !== this.storageToken) return;
        this.patch({
          ...this.state,
          storage: { data, status: 'ready', error: null },
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation || token !== this.storageToken) return;
        this.patch({
          ...this.state,
          storage: { ...this.state.storage, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && token === this.storageToken) {
          this.storageInFlight = null;
        }
      }
    })();
    return this.storageInFlight;
  }

  /* ---------------------------------------------------------------------- */
  /* Audit (E11-F, FR-ADM-17) — cursor chain with an exact action filter    */
  /* ---------------------------------------------------------------------- */

  /** Exact action filter change starts a new page chain. */
  setAuditAction(action: string): void {
    const normalized = action.trim();
    if (normalized === this.state.audit.action) return;
    this.auditToken += 1;
    this.auditInFlight = null;
    this.patch({
      ...this.state,
      audit: {
        ...this.state.audit,
        action: normalized,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
        exportStatus: 'idle',
        exportFormat: null,
        exportRows: null,
        exportTruncated: false,
        exportFilename: null,
        exportError: null,
      },
    });
    void this.loadAudit();
  }

  async loadAudit(options: { force?: boolean } = {}): Promise<void> {
    if (this.auditInFlight) return this.auditInFlight;
    if (!options.force && this.state.audit.status === 'ready') return;

    const generation = this.generation;
    const token = ++this.auditToken;
    this.patch({
      ...this.state,
      audit: { ...this.state.audit, status: 'loading', error: null, moreError: null },
    });

    this.auditInFlight = (async () => {
      try {
        const page: AdminAuditPage = await this.api.listAdminAudit({
          action: this.state.audit.action || undefined,
          limit: ADMIN_PAGE_SIZE,
        });
        if (this.disposed || generation !== this.generation || token !== this.auditToken) return;
        this.patch({
          ...this.state,
          audit: {
            ...this.state.audit,
            items: dedupeAudit(page.items),
            nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
            hasMore: page.has_more && page.next_cursor !== null,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation || token !== this.auditToken) return;
        this.patch({
          ...this.state,
          audit: { ...this.state.audit, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && token === this.auditToken) {
          this.auditInFlight = null;
        }
      }
    })();
    return this.auditInFlight;
  }

  async loadMoreAudit(): Promise<void> {
    const { audit } = this.state;
    if (audit.status === 'loading' || audit.loadingMore || !audit.hasMore) return;
    const cursor = audit.nextCursor;
    if (!cursor) return;

    const generation = this.generation;
    const token = this.auditToken;
    this.patch({
      ...this.state,
      audit: { ...audit, loadingMore: true, moreError: null },
    });

    try {
      const page: AdminAuditPage = await this.api.listAdminAudit({
        action: audit.action || undefined,
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      if (this.disposed || generation !== this.generation || token !== this.auditToken) return;
      this.patch({
        ...this.state,
        audit: {
          ...this.state.audit,
          items: dedupeAudit([...this.state.audit.items, ...page.items]),
          nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
          hasMore: page.has_more && page.next_cursor !== null,
          loadingMore: false,
          status: 'ready',
          moreError: null,
        },
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation || token !== this.auditToken) return;
      this.patch({
        ...this.state,
        audit: {
          ...this.state.audit,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  /**
   * #84 bounded audit export. The Blob is downloaded by the caller without
   * re-encoding; `X-Export-Rows`/`X-Export-Truncated` are authoritative. For
   * JSON the body is a fallback when the headers are missing.
   */
  async exportAudit(format: AdminAuditExportFormat): Promise<AdminAuditExportResult | null> {
    if (this.state.audit.exportStatus === 'exporting') return null;
    const generation = this.generation;
    const token = ++this.exportToken;
    this.patch({
      ...this.state,
      audit: {
        ...this.state.audit,
        exportStatus: 'exporting',
        exportFormat: format,
        exportRows: null,
        exportTruncated: false,
        exportFilename: null,
        exportError: null,
      },
    });

    try {
      const result = await this.api.exportAdminAudit({
        format,
        action: this.state.audit.action || undefined,
      });
      if (this.disposed || generation !== this.generation || token !== this.exportToken)
        return null;

      let rows = result.rows;
      let truncated = result.truncated;
      if (format === 'json' && (rows === null || !truncated)) {
        try {
          const parsed = JSON.parse(await readBlobText(result.blob)) as {
            exported_rows?: unknown;
            truncated?: unknown;
          };
          if (rows === null && typeof parsed.exported_rows === 'number') {
            rows = parsed.exported_rows;
          }
          if (parsed.truncated === true) truncated = true;
        } catch {
          // Headers stay authoritative; the bytes are still downloadable.
        }
      }
      this.patch({
        ...this.state,
        audit: {
          ...this.state.audit,
          exportStatus: 'done',
          exportFormat: format,
          exportRows: rows,
          exportTruncated: truncated,
          exportFilename: result.filename,
          exportError: null,
        },
      });
      return { ...result, rows, truncated };
    } catch (error) {
      if (this.disposed || generation !== this.generation || token !== this.exportToken)
        return null;
      this.patch({
        ...this.state,
        audit: {
          ...this.state.audit,
          exportStatus: 'error',
          exportError: toApiError(error),
        },
      });
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Sessions (#84) — one selected user, opaque cursor, idempotent revoke    */
  /* ---------------------------------------------------------------------- */

  /** Open the sessions dialog for one user and load the first page. */
  openSessions(userId: string): void {
    if (this.state.sessions.userId === userId && this.state.sessions.status === 'ready') return;
    this.sessionsToken += 1;
    this.sessionsInFlight = null;
    this.patch({
      ...this.state,
      sessions: {
        ...createInitialAdminDirectoryState().sessions,
        userId,
        status: 'idle',
      },
    });
    void this.loadSessions();
  }

  closeSessions(): void {
    this.sessionsToken += 1;
    this.sessionsInFlight = null;
    this.patch({
      ...this.state,
      sessions: createInitialAdminDirectoryState().sessions,
    });
  }

  async loadSessions(options: { force?: boolean } = {}): Promise<void> {
    const userId = this.state.sessions.userId;
    if (!userId) return;
    if (this.sessionsInFlight) return this.sessionsInFlight;
    if (!options.force && this.state.sessions.status === 'ready') return;

    const generation = this.generation;
    const token = ++this.sessionsToken;
    this.patch({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        status: 'loading',
        error: null,
        moreError: null,
      },
    });

    this.sessionsInFlight = (async () => {
      try {
        const page: AdminSessionPage = await this.api.listAdminSessions({
          userId,
          limit: ADMIN_PAGE_SIZE,
        });
        if (this.disposed || generation !== this.generation || token !== this.sessionsToken) return;
        this.patch({
          ...this.state,
          sessions: {
            ...this.state.sessions,
            items: page.items,
            nextCursor: page.next_cursor ?? null,
            hasMore: page.has_more && page.next_cursor !== null,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation || token !== this.sessionsToken) return;
        this.patch({
          ...this.state,
          sessions: {
            ...this.state.sessions,
            status: 'error',
            error: toApiError(error),
          },
        });
      } finally {
        if (generation === this.generation && token === this.sessionsToken) {
          this.sessionsInFlight = null;
        }
      }
    })();
    return this.sessionsInFlight;
  }

  async loadMoreSessions(): Promise<void> {
    const { sessions } = this.state;
    const userId = sessions.userId;
    if (!userId || !sessions.nextCursor || sessions.loadingMore) return;
    if (sessions.status === 'loading') return;

    const generation = this.generation;
    const token = this.sessionsToken;
    this.patch({
      ...this.state,
      sessions: { ...sessions, loadingMore: true, moreError: null },
    });
    try {
      const page: AdminSessionPage = await this.api.listAdminSessions({
        userId,
        cursor: sessions.nextCursor,
        limit: ADMIN_PAGE_SIZE,
      });
      if (this.disposed || generation !== this.generation || token !== this.sessionsToken) return;
      const seen = new Set(this.state.sessions.items.map((item) => item.id));
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          items: [...this.state.sessions.items, ...page.items.filter((item) => !seen.has(item.id))],
          nextCursor: page.next_cursor ?? null,
          hasMore: page.has_more && page.next_cursor !== null,
          loadingMore: false,
          moreError: null,
        },
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation || token !== this.sessionsToken) return;
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  /** Idempotent revoke: the server returns `204` even for an unknown id. */
  async revokeSession(sessionId: string): Promise<boolean> {
    if (this.state.sessions.revokeStatus === 'revoking') return false;
    const generation = this.generation;
    const userId = this.state.sessions.userId;
    this.patch({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        revokeStatus: 'revoking',
        revokingId: sessionId,
        revokeError: null,
        revokeErrorId: null,
        revokeAllStatus: 'idle',
        revokeAllError: null,
        revokeAllResult: null,
      },
    });
    try {
      await this.api.revokeAdminSession(sessionId);
      if (this.disposed || generation !== this.generation || userId !== this.state.sessions.userId)
        return false;
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          items: this.state.sessions.items.filter((item) => item.id !== sessionId),
          revokeStatus: 'idle',
          revokingId: null,
          revokeError: null,
          revokeErrorId: null,
        },
      });
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          revokeStatus: 'error',
          revokingId: null,
          revokeError: toApiError(error),
          revokeErrorId: sessionId,
        },
      });
      return false;
    }
  }

  async revokeAllSessions(): Promise<AdminSessionRevokeAll | null> {
    const userId = this.state.sessions.userId;
    if (!userId || this.state.sessions.revokeAllStatus === 'revoking') return null;
    const generation = this.generation;
    this.patch({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        revokeAllStatus: 'revoking',
        revokeAllError: null,
        revokeAllResult: null,
        revokeStatus: 'idle',
        revokeError: null,
        revokeErrorId: null,
      },
    });
    try {
      const result = await this.api.revokeAdminUserSessions(userId);
      if (this.disposed || generation !== this.generation) return null;
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          items: [],
          hasMore: false,
          nextCursor: null,
          revokeAllStatus: 'done',
          revokeAllError: null,
          revokeAllResult: result,
        },
      });
      return result;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return null;
      this.patch({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          revokeAllStatus: 'error',
          revokeAllError: toApiError(error),
        },
      });
      return null;
    }
  }
}

/** 409 codes that mean the requested state is already in effect. */
function isAlreadyApplied(error: ApiError): boolean {
  return (
    error.status === 409 &&
    (error.code === 'USER_ALREADY_SUSPENDED' ||
      error.code === 'USER_ALREADY_ACTIVE' ||
      error.code === 'CHAT_ALREADY_DELETED')
  );
}

/** `Blob.text()` fallback for older jsdom builds; browsers have both paths. */
function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(blob);
  });
}

function dedupeAudit(items: AdminAuditEvent[]): AdminAuditEvent[] {
  const seen = new Set<string>();
  const result: AdminAuditEvent[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function createAdminDirectoryStore(deps: AdminDirectoryStoreDeps): AdminDirectoryStore {
  return new AdminDirectoryStore(deps);
}
