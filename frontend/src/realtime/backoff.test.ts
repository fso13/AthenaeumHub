import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  RECONNECT_BUDGET_PER_HOUR,
  ReconnectBudget,
  RECONNECT_DELAYS_MS,
} from './backoff';

describe('reconnect backoff', () => {
  it('uses 1/2/4/8/16/30 s bases and clamps at 30 s', () => {
    expect(RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    const exact = () => 0.5; // zero jitter
    expect(backoffDelay(0, exact)).toBe(1_000);
    expect(backoffDelay(1, exact)).toBe(2_000);
    expect(backoffDelay(2, exact)).toBe(4_000);
    expect(backoffDelay(3, exact)).toBe(8_000);
    expect(backoffDelay(4, exact)).toBe(16_000);
    expect(backoffDelay(5, exact)).toBe(30_000);
    expect(backoffDelay(99, exact)).toBe(30_000);
  });

  it('applies bounded ±20 % jitter', () => {
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1_200);
    expect(backoffDelay(5, () => 0)).toBe(24_000);
    expect(backoffDelay(5, () => 1)).toBe(36_000);
  });
});

describe('reconnect budget 60/hour', () => {
  it('allows exactly 60 attempts in a sliding hour', () => {
    let now = 1_000;
    const budget = new ReconnectBudget({ now: () => now });
    expect(RECONNECT_BUDGET_PER_HOUR).toBe(60);
    for (let index = 0; index < 60; index += 1) {
      expect(budget.tryConsume()).toBe(true);
      now += 1_000;
    }
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(60);
    expect(budget.nextAvailableAt()).toBe(1_000 + 60 * 60 * 1_000);
  });

  it('frees slots as the window slides', () => {
    let now = 0;
    const budget = new ReconnectBudget({ now: () => now, max: 2, windowMs: 1_000 });
    expect(budget.tryConsume()).toBe(true);
    now = 100;
    expect(budget.tryConsume()).toBe(true);
    now = 200;
    expect(budget.tryConsume()).toBe(false);

    now = 1_001;
    expect(budget.tryConsume()).toBe(true);
    expect(budget.used).toBe(2);
  });

  it('resets explicitly', () => {
    const budget = new ReconnectBudget({ max: 1 });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    budget.reset();
    expect(budget.tryConsume()).toBe(true);
  });
});
