import type { WorkspaceLimits, WorkspaceRole, WorkspaceUsage } from '../api/types';

export const MAX_MESSAGE_ATTACHMENTS = 10;

export type LimitWarning = 'ok' | 'warning' | 'critical' | 'full';

export interface LimitState {
  /** used + reserved; reserved counts toward the server-side quota check. */
  committed: number;
  limit: number;
  ratio: number;
  percent: number;
  remaining: number;
  warning: LimitWarning;
}

export function usageCommitted(usage: WorkspaceUsage): number {
  return Math.max(0, usage.used) + Math.max(0, usage.reserved);
}

export function limitState(limits: WorkspaceLimits): LimitState {
  const committed = usageCommitted(limits.usage);
  const limit = Math.max(0, limits.usage.limit);
  const ratio = limit <= 0 ? 1 : Math.max(0, Math.min(1, committed / limit));
  return {
    committed,
    limit,
    ratio,
    percent: Math.round(ratio * 100),
    remaining: Math.max(0, limit - committed),
    warning: warningFor(ratio),
  };
}

export function warningFor(ratio: number): LimitWarning {
  if (ratio >= 1) return 'full';
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.8) return 'warning';
  return 'ok';
}

/** Analysis §12.1: guests get a smaller per-file cap, independent of tariff. */
export function effectiveMaxFileBytes(
  limits: WorkspaceLimits | null,
  role: WorkspaceRole | null | undefined,
): number | null {
  if (!limits) return null;
  const tariffMax = Math.max(0, limits.max_file_bytes);
  if (role === 'GUEST') {
    return Math.min(tariffMax, Math.max(0, limits.guest_file_bytes));
  }
  return tariffMax;
}

export function isStorageFull(limits: WorkspaceLimits | null): boolean {
  if (!limits) return false;
  return limitState(limits).warning === 'full';
}

export function maxAttachmentCount(limits: WorkspaceLimits | null): number {
  return Math.min(
    MAX_MESSAGE_ATTACHMENTS,
    limits ? Math.max(0, limits.max_attachments) : MAX_MESSAGE_ATTACHMENTS,
  );
}
