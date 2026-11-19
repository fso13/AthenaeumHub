import { describe, expect, it } from 'vitest';
import { createApi } from '../api/endpoints';
import { ApiClient } from '../api/http';
import { getAccessToken, getDeviceId } from '../auth/session';
import { mockDb } from '../test/server';
import { createOpsStore } from './store';

function createTestOps() {
  const api = createApi(
    new ApiClient({
      baseUrl: 'http://api.test/api/v1',
      timeoutMs: 5_000,
      getToken: getAccessToken,
      getDeviceId,
    }),
    { devSession: true, authMode: 'dev' },
  );
  const store = createOpsStore({ api });
  return { api, store };
}

describe('ops store (E8 setup/admin)', () => {
  it('loads the public setup status without a session', async () => {
    mockDb.admin.setupCompletedAt = null;
    const { store } = createTestOps();

    await store.loadSetupStatus();

    expect(store.getSnapshot().setupStatusStatus).toBe('ready');
    expect(store.getSnapshot().setupStatus).toEqual({
      setup_required: true,
      registration_open: true,
    });
  });

  it('completes setup atomically and then rejects a second completion with 409', async () => {
    mockDb.admin.setupCompletedAt = null;
    const { api, store } = createTestOps();
    await api.bootstrapDevSession();

    const saved = await store.saveSettings(
      {
        smtp_host: 'smtp.example.test',
        smtp_port: 587,
        smtp_from: 'sova@example.test',
        smtp_password: 'super-secret',
        max_chats_per_user: 7,
        max_chats_per_workspace: 70,
        max_workspace_members: 30,
        registration_open: false,
      },
      true,
    );

    expect(saved?.setup_completed).toBe(true);
    expect(store.getSnapshot().setupStatus).toEqual({
      setup_required: false,
      registration_open: false,
    });
    expect(store.getSnapshot().settings?.smtp_configured).toBe(true);
    expect(store.getSnapshot().settings).not.toHaveProperty('smtp_password');
    expect(JSON.stringify(store.getSnapshot().settings)).not.toContain('super-secret');
    expect(mockDb.admin.smtpPasswordStored).toBe(true);
    expect(mockDb.adminSettingsPatches.at(-1)?.completeSetup).toBe(true);

    const second = await store.saveSettings({ max_chats_per_user: 9 }, true);
    expect(second).toBeNull();
    expect(store.getSnapshot().saveError?.status).toBe(409);
    expect(store.getSnapshot().saveError?.code).toBe('SETUP_ALREADY_COMPLETED');
  });

  it('sends a test email only when SMTP is configured and surfaces 503', async () => {
    const { api, store } = createTestOps();
    await api.bootstrapDevSession();

    const missing = await store.sendTestEmail('admin@example.test');
    expect(missing).toBe(false);
    expect(store.getSnapshot().testEmailError?.status).toBe(503);
    expect(store.getSnapshot().testEmailError?.code).toBe('SMTP_UNAVAILABLE');

    mockDb.admin.smtpHost = 'smtp.example.test';
    mockDb.admin.smtpFrom = 'sova@example.test';
    const sent = await store.sendTestEmail('admin@example.test');
    expect(sent).toBe(true);
    expect(store.getSnapshot().testEmailStatus).toBe('sent');
    expect(store.getSnapshot().testEmailTo).toBe('admin@example.test');
    expect(mockDb.adminTestEmails).toEqual(['admin@example.test']);
  });

  it('loads settings and aggregate overview for the admin screen', async () => {
    const { api, store } = createTestOps();
    await api.bootstrapDevSession();

    await store.loadAdmin();

    expect(store.getSnapshot().settingsStatus).toBe('ready');
    expect(store.getSnapshot().overviewStatus).toBe('ready');
    expect(store.getSnapshot().settings?.smtp_configured).toBe(false);
    expect(store.getSnapshot().overview).toMatchObject({
      users: mockDb.authUsers.length,
      workspaces: mockDb.me.workspaces.length,
      chats: Object.keys(mockDb.chats).length,
    });
  });

  it('resets the state on logout and never leaves the SMTP password in it', async () => {
    mockDb.admin.setupCompletedAt = null;
    const { api, store } = createTestOps();
    await api.bootstrapDevSession();
    await store.saveSettings(
      {
        smtp_host: 'smtp.example.test',
        smtp_from: 'sova@example.test',
        smtp_password: 'do-not-keep',
      },
      false,
    );

    store.reset();

    const state = store.getSnapshot();
    expect(state.settings).toBeNull();
    expect(state.setupStatus).toBeNull();
    expect(JSON.stringify(state)).not.toContain('do-not-keep');
  });
});
