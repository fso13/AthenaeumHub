/**
 * #84 client-side mirror of `TranslationProviderUrl.normalize`.
 *
 * The server remains authoritative; this validation only prevents obvious
 * invalid input (non-https, credentials, query/fragment, dot segments) from
 * being sent. There is deliberately no API-key/secret field anywhere.
 */

export const TRANSLATION_URL_MAX = 2048;

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
  if (url.protocol !== 'https:') return 'notHttps';
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

/** True when the editable fields differ from the last server response. */
export function translationDraftChanged(
  settings: { enabled: boolean; url: string } | null,
  enabled: boolean,
  url: string,
): boolean {
  if (!settings) return true;
  return settings.enabled !== enabled || settings.url !== url.trim();
}
