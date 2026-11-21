import { useEffect, useState } from 'react';
import type { AttachmentMedia } from '../api/types';
import { getLocalArtworkUrl } from '../files/artworkCache';
import { externalArtworkUrl, usesServerArtwork } from '../files/media';
import { useFilesStore } from '../store/ChatProvider';

export type ArtworkStatus = 'idle' | 'loading' | 'ready' | 'empty';

export interface ArtworkResolution {
  /** A render-ready `https:` URL or an object URL of authenticated bytes. */
  url: string | null;
  status: ArtworkStatus;
  /** `true` when `url` is a local object URL (authenticated server bytes). */
  server: boolean;
}

/**
 * #97 cover resolution for one attachment.
 *
 * Priority:
 *  1. a client-supplied public http(s) `media.artwork_url` — rendered as-is;
 *  2. the server artwork endpoint (`.../attachments/{id}/artwork` or
 *     `metadata_source=SERVER` for AUDIO) — fetched through the API client as
 *     an authenticated blob and cached per attachment id, so its URL never
 *     appears in `<img src>` (that request would be unauthenticated → `401`);
 *  3. `url === null` → the caller shows its local ID3 cover or the default.
 *
 * A `404` (no extracted cover), `401`, `409` (scanning) or `423` (quarantine)
 * resolves to `empty`; artwork is decorative and never raises an error surface.
 */
export function useArtwork(
  attachmentId: string | null | undefined,
  media: AttachmentMedia | null | undefined,
  enabled = true,
): ArtworkResolution {
  const files = useFilesStore();
  const id = attachmentId ?? '';
  const external = externalArtworkUrl(id, media);
  const wantsServer = enabled && id.length > 0 && usesServerArtwork(id, media);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<ArtworkStatus>('idle');

  useEffect(() => {
    setServerUrl(null);
    if (external) {
      setStatus('ready');
      return;
    }
    if (!wantsServer || !id) {
      setStatus('idle');
      return;
    }
    let active = true;
    setStatus('loading');
    void files.getAttachmentArtworkUrl(id).then((url) => {
      if (!active) return;
      setServerUrl(url);
      setStatus(url ? 'ready' : 'empty');
    });
    return () => {
      active = false;
    };
  }, [external, files, id, wantsServer]);

  if (external) return { url: external, status: 'ready', server: false };
  return { url: serverUrl, status, server: serverUrl !== null };
}

/**
 * Local-only ID3 artwork from the IndexedDB cache (D1-FE2). Used as the second
 * fallback after the server cover; `enabled=false` skips the lookup entirely.
 */
export function useLocalArtworkFallback(
  attachmentId: string | null | undefined,
  enabled: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = attachmentId ?? '';

  useEffect(() => {
    setUrl(null);
    if (!enabled || !id) return;
    let active = true;
    void getLocalArtworkUrl(id).then((resolved) => {
      if (active) setUrl(resolved);
    });
    return () => {
      active = false;
    };
  }, [enabled, id]);

  return url;
}
