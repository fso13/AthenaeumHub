/**
 * Web Locks + fallback tests (§3.4.6).
 *
 * The browser path is injected as a fake `LockManager`; the BroadcastChannel
 * fallback is exercised through an in-memory bus so two "tabs" can contend for
 * the same lock name. The local queue is the last-resort fallback.
 */
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_LOCK,
  SESSION_LOCK_PREFIX,
  createE2eeLockManager,
  createTabId,
  sessionLockName,
  withOutboxLock,
  withSessionLock,
} from './locks/locks';
import {
  createFakeWebLocks,
  createInMemoryChannelBus,
  createManualScheduler,
  delay,
  testSessionId,
} from './test/fixtures';

describe('lock names', () => {
  it('uses the normative per-session and outbox names', () => {
    const id = testSessionId(5);
    expect(sessionLockName(id)).toBe(`${SESSION_LOCK_PREFIX}${id}`);
    expect(OUTBOX_LOCK).toBe('krug-outbox');
    expect(() => sessionLockName('not-a-session')).toThrowError(
      expect.objectContaining({ code: 'KEY_STORAGE_UNAVAILABLE' }),
    );
  });
});

describe('Web Locks path', () => {
  it('passes the exact lock name and serialises the body', async () => {
    const locks = createFakeWebLocks();
    const manager = createE2eeLockManager({ locks });
    let active = 0;
    let peak = 0;
    const body = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(2);
      active -= 1;
      return 'done';
    };
    const [first, second] = await Promise.all([
      manager.withLock('krug-session:test', body),
      manager.withLock('krug-session:test', body),
    ]);
    expect(first).toBe('done');
    expect(second).toBe('done');
    expect(peak).toBe(1);
    expect(locks.names).toEqual(['krug-session:test', 'krug-session:test']);
    manager.close();
  });

  it('releases the lock after a body error and surfaces the error', async () => {
    const locks = createFakeWebLocks();
    const manager = createE2eeLockManager({ locks });
    await expect(
      manager.withLock('krug-session:test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(manager.withLock('krug-session:test', async () => 42)).resolves.toBe(42);
    manager.close();
  });

  it('times out only while waiting for acquisition', async () => {
    const locks = createFakeWebLocks();
    const manager = createE2eeLockManager({ locks });
    const first = manager.withLock('krug-session:test', async () => {
      await delay(50);
      return 'slow';
    });
    await delay(1);
    await expect(
      manager.withLock('krug-session:test', async () => 'never', { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await expect(first).resolves.toBe('slow');
    manager.close();
  });

  it('does not abort an already-running critical section on timeout', async () => {
    const locks = createFakeWebLocks();
    const manager = createE2eeLockManager({ locks });
    await expect(
      manager.withLock(
        'krug-session:test',
        async () => {
          await delay(20);
          return 'finished';
        },
        { timeoutMs: 5 },
      ),
    ).resolves.toBe('finished');
    manager.close();
  });
});

describe('local fallback', () => {
  it('serialises per name and allows different names in parallel', async () => {
    const manager = createE2eeLockManager({ locks: null, channelFactory: null });
    expect(manager.kind).toBe('local');
    let active = 0;
    let peak = 0;
    const body = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(2);
      active -= 1;
    };
    await Promise.all([
      manager.withLock('a', body),
      manager.withLock('a', body),
      manager.withLock('b', body),
      manager.withLock('b', body),
    ]);
    expect(peak).toBe(2);
    manager.close();
    await expect(manager.withLock('a', async () => 1)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });
  });

  it('falls back to the local queue when the channel factory fails', async () => {
    const manager = createE2eeLockManager({
      locks: null,
      channelFactory: () => {
        throw new Error('no BroadcastChannel');
      },
    });
    await expect(manager.withLock('a', async () => 'ok')).resolves.toBe('ok');
    manager.close();
  });
});

describe('BroadcastChannel fallback', () => {
  it('serialises the same lock across two simulated tabs', async () => {
    const bus = createInMemoryChannelBus();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 5,
      leaseMs: 200,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-b',
      settleMs: 5,
      leaseMs: 200,
    });
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const body = (label: string) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(label);
      await delay(20);
      active -= 1;
    };
    await Promise.all([
      first.withLock('krug-session:x', body('a')),
      second.withLock('krug-session:x', body('b')),
    ]);
    expect(peak).toBe(1);
    expect(order).toHaveLength(2);
    first.close();
    second.close();
    bus.closeAll();
  });

  it('runs different lock names concurrently', async () => {
    const bus = createInMemoryChannelBus();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 3,
      leaseMs: 200,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-b',
      settleMs: 3,
      leaseMs: 200,
    });
    let active = 0;
    let peak = 0;
    const body = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(15);
      active -= 1;
    };
    await Promise.all([first.withLock('lock-a', body), second.withLock('lock-b', body)]);
    expect(peak).toBe(2);
    first.close();
    second.close();
    bus.closeAll();
  });

  it('elects the lower tab id when both claim simultaneously', async () => {
    const bus = createInMemoryChannelBus();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'aaa',
      settleMs: 10,
      leaseMs: 200,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'zzz',
      settleMs: 10,
      leaseMs: 200,
    });
    const order: string[] = [];
    await Promise.all([
      first.withLock('krug-session:x', async () => {
        order.push('aaa');
        await delay(5);
      }),
      second.withLock('krug-session:x', async () => {
        order.push('zzz');
        await delay(5);
      }),
    ]);
    expect(order[0]).toBe('aaa');
    first.close();
    second.close();
    bus.closeAll();
  });

  it('proceeds after a stale lease expires', async () => {
    const bus = createInMemoryChannelBus();
    const manager = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 3,
      leaseMs: 20,
    });
    await manager.withLock('warmup', async () => undefined);
    bus.broadcast({
      v: 1,
      type: 'held',
      name: 'krug-session:x',
      token: 'ghost#1',
      tabId: 'ghost',
      instanceId: 'ghost-instance',
      at: Date.now(),
      expiresAt: Date.now() + 15,
    });
    await delay(5);
    const started = Date.now();
    await manager.withLock('krug-session:x', async () => 'acquired', { timeoutMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    manager.close();
    bus.closeAll();
  });

  it('times out while another tab holds the lease', async () => {
    const bus = createInMemoryChannelBus();
    const manager = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 3,
      leaseMs: 200,
    });
    await manager.withLock('warmup', async () => undefined);
    bus.broadcast({
      v: 1,
      type: 'held',
      name: 'krug-session:x',
      token: 'ghost#1',
      tabId: 'ghost',
      instanceId: 'ghost-instance',
      at: Date.now(),
      expiresAt: Date.now() + 500,
    });
    await delay(5);
    await expect(
      manager.withLock('krug-session:x', async () => 'never', { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    manager.close();
    bus.closeAll();
  });

  it('releases and lets another tab proceed after close', async () => {
    const bus = createInMemoryChannelBus();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 3,
      leaseMs: 200,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-b',
      settleMs: 3,
      leaseMs: 200,
    });
    const order: string[] = [];
    await first.withLock('krug-session:x', async () => {
      order.push('first');
    });
    await second.withLock('krug-session:x', async () => {
      order.push('second');
    });
    expect(order).toEqual(['first', 'second']);
    first.close();
    second.close();
    bus.closeAll();
  });

  it('exposes the session/outbox helpers', async () => {
    const manager = createE2eeLockManager({ locks: createFakeWebLocks() });
    const names: string[] = [];
    await withSessionLock(manager, testSessionId(4), async () => {
      names.push('session');
    });
    await withOutboxLock(manager, async () => {
      names.push('outbox');
    });
    expect(names).toEqual(['session', 'outbox']);
    manager.close();
  });
});

