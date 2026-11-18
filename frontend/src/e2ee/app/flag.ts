/**
 * E2EE feature flag (E7-F5).
 *
 * The whole E2EE wire-up is opt-in: `VITE_E2EE_ENABLED` is the only build-time
 * switch and it defaults to **false**. A runtime override exists so tests and a
 * staged rollout can gate the same code without rebuilding; it is deliberately
 * in-memory only (never localStorage/sessionStorage, never persisted).
 *
 * No crypto, no network, no UI imports: this module is safe to read anywhere.
 */
export const E2EE_FLAG_ENV = 'VITE_E2EE_ENABLED';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

let runtimeOverride: boolean | null = null;

/**
 * `true` only for the documented truthy spellings; every other value (missing,
 * empty, malformed) falls back to `false`. E2EE must never be enabled by a typo.
 */
export function parseE2eeFlag(value: unknown, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === '') return fallback;
  if (TRUTHY.has(normalised)) return true;
  if (FALSY.has(normalised)) return false;
  return fallback;
}

export function readEnvE2eeFlag(
  env: Record<string, string | boolean | undefined> | undefined,
): boolean {
  const value = env?.[E2EE_FLAG_ENV];
  if (typeof value === 'boolean') return value;
  return parseE2eeFlag(value, false);
}

/** Effective flag: runtime override first, then the build-time env. */
export function isE2eeEnabled(
  env: Record<string, string | boolean | undefined> | undefined = import.meta.env as unknown as
    Record<string, string | boolean | undefined> | undefined,
): boolean {
  if (runtimeOverride !== null) return runtimeOverride;
  return readEnvE2eeFlag(env);
}

/** Test/staged-rollout override; `null` restores the env-driven value. */
export function setE2eeEnabledForTests(value: boolean | null): void {
  runtimeOverride = value;
}

export function resetE2eeFlagForTests(): void {
  runtimeOverride = null;
}
