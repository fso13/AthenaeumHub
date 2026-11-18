/**
 * Active-session SPK scope for prekey rotation (CR1 P1-03).
 *
 * A prekey message needs the private SPK it was encrypted with; a session that
 * is still active must keep that SPK inside the retention window. F4 writes
 * `spkId` into session state, and rotation passes the resulting set to
 * `rotateSignedPrekey`.
 *
 * Honest fallback: sessions created before `spkId` existed cannot identify
 * their SPK. If any such session exists, `undefined` is returned instead of an
 * empty set, which makes rotation keep the full `current + 2 / 90 days`
 * retention rather than destroying a key an offline prekey message may need.
 */
import { KEY_ID_PATTERN } from '../constants';
import type { E2eeStorage } from '../storage/types';
import type { StoredSessionRecord } from '../session/types';
import { SESSION_KEY_PREFIX } from '../session/sessionStore';

export async function collectActiveSessionSpkIds(
  storage: E2eeStorage,
): Promise<ReadonlySet<string> | undefined> {
  const ids = new Set<string>();
  let unknownLegacySession = false;
  for (const key of await storage.keys('sessions')) {
    if (!key.startsWith(SESSION_KEY_PREFIX)) continue;
    const record = await storage.get<StoredSessionRecord>('sessions', key);
    if (record === null) continue;
    if (typeof record.spkId !== 'string' || !KEY_ID_PATTERN.test(record.spkId)) {
      unknownLegacySession = true;
      continue;
    }
    ids.add(record.spkId);
  }
  return unknownLegacySession ? undefined : ids;
}
