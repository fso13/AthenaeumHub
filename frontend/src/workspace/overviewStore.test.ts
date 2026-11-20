import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem';
import type { WorkspaceOverview } from '../api/types';
import { createWorkspaceOverviewStore } from './overviewStore';

function overview(total: number): WorkspaceOverview {
  return {
    members: { total: 3, online: 1 },
    chats: 2,
    messages: { total, last_24h: 1 },
    files: { total: 1, used_bytes: 10, reserved_bytes: 0 },
    dlp: { events_last_24h: 0 },
    storage: { used_bytes: 10, quota_bytes: 100 },
    audit_recent: [],
    generated_at: '2026-11-20T12:00:00Z',
  };
}

describe('#84 workspace overview store', () => {
  it('loads one workspace once and keeps the last good snapshot on error', async () => {
    const api = { getWorkspaceOverview: vi.fn() };
    const store = createWorkspaceOverviewStore({ api });
    store.setWorkspace('ws-1');
    api.getWorkspaceOverview.mockResolvedValueOnce(overview(5));

    await store.load();
    expect(store.getSnapshot()).toMatchObject({
      workspaceId: 'ws-1',
      status: 'ready',
      data: { messages: { total: 5 } },
    });

    await store.load();
    expect(api.getWorkspaceOverview).toHaveBeenCalledTimes(1);

    api.getWorkspaceOverview.mockRejectedValueOnce(
      new ApiError({ source: 'http', status: 503, code: 'UNAVAILABLE', message: 'boom' }),
    );
    await store.load(true);
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().data?.messages.total).toBe(5);
    expect(store.getSnapshot().error?.status).toBe(503);
  });

  it('drops data and ignores late responses after a workspace switch', async () => {
    const pending: Array<(value: WorkspaceOverview) => void> = [];
    const api = {
      getWorkspaceOverview: vi.fn(
        () => new Promise<WorkspaceOverview>((resolve) => pending.push(resolve)),
      ),
    };
    const store = createWorkspaceOverviewStore({ api });
    store.setWorkspace('ws-1');
    const first = store.load();
    store.setWorkspace('ws-2');
    pending[0]?.(overview(1));
    await first;

    expect(store.getSnapshot()).toMatchObject({ workspaceId: 'ws-2', data: null, status: 'idle' });

    const second = store.load();
    pending[1]?.(overview(2));
    await second;
    expect(store.getSnapshot()).toMatchObject({
      workspaceId: 'ws-2',
      status: 'ready',
      data: { messages: { total: 2 } },
    });
  });

  it('resets to the idle state on logout', async () => {
    const api = { getWorkspaceOverview: vi.fn().mockResolvedValue(overview(1)) };
    const store = createWorkspaceOverviewStore({ api });
    store.setWorkspace('ws-1');
    await store.load();
    store.reset();
    expect(store.getSnapshot()).toEqual({
      workspaceId: null,
      data: null,
      status: 'idle',
      error: null,
    });
  });
});
