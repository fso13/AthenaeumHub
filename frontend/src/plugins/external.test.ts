import { describe, expect, it } from 'vitest';
import {
  isSafePluginAssetPath,
  parsePluginAssetUrl,
  pluginAssetApiPath,
  pluginAssetContentType,
  pluginRelativeAssetApiPath,
  resolvePluginAssetPath,
  validatePluginPackageFile,
} from './assets';
import { buildPluginDocument } from './externalDocument';
import {
  PLUGIN_MESSAGE_MAX_BYTES,
  PLUGIN_PROTOCOL_VERSION,
  buildPluginInitMessage,
  buildPluginRpcErrorResult,
  parsePluginMessage,
} from './messages';

const ENTRY = '/api/v1/plugins/hello-panel/assets/index.html';

describe('D1.2 plugin asset paths', () => {
  it('parses only contract package asset URLs', () => {
    expect(parsePluginAssetUrl(ENTRY)).toEqual({
      pluginId: 'hello-panel',
      assetPath: 'index.html',
    });
    expect(
      parsePluginAssetUrl('https://api.test/api/v1/plugins/hello-panel/assets/ui/index.html?x=1#y'),
    ).toEqual({ pluginId: 'hello-panel', assetPath: 'ui/index.html' });
    expect(parsePluginAssetUrl('https://evil.test/index.html')).toBeNull();
    expect(parsePluginAssetUrl('/api/v1/plugins/Bad_Id/assets/index.html')).toBeNull();
    expect(pluginAssetApiPath(ENTRY)).toBe('/plugins/hello-panel/assets/index.html');
  });

  it('resolves same-package references and rejects escapes', () => {
    expect(resolvePluginAssetPath(ENTRY, 'assets/app.js')).toBe('assets/app.js');
    expect(resolvePluginAssetPath(ENTRY, './assets/app.js')).toBe('assets/app.js');
    expect(resolvePluginAssetPath(ENTRY, '../manifest.json')).toBeNull();
    expect(resolvePluginAssetPath(ENTRY, '/etc/passwd')).toBeNull();
    expect(resolvePluginAssetPath(ENTRY, 'https://evil.test/app.js')).toBeNull();
    expect(resolvePluginAssetPath(ENTRY, '//evil.test/app.js')).toBeNull();
    expect(resolvePluginAssetPath(ENTRY, 'assets\\app.js')).toBeNull();
    expect(resolvePluginAssetPath(ENTRY, '%2e%2e/manifest.json')).toBeNull();
    expect(pluginRelativeAssetApiPath(ENTRY, 'assets/app.js')).toBe(
      '/plugins/hello-panel/assets/assets/app.js',
    );
    expect(pluginRelativeAssetApiPath(ENTRY, '../manifest.json')).toBeNull();
  });

  it('enforces the segment grammar and closed content types', () => {
    expect(isSafePluginAssetPath('index.html')).toBe(true);
    expect(isSafePluginAssetPath('assets/logo.svg')).toBe(true);
    expect(isSafePluginAssetPath('.hidden')).toBe(false);
    expect(isSafePluginAssetPath('assets//logo.svg')).toBe(false);
    expect(isSafePluginAssetPath('assets/../logo.svg')).toBe(false);
    expect(isSafePluginAssetPath('assets\\logo.svg')).toBe(false);
    expect(pluginAssetContentType('app.js', 'application/octet-stream')).toMatch(/javascript/);
    expect(pluginAssetContentType('blob.bin', null)).toBe('application/octet-stream');
  });

  it('validates the obvious file shape before upload', () => {
    expect(
      validatePluginPackageFile({ name: 'panel.zip', size: 10, type: 'application/zip' }),
    ).toBeNull();
    expect(validatePluginPackageFile({ name: 'panel.zip', size: 0, type: '' })).toBe('empty');
    expect(validatePluginPackageFile({ name: 'panel.html', size: 10, type: '' })).toBe('extension');
    expect(
      validatePluginPackageFile({ name: 'panel.zip', size: 5 * 1024 * 1024 + 1, type: '' }),
    ).toBe('too-large');
    expect(validatePluginPackageFile({ name: 'panel.zip', size: 10, type: 'text/html' })).toBe(
      'not-zip-mime',
    );
  });
});

