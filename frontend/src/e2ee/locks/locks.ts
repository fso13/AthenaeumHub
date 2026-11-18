/**
 * Cross-tab serialisation for session/outbox critical sections (§3.4.6).
 *
 * Primary path: the browser's Web Locks API —
 * `navigator.locks.request("krug-session:"+session_id)` around send/receive and
 * `"krug-outbox"` around the outbox worker. Two tabs must never advance the same
 * chain or send the same outbox row concurrently.
 *
 * Fallback: a BroadcastChannel lease mutex. Each acquisition elects a single
 * holder for the lock name (lowest `(at, tabId, token)` wins), broadcasts a
 * `held` lease, renews it while running and releases on completion. A crashed
 * tab's lease expires, so another tab can proceed. This is best-effort
 * coordination, not a security boundary: a network/event-loop partition can
 * still let two tabs run briefly, which is why the browser path is preferred.
 *
 * Last resort (no Web Locks, no BroadcastChannel): an in-process queue. It only
 * serialises tabs that share a JS realm, which is honest degradation, not a
 * multi-tab guarantee.
 */
import { E2eeError } from '../errors';
import { decodeBase64Url } from '../encoding/base64url';
import { bytesToHex } from '../encoding/bytes';
import { randomBytes } from '../crypto/random';
import { SESSION_ID_BYTES } from '../constants';

export const SESSION_LOCK_PREFIX = 'krug-session:';
export const OUTBOX_LOCK = 'krug-outbox';
export const STORAGE_LOCK = 'krug-storage';
export const BROADCAST_CHANNEL_NAME = 'krug-e2ee-locks';

export function sessionLockName(sessionId: string): string {
  try {
    decodeBase64Url(sessionId, SESSION_ID_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session_id must be canonical b64u16');
  }
  return `${SESSION_LOCK_PREFIX}${sessionId}`;
}

export interface LockOptions {
  /** Acquisition timeout; never aborts an already-running critical section. */
  readonly timeoutMs?: number;
}

export type E2eeLockKind = 'web-locks' | 'broadcast' | 'local';

/**
 * Per-acquisition fence. The holder must re-check it before every durable
 * mutation: a throttled background tab can lose its fallback lease while a
 * second tab has already entered the critical section. `epoch` is a
 * per-provider acquisition counter (the durable, cross-tab fence remains the
 * session revision CAS / outbox status, which every write still enforces).
 */
export interface LockFence {
  readonly token: string;
  readonly epoch: number;
  /** True only for the browser Web Locks path (a real mutual-exclusion API). */
  readonly securityBoundary: boolean;
  valid(): boolean;
  /** Throws `LOCK_LEASE_EXPIRED` when the lease is gone. */
  assertValid(): void;
}

export interface E2eeLockManager {
  readonly kind: E2eeLockKind;
  /**
   * `false` for BroadcastChannel/local fallbacks: they are best-effort
   * coordination, not a security boundary (P1-06).
   */
  readonly isSecurityBoundary: boolean;
  withLock<T>(
    name: string,
    body: (fence: LockFence) => Promise<T>,
    options?: LockOptions,
  ): Promise<T>;
  close(): void;
}

/** Structural subset of `LockManager` so tests can inject a fake. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly mode?: 'exclusive' | 'shared'; readonly signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface LockScheduler {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: LockScheduler = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface E2eeLockManagerOptions {
  /** Injection point for tests; defaults to `navigator.locks`. */
  readonly locks?: LockManagerLike | null;
  /** Injection point for tests; defaults to a `BroadcastChannel` in this realm. */
  readonly channelFactory?: (() => BroadcastChannelLike) | null;
  readonly tabId?: string;
  readonly leaseMs?: number;
  readonly settleMs?: number;
  readonly scheduler?: LockScheduler;
}

/** RFC 4122 v4 UUID from `crypto.getRandomValues` (never `Math.random`). */
function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

/**
 * Collision-resistant tab identity (P1-06): a random v4 UUID instead of
 * `Date.now()`+per-tab counter, which could repeat across two tabs that opened
 * in the same millisecond.
 */
export function createTabId(): string {
  return randomUuid();
}

function createInstanceId(): string {
  return randomUuid();
}

function detectWebLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const candidate = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (!candidate || typeof candidate.request !== 'function') return null;
  return candidate;
}

