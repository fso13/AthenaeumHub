import { useCallback, useEffect, useState } from 'react';
import {
  readThemePreference,
  resolveTheme,
  systemTheme,
  writeThemePreference,
  type Theme,
} from '../theme/themePreference';

export interface ThemeController {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/**
 * Applies the effective theme to `<html data-theme>` and keeps the OS
 * preference as the default until the user makes an explicit choice.
 */
export function useTheme(): ThemeController {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readThemePreference()));

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Only follow the OS while the user has not chosen explicitly.
  useEffect(() => {
    if (readThemePreference() !== null) return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const handle = () => setThemeState(systemTheme());
    media.addEventListener?.('change', handle);
    return () => media.removeEventListener?.('change', handle);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    writeThemePreference(next);
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