describe('D1.2 plugin document builder', () => {
  const files: Record<string, { type: string; body: string }> = {
    'assets/app.js': { type: 'text/javascript', body: 'console.log("plugin-ok");' },
    'assets/app.css': {
      type: 'text/css',
      body: 'body { background: url("../assets/logo.svg"); }',
    },
    'assets/logo.svg': {
      type: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    },
  };
  const loadAsset = async (path: string): Promise<Blob> => {
    const record = files[path];
    if (!record) throw new Error(`missing ${path}`);
    return new Blob([record.body], { type: record.type });
  };

  it('inerts the package and inlines only same-package assets', async () => {
    const html = `<!doctype html><html><head>
      <base href="https://evil.test/">
      <meta http-equiv="refresh" content="0;url=https://evil.test/">
      <link rel="stylesheet" href="assets/app.css">
      </head><body>
      <a href="https://evil.test/escape">escape</a>
      <a href="#inside">inside</a>
      <img src="assets/logo.svg" alt="logo">
      <img src="https://evil.test/tracker.png" alt="remote">
      <script src="assets/app.js"></script>
      <script src="https://evil.test/remote.js"></script>
    </body></html>`;

    const documentHtml = await buildPluginDocument({ html, entryUrl: ENTRY, loadAsset });
    const parsed = new DOMParser().parseFromString(documentHtml, 'text/html');

    const csp = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(csp?.getAttribute('content')).toContain("default-src 'none'");
    expect(csp?.getAttribute('content')).toContain("connect-src 'none'");
    expect(parsed.querySelector('base')).toBeNull();
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(documentHtml).not.toContain('https://evil.test');
    expect(parsed.querySelector('a[href="https://evil.test/escape"]')).toBeNull();
    expect(parsed.querySelector('a[href="#inside"]')).not.toBeNull();

    const inlineScript = parsed.querySelector('script:not([src])');
    expect(inlineScript?.textContent).toContain('plugin-ok');
    expect(parsed.querySelectorAll('script[src]')).toHaveLength(0);

    const style = parsed.querySelector('style');
    expect(style?.textContent).toContain('data:image/svg+xml');
    expect(style?.textContent).not.toContain('../assets/logo.svg');

    const image = parsed.querySelector('img[alt="logo"]');
    expect(image?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(parsed.querySelector('img[alt="remote"]')?.getAttribute('src')).toBeNull();
  });

  it('keeps inline scripts without asking the network', async () => {
    const html =
      '<html><head></head><body><script>document.title="x"</script><p>ok</p></body></html>';
    const documentHtml = await buildPluginDocument({
      html,
      entryUrl: ENTRY,
      loadAsset,
    });
    const parsed = new DOMParser().parseFromString(documentHtml, 'text/html');
    expect(parsed.querySelector('script')?.textContent).toContain('document.title');
    expect(parsed.body.textContent).toContain('ok');
  });
});

describe('D1.2 plugin postMessage protocol', () => {
  it('accepts only the documented envelope', () => {
    expect(parsePluginMessage({ v: 1, type: 'ready' })).toEqual({ type: 'ready' });
    expect(
      parsePluginMessage({ v: 1, type: 'rpc', id: 'r1', method: 'chat.read', params: {} }),
    ).toEqual({ type: 'rpc', id: 'r1', method: 'chat.read', params: {} });
    expect(parsePluginMessage({ v: 1, type: 'log', level: 'info', message: 'hi' })).toEqual({
      type: 'log',
      level: 'info',
      message: 'hi',
    });
    expect(parsePluginMessage({ v: 2, type: 'ready' })).toBeNull();
    expect(parsePluginMessage({ v: 1, type: 'rpc', id: '', method: 'x' })).toBeNull();
    expect(parsePluginMessage({ v: 1, type: 'rpc', id: 'r', method: 'x'.repeat(200) })).toBeNull();
    expect(parsePluginMessage({ v: 1, type: 'log', level: 'error', message: 'hi' })).toBeNull();
    expect(parsePluginMessage('ready')).toBeNull();
    expect(parsePluginMessage(null)).toBeNull();
  });

  it('caps message size and depth', () => {
    const huge = {
      v: 1,
      type: 'log',
      level: 'info',
      message: 'x'.repeat(PLUGIN_MESSAGE_MAX_BYTES),
    };
    expect(parsePluginMessage(huge)).toBeNull();
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10; index += 1) nested = { nested };
    expect(
      parsePluginMessage({ v: 1, type: 'rpc', id: 'r', method: 'm', params: nested }),
    ).toBeNull();
  });

  it('builds init without any secret and a stable RPC error', () => {
    const init = buildPluginInitMessage({
      pluginId: 'hello-panel',
      version: '1.0.0',
      permissions: ['chat.messages.read'],
      locale: 'ru',
      theme: 'light',
      chatId: 'chat-1',
    });
    expect(init).toMatchObject({
      v: PLUGIN_PROTOCOL_VERSION,
      type: 'init',
      plugin_id: 'hello-panel',
      version: '1.0.0',
      permissions: ['chat.messages.read'],
      chat_id: 'chat-1',
    });
    expect(JSON.stringify(init)).not.toMatch(/token|secret|password/i);
    expect(buildPluginRpcErrorResult('r1')).toMatchObject({
      v: 1,
      type: 'rpc_result',
      id: 'r1',
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' },
    });
  });
});
