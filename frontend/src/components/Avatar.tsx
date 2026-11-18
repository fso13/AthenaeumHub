import { avatarHue, initials } from '../domain/messages';

interface AvatarProps {
  name: string | null | undefined;
  seed?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

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
