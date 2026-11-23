/**
 * #84/#104 client-side mirror of `TranslationProviderUrl.normalize` and the provider
 * protocol hint.
 *
 * The server remains authoritative; this validation only prevents obvious invalid input
 * (public plain http, credentials, query/fragment, dot segments) from being sent. There is
 * deliberately no API-key/secret field anywhere.
 */

export const TRANSLATION_URL_MAX = 2048;

export type TranslationProviderKind = 'AUTO' | 'CUSTOM' | 'LIBRETRANSLATE';

export type TranslationUrlIssue =
  | 'tooLong'
  | 'whitespace'
  | 'notAbsolute'
  | 'notHttps'
  | 'noHost'
  | 'credentials'
  | 'query'
  | 'fragment'
  | 'dotSegments'
  | 'port';

/**
 * True for hosts that cannot be reached from the public internet: Docker/compose
 * single-label service names, loopback, RFC 1918, link-local and common internal TLDs.
 * Plain http is accepted only for these (self-hosted LibreTranslate).
 */
export function isInternalTranslationHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1] ?? 0);
    const b = Number(ipv4[2] ?? 0);
    const c = Number(ipv4[3] ?? 0);
    const d = Number(ipv4[4] ?? 0);
    if ([a, b, c, d].some((part) => part > 255)) return false;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  // A single-label name is a compose service / internal DNS name, never a public FQDN.
  // Anything left with a colon is a public IPv6 literal.
  return !host.includes('.') && !host.includes(':');
}

/** Returns `null` for a valid URL or for an empty (clear) value. */
export function validateTranslationUrl(raw: string): TranslationUrlIssue | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > TRANSLATION_URL_MAX) return 'tooLong';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || /\s/.test(char)) return 'whitespace';
  }

  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const pathPart = withoutScheme.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'dotSegments';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'notAbsolute';
  }
  if (url.protocol === 'http:') {
    if (!isInternalTranslationHost(url.hostname)) return 'notHttps';
  } else if (url.protocol !== 'https:') {
    return 'notHttps';
  }
  if (!url.hostname) return 'noHost';
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (url.search !== '') return 'query';
  if (url.hash !== '') return 'fragment';
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port';
  }
  return null;
}

/** True when the URL's last path segment is `translate` (auto LibreTranslate). */
export function isLibreTranslateUrl(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    return false;
  }
  return path.replace(/\/+$/, '').toLowerCase().endsWith('/translate');
}

/**
 * What the adapter will use for the current URL/provider pair. Shown as a hint so an
 * administrator is never surprised by the AUTO heuristic.
 */
export function resolveTranslationProvider(
  provider: TranslationProviderKind,
  url: string,
): TranslationProviderKind {
  if (provider !== 'AUTO') return provider;
  return isLibreTranslateUrl(url) ? 'LIBRETRANSLATE' : 'CUSTOM';
}

/** True when the editable fields differ from the last server response. */
export function translationDraftChanged(
  settings: { enabled: boolean; url: string; provider: TranslationProviderKind } | null,
  enabled: boolean,
  url: string,
  provider: TranslationProviderKind,
): boolean {
  if (!settings) return true;
  return (
    settings.enabled !== enabled || settings.url !== url.trim() || settings.provider !== provider
  );
}