function detectBroadcastChannel(): (() => BroadcastChannelLike) | null {
  const Candidate = (
    globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }
  ).BroadcastChannel;
  if (typeof Candidate !== 'function') return null;
  return () => new Candidate(BROADCAST_CHANNEL_NAME);
}

function lockError(message: string): E2eeError {
  return new E2eeError('LOCK_TIMEOUT', message);
}

function validateLockName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'lock name must be a non-empty string');
  }
  return name;
}

/** Promise-chain mutex for one lock name inside a single JS realm. */
class LocalLockQueue {
  private readonly queues = new Map<string, Promise<void>>();
  private closed = false;

  async run<T>(name: string, body: () => Promise<T>): Promise<T> {
    if (this.closed) throw lockError('lock manager is closed');
    const previous = this.queues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(name, tail);

    await previous;
    if (this.closed) {
      release();
      throw lockError('lock manager is closed');
    }
    try {
      return await body();
    } finally {
      release();
      if (this.queues.get(name) === tail) this.queues.delete(name);
    }
  }

  close(): void {
    this.closed = true;
  }
}

interface Candidate {
  readonly tabId: string;
  readonly token: string;
  readonly at: number;
}

interface HeldLease {
  readonly tabId: string;
  readonly token: string;
  readonly at: number;
  readonly expiresAt: number;
}

interface LockMessage {
  readonly v: 1;
  readonly type: 'acquire' | 'held' | 'release';
  readonly name: string;
  readonly token: string;
  readonly tabId: string;
  /** Per-realm random id; distinguishes two tabs that accidentally share `tabId`. */
  readonly instanceId: string;
  readonly at: number;
  readonly expiresAt: number | null;
}

function comparePriority(a: { at: number; tabId: string; token: string }, b: typeof a): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.tabId !== b.tabId) return a.tabId < b.tabId ? -1 : 1;
  if (a.token === b.token) return 0;
  return a.token < b.token ? -1 : 1;
}

class BroadcastLockProvider {
  private readonly channel: BroadcastChannelLike;
  private readonly tabId: string;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly settleMs: number;
  private readonly scheduler: LockScheduler;
  private readonly queue = new LocalLockQueue();
  private readonly candidates = new Map<string, Map<string, Candidate>>();
  private readonly remoteHeld = new Map<string, HeldLease>();
  private readonly selfHeld = new Map<string, HeldLease & { renewal: unknown }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listener: (event: { data: unknown }) => void;
  private closed = false;
  private counter = 0;
  private epochCounter = 0;
  private collisionDetected = false;

  constructor(options: {
    channel: BroadcastChannelLike;
    tabId: string;
    leaseMs: number;
    settleMs: number;
    scheduler: LockScheduler;
  }) {
    this.channel = options.channel;
    this.tabId = options.tabId;
    this.instanceId = createInstanceId();
    this.leaseMs = options.leaseMs;
    this.settleMs = options.settleMs;
    this.scheduler = options.scheduler;
    this.listener = (event) => this.onMessage(event.data);
    this.channel.addEventListener('message', this.listener);
  }

  request<T>(
    name: string,
    body: (fence: LockFence) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    validateLockName(name);
    return this.queue.run(name, async () => {
      const deadline =
        options.timeoutMs === undefined ? Infinity : this.scheduler.now() + options.timeoutMs;
      const acquired = await this.acquire(name, deadline);
      if (!acquired) throw lockError('lock acquisition timed out');
      try {
        return await body(this.fenceFor(name, acquired.token, acquired.epoch));
      } finally {
        this.release(name);
      }
    });
  }

  private fenceFor(name: string, token: string, epoch: number): LockFence {
    const valid = (): boolean => {
      if (this.closed) return false;
      const held = this.selfHeld.get(name);
      return held !== undefined && held.token === token && held.expiresAt > this.scheduler.now();
    };
    return {
      token,
      epoch,
      securityBoundary: false,
      valid,
      assertValid: () => {
        if (!valid()) {
          throw new E2eeError(
            'LOCK_LEASE_EXPIRED',
            'fallback lock lease expired or was lost; refusing the mutation',
          );
        }
      },
    };
  }

  private assertNoCollision(): void {
    if (this.collisionDetected) {
      throw new E2eeError(
        'LOCK_TAB_ID_COLLISION',
        'two tabs share the same tabId; fallback coordination is untrusted',
      );
    }
  }

