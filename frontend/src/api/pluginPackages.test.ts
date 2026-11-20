import { describe, expect, it, vi } from 'vitest';
import { getSession, setSession } from '../auth/session';
import { mockDb } from '../test/server';
import { mockSession } from '../mocks/fixtures';
import { createMockPluginZip, createStoredZip } from '../mocks/pluginPackage';
import { setMockPlatformAdmin } from '../mocks/db';
import { createApi } from './endpoints';
import { ApiClient } from './http';

async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function makeApi() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => getSession()?.access_token ?? null,
    getDeviceId: () => getSession()?.device.id ?? null,
  });
  return createApi(client, { devSession: true });
}

describe('D1.2 admin plugin package API', () => {
  it('lists nothing initially and installs a valid ZIP with metadata', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();

    expect(await api.listAdminPlugins()).toEqual({ items: [] });
    expect(mockDb.adminPluginListRequests).toBe(1);

    const zip = createMockPluginZip({ id: 'hello-panel', version: '1.2.3' });
    const installed = await api.installPluginPackage(zip);

    expect(installed).toMatchObject({
      id: 'hello-panel',
      name: 'Hello panel',
      version: '1.2.3',
      author: 'Sova',
      entry: 'index.html',
      permissions: ['chat.messages.read'],
      modes: ['MANAGED'],
    });
    expect(installed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mockDb.pluginPackageInstallRequests).toHaveLength(1);
    expect(mockDb.pluginPackageInstallRequests[0]).toMatchObject({
      fileName: 'hello-panel.zip',
      deviceId: mockSession.device.id,
    });

    const listed = await api.listAdminPlugins();
    expect(listed.items.map((item) => item.id)).toEqual(['hello-panel']);

    const catalog = await api.listPlugins();
    const external = catalog.items.find((plugin) => plugin.id === 'hello-panel');
    expect(external).toMatchObject({
      kind: 'EXTERNAL',
      version: '1.2.3',
      author: 'Sova',
      entry_url: '/api/v1/plugins/hello-panel/assets/index.html',
    });

    const entry = await api.getPluginAsset(external?.entry_url ?? '');
    expect(await blobText(entry)).toContain('Hello panel');
    expect(entry.type).toMatch(/^text\/html/);

    const script = await api.getPluginAsset(external?.entry_url ?? '', 'assets/app.js');
    expect(await blobText(script)).toContain('addEventListener');
  });

  it('reports upload progress without inventing a server result', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();
    const onProgress = vi.fn();
    const zip = createMockPluginZip({ id: 'progress-panel' });

    await api.installPluginPackage(zip, { onProgress });

    // jsdom may not emit a final upload progress event; the contract result is
    // still the server row and progress never becomes a success signal.
    expect(mockDb.pluginPackages.map((pkg) => pkg.id)).toEqual(['progress-panel']);
    if (onProgress.mock.calls.length > 0) {
      for (const [loaded, total] of onProgress.mock.calls) {
        expect(loaded).toBeGreaterThanOrEqual(0);
        expect(total).toBeGreaterThanOrEqual(loaded);
      }
    }
  });

  it('rejects invalid archives, duplicates and reserved ids', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();

    const notZip = new File([new TextEncoder().encode('not a zip')], 'bad.zip', {
      type: 'application/zip',
    });
    await expect(api.installPluginPackage(notZip)).rejects.toMatchObject({
      status: 400,
      code: 'PLUGIN_PACKAGE_INVALID',
    });

    const traversal = createStoredZip([
      { path: 'manifest.json', data: new TextEncoder().encode('{}') },
      { path: '../escape.html', data: new TextEncoder().encode('<h1>x</h1>') },
    ]);
    const traversalFile = new File([new Uint8Array(traversal).buffer], 'traversal.zip', {
      type: 'application/zip',
    });
    await expect(api.installPluginPackage(traversalFile)).rejects.toMatchObject({
      status: 400,
      code: 'PLUGIN_PACKAGE_INVALID',
    });

    await api.installPluginPackage(createMockPluginZip({ id: 'dupe-panel' }));
    await expect(
      api.installPluginPackage(createMockPluginZip({ id: 'dupe-panel' })),
    ).rejects.toMatchObject({ status: 409, code: 'PLUGIN_ALREADY_INSTALLED' });

    await expect(
      api.installPluginPackage(createMockPluginZip({ id: 'polls' })),
    ).rejects.toMatchObject({ status: 409, code: 'PLUGIN_ID_RESERVED' });
  });

  it('rejects an oversized ZIP with 413 before parsing it', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.zip', {
      type: 'application/zip',
    });

    await expect(api.installPluginPackage(oversized)).rejects.toMatchObject({
      status: 413,
      code: 'PLUGIN_PACKAGE_TOO_LARGE',
    });
  });

  it('keeps admin install/uninstall platform_admin-only', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, false);
    const api = makeApi();

    await expect(api.listAdminPlugins()).rejects.toMatchObject({ status: 403 });
    await expect(api.installPluginPackage(createMockPluginZip())).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expect(api.uninstallPluginPackage('hello-panel')).rejects.toMatchObject({ status: 403 });
    expect(mockDb.pluginPackages).toHaveLength(0);
  });

  it('uninstalls the package, removes assets and hides it from the catalog', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();
    const zip = createMockPluginZip({ id: 'remove-me' });
    const installed = await api.installPluginPackage(zip);

    await api.uninstallPluginPackage(installed.id);
    expect(mockDb.pluginPackageUninstallRequests).toEqual(['remove-me']);
    expect((await api.listAdminPlugins()).items).toHaveLength(0);
    expect((await api.listPlugins()).items.some((plugin) => plugin.id === 'remove-me')).toBe(false);

    await expect(
      api.getPluginAsset('/api/v1/plugins/remove-me/assets/index.html'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(api.uninstallPluginPackage('remove-me')).rejects.toMatchObject({
      status: 404,
      code: 'PLUGIN_NOT_FOUND',
    });
  });

  it('never builds a traversal asset request', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();
    await api.installPluginPackage(createMockPluginZip({ id: 'safe-panel' }));
    const entryUrl = '/api/v1/plugins/safe-panel/assets/index.html';

    await expect(api.getPluginAsset(entryUrl, '../../manifest.json')).rejects.toMatchObject({
      code: 'PLUGIN_ASSET_INVALID',
    });
    await expect(api.getPluginAsset(entryUrl, 'https://evil.test/x.js')).rejects.toMatchObject({
      code: 'PLUGIN_ASSET_INVALID',
    });
    await expect(
      api.getPluginAsset('/api/v1/plugins/safe-panel/assets/missing.html'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('requires a session for package assets', async () => {
    setSession(mockSession);
    setMockPlatformAdmin(mockDb, true);
    const api = makeApi();
    await api.installPluginPackage(createMockPluginZip({ id: 'auth-panel' }));
    const entryUrl = '/api/v1/plugins/auth-panel/assets/index.html';

    // The API attaches the bearer; an unauthenticated direct request is 401.
    const response = await fetch('http://api.test/api/v1' + entryUrl.replace('/api/v1', ''));
    expect(response.status).toBe(401);
  });
});
