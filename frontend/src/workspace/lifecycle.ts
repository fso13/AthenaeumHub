import type { WorkspaceRole } from '../api/types';

/**
 * #99: workspace lifecycle actions exposed by the settings danger zone, the
 * workspace switcher and the space rail.
 *
 * The server owns the real guards (`409 LAST_OWNER` for the sole OWNER,
 * `403 WORKSPACE_PERMISSION_DENIED` for a non-OWNER delete, `403 FORBIDDEN`
 * for outsiders). These helpers only decide which entry point is honest to
 * show: the sole OWNER can never leave (there is exactly one OWNER in the
 * current schema), while every other ACTIVE member can leave and only the
 * OWNER can delete.
 */
export type WorkspaceLifecycleAction = 'leave' | 'delete';

export function canLeaveWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return role === 'ADMIN' || role === 'MEMBER' || role === 'GUEST';
}

export function canDeleteWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return role === 'OWNER';
}

/** The single primary action offered by the compact rail/switcher context. */
export function workspaceLifecycleActionForRole(
  role: WorkspaceRole | null | undefined,
): WorkspaceLifecycleAction | null {
  if (canDeleteWorkspace(role)) return 'delete';
  if (canLeaveWorkspace(role)) return 'leave';
  return null;
}
