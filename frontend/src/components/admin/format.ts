/** Admin-only formatting. UI-only helpers: no contract shapes, no content. */

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Compact numeric formatting for aggregate counters (never negative). */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.max(0, Math.trunc(value)).toLocaleString('ru-RU');
}

/**
 * Share of `used` in `limit` as an integer percentage. `null` means the
 * workspace has no limit (`storage_limit_bytes = 0`).
 */
export function limitPercent(used: number, limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const share = (Math.max(0, used) / limit) * 100;
  return Math.min(100, Math.max(0, Math.round(share)));
}
