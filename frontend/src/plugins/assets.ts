/**
 * D1.2 (#86): pure helpers for external plugin package assets.
 *
 * The server exposes an authenticated API path (`entry_url`), never a storage
 * URL or a presigned link. These helpers translate that path into a request the
 * existing `ApiClient` can send, and resolve the relative references of a
 * package without ever letting a `..` segment escape the package root.
 */

/** Contract limits from `docs/PLUGIN-DEVELOPMENT.md` §3. */
export const PLUGIN_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const PLUGIN_MAX_UNPACKED_BYTES = 10 * 1024 * 1024;
export const PLUGIN_MAX_FILES = 200;
export const PLUGIN_ARCHIVE_EXTENSION = '.zip';

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ASSET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASSET_API_RE =
  /\/plugins\/([a-z][a-z0-9-]{0,63})\/assets\/([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/;

export interface PluginAssetLocation {
  pluginId: string;
  /** Path inside the package, e.g. `assets/logo.svg`. */
  assetPath: string;
}

/** Segment grammar shared by the backend and the host-side resolver. */
export function isSafePluginAssetPath(path: string): boolean {
  if (path.length < 1 || path.length > 512) return false;
  return path.split('/').every((segment) => ASSET_SEGMENT_RE.test(segment));
}

/**
 * Parse the contract `entry_url` (`/api/v1/plugins/{id}/assets/index.html`).
 * Absolute URLs are accepted only to read their pathname; query/hash are
 * ignored. Returns `null` for anything that is not a package asset path.
 */
export function parsePluginAssetUrl(url: string): PluginAssetLocation | null {
  let pathname = url.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  const clean = pathname.split(/[?#]/)[0] ?? '';
  const match = ASSET_API_RE.exec(clean);
  if (!match) return null;
  const pluginId = match[1];
  const assetPath = match[2];
  if (!pluginId || !assetPath || !isSafePluginAssetPath(assetPath)) return null;
  return { pluginId, assetPath };
}

/**
 * Convert `entry_url` to a path relative to the configured API base. The
 * contract base is `/api/v1`; only the stable `/plugins/...` suffix is kept so
 * an absolute deployment URL cannot double-prefix the client base.
 */
export function pluginAssetApiPath(entryUrl: string): string {
  const parsed = parsePluginAssetUrl(entryUrl);
  if (!parsed) throw new Error('entry_url is not a plugin asset path');
  return `/plugins/${parsed.pluginId}/assets/${parsed.assetPath}`;
}

/**
 * Resolve a relative package reference against another package file (entry or
 * nested CSS). Absolute URLs, protocol-relative URLs, backslashes and escaped
 * roots are rejected (`null`).
 */
export function resolveRelativeAssetPath(fromAssetPath: string, reference: string): string | null {
  if (!isSafePluginAssetPath(fromAssetPath)) return null;
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\/|\\)/.test(trimmed)) return null;
  if (trimmed.includes('\\')) return null;

  const directory = fromAssetPath.slice(0, fromAssetPath.lastIndexOf('/') + 1);
  const base = `https://plugin.invalid/assets/${directory}`;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }
  const candidate = resolved.pathname.replace(/^\/assets\//, '');
  if (candidate === resolved.pathname) return null;
  if (!isSafePluginAssetPath(candidate)) return null;
  return candidate;
}

/**
 * Resolve a relative package reference against the entry document directory.
 */
export function resolvePluginAssetPath(entryUrl: string, reference: string): string | null {
  const entry = parsePluginAssetUrl(entryUrl);
  if (!entry) return null;
  return resolveRelativeAssetPath(entry.assetPath, reference);
}

/**
 * API path for a same-package relative asset, or `null` when the reference is
 * invalid. Used by the authenticated asset fetch of the plugin runner.
 */
export function pluginRelativeAssetApiPath(entryUrl: string, reference: string): string | null {
  const entry = parsePluginAssetUrl(entryUrl);
  if (!entry) return null;
  const resolved = resolveRelativeAssetPath(entry.assetPath, reference);
  if (!resolved) return null;
  return `/plugins/${entry.pluginId}/assets/${resolved}`;
}

/** `null` means the file is acceptable for upload; otherwise a UX error key. */
export type PluginPackageClientError = 'empty' | 'extension' | 'too-large' | 'not-zip-mime';

export function validatePluginPackageFile(
  file: Pick<File, 'name' | 'size' | 'type'>,
): PluginPackageClientError | null {
  if (file.size <= 0) return 'empty';
  if (!file.name.toLowerCase().endsWith(PLUGIN_ARCHIVE_EXTENSION)) return 'extension';
  if (file.size > PLUGIN_MAX_ARCHIVE_BYTES) return 'too-large';
  // Browsers often report an empty type for `.zip`; only reject an explicitly
  // different, non-empty MIME. The server is the authoritative ZIP validator.
  if (
    file.type &&
    !/^(application\/zip|application\/x-zip-compressed|multipart\/x-zip)$/i.test(file.type)
  ) {
    return 'not-zip-mime';
  }
  return null;
}

/** Closed content-type fallback for packages served as octet-stream. */
export function pluginAssetContentType(path: string, headerType?: string | null): string {
  if (headerType && headerType !== 'application/octet-stream') return headerType;
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    txt: 'text/plain; charset=utf-8',
  };
  return types[extension] ?? 'application/octet-stream';
}

export function isPluginId(value: string): boolean {
  return PLUGIN_ID_RE.test(value);
}