  close(): void {
    if (this.closed) return;
    for (const name of [...this.selfHeld.keys()]) this.release(name);
    this.closed = true;
    this.channel.removeEventListener('message', this.listener);
    this.channel.close();
    this.queue.close();
    this.notifyAll();
  }

  private async acquire(
    name: string,
    deadline: number,
  ): Promise<{ token: string; epoch: number } | null> {
    while (!this.closed) {
      this.assertNoCollision();
      if (this.scheduler.now() >= deadline) return null;
      await this.waitForRemoteRelease(name, deadline);
      if (this.closed) return null;
      this.assertNoCollision();
      if (this.remoteHeldActive(name)) continue;

      const at = this.scheduler.now();
      this.counter += 1;
      const token = `${this.tabId}#${this.counter}`;
      const candidate: Candidate = { tabId: this.tabId, token, at };
      this.addCandidate(name, candidate);
      this.post({
        v: 1,
        type: 'acquire',
        name,
        token,
        tabId: this.tabId,
        instanceId: this.instanceId,
        at,
        expiresAt: null,
      });

      await this.sleep(this.settleMs);
      if (this.closed) return null;
      this.assertNoCollision();

      const contenders = [...(this.candidates.get(name)?.values() ?? [])].sort(comparePriority);
      this.candidates.delete(name);
      const winner = contenders[0];
      if (!winner || winner.token !== token) continue;
      if (this.remoteHeldActive(name)) continue;

      this.selfHeld.set(name, {
        tabId: this.tabId,
        token,
        at,
        expiresAt: this.scheduler.now() + this.leaseMs,
        renewal: null,
      });
      this.post({
        v: 1,
        type: 'held',
        name,
        token,
        tabId: this.tabId,
        instanceId: this.instanceId,
        at,
        expiresAt: this.scheduler.now() + this.leaseMs,
      });

      // Guard window: if another tab also won a race, the lower-priority holder
      // yields so exactly one critical section runs.
      await this.sleep(this.settleMs);
      this.assertNoCollision();
      const competitor = this.remoteHeld.get(name);
      if (competitor && comparePriority(competitor, candidate) < 0) {
        this.release(name);
        continue;
      }
      if (this.closed) {
        this.release(name);
        return null;
      }
      this.startRenewal(name, token);
      this.epochCounter += 1;
      return { token, epoch: this.epochCounter };
    }
    return null;
  }

  private release(name: string): void {
    const held = this.selfHeld.get(name);
    if (!held) {
      this.notifyAll();
      return;
    }
    this.selfHeld.delete(name);
    if (held.renewal !== null) this.scheduler.clearTimeout(held.renewal);
    this.post({
      v: 1,
      type: 'release',
      name,
      token: held.token,
      tabId: this.tabId,
      instanceId: this.instanceId,
      at: this.scheduler.now(),
      expiresAt: null,
    });
    this.notifyAll();
  }

  private startRenewal(name: string, token: string): void {
    const renew = () => {
      const held = this.selfHeld.get(name);
      if (!held || held.token !== token || this.closed) return;
      if (held.expiresAt <= this.scheduler.now()) {
        // Throttled past the lease: another tab may already be inside. Do not
        // resurrect the lease by renewing late; the fence must stay invalid.
        this.release(name);
        return;
      }
      const expiresAt = this.scheduler.now() + this.leaseMs;
      this.selfHeld.set(name, { ...held, expiresAt });
      this.post({
        v: 1,
        type: 'held',
        name,
        token,
        tabId: this.tabId,
        instanceId: this.instanceId,
        at: held.at,
        expiresAt,
      });
      const handle = this.scheduler.setTimeout(renew, Math.max(1, Math.floor(this.leaseMs / 2)));
      this.selfHeld.set(name, { ...this.selfHeld.get(name)!, renewal: handle });
    };
    const handle = this.scheduler.setTimeout(renew, Math.max(1, Math.floor(this.leaseMs / 2)));
    const held = this.selfHeld.get(name);
    if (held) this.selfHeld.set(name, { ...held, renewal: handle });
  }

  private addCandidate(name: string, candidate: Candidate): void {
    let map = this.candidates.get(name);
    if (!map) {
      map = new Map();
      this.candidates.set(name, map);
    }
    map.set(candidate.token, candidate);
  }

