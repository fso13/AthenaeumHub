import { useState, type ReactNode } from 'react';
import type { AttachmentMedia } from '../api/types';
import { useArtwork } from '../hooks/useArtwork';

export interface ArtworkImageProps {
  attachmentId: string;
  media: AttachmentMedia | null | undefined;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** Rendered when there is no artwork or the image fails to decode. */
  fallback: ReactNode;
}

/**
 * #97 cover thumbnail. Resolves `media.artwork_url` through the artwork hook:
 * a public client URL is used as-is, the server endpoint is fetched as an
 * authenticated blob, and the fallback node is shown when neither exists.
 * Centralizes the rule that the authenticated endpoint never becomes `src`.
 */
export function ArtworkImage({
  attachmentId,
  media,
  alt = '',
  className,
  loading = 'lazy',
  fallback,
}: ArtworkImageProps) {
  const artwork = useArtwork(attachmentId, media);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = artwork.url !== null && artwork.url !== failedSrc ? artwork.url : null;
  if (!src) return <>{fallback}</>;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailedSrc(src)}
    />
  );
}
