import { describe, expect, it } from 'vitest';
import type { WorkspaceLimits } from '../api/types';
import {
  effectiveMaxFileBytes,
  isStorageFull,
  limitState,
  maxAttachmentCount,
  usageCommitted,
  warningFor,
} from './limits';

function limits(patch: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  return {
    tariff: 'TEAM',
    max_file_bytes: 2 * 1024 ** 3,
    storage_bytes: 1024 ** 4,
    max_attachments: 10,
    guest_file_bytes: 500 * 1024 ** 2,
    usage: { used: 0, reserved: 0, limit: 1024 ** 4 },
    max_chats_per_user: 100,
    chats_used: 0,
    ...patch,
  };
}

describe('workspace limits', () => {
  it('counts used + reserved and exposes warnings at 80/95/100 %', () => {
    const base = limits({ usage: { used: 0, reserved: 0, limit: 1000 } });
    expect(limitState(base).warning).toBe('ok');
    expect(limitState({ ...base, usage: { used: 790, reserved: 0, limit: 1000 } }).warning).toBe(
      'ok',
    );
    expect(limitState({ ...base, usage: { used: 800, reserved: 0, limit: 1000 } }).warning).toBe(
      'warning',
    );
    expect(limitState({ ...base, usage: { used: 900, reserved: 50, limit: 1000 } }).warning).toBe(
      'critical',
    );
    expect(limitState({ ...base, usage: { used: 1000, reserved: 0, limit: 1000 } }).warning).toBe(
      'full',
    );
    expect(usageCommitted({ used: 100, reserved: 25, limit: 1000 })).toBe(125);
  });

  it('clamps ratios and treats a zero limit as full', () => {
    expect(limitState(limits({ usage: { used: 0, reserved: 0, limit: 100 } })).percent).toBe(0);
    expect(limitState(limits({ usage: { used: 200, reserved: 0, limit: 100 } })).percent).toBe(100);
    expect(limitState(limits({ usage: { used: 0, reserved: 0, limit: 0 } })).warning).toBe('full');
  });

  it('applies the smaller guest per-file cap', () => {
    expect(effectiveMaxFileBytes(limits(), 'MEMBER')).toBe(2 * 1024 ** 3);
    expect(effectiveMaxFileBytes(limits(), 'GUEST')).toBe(500 * 1024 ** 2);
    expect(effectiveMaxFileBytes(limits({ guest_file_bytes: 4 * 1024 ** 3 }), 'GUEST')).toBe(
      2 * 1024 ** 3,
    );
    expect(effectiveMaxFileBytes(null, 'GUEST')).toBeNull();
  });

  it('exposes full/attachment helpers', () => {
    expect(isStorageFull(null)).toBe(false);
    expect(isStorageFull(limits({ usage: { used: 10, reserved: 0, limit: 10 } }))).toBe(true);
    expect(maxAttachmentCount(null)).toBe(10);
    expect(maxAttachmentCount(limits({ max_attachments: 5 }))).toBe(5);
    expect(warningFor(0.79)).toBe('ok');
    expect(warningFor(0.8)).toBe('warning');
    expect(warningFor(0.95)).toBe('critical');
    expect(warningFor(1)).toBe('full');
  });
});