  private remoteHeldActive(name: string): boolean {
    const held = this.remoteHeld.get(name);
    if (!held) return false;
    if (held.expiresAt <= this.scheduler.now()) {
      this.remoteHeld.delete(name);
      return false;
    }
    return true;
  }

  private async waitForRemoteRelease(name: string, deadline: number): Promise<void> {
    const held = this.remoteHeld.get(name);
    if (!held) return;
    if (this.scheduler.now() >= deadline) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timerRef: { handle: unknown } = { handle: null };
      const finish = () => {
        if (settled) return;
        settled = true;
        this.scheduler.clearTimeout(timerRef.handle);
        this.waiters.get(name)?.delete(finish);
        resolve();
      };
      let waiterSet = this.waiters.get(name);
      if (!waiterSet) {
        waiterSet = new Set();
        this.waiters.set(name, waiterSet);
      }
      waiterSet.add(finish);
      const waitMs = Math.max(
        1,
        Math.min(held.expiresAt - this.scheduler.now(), deadline - this.scheduler.now()),
      );
      timerRef.handle = this.scheduler.setTimeout(() => {
        // Wake the waiter; lease expiry is evaluated by `remoteHeldActive`.
        // Never delete a still-valid lease just because our acquisition
        // deadline is shorter than the lease.
        finish();
      }, waitMs);
      if (this.remoteHeld.get(name)?.expiresAt !== held.expiresAt) finish();
    });
  }

  private notifyAll(): void {
    for (const name of [...this.waiters.keys()]) {
      const set = this.waiters.get(name);
      if (!set) continue;
      this.waiters.delete(name);
      for (const waiter of set) waiter();
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, ms);
    });
  }

  private post(message: LockMessage): void {
    if (this.closed) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // A closed channel cannot coordinate; the lease timeout still releases
      // other tabs. Never log the message (lock names include session ids).
    }
  }

  private onMessage(data: unknown): void {
    if (!isLockMessage(data)) return;
    const message = data;
    if (message.tabId === this.tabId) {
      // Same tabId but a different realm means two tabs collided on their id.
      // The fallback can no longer distinguish self from peer, so fail closed.
      if (message.instanceId !== this.instanceId) {
        this.collisionDetected = true;
        this.notifyAll();
      }
      return;
    }
    if (message.name.length > 200) return;
    if (message.type === 'acquire') {
      this.addCandidate(message.name, {
        tabId: message.tabId,
        token: message.token,
        at: message.at,
      });
      const held = this.selfHeld.get(message.name) ?? this.remoteHeld.get(message.name);
      if (held && held.expiresAt > this.scheduler.now()) {
        this.post({
          v: 1,
          type: 'held',
          name: message.name,
          token: held.token,
          tabId: held.tabId,
          instanceId: this.instanceId,
          at: held.at,
          expiresAt: held.expiresAt,
        });
      }
      return;
    }
    if (message.type === 'held') {
      const expiresAt = message.expiresAt ?? this.scheduler.now() + this.leaseMs;
      const lease: HeldLease = {
        tabId: message.tabId,
        token: message.token,
        at: message.at,
        expiresAt,
      };
      const current = this.remoteHeld.get(message.name);
      if (!current || comparePriority(lease, current) <= 0) {
        this.remoteHeld.set(message.name, lease);
      }
      const self = this.selfHeld.get(message.name);
      if (self && comparePriority(lease, self) < 0) {
        // We lost a race; release before the body was allowed to run.
        this.release(message.name);
      }
      return;
    }
    if (message.type === 'release') {
      const current = this.remoteHeld.get(message.name);
      if (current?.token === message.token) this.remoteHeld.delete(message.name);
      this.notifyAll();
    }
  }
}

function isLockMessage(value: unknown): value is LockMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LockMessage>;
  return (
    candidate.v === 1 &&
    (candidate.type === 'acquire' || candidate.type === 'held' || candidate.type === 'release') &&
    typeof candidate.name === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.tabId === 'string' &&
    typeof candidate.instanceId === 'string' &&
    candidate.instanceId.length > 0 &&
    candidate.instanceId.length <= 64 &&
    typeof candidate.at === 'number' &&
    (candidate.expiresAt === null || typeof candidate.expiresAt === 'number')
  );
}

