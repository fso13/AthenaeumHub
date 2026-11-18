/**
 * D1-FE1: workspace section routing.
 *
 * The chat is the default surface; sections live in `?view=...` so they are
 * linkable and the browser back button keeps working. The active chat itself
 * stays in the store (the URL never contains private conversation data), so a
 * round-trip to a page and back does not reset it.
 */
export const PAGE_VIEWS = ['overview', 'files', 'plugins', 'security', 'settings'] as const;

export type PageView = (typeof PAGE_VIEWS)[number];
export type AppView = 'chat' | PageView;

export const CHAT_VIEW: AppView = 'chat';

const PAGE_VIEW_SET: ReadonlySet<string> = new Set(PAGE_VIEWS);

export function isPageView(value: string | null | undefined): value is PageView {
  return value !== null && value !== undefined && PAGE_VIEW_SET.has(value);
}

/** Parse `?view=` from a `pathname+search` location. Unknown values → chat. */
export function parseView(location: string): AppView {
  const queryStart = location.indexOf('?');
  if (queryStart < 0) return CHAT_VIEW;
  const params = new URLSearchParams(location.slice(queryStart + 1));
  const value = params.get('view');
  return isPageView(value) ? value : CHAT_VIEW;
}

/**
 * Return the same location with `view` added/removed. Other query parameters
 * are preserved; `view=chat` is normalised to the absence of the parameter so
 * the default URL stays clean.
 */
export function withView(location: string, view: AppView): string {
  const queryStart = location.indexOf('?');
  const pathname = queryStart < 0 ? location : location.slice(0, queryStart);
  const params = new URLSearchParams(queryStart < 0 ? '' : location.slice(queryStart + 1));
  if (view === CHAT_VIEW) params.delete('view');
  else params.set('view', view);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
