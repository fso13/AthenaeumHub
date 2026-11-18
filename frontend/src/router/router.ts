import { useCallback, useSyncExternalStore } from 'react';

/**
 * Tiny history router: three routes are needed in F-04, so a routing library
 * would be more weight than value. The app is served as a SPA by Vite; in
 * production a static host must fall back to index.html for these paths.
 */
let cached = currentLocation();

function currentLocation(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}

function refresh(): void {
  cached = currentLocation();
}

function subscribe(listener: () => void): () => void {
  const handle = () => {
    refresh();
    listener();
  };
  window.addEventListener('popstate', handle);
  window.addEventListener('krug:navigate', handle);
  return () => {
    window.removeEventListener('popstate', handle);
    window.removeEventListener('krug:navigate', handle);
  };
}

function getSnapshot(): string {
  const next = currentLocation();
  if (next !== cached) cached = next;
  return cached;
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}

export function usePathname(): string {
  return useLocation().split('?')[0] ?? '/';
}

export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  return useCallback((path: string, options: { replace?: boolean } = {}) => {
    if (typeof window === 'undefined') return;
    if (options.replace) window.history.replaceState({}, document.title, path);
    else window.history.pushState({}, document.title, path);
    refresh();
    window.dispatchEvent(new Event('krug:navigate'));
  }, []);
}

/** Imperative variant for non-React modules (auth provider redirects). */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  if (options.replace) window.history.replaceState({}, document.title, path);
  else window.history.pushState({}, document.title, path);
  refresh();
  window.dispatchEvent(new Event('krug:navigate'));
}

export function resetRouterForTests(path = '/'): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, document.title, path);
  refresh();
}
