import { useEffect, useState } from 'react';
import { avatarHue, initials } from '../domain/messages';

interface AvatarProps {
  name: string | null | undefined;
  seed?: string | null;
  /** 26 row-xs · 28 chat rows · 36 compact · 38 feed/header · 76 profile cover. */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'profile';
  /** D1-FE1: workspace rail/menu avatars use one meaningful letter. */
  short?: string;
  /**
   * P0-4 (#82): optional image URL (presigned/object URL, already validated by
   * the caller). Falls back to the initials when absent or unsafe.
   */
  src?: string | null;
}

/**
 * D1 UX fidelity: squircle initials on the warm gradient palette from
 * `design/dashboard/styles.css` (`.av.p1…p10`). The tone is derived from the
 * same stable hue hash as before; only the visual language changed.
 *
 * P0-4 avatars are authenticated blob/object or short-lived presigned URLs. A
 * failed load (expired URL, revoked object URL, blocked CORS) flips back to the
 * initials instead of leaving a broken image.
 */
export function Avatar({ name, seed, size = 'sm', short, src }: AvatarProps) {
  const tone = Math.floor(avatarHue(seed ?? name) / 45);
  const image = typeof src === 'string' && /^(https?:|blob:)/i.test(src) ? src : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    setFailedSrc(null);
  }, [image]);

  const showImage = image !== null && failedSrc !== image;
  return (
    <span
      className={`avatar avatar--${size} avatar--tone-${tone}${showImage ? ' avatar--image' : ''}`}
      aria-hidden="true"
      title={name ?? undefined}
    >
      {showImage ? (
        <img
          className="avatar__img"
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(image)}
        />
      ) : (
        (short ?? initials(name))
      )}
    </span>
  );
}
