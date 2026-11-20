import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * CSP is injected into the production HTML only: Vite's dev server needs inline
 * scripts for HMR, so a strict meta-CSP would break local development.
 * The API origin is derived from VITE_API_BASE_URL at build time.
 */
function contentSecurityPolicy(apiBaseUrl: string, wsUrl: string, mediaOrigins: string[]): Plugin {
  const apiOrigin = /^https?:\/\//.test(apiBaseUrl) ? new URL(apiBaseUrl).origin : "'self'";
  const wsOrigins = new Set<string>();
  if (apiOrigin !== "'self'") {
    const apiUrl = new URL(apiOrigin);
    wsOrigins.add(`${apiUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiUrl.host}`);
  }
  if (/^wss?:\/\//.test(wsUrl)) {
    wsOrigins.add(new URL(wsUrl).origin);
  }
  const mediaSources = mediaOrigins.filter((origin) => /^https?:\/\//i.test(origin));
  const connectSources = [...new Set(["'self'", apiOrigin, ...wsOrigins, ...mediaSources])].join(
    ' ',
  );
  const imageSources = [...new Set(["'self'", 'data:', 'blob:', ...mediaSources])].join(' ');

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources}`,
    `media-src ${imageSources}`,
    "font-src 'self'",
    `connect-src ${connectSources}`,
    "frame-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return {
    name: 'krug-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBaseUrl = env.VITE_API_BASE_URL || 'http://localhost:8081/api/v1';
  const proxyTarget = env.VITE_API_PROXY_TARGET;
  const wsProxyTarget = env.VITE_WS_PROXY_TARGET || proxyTarget || 'http://localhost:8081';
  const wsUrl = env.VITE_WS_URL || '';
  // Browser WS always goes through the same-origin Vite proxy by default; the
  // backend advertises ws_url in the ticket, and the client resolves loopback
  // targets to /ws so cookies/origin/CSP behave like API calls.
  const proxy = {
    '/ws': { target: wsProxyTarget, changeOrigin: true, ws: true },
    ...(proxyTarget ? { '/api': { target: proxyTarget, changeOrigin: true } } : {}),
  };
  const mediaOrigins = (env.VITE_MEDIA_ORIGINS || 'http://localhost:9002')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    plugins: [react(), contentSecurityPolicy(apiBaseUrl, wsUrl, mediaOrigins)],
    server: {
      port: 5173,
      strictPort: true,
      proxy,
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy,
    },
    build: {
      sourcemap: false,
    },
  };
});
