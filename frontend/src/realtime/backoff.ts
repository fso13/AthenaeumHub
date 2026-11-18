/**
 * Reconnect policy from contracts/ws-protocol.md §6 and SYSTEM-ANALYSIS §7.5:
 * delays 1, 2, 4, 8, 16, 30 s + jitter, at most 60 attempts per hour.
 */

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export const RECONNECT_BUDGET_PER_HOUR = 60;
export const RECONNECT_BUDGET_WINDOW_MS = 60 * 60 * 1_000;
/** Max ±20 % jitter keeps spread without multiplying the total wait. */
export const RECONNECT_JITTER_RATIO = 0.2;

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), RECONNECT_DELAYS_MS.length - 1));
  const base = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0];
  const jitter = base * RECONNECT_JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Sliding-window limiter. `tryConsume` returns false once the budget is spent;
 * `nextAvailableAt` lets the client retry at the window boundary instead of
 * spinning forever.
 */
export class ReconnectBudget {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private timestamps: number[] = [];

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.max = options.max ?? RECONNECT_BUDGET_PER_HOUR;
    this.windowMs = options.windowMs ?? RECONNECT_BUDGET_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get used(): number {
    this.prune();
    return this.timestamps.length;
  }

  tryConsume(): boolean {
    const now = this.now();
    this.prune(now);
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
  }

  nextAvailableAt(): number {
    this.prune();
    const oldest = this.timestamps[0];
    return oldest === undefined ? this.now() : oldest + this.windowMs;
  }

  reset(): void {
    this.timestamps = [];
  }

  private prune(now: number = this.now()): void {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);
  }
}
