import type { RailSpace } from '../domain/unread';
import { formatUnreadBadge, unreadLabel } from '../domain/unread';
import { t } from '../i18n/ru';
import { Avatar } from './Avatar';
import { PlusIcon } from './Icons';

interface SpaceRailProps {
  spaces: RailSpace[];
  activeSpaceId: string | null;
  unreadBySpace: Record<string, number>;
  onSelect: (workspaceId: string) => void;
}

/**
 * D1-FE1: the space rail. The unread badge is the sum of the workspace chat
 * counters; the visual text is capped at `99+`, while `aria-label` always
 * contains the exact number. The badge itself is decorative (`aria-hidden`)
 * so assistive technology announces the number once, from the button label.
 */
export function SpaceRail({ spaces, activeSpaceId, unreadBySpace, onSelect }: SpaceRailProps) {
  if (spaces.length === 0) return null;

  return (
    <nav className="space-rail" aria-label={t('rail.label')}>
      <span className="space-rail__brand" aria-hidden="true">
        <img src="/icons/sova-icon-64.png" alt="" width={40} height={40} />
      </span>
      <ul className="space-rail__items">
        {spaces.map((space) => {
          const active = space.id === activeSpaceId;
          const unread = Math.max(0, unreadBySpace[space.id] ?? 0);
          const badge = formatUnreadBadge(unread);
          const label =
            unread > 0
              ? t('rail.spaceUnread', { name: space.name, count: unreadLabel(unread) })
              : t('rail.space', { name: space.name });
          return (
            <li key={space.id}>
              <button
                type="button"
                className={`space-rail__item${active ? ' space-rail__item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={label}
                title={label}
                onClick={() => onSelect(space.id)}
              >
                <Avatar name={space.name} seed={space.id} size="lg" />
                {badge ? (
                  <span className="unread-badge space-rail__badge" aria-hidden="true">
                    {badge}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="rail-add"
        disabled
        aria-label={t('rail.add')}
        title={t('rail.addUnavailable')}
      >
        <PlusIcon aria-hidden="true" />
      </button>
    </nav>
  );
}