describe('P1-06 lock identity, fencing and boundaries (CR1)', () => {
  it('generates collision-resistant RFC 4122 v4 tab ids', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 64; index += 1) ids.add(createTabId());
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('reports the fallback as non-security-boundary and Web Locks as the boundary', () => {
    const web = createE2eeLockManager({ locks: createFakeWebLocks() });
    expect(web.kind).toBe('web-locks');
    expect(web.isSecurityBoundary).toBe(true);
    web.close();

    const bus = createInMemoryChannelBus();
    const broadcast = createE2eeLockManager({ locks: null, channelFactory: bus.factory });
    expect(broadcast.kind).toBe('broadcast');
    expect(broadcast.isSecurityBoundary).toBe(false);
    broadcast.close();

    const local = createE2eeLockManager({ locks: null, channelFactory: null });
    expect(local.kind).toBe('local');
    expect(local.isSecurityBoundary).toBe(false);
    local.close();
    bus.closeAll();
  });

  it('fails closed when two tabs collide on the same tabId', async () => {
    const bus = createInMemoryChannelBus();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'colliding-tab',
      settleMs: 5,
      leaseMs: 200,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'colliding-tab',
      settleMs: 5,
      leaseMs: 200,
    });
    const entered: string[] = [];
    const results = await Promise.allSettled([
      first.withLock('krug-session:x', async () => {
        entered.push('first');
      }),
      second.withLock('krug-session:x', async () => {
        entered.push('second');
      }),
    ]);
    expect(entered).toEqual([]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'LOCK_TAB_ID_COLLISION' });
      }
    }
    first.close();
    second.close();
    bus.closeAll();
  });

  it('invalidates the fence when the fallback lease expires', async () => {
    const bus = createInMemoryChannelBus();
    const scheduler = createManualScheduler();
    const manager = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 1,
      leaseMs: 5000,
      scheduler,
    });
    let validAfterExpiry: boolean | null = null;
    await manager.withLock('krug-session:x', async (fence) => {
      expect(fence.valid()).toBe(true);
      expect(fence.securityBoundary).toBe(false);
      scheduler.advance(6000);
      validAfterExpiry = fence.valid();
      expect(() => fence.assertValid()).toThrowError(
        expect.objectContaining({ code: 'LOCK_LEASE_EXPIRED' }),
      );
    });
    expect(validAfterExpiry).toBe(false);
    manager.close();
    bus.closeAll();
  });

  it('does not resurrect an expired lease when a throttled renewal fires late', async () => {
    const bus = createInMemoryChannelBus();
    const scheduler = createManualScheduler();
    const manager = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 1,
      leaseMs: 40,
      scheduler,
    });
    await manager.withLock('krug-session:x', async (fence) => {
      scheduler.advance(100);
      // The renewal timer fires at leaseMs/2 real time, after the clock jump.
      await delay(30);
      expect(fence.valid()).toBe(false);
      expect(() => fence.assertValid()).toThrowError(
        expect.objectContaining({ code: 'LOCK_LEASE_EXPIRED' }),
      );
    });
    manager.close();
    bus.closeAll();
  });

  it('lets a second tab take over after expiry while the first fence fails closed', async () => {
    const bus = createInMemoryChannelBus();
    const scheduler = createManualScheduler();
    const first = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 1,
      leaseMs: 5000,
      scheduler,
    });
    const second = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-b',
      settleMs: 1,
      leaseMs: 5000,
      scheduler,
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const firstRun = first.withLock('krug-session:x', async (fence) => {
      signalEntered();
      scheduler.advance(6000);
      await gate;
      // The first writer lost the lease: it must not mutate anything.
      fence.assertValid();
      return 'mutated';
    });
    await entered;
    await expect(
      second.withLock('krug-session:x', async (fence) => {
        expect(fence.valid()).toBe(true);
        return 'second';
      }),
    ).resolves.toBe('second');
    releaseFirst();
    await expect(firstRun).rejects.toMatchObject({ code: 'LOCK_LEASE_EXPIRED' });
    first.close();
    second.close();
    bus.closeAll();
  });

  it('passes a valid fence on the Web Locks path', async () => {
    const manager = createE2eeLockManager({ locks: createFakeWebLocks() });
    await manager.withLock('krug-session:x', async (fence) => {
      expect(fence.securityBoundary).toBe(true);
      expect(fence.valid()).toBe(true);
      expect(() => fence.assertValid()).not.toThrow();
    });
    manager.close();
  });
});
