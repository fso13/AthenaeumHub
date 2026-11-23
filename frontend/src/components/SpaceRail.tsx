import type { RailSpace } from '../domain/unread';
import { formatUnreadBadge, unreadLabel } from '../domain/unread';
import { t } from '../i18n/ru';
import { workspaceInitial } from '../domain/workspace';
import {
  workspaceLifecycleActionForRole,
  type WorkspaceLifecycleAction,
} from '../workspace/lifecycle';
import { Avatar } from './Avatar';
import { LogoutIcon, PlusIcon } from './Icons';

interface SpaceRailProps {
  spaces: RailSpace[];
  activeSpaceId: string | null;
  unreadBySpace: Record<string, number>;
  onSelect: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  /** Workspace logo object/presigned URLs keyed by workspace id (optional). */
  logoUrls?: Record<string, string | null>;
  /**
   * #99: opens the shared leave/delete confirmation. The role decides whether
   * the row exposes an action at all: the sole OWNER only gets delete, other
   * ACTIVE members only get leave.
   */
  onWorkspaceAction?: (workspaceId: string, action: WorkspaceLifecycleAction) => void;
}

/**
 * D1-FE1: the space rail. The unread badge is the sum of the workspace chat
 * counters; the visual text is capped at `99+`, while `aria-label` always
 * contains the exact number. The badge itself is decorative (`aria-hidden`)
 * so assistive technology announces the number once, from the button label.
 */
export function SpaceRail({
  spaces,
  activeSpaceId,
  unreadBySpace,
  onSelect,
  onCreateWorkspace,
  logoUrls,
  onWorkspaceAction,
}: SpaceRailProps) {
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
          const roleAction = onWorkspaceAction ? workspaceLifecycleActionForRole(space.role) : null;
          // #99: deletion is destructive and belongs to the Settings danger zone,
          // never to the tiny rail icon where it can be hit accidentally.
          const action = roleAction === 'leave' ? roleAction : null;
          const actionLabel = action
            ? t('workspace.lifecycle.railLeave', { name: space.name })
            : null;
          return (
            <li className="space-rail__row" key={space.id}>
              <button
                type="button"
                className={`space-rail__item${active ? ' space-rail__item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={label}
                title={label}
                onClick={() => onSelect(space.id)}
              >
                <Avatar
                  name={space.name}
                  seed={space.id}
                  size="lg"
                  short={workspaceInitial(space.name)}
                  src={logoUrls?.[space.id] ?? null}
                />
                {badge ? (
                  <span className="unread-badge space-rail__badge" aria-hidden="true">
                    {badge}
                  </span>
                ) : null}
              </button>
              {action && actionLabel ? (
                <button
                  type="button"
                  className={`space-rail__action space-rail__action--${action}`}
                  aria-label={actionLabel}
                  title={actionLabel}
                  onClick={() => onWorkspaceAction?.(space.id, action)}
                >
                  <LogoutIcon aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="rail-add"
        disabled={!onCreateWorkspace}
        aria-label={t('rail.add')}
        title={onCreateWorkspace ? t('rail.add') : t('rail.addUnavailable')}
        onClick={onCreateWorkspace}
      >
        <PlusIcon aria-hidden="true" />
      </button>
    </nav>
  );
}
