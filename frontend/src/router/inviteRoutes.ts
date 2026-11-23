/**
 * #79/#100 invite route parsing. The app has no routing library, so the two
 * invite paths are parsed from the pathname here. The raw token is allowed to
 * live in the URL (path or the `invite_token` query used across the
 * login/register round-trip) and is never written to storage.
 */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

function pathnameOf(location: string): string {
  return location.split('?')[0] ?? '/';
}

function parseTokenSegment(
  location: string,
  prefix: string,
): {
  matched: boolean;
  token: string | null;
} {
  const pathname = pathnameOf(location);
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return { matched: false, token: null };
  }
  const raw = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '');
  if (raw.length === 0) return { matched: true, token: null };
  try {
    return { matched: true, token: decodeURIComponent(raw) };
  } catch {
    return { matched: true, token: null };
  }
}

/** `/invite/:token` is the existing channel invitation route. */
export function parseInviteRoute(location: string): { matched: boolean; token: string | null } {
  return parseTokenSegment(location, '/invite');
}

/** `/workspace-invite/:token` is the workspace invitation route (#79/#100). */
export function parseWorkspaceInviteRoute(location: string): {
  matched: boolean;
  token: string | null;
} {
  return parseTokenSegment(location, '/workspace-invite');
}

/** Read the login/register round-trip token; malformed values are ignored. */
export function readInviteToken(location: string): string | null {
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  const token = params.get('invite_token');
  return token && INVITE_TOKEN_RE.test(token) ? token : null;
}

/** Append the token to an auth path without ever storing it. */
export function withInviteToken(path: string, token: string | null): string {
  if (!token || !INVITE_TOKEN_RE.test(token)) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}invite_token=${encodeURIComponent(token)}`;
}

/** Canonical accept/preview path for a validated token. */
export function workspaceInvitePath(token: string): string {
  return `/workspace-invite/${encodeURIComponent(token)}`;
}