const WEB_LOCK_FENCE: LockFence = {
  token: 'web-locks',
  epoch: 0,
  securityBoundary: true,
  valid: () => true,
  assertValid: () => undefined,
};

function createWebLocksManager(locks: LockManagerLike): E2eeLockManager {
  return {
    kind: 'web-locks',
    isSecurityBoundary: true,
    withLock<T>(
      name: string,
      body: (fence: LockFence) => Promise<T>,
      options: LockOptions = {},
    ): Promise<T> {
      validateLockName(name);
      const controller = options.timeoutMs === undefined ? null : new AbortController();
      let acquired = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (controller && options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!acquired) controller.abort();
        }, options.timeoutMs);
      }
      const request = Promise.resolve().then(() =>
        locks.request(
          name,
          { mode: 'exclusive', ...(controller ? { signal: controller.signal } : {}) },
          async () => {
            acquired = true;
            return body(WEB_LOCK_FENCE);
          },
        ),
      );
      return request
        .catch((error: unknown) => {
          if (controller?.signal.aborted) {
            throw lockError('lock acquisition timed out');
          }
          throw error;
        })
        .finally(() => {
          if (timer !== null) clearTimeout(timer);
        });
    },
    close() {
      // Web Locks are released automatically when the callback settles.
    },
  };
}

function createLocalManager(): E2eeLockManager {
  const queue = new LocalLockQueue();
  let epoch = 0;
  let closed = false;
  return {
    kind: 'local',
    isSecurityBoundary: false,
    withLock<T>(name: string, body: (fence: LockFence) => Promise<T>): Promise<T> {
      validateLockName(name);
      if (closed) return Promise.reject(lockError('lock manager is closed'));
      epoch += 1;
      const acquiredEpoch = epoch;
      const fence: LockFence = {
        token: `local#${acquiredEpoch}`,
        epoch: acquiredEpoch,
        securityBoundary: false,
        valid: () => !closed,
        assertValid: () => {
          if (closed) {
            throw new E2eeError('LOCK_LEASE_EXPIRED', 'local lock manager was closed');
          }
        },
      };
      return queue.run(name, () => body(fence));
    },
    close() {
      closed = true;
      queue.close();
    },
  };
}

/**
 * Picks the strongest available mechanism. Tests inject a fake `locks` or
 * `channelFactory`; production uses Web Locks, then BroadcastChannel, then an
 * in-realm queue.
 */
export function createE2eeLockManager(options: E2eeLockManagerOptions = {}): E2eeLockManager {
  const locks = options.locks === undefined ? detectWebLocks() : options.locks;
  if (locks) return createWebLocksManager(locks);

  const channelFactory =
    options.channelFactory === undefined ? detectBroadcastChannel() : options.channelFactory;
  if (channelFactory) {
    const localFallback = createLocalManager();
    let provider: BroadcastLockProvider | null = null;
    let factoryFailed = false;
    const getProvider = (): BroadcastLockProvider | null => {
      if (provider || factoryFailed) return provider;
      try {
        provider = new BroadcastLockProvider({
          channel: channelFactory(),
          tabId: options.tabId ?? createTabId(),
          leaseMs: options.leaseMs ?? 5000,
          settleMs: options.settleMs ?? 20,
          scheduler: options.scheduler ?? defaultScheduler,
        });
      } catch {
        factoryFailed = true;
        provider = null;
      }
      return provider;
    };

    return {
      kind: 'broadcast',
      isSecurityBoundary: false,
      async withLock<T>(
        name: string,
        body: (fence: LockFence) => Promise<T>,
        lockOptions: LockOptions = {},
      ) {
        const active = getProvider();
        if (!active) return localFallback.withLock(name, body, lockOptions);
        return active.request(name, body, lockOptions);
      },
      close() {
        provider?.close();
        localFallback.close();
      },
    };
  }
  return createLocalManager();
}

/** Convenience wrapper so callers cannot forget the normative lock name. */
export function withSessionLock<T>(
  locks: E2eeLockManager,
  sessionId: string,
  body: (fence: LockFence) => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  return locks.withLock(sessionLockName(sessionId), body, options);
}

export function withOutboxLock<T>(
  locks: E2eeLockManager,
  body: (fence: LockFence) => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  return locks.withLock(OUTBOX_LOCK, body, options);
}
