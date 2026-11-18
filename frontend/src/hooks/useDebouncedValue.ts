import { useEffect, useState } from 'react';

/**
 * Debounces a controlled input value. Admin lists are server-filtered, so every
 * keystroke must not become an audited read: the store sees the settled value.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return;
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, debounced, delayMs]);

  return debounced;
}
