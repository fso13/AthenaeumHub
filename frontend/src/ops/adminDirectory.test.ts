import { describe, expect, it, vi } from 'vitest';
import type {
  AdminAuditEvent,
  AdminAuditPage,
  AdminChat,
  AdminStorage,
  AdminUser,
  AdminUserPage,
} from '../api/types';
import { ApiError } from '../api/problem';
import { createAdminDirectoryStore, type AdminDirectoryApi } from './adminDirectory';

function user(id: string, email: string): AdminUser {
  return {
    id,
    email,
    display_name: `Имя ${id}`,
    is_platform_admin: false,
    status: 'ACTIVE',
    workspaces_count: 1,
    chats_count: 1,
    storage_used_bytes: 0,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function chat(id: string, workspaceId: string, type: AdminChat['type']): AdminChat {
  return {
    id,
    name: id,
    type,
    security_mode: 'MANAGED',
    workspace_id: workspaceId,
    workspace_name: 'Пространство',
    members_count: 2,
    messages_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: null,
  };
}

function page<T>(
  items: T[],
  nextCursor: string | null,
): { items: T[]; next_cursor: string | null; has_more: boolean } {
  return { items, next_cursor: nextCursor, has_more: nextCursor !== null };
}

function createFakeApi() {
  const api: AdminDirectoryApi = {
    listAdminUsers: vi.fn(),
    listAdminChats: vi.fn(),
    getAdminStorage: vi.fn(),
    suspendUser: vi.fn(),
    activateUser: vi.fn(),
    deleteChat: vi.fn(),
    listAdminAudit: vi.fn(),
  };
  return api;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('admin directory store (E9-F)', () => {
  it('loads the first page, appends the next one and de-duplicates boundary rows', async () => {
    const api = createFakeApi();
    const first: AdminUserPage = page([user('u1', 'a@test'), user('u2', 'b@test')], 'c1');
    const second: AdminUserPage = page([user('u2', 'b@test'), user('u3', 'c@test')], null);
    vi.mocked(api.listAdminUsers).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const store = createAdminDirectoryStore({ api });

    await store.loadUsers();
    expect(api.listAdminUsers).toHaveBeenNthCalledWith(1, { query: undefined, limit: 25 });
    expect(store.getSnapshot().users).toMatchObject({
      status: 'ready',
      hasMore: true,
      nextCursor: 'c1',
    });

    await store.loadMoreUsers();
    expect(api.listAdminUsers).toHaveBeenNthCalledWith(2, {
      query: undefined,
      cursor: 'c1',
      limit: 25,
    });
    expect(store.getSnapshot().users.items.map((item) => item.id)).toEqual(['u1', 'u2', 'u3']);
    expect(store.getSnapshot().users.hasMore).toBe(false);
  });

  it('drops a stale response when the search changes mid-flight', async () => {
    const api = createFakeApi();
    const slow = deferred<AdminUserPage>();
    const fast = deferred<AdminUserPage>();
    vi.mocked(api.listAdminUsers)
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);
    const store = createAdminDirectoryStore({ api });

    const initial = store.loadUsers();
    store.setUsersQuery('anna');
    slow.resolve(page([user('old', 'old@test')], null));
    await initial;
    fast.resolve(page([user('anna', 'anna@test')], null));
    await vi.waitFor(() => {
      expect(store.getSnapshot().users.items.map((item) => item.id)).toEqual(['anna']);
    });
    expect(store.getSnapshot().users.query).toBe('anna');
    expect(store.getSnapshot().users.status).toBe('ready');
  });

  it('sends chat filters as contract parameters and resets the cursor chain', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminChats).mockResolvedValue(page([chat('c1', 'ws-1', 'GROUP')], 'next'));
    const store = createAdminDirectoryStore({ api });

    await store.loadChats();
    expect(api.listAdminChats).toHaveBeenLastCalledWith({
      query: undefined,
      workspaceId: undefined,
      type: undefined,
      limit: 25,
    });

    store.setChatsFilters({ workspaceId: 'ws-1', type: 'GROUP', query: 'team' });
    await vi.waitFor(() => {
      expect(store.getSnapshot().chats.status).toBe('ready');
    });
    expect(api.listAdminChats).toHaveBeenLastCalledWith({
      query: 'team',
      workspaceId: 'ws-1',
      type: 'GROUP',
      limit: 25,
    });

    await store.loadMoreChats();
    expect(api.listAdminChats).toHaveBeenLastCalledWith({
      query: 'team',
      workspaceId: 'ws-1',
      type: 'GROUP',
      cursor: 'next',
      limit: 25,
    });
  });

  it('keeps the storage snapshot and surfaces a 403 as an error', async () => {
    const api = createFakeApi();
    const storage: AdminStorage = {
      totals: { used_bytes: 10, reserved_bytes: 0, objects: 1, attachments: 1 },
      workspaces: [],
    };
    vi.mocked(api.getAdminStorage).mockResolvedValueOnce(storage);
    const store = createAdminDirectoryStore({ api });

    await store.loadStorage();
    expect(store.getSnapshot().storage).toMatchObject({ status: 'ready', data: storage });

    vi.mocked(api.getAdminStorage).mockRejectedValueOnce(
      new ApiError({ source: 'http', status: 403, code: 'FORBIDDEN', message: 'no' }),
    );
    await store.loadStorage({ force: true });
    expect(store.getSnapshot().storage.status).toBe('error');
    expect(store.getSnapshot().storage.error?.status).toBe(403);
    // The previous snapshot stays on screen while the refresh failed.
    expect(store.getSnapshot().storage.data).toEqual(storage);
  });

  it('reset() clears every slice and ignores late responses', async () => {
    const api = createFakeApi();
    const slow = deferred<AdminUserPage>();
    vi.mocked(api.listAdminUsers).mockReturnValueOnce(slow.promise);
    const store = createAdminDirectoryStore({ api });

    void store.loadUsers();
    store.reset();
    slow.resolve(page([user('late', 'late@test')], null));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().users).toMatchObject({ items: [], status: 'idle', query: '' });
  });
});

