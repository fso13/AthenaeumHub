import { describe, expect, it } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { IDS, mockSession } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { ApiError } from './problem';
import { contentDispositionFilename, createApi } from './endpoints';
import { ApiClient } from './http';

function makeApi() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
  return createApi(client, { devSession: true });
}

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('P0-3 security API', () => {
  it('maps every list/query operation to the contract path, query and headers', async () => {
    setSession(mockSession);
    const api = makeApi();

    const policies = await api.listWorkspaceDlpPolicies(IDS.workspace);
    expect(policies.items).toHaveLength(2);
    expect(mockDb.security.policyRequests.at(-1)).toMatchObject({
      action: 'list',
      deviceId: mockSession.device.id,
    });

    const events = await api.listWorkspaceDlpEvents(IDS.workspace, {
      policyId: 'c0000000-0000-4000-8000-000000000001',
      action: 'BLOCK',
      limit: 1,
    });
    expect(events.items).toHaveLength(1);
    expect(mockDb.security.eventRequests.at(-1)).toMatchObject({
      policyId: 'c0000000-0000-4000-8000-000000000001',
      action: 'BLOCK',
      cursor: null,
      limit: 1,
    });

    const audit = await api.listWorkspaceAudit(IDS.workspace, {
      action: 'workspace.security.updated',
      actorId: IDS.user,
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
      limit: 1,
    });
    expect(audit.items).toHaveLength(1);
    expect(mockDb.security.auditRequests.at(-1)).toMatchObject({
      action: 'workspace.security.updated',
      actorId: IDS.user,
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
      limit: 1,
    });

    const sessions = await api.listWorkspaceSessions(IDS.workspace, { limit: 2 });
    expect(sessions.items).toHaveLength(2);
    expect(mockDb.security.sessionRequests.at(-1)).toEqual({ cursor: null, limit: 2 });

    const security = await api.getWorkspaceSecurity(IDS.workspace);
    expect(security).toMatchObject({
      require_2fa: false,
      session_timeout_minutes: 60,
      dlp_enabled: true,
      retention_days: 30,
    });

    const updated = await api.updateWorkspaceSecurity(IDS.workspace, { require_2fa: true });
    expect(updated.require_2fa).toBe(true);
    expect(mockDb.security.settingsPatches.at(-1)).toEqual({ require_2fa: true });
  });

  it('creates, edits and deletes a DLP policy through the contract methods', async () => {
    setSession(mockSession);
    const api = makeApi();

    const created = await api.createWorkspaceDlpPolicy(IDS.workspace, {
      name: 'Контракты',
      action: 'WARN',
      pattern_type: 'PATTERN',
      pattern: 'contract-*',
      enabled: true,
    });
    expect(created).toMatchObject({ name: 'Контракты', action: 'WARN' });
    expect(mockDb.security.policyRequests.at(-1)?.action).toBe('create');

    const updated = await api.updateWorkspaceDlpPolicy(IDS.workspace, created.id, {
      name: 'Контракты и сметы',
      enabled: false,
    });
    expect(updated).toMatchObject({ name: 'Контракты и сметы', enabled: false });
    expect(mockDb.security.policyRequests.at(-1)?.action).toBe('update');

    await api.deleteWorkspaceDlpPolicy(IDS.workspace, created.id);
    expect(mockDb.security.policyRequests.at(-1)?.action).toBe('delete');
    expect(mockDb.security.dlpPolicies.some((policy) => policy.id === created.id)).toBe(false);
  });

  it('revokes one session and revoke-all spares the current session', async () => {
    setSession(mockSession);
    const api = makeApi();
    await api.revokeWorkspaceSession(IDS.workspace, 'f0000000-0000-4000-8000-000000000002');
    expect(mockDb.security.sessionRevokeRequests).toContain('f0000000-0000-4000-8000-000000000002');

    const result = await api.revokeAllWorkspaceSessions(IDS.workspace);
    expect(result.revoked_sessions).toBe(2);
    expect(result.affected_users).toBe(1);
    expect(mockDb.security.sessions).toHaveLength(1);
    expect(mockDb.security.sessions[0]?.current).toBe(true);
  });

  it('downloads the bounded export as a Blob with rows/truncation headers', async () => {
    setSession(mockSession);
    const api = makeApi();
    mockDb.security.auditExportLimit = 2;

    const csv = await api.exportWorkspaceAudit(IDS.workspace, {
      format: 'csv',
      action: 'workspace.dlp.policy.created',
    });
    expect(csv.blob.size).toBeGreaterThan(0);
    expect(csv.blob.type).toContain('text/csv');
    expect(csv.rows).toBe(1);
    expect(csv.truncated).toBe(false);
    expect(csv.filename).toMatch(/^workspace-audit-.*\.csv$/);
    const text = await readText(csv.blob);
    expect(text.split('\r\n')[0]).toBe('created_at,action,actor_id,target_type,target_id');
    expect(text).toContain('workspace.dlp.policy.created');
    expect(mockDb.security.exportRequests.at(-1)).toMatchObject({
      format: 'csv',
      action: 'workspace.dlp.policy.created',
    });

    const json = await api.exportWorkspaceAudit(IDS.workspace, { format: 'json' });
    expect(json.blob.type).toContain('application/json');
    expect(json.rows).toBe(2);
    expect(json.truncated).toBe(true);
    expect(json.filename).toMatch(/\.json$/);
    const parsed = JSON.parse(await readText(json.blob)) as {
      items: unknown[];
      exported_rows: number;
      truncated: boolean;
    };
    expect(parsed.items).toHaveLength(2);
    expect(parsed.exported_rows).toBe(2);
    expect(parsed.truncated).toBe(true);
  });

  it('surfaces the Keycloak 503 as an ApiError with Retry-After', async () => {
    setSession(mockSession);
    mockDb.security.forceSessionsError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'down',
      retryAfterSeconds: 5,
    };
    const api = makeApi();
    let caught: unknown;
    try {
      await api.listWorkspaceSessions(IDS.workspace);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(503);
    expect(apiError.code).toBe('AUTH_UNAVAILABLE');
    expect(apiError.retryAfterSeconds).toBe(5);
  });

  it('sanitizes Content-Disposition filenames', () => {
    expect(contentDispositionFilename('attachment; filename="workspace-audit.csv"')).toBe(
      'workspace-audit.csv',
    );
    expect(
      contentDispositionFilename("attachment; filename*=UTF-8''%D0%B0%D1%83%D0%B4%D0%B8%D1%82.csv"),
    ).toBe('аудит.csv');
    expect(contentDispositionFilename('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(contentDispositionFilename(null)).toBeNull();
  });
});
