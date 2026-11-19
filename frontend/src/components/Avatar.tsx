import { avatarHue, initials } from '../domain/messages';

interface AvatarProps {
  name: string | null | undefined;
  seed?: string | null;
  /** 26 row-xs · 28 chat rows · 36 compact · 38 feed/header · 76 profile cover. */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'profile';
}

/**
 * D1 UX fidelity: squircle initials on the warm gradient palette from
 * `design/dashboard/styles.css` (`.av.p1…p10`). The tone is derived from the
 * same stable hue hash as before; only the visual language changed.
 */
export function Avatar({ name, seed, size = 'sm' }: AvatarProps) {
  const tone = Math.floor(avatarHue(seed ?? name) / 45);
  return (
    <span
      className={`avatar avatar--${size} avatar--tone-${tone}`}
      aria-hidden="true"
      title={name ?? undefined}
    >
      {initials(name)}
    </span>
  );
}
