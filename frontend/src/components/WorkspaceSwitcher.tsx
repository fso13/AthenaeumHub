import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { WorkspaceSummary } from '../api/types';
import { useAvatarsState, useAvatarsStore } from '../store/ChatProvider';
import { workspaceInitial } from '../domain/workspace';
import {
  workspaceLifecycleActionForRole,
  type WorkspaceLifecycleAction,
} from '../workspace/lifecycle';
import { t } from '../i18n/ru';
import { Avatar } from './Avatar';
import { ChevronDownIcon, LogoutIcon, PlusIcon, TrashIcon } from './Icons';

interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  currentName: string;
  onSelect: (workspaceId: string) => void;
  /** Opens the shared create-workspace dialog (same as the rail "+"). */
  onCreateWorkspace?: () => void;
  /** #99: leave/delete for the current workspace (role-aware). */
  onWorkspaceAction?: (workspaceId: string, action: WorkspaceLifecycleAction) => void;
}

function modeLabel(workspace: WorkspaceSummary): string {
  return workspace.security_mode === 'E2EE' ? t('chat.e2ee') : t('chat.managedChip');
}

/**
 * D1-FE1 / v1.2: workspace switcher from design/dashboard (v1.2.0).
 *
 * The native `<select>` is replaced with the popover from the frozen design:
 * two-line workspace names, mode chips, an active row and the disabled
 * "create workspace" item. Behaviour stays the same: only the workspace id is
 * handed to the parent, which persists and reloads it per device.
 *
 * Keyboard: Enter/Space toggles, ArrowDown/Up moves through workspace rows,
 * Home/End jump to the edges, Escape closes and returns focus to the trigger.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  currentName,
  onSelect,
  onCreateWorkspace,
  onWorkspaceAction,
}: WorkspaceSwitcherProps) {
  const avatars = useAvatarsState();
  const avatarsStore = useAvatarsStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  // The sole OWNER sees delete and no leave; ADMIN/MEMBER/GUEST see leave only.
  const lifecycleAction = onWorkspaceAction
    ? workspaceLifecycleActionForRole(activeWorkspace?.role)
    : null;

  // Workspace logos are existing attachments (`logo_file_id`), deduped per id.
  useEffect(() => {
    for (const workspace of workspaces) {
      if (workspace.logo_file_id) {
        void avatarsStore.ensureWorkspace(workspace.id, workspace.logo_file_id);
      }
    }
  }, [avatarsStore, workspaces]);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const active = activeIndex >= 0 ? activeIndex : 0;
    itemRefs.current[active]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const focusItem = (direction: 1 | -1 | 'first' | 'last') => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (direction === 'first') next = 0;
    else if (direction === 'last') next = items.length - 1;
    else if (current === -1) next = direction === 1 ? 0 : items.length - 1;
    else next = (current + direction + items.length) % items.length;
    items[next]?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem('last');
    }
  };

  return (
    <div
      className="ws-switch"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ws-btn ws-switch__trigger"
        aria-label={`${t('workspace.switch')}: ${currentName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={t('workspace.switchHint')}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="ws-btn__name">{currentName}</span>
        <ChevronDownIcon className="chev" aria-hidden="true" />
      </button>

      {open ? (
        <div
          id={menuId}
          className="ws-switch__menu"
          role="menu"
          aria-label={t('rail.label')}
          onKeyDown={onMenuKeyDown}
        >
          <div className="ws-switch__label">{t('rail.label')}</div>
          {workspaces.map((workspace, index) => {
            const active = workspace.id === activeWorkspaceId;
            return (
              <button
                key={workspace.id}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`ws-switch__item${active ? ' ws-switch__item--active' : ''}`}
                onClick={() => {
                  onSelect(workspace.id);
                  close(true);
                }}
              >
                <Avatar
                  name={workspace.name}
                  seed={workspace.id}
                  size="sm"
                  short={workspaceInitial(workspace.name)}
                  src={avatars.workspaces[workspace.id]?.url ?? null}
                />
                <span className="ws-switch__name">{workspace.name}</span>
                <span
                  className={`ws-switch__chip${
                    workspace.security_mode === 'E2EE' ? ' ws-switch__chip--e2ee' : ''
                  }`}
                >
                  {modeLabel(workspace)}
                </span>
              </button>
            );
          })}
          <div className="ws-switch__divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="ws-switch__create"
            disabled={!onCreateWorkspace}
            title={onCreateWorkspace ? t('rail.add') : t('rail.addUnavailable')}
            onClick={() => {
              if (!onCreateWorkspace) return;
              close(false);
              onCreateWorkspace();
            }}
          >
            <PlusIcon aria-hidden="true" />
            <span>{t('rail.add')}</span>
          </button>
          {lifecycleAction && activeWorkspace ? (
            <>
              <div className="ws-switch__divider" role="separator" />
              <div className="ws-switch__label">{t('workspace.lifecycle.menuLabel')}</div>
              <button
                type="button"
                role="menuitem"
                className={`ws-switch__item ws-switch__item--danger${
                  lifecycleAction === 'delete' ? ' ws-switch__item--delete' : ''
                }`}
                onClick={() => {
                  close(true);
                  onWorkspaceAction?.(activeWorkspace.id, lifecycleAction);
                }}
              >
                {lifecycleAction === 'delete' ? (
                  <TrashIcon aria-hidden="true" />
                ) : (
                  <LogoutIcon aria-hidden="true" />
                )}
                <span className="ws-switch__name">
                  {t(
                    lifecycleAction === 'delete'
                      ? 'workspace.lifecycle.delete'
                      : 'workspace.lifecycle.leave',
                  )}
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