function auditEvent(
  id: string,
  action: string,
  overrides: Partial<AdminAuditEvent> = {},
): AdminAuditEvent {
  return {
    id,
    action,
    actor_id: 'actor-1',
    actor_email: 'admin@test',
    target_type: 'user',
    target_id: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function auditPage(items: AdminAuditEvent[], nextCursor: string | null): AdminAuditPage {
  return { items, next_cursor: nextCursor, has_more: nextCursor !== null };
}

function forbidden(): ApiError {
  return new ApiError({ source: 'http', status: 403, code: 'FORBIDDEN', message: 'no' });
}

describe('admin directory store (E11-F actions + audit)', () => {
  it('loads the audit chain with an exact action filter and de-duplicates boundaries', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminAudit)
      .mockResolvedValueOnce(auditPage([auditEvent('a1', 'admin.user.suspended')], 'c1'))
      .mockResolvedValueOnce(
        auditPage(
          [auditEvent('a1', 'admin.user.suspended'), auditEvent('a2', 'admin.chat.deleted')],
          null,
        ),
      );
    const store = createAdminDirectoryStore({ api });

    await store.loadAudit();
    expect(api.listAdminAudit).toHaveBeenNthCalledWith(1, { action: undefined, limit: 25 });
    expect(store.getSnapshot().audit).toMatchObject({ status: 'ready', hasMore: true });

    await store.loadMoreAudit();
    expect(api.listAdminAudit).toHaveBeenNthCalledWith(2, {
      action: undefined,
      cursor: 'c1',
      limit: 25,
    });
    expect(store.getSnapshot().audit.items.map((event) => event.id)).toEqual(['a1', 'a2']);

    vi.mocked(api.listAdminAudit).mockResolvedValueOnce(auditPage([], null));
    store.setAuditAction('admin.chat.deleted');
    await vi.waitFor(() => {
      expect(store.getSnapshot().audit.status).toBe('ready');
    });
    expect(api.listAdminAudit).toHaveBeenLastCalledWith({
      action: 'admin.chat.deleted',
      limit: 25,
    });
    expect(store.getSnapshot().audit).toMatchObject({ items: [], hasMore: false });
  });

  it('drops a stale audit page when the filter changes mid-flight', async () => {
    const api = createFakeApi();
    const slow = deferred<AdminAuditPage>();
    const fast = deferred<AdminAuditPage>();
    vi.mocked(api.listAdminAudit)
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);
    const store = createAdminDirectoryStore({ api });

    const initial = store.loadAudit();
    store.setAuditAction('admin.user.suspended');
    slow.resolve(auditPage([auditEvent('old', 'settings.updated')], null));
    await initial;
    fast.resolve(auditPage([auditEvent('new', 'admin.user.suspended')], null));
    await vi.waitFor(() => {
      expect(store.getSnapshot().audit.items.map((event) => event.id)).toEqual(['new']);
    });
    expect(store.getSnapshot().audit.action).toBe('admin.user.suspended');
  });

  it('surfaces an audit error and keeps the previous rows', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminAudit).mockResolvedValueOnce(
      auditPage([auditEvent('a1', 'admin.users.viewed')], null),
    );
    const store = createAdminDirectoryStore({ api });

    await store.loadAudit();
    vi.mocked(api.listAdminAudit).mockRejectedValueOnce(forbidden());
    await store.loadAudit({ force: true });
    expect(store.getSnapshot().audit.status).toBe('error');
    expect(store.getSnapshot().audit.error?.status).toBe(403);
    expect(store.getSnapshot().audit.items).toHaveLength(1);
  });

  it('suspends a user, patches the row and re-reads the page', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminUsers)
      .mockResolvedValueOnce(page([user('u1', 'a@test')], null))
      .mockResolvedValueOnce(page([{ ...user('u1', 'a@test'), status: 'SUSPENDED' }], null));
    vi.mocked(api.suspendUser).mockResolvedValue(undefined);
    const store = createAdminDirectoryStore({ api });

    await store.loadUsers();
    const result = await store.changeUserStatus('u1', 'SUSPENDED');

    expect(result).toMatchObject({ ok: true, error: null, alreadyApplied: false });
    expect(api.suspendUser).toHaveBeenCalledWith('u1');
    // Immediately after 204 the chip reflects the server-confirmed state.
    expect(store.getSnapshot().users.items[0]?.status).toBe('SUSPENDED');
    await vi.waitFor(() => {
      expect(api.listAdminUsers).toHaveBeenCalledTimes(2);
    });
    expect(store.getSnapshot().users.items[0]?.status).toBe('SUSPENDED');
  });

  it('does not change the status or drop the row on 403', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminUsers).mockResolvedValue(page([user('u1', 'a@test')], null));
    vi.mocked(api.suspendUser).mockRejectedValueOnce(forbidden());
    const store = createAdminDirectoryStore({ api });

    await store.loadUsers();
    const result = await store.changeUserStatus('u1', 'SUSPENDED');

    expect(result.ok).toBe(false);
    expect(result.error?.status).toBe(403);
    expect(result.alreadyApplied).toBe(false);
    expect(store.getSnapshot().users.items[0]?.status).toBe('ACTIVE');
    expect(store.getSnapshot().users.items).toHaveLength(1);
    // A rejected action is not a reason to re-read the page.
    expect(api.listAdminUsers).toHaveBeenCalledTimes(1);
  });

  it('reconciles a repeat suspend (409) and refreshes the list', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminUsers).mockResolvedValue(
      page([{ ...user('u1', 'a@test'), status: 'SUSPENDED' }], null),
    );
    vi.mocked(api.suspendUser).mockRejectedValueOnce(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'USER_ALREADY_SUSPENDED',
        message: 'already',
      }),
    );
    const store = createAdminDirectoryStore({ api });

    await store.loadUsers();
    const result = await store.changeUserStatus('u1', 'SUSPENDED');

    expect(result).toMatchObject({ ok: false, alreadyApplied: true });
    expect(result.error?.code).toBe('USER_ALREADY_SUSPENDED');
    await vi.waitFor(() => {
      expect(api.listAdminUsers).toHaveBeenCalledTimes(2);
    });
    expect(store.getSnapshot().users.items[0]?.status).toBe('SUSPENDED');
  });

  it('activates a suspended user', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminUsers).mockResolvedValue(
      page([{ ...user('u1', 'a@test'), status: 'ACTIVE' }], null),
    );
    vi.mocked(api.activateUser).mockResolvedValue(undefined);
    const store = createAdminDirectoryStore({ api });

    await store.loadUsers();
    const result = await store.changeUserStatus('u1', 'ACTIVE');

    expect(result.ok).toBe(true);
    expect(api.activateUser).toHaveBeenCalledWith('u1');
    expect(store.getSnapshot().users.items[0]?.status).toBe('ACTIVE');
  });

  it('soft-deletes a chat, removes the row and refreshes the chain', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminChats)
      .mockResolvedValueOnce(
        page([chat('c1', 'ws-1', 'GROUP'), chat('c2', 'ws-1', 'DIRECT')], null),
      )
      .mockResolvedValueOnce(page([chat('c2', 'ws-1', 'DIRECT')], null));
    vi.mocked(api.deleteChat).mockResolvedValue(undefined);
    const store = createAdminDirectoryStore({ api });
    await store.loadChats();

    const result = await store.deleteChat('c1');

    expect(result).toMatchObject({ ok: true, alreadyApplied: false });
    expect(api.deleteChat).toHaveBeenCalledWith('c1');
    expect(store.getSnapshot().chats.items.map((item) => item.id)).toEqual(['c2']);
  });

  it('reconciles CHAT_ALREADY_DELETED but keeps the row on 503', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminChats)
      .mockResolvedValueOnce(
        page([chat('c1', 'ws-1', 'GROUP'), chat('c2', 'ws-1', 'DIRECT')], null),
      )
      .mockResolvedValue(page([chat('c2', 'ws-1', 'DIRECT')], null));
    const store = createAdminDirectoryStore({ api });
    await store.loadChats();

    vi.mocked(api.deleteChat).mockRejectedValueOnce(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'CHAT_ALREADY_DELETED',
        message: 'gone',
      }),
    );
    const repeat = await store.deleteChat('c1');
    expect(repeat).toMatchObject({ ok: false, alreadyApplied: true });
    expect(store.getSnapshot().chats.items.map((item) => item.id)).toEqual(['c2']);

    vi.mocked(api.deleteChat).mockRejectedValueOnce(
      new ApiError({
        source: 'http',
        status: 503,
        code: 'AUTH_UNAVAILABLE',
        message: 'idp down',
      }),
    );
    const failed = await store.deleteChat('c2');
    expect(failed).toMatchObject({ ok: false, alreadyApplied: false });
    expect(failed.error?.status).toBe(503);
    expect(store.getSnapshot().chats.items.map((item) => item.id)).toEqual(['c2']);
  });

  it('removes a chat on 404 and refreshes, without inventing a status', async () => {
    const api = createFakeApi();
    vi.mocked(api.listAdminChats)
      .mockResolvedValueOnce(page([chat('c1', 'ws-1', 'GROUP')], null))
      .mockResolvedValueOnce(page([], null));
    vi.mocked(api.deleteChat).mockRejectedValueOnce(
      new ApiError({ source: 'http', status: 404, code: 'NOT_FOUND', message: 'gone' }),
    );
    const store = createAdminDirectoryStore({ api });
    await store.loadChats();

    const result = await store.deleteChat('c1');

    expect(result).toMatchObject({ ok: false, alreadyApplied: false });
    expect(store.getSnapshot().chats.items).toEqual([]);
    await vi.waitFor(() => {
      expect(api.listAdminChats).toHaveBeenCalledTimes(2);
    });
  });
});
