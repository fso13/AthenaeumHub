import type { ChatApi } from '../api/endpoints';
import { toApiError } from '../api/problem';
import type { ApiError } from '../api/problem';
import type {
  AuthUser,
  FileItem,
  TwoFactorRecoveryCodes,
  TwoFactorSetup,
  TwoFactorStatus,
  WorkspaceInvite,
  WorkspaceInviteCreated,
  WorkspaceInviteCreateRequest,
  WorkspacePermissionEntry,
  WorkspacePermissionKey,
  WorkspacePermissionMatrix,
  WorkspacePermissionRole,
  WorkspaceRolePermissions,
  WorkspaceSummary,
  WorkspaceUpdate,
} from '../api/types';

/** Where an image is being chosen: the own avatar or the workspace logo. */
export type AvatarTarget = 'PROFILE' | 'WORKSPACE';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AvatarState {
  target: AvatarTarget | null;
  workspaceId: string | null;
  imagesStatus: LoadStatus;
  /** Only `CLEAN`/`SKIPPED` images: the server rejects every other scan state. */
  images: FileItem[];
  imagesError: ApiError | null;
  actionStatus: 'idle' | 'saving' | 'removing';
  actionError: ApiError | null;
  /** Best-effort authenticated object URL of the current own avatar. */
  previewUrl: string | null;
  previewStatus: LoadStatus;
}

export interface TwoFactorState {
  status: LoadStatus;
  value: TwoFactorStatus | null;
  error: ApiError | null;
  setupStatus: 'idle' | 'starting' | 'error';
  setupError: ApiError | null;
  /** One-time setup payload; never persisted, cleared on close/verify. */
  setup: TwoFactorSetup | null;
  verifyStatus: 'idle' | 'verifying' | 'error';
  verifyError: ApiError | null;
  recoveryStatus: 'idle' | 'issuing' | 'error';
  recoveryError: ApiError | null;
  /** One-time recovery codes; never persisted, cleared on close/copy-away. */
  recoveryCodes: TwoFactorRecoveryCodes | null;
  disableStatus: 'idle' | 'disabling' | 'error';
  disableError: ApiError | null;
}

export interface WorkspaceInvitesState {
  status: LoadStatus;
  items: WorkspaceInvite[];
  error: ApiError | null;
  createStatus: 'idle' | 'creating' | 'error';
  createError: ApiError | null;
  /** Raw token/accept URL shown exactly once, then dropped on reset. */
  created: WorkspaceInviteCreated | null;
  revokePendingId: string | null;
  revokeError: ApiError | null;
}

export interface WorkspacePermissionsState {
  status: LoadStatus;
  matrix: WorkspacePermissionMatrix | null;
  error: ApiError | null;
  saveStatus: SaveStatus;
  saveError: ApiError | null;
}

export interface WorkspaceSettingsState {
  workspaceId: string | null;
  /** `PATCH /workspaces/{id}` (name/description/logo) state. */
  saveStatus: SaveStatus;
  saveError: ApiError | null;
  logoStatus: 'idle' | 'saving' | 'removing' | 'error';
  logoError: ApiError | null;
  /** Short-lived presigned URL of `logo_file_id` for the settings preview. */
  logoUrl: string | null;
  logoPreviewStatus: LoadStatus;
  invites: WorkspaceInvitesState;
  permissions: WorkspacePermissionsState;
}

export interface ProfileWorkspaceState {
  avatar: AvatarState;
  twoFactor: TwoFactorState;
  workspace: WorkspaceSettingsState;
}

/** The six configurable workspace rights, in contract order. */
export const WORKSPACE_PERMISSION_KEYS: readonly WorkspacePermissionKey[] = [
  'manage_workspace',
  'manage_members',
  'manage_invites',
  'manage_permissions',
  'view_audit',
  'manage_security',
];

export interface ProfileWorkspaceDeps {
  api: Pick<
    ChatApi,
    | 'listFiles'
    | 'setMyAvatar'
    | 'removeMyAvatar'
    | 'getMyAvatarBlob'
    | 'attachmentDownloadUrl'
    | 'getMyTwoFactor'
    | 'setupMyTwoFactor'
    | 'verifyMyTwoFactor'
    | 'disableMyTwoFactor'
    | 'regenerateMyRecoveryCodes'
    | 'updateWorkspace'
    | 'setWorkspaceAvatar'
    | 'deleteWorkspaceAvatar'
    | 'listWorkspaceInvites'
    | 'createWorkspaceInvite'
    | 'revokeWorkspaceInvite'
    | 'getWorkspacePermissions'
    | 'updateWorkspacePermissions'
  >;
  /** Keeps the app's workspace list/active workspace in sync with a server row. */
  onWorkspaceUpdated?: (workspace: WorkspaceSummary) => void;
  /** `null` means the own avatar was cleared (the `204` carries no body). */
  onProfileUpdated?: (user: AuthUser | null) => void;
  /** The workspace-logo `204` carries no body; the app clears the known row. */
  onWorkspaceLogoCleared?: (workspaceId: string) => void;
}

function emptyAvatar(): AvatarState {
  return {
    target: null,
    workspaceId: null,
    imagesStatus: 'idle',
    images: [],
    imagesError: null,
    actionStatus: 'idle',
    actionError: null,
    previewUrl: null,
    previewStatus: 'idle',
  };
}

function emptyTwoFactor(): TwoFactorState {
  return {
    status: 'idle',
    value: null,
    error: null,
    setupStatus: 'idle',
    setupError: null,
    setup: null,
    verifyStatus: 'idle',
    verifyError: null,
    recoveryStatus: 'idle',
    recoveryError: null,
    recoveryCodes: null,
    disableStatus: 'idle',
    disableError: null,
  };
}

function emptyInvites(): WorkspaceInvitesState {
  return {
    status: 'idle',
    items: [],
    error: null,
    createStatus: 'idle',
    createError: null,
    created: null,
    revokePendingId: null,
    revokeError: null,
  };
}

function emptyPermissions(): WorkspacePermissionsState {
  return {
    status: 'idle',
    matrix: null,
    error: null,
    saveStatus: 'idle',
    saveError: null,
  };
}

function emptyWorkspace(): WorkspaceSettingsState {
  return {
    workspaceId: null,
    saveStatus: 'idle',
    saveError: null,
    logoStatus: 'idle',
    logoError: null,
    logoUrl: null,
    logoPreviewStatus: 'idle',
    invites: emptyInvites(),
    permissions: emptyPermissions(),
  };
}

export function createEmptyProfileWorkspaceState(): ProfileWorkspaceState {
  return {
    avatar: emptyAvatar(),
    twoFactor: emptyTwoFactor(),
    workspace: emptyWorkspace(),
  };
}

/** Effective permission of one role, or `null` when the matrix is not loaded. */
export function permissionAllowed(
  matrix: WorkspacePermissionMatrix | null,
  role: WorkspacePermissionRole | null,
  key: WorkspacePermissionKey,
): boolean | null {
  if (!matrix || role === null) return null;
  const row = matrix.roles.find((entry) => entry.role === role);
  return row ? row[key] : null;
}

/** Immutable-by-contract OWNER row (always all `true`). */
export function ownerPermissions(
  matrix: WorkspacePermissionMatrix | null,
): WorkspaceRolePermissions | null {
  return matrix?.roles.find((entry) => entry.role === 'OWNER') ?? null;
}

/**
 * P0-4 (#82) profile/workspace store.
 *
 * - Avatar/logo selection reuses the file center (`GET /files?kind=IMAGE`);
 *   there is no new upload pipeline and only scan-approved images are offered.
 * - The TOTP setup secret and the recovery codes are held in memory only for
 *   the current open flow and are dropped by `clearTwoFactorDraft()`; they are
 *   never written to storage, logs or the audit surface.
 * - Workspace settings/invites/permissions replace rows only with server
 *   responses; the server owns every role ceiling and permission guard.
 */
export class ProfileWorkspaceStore {
  private readonly api: ProfileWorkspaceDeps['api'];
  private readonly onWorkspaceUpdated: ((workspace: WorkspaceSummary) => void) | undefined;
  private readonly onProfileUpdated: ((user: AuthUser | null) => void) | undefined;
  private readonly onWorkspaceLogoCleared: ((workspaceId: string) => void) | undefined;
  private state: ProfileWorkspaceState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private generation = 0;
  private avatarInFlight: Promise<void> | null = null;
  private twoFactorInFlight: Promise<void> | null = null;
  private invitesInFlight: Promise<void> | null = null;
  private permissionsInFlight: Promise<void> | null = null;
  /** Object URL created from the authenticated avatar blob (own avatar only). */
  private avatarObjectUrl: string | null = null;

  constructor(deps: ProfileWorkspaceDeps, initial?: ProfileWorkspaceState) {
    this.api = deps.api;
    this.onWorkspaceUpdated = deps.onWorkspaceUpdated;
    this.onProfileUpdated = deps.onProfileUpdated;
    this.onWorkspaceLogoCleared = deps.onWorkspaceLogoCleared;
    this.state = initial ?? createEmptyProfileWorkspaceState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ProfileWorkspaceState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  /** Logout/workspace switch drops every user-scoped row and one-time value. */
  reset(): void {
    this.generation += 1;
    this.avatarInFlight = null;
    this.twoFactorInFlight = null;
    this.invitesInFlight = null;
    this.permissionsInFlight = null;
    this.replaceAvatarObjectUrl(null);
    this.state = createEmptyProfileWorkspaceState();
    this.emit();
  }

  /** Clear the one-time TOTP values when the profile dialog closes. */
  clearTwoFactorDraft(): void {
    const { twoFactor } = this.state;
    if (!twoFactor.setup && !twoFactor.recoveryCodes && twoFactor.setupStatus === 'idle') {
      return;
    }
    this.patch({
      twoFactor: {
        ...twoFactor,
        setup: null,
        setupStatus: 'idle',
        setupError: null,
        verifyStatus: 'idle',
        verifyError: null,
        recoveryCodes: null,
        recoveryStatus: 'idle',
        recoveryError: null,
        disableStatus: 'idle',
        disableError: null,
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Avatar / workspace logo                                            */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /files?kind=IMAGE` for the own avatar or the active workspace logo.
   * Only CLEAN/SKIPPED rows are offered because the server rejects the rest.
   */
  loadAvatarImages(
    target: AvatarTarget,
    workspaceId: string | null = null,
    force = false,
  ): Promise<void> {
    const current = this.state.avatar;
    const sameTarget = current.target === target && current.workspaceId === workspaceId;
    if (!force && sameTarget) {
      if (current.imagesStatus === 'ready') return Promise.resolve();
      if (current.imagesStatus === 'loading' && this.avatarInFlight) return this.avatarInFlight;
    }
    const generation = this.generation;
    this.patch({
      avatar: {
        ...emptyAvatar(),
        target,
        workspaceId,
        imagesStatus: 'loading',
        images: sameTarget ? current.images : [],
      },
    });
    const promise = (async () => {
      try {
        const page = await this.api.listFiles({
          kind: 'IMAGE',
          // Own-profile image selection still reads the file center, which is
          // workspace-scoped. BFF access tokens carry no workspace claim, so the
          // active workspace id must be explicit for PROFILE too.
          workspaceId: workspaceId ?? undefined,
          limit: 50,
        });
        if (this.isStale(generation) || this.state.avatar.target !== target) return;
        this.patch({
          avatar: {
            ...this.state.avatar,
            images: page.items.filter(
              (item) => item.scan_status === 'CLEAN' || item.scan_status === 'SKIPPED',
            ),
            imagesStatus: 'ready',
            imagesError: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || this.state.avatar.target !== target) return;
        this.patch({
          avatar: {
            ...this.state.avatar,
            images: [],
            imagesStatus: 'error',
            imagesError: toApiError(error),
          },
        });
      } finally {
        this.avatarInFlight = null;
      }
    })();
    this.avatarInFlight = promise;
    return promise;
  }

  /** `POST /me/avatar` or `POST /workspaces/{id}/avatar`. */
  async setAvatar(
    target: AvatarTarget,
    fileId: string,
    workspaceId: string | null = null,
  ): Promise<boolean> {
    if (this.state.avatar.actionStatus !== 'idle') return false;
    const generation = this.generation;
    this.patch({
      avatar: {
        ...this.state.avatar,
        target,
        workspaceId,
        actionStatus: 'saving',
        actionError: null,
      },
    });
    try {
      if (target === 'PROFILE') {
        const user = await this.api.setMyAvatar(fileId);
        this.onProfileUpdated?.(user);
        // Replace the cached blob object URL; it is shared with the sidebar row.
        void this.loadMyAvatarPreview(true);
      } else if (workspaceId) {
        const workspace = await this.api.setWorkspaceAvatar(workspaceId, fileId);
        this.onWorkspaceUpdated?.(workspace);
        void this.loadWorkspaceLogoPreview(workspace.logo_file_id ?? null);
      }
      if (this.isStale(generation)) return false;
      this.patch({ avatar: { ...this.state.avatar, actionStatus: 'idle', actionError: null } });
      return true;
    } catch (error) {
      if (this.isStale(generation)) return false;
      this.patch({
        avatar: { ...this.state.avatar, actionStatus: 'idle', actionError: toApiError(error) },
      });
      return false;
    }
  }

  /**
   * Resolve the own avatar through the authenticated `GET /me/avatar` blob.
   * The raw attachment id is never known to the client; a browser without
   * `URL.createObjectURL` (jsdom) simply shows the initials fallback.
   */
  async loadMyAvatarPreview(force = false): Promise<void> {
    if (!force) {
      if (this.state.avatar.previewStatus === 'ready') return;
      if (this.state.avatar.previewStatus === 'loading') return;
    }
    const generation = this.generation;
    this.patch({
      avatar: { ...this.state.avatar, previewStatus: 'loading' },
    });
    try {
      const blob = await this.api.getMyAvatarBlob();
      if (this.isStale(generation)) return;
      const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
      this.replaceAvatarObjectUrl(url);
      this.patch({
        avatar: { ...this.state.avatar, previewUrl: url, previewStatus: 'ready' },
      });
    } catch {
      if (this.isStale(generation)) return;
      // `404` simply means "no avatar"; any other failure keeps the initials.
      this.replaceAvatarObjectUrl(null);
      this.patch({
        avatar: { ...this.state.avatar, previewUrl: null, previewStatus: 'ready' },
      });
    }
  }

  /**
   * Resolve a short-lived presigned URL for the workspace logo (same file flow
   * as every other managed attachment; no storage key/id is exposed).
   */
  async loadWorkspaceLogoPreview(fileId: string | null): Promise<void> {
    if (!fileId) {
      this.patch({
        workspace: {
          ...this.state.workspace,
          logoUrl: null,
          logoPreviewStatus: 'ready',
        },
      });
      return;
    }
    this.patch({
      workspace: { ...this.state.workspace, logoUrl: null, logoPreviewStatus: 'loading' },
    });
    try {
      const download = await this.api.attachmentDownloadUrl(fileId);
      this.patch({
        workspace: {
          ...this.state.workspace,
          logoUrl: download.url,
          logoPreviewStatus: 'ready',
        },
      });
    } catch {
      this.patch({
        workspace: {
          ...this.state.workspace,
          logoUrl: null,
          logoPreviewStatus: 'error',
        },
      });
    }
  }

  /** Drop the own-avatar object URL (profile dialog close / logout). */
  clearAvatarPreview(): void {
    this.replaceAvatarObjectUrl(null);
    if (this.state.avatar.previewUrl === null && this.state.avatar.previewStatus === 'idle') return;
    this.patch({
      avatar: { ...this.state.avatar, previewUrl: null, previewStatus: 'idle' },
    });
  }

  private replaceAvatarObjectUrl(next: string | null): void {
    if (
      this.avatarObjectUrl &&
      this.avatarObjectUrl !== next &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(this.avatarObjectUrl);
    }
    this.avatarObjectUrl = next;
  }

  /** `DELETE /me/avatar` or `DELETE /workspaces/{id}/avatar` (idempotent). */
  async removeAvatar(target: AvatarTarget, workspaceId: string | null = null): Promise<boolean> {
    if (this.state.avatar.actionStatus !== 'idle') return false;
    const generation = this.generation;
    this.patch({
      avatar: {
        ...this.state.avatar,
        target,
        workspaceId,
        actionStatus: 'removing',
        actionError: null,
      },
    });
    try {
      if (target === 'PROFILE') {
        await this.api.removeMyAvatar();
        // The contract's `204` carries no body: the app only clears
        // `avatar_url` on the already-known profile row.
        this.onProfileUpdated?.(null);
        this.replaceAvatarObjectUrl(null);
        this.patch({
          avatar: { ...this.state.avatar, previewUrl: null, previewStatus: 'ready' },
        });
      } else if (workspaceId) {
        await this.api.deleteWorkspaceAvatar(workspaceId);
        this.onWorkspaceLogoCleared?.(workspaceId);
        this.patch({
          workspace: {
            ...this.state.workspace,
            logoUrl: null,
            logoPreviewStatus: 'ready',
          },
        });
      }
      if (this.isStale(generation)) return false;
      this.patch({ avatar: { ...this.state.avatar, actionStatus: 'idle', actionError: null } });
      return true;
    } catch (error) {
      if (this.isStale(generation)) return false;
      this.patch({
        avatar: { ...this.state.avatar, actionStatus: 'idle', actionError: toApiError(error) },
      });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* TOTP authenticator                                                 */
  /* ------------------------------------------------------------------ */

  /** `GET /me/2fa` — status only, never the secret/codes. */
  loadTwoFactor(force = false): Promise<void> {
    if (!force) {
      if (this.state.twoFactor.status === 'ready') return Promise.resolve();
      if (this.state.twoFactor.status === 'loading' && this.twoFactorInFlight) {
        return this.twoFactorInFlight;
      }
    }
    const generation = this.generation;
    this.patch({ twoFactor: { ...this.state.twoFactor, status: 'loading', error: null } });
    const promise = (async () => {
      try {
        const value = await this.api.getMyTwoFactor();
        if (this.isStale(generation)) return;
        this.patch({
          twoFactor: { ...this.state.twoFactor, status: 'ready', value, error: null },
        });
      } catch (error) {
        if (this.isStale(generation)) return;
        this.patch({
          twoFactor: {
            ...this.state.twoFactor,
            status: 'error',
            error: toApiError(error),
          },
        });
      } finally {
        this.twoFactorInFlight = null;
      }
    })();
    this.twoFactorInFlight = promise;
    return promise;
  }

  /**
   * `POST /me/2fa/setup` (password re-auth). The returned secret/otpauth URI is
   * kept only in memory for this flow and is cleared after confirmation.
   */
  async setupTwoFactor(password: string): Promise<boolean> {
    if (this.state.twoFactor.setupStatus === 'starting') return false;
    this.patch({
      twoFactor: {
        ...this.state.twoFactor,
        setupStatus: 'starting',
        setupError: null,
        setup: null,
        recoveryCodes: null,
        recoveryError: null,
      },
    });
    try {
      const setup = await this.api.setupMyTwoFactor(password);
      this.patch({
        twoFactor: { ...this.state.twoFactor, setupStatus: 'idle', setup, setupError: null },
      });
      return true;
    } catch (error) {
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          setupStatus: 'error',
          setup: null,
          setupError: toApiError(error),
        },
      });
      return false;
    }
  }

  /** `POST /me/2fa/verify`; on success the one-time setup payload is dropped. */
  async verifyTwoFactorSetup(code: string): Promise<boolean> {
    if (this.state.twoFactor.verifyStatus === 'verifying') return false;
    this.patch({
      twoFactor: { ...this.state.twoFactor, verifyStatus: 'verifying', verifyError: null },
    });
    try {
      const value = await this.api.verifyMyTwoFactor(code);
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          status: 'ready',
          value,
          setup: null,
          setupStatus: 'idle',
          verifyStatus: 'idle',
          verifyError: null,
        },
      });
      return true;
    } catch (error) {
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          verifyStatus: 'error',
          verifyError: toApiError(error),
        },
      });
      return false;
    }
  }

  /** `POST /me/2fa/recovery-codes` (password re-auth); one-time display. */
  async issueRecoveryCodes(password: string): Promise<boolean> {
    if (this.state.twoFactor.recoveryStatus === 'issuing') return false;
    this.patch({
      twoFactor: {
        ...this.state.twoFactor,
        recoveryStatus: 'issuing',
        recoveryError: null,
        recoveryCodes: null,
      },
    });
    try {
      const recoveryCodes = await this.api.regenerateMyRecoveryCodes(password);
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          recoveryStatus: 'idle',
          recoveryCodes,
          recoveryError: null,
          value: this.state.twoFactor.value
            ? {
                ...this.state.twoFactor.value,
                recovery_codes_remaining: recoveryCodes.remaining,
              }
            : this.state.twoFactor.value,
        },
      });
      return true;
    } catch (error) {
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          recoveryStatus: 'error',
          recoveryError: toApiError(error),
        },
      });
      return false;
    }
  }

  /** `DELETE /me/2fa` with password + TOTP/recovery code. */
  async disableTwoFactor(password: string, code: string): Promise<boolean> {
    if (this.state.twoFactor.disableStatus === 'disabling') return false;
    this.patch({
      twoFactor: { ...this.state.twoFactor, disableStatus: 'disabling', disableError: null },
    });
    try {
      await this.api.disableMyTwoFactor({ password, code });
      this.patch({
        twoFactor: {
          ...emptyTwoFactor(),
          status: 'ready',
          value: {
            enabled: false,
            enabled_at: null,
            recovery_codes_remaining: 0,
          },
        },
      });
      return true;
    } catch (error) {
      this.patch({
        twoFactor: {
          ...this.state.twoFactor,
          disableStatus: 'error',
          disableError: toApiError(error),
        },
      });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Workspace settings, invites and permissions                        */
  /* ------------------------------------------------------------------ */

  /** Load the matrix and the invite list for the workspace settings pane. */
  async loadWorkspaceAdmin(workspaceId: string, force = false): Promise<void> {
    if (workspaceId !== this.state.workspace.workspaceId) {
      // A previous workspace's in-flight response must not land in this one.
      this.generation += 1;
      this.invitesInFlight = null;
      this.permissionsInFlight = null;
      this.patch({ workspace: { ...emptyWorkspace(), workspaceId } });
    }
    await Promise.all([
      this.loadWorkspacePermissions(workspaceId, force),
      this.loadWorkspaceInvites(workspaceId, force),
    ]);
  }

  /** `PATCH /workspaces/{id}`; the response is the authoritative summary. */
  async updateWorkspaceSettings(
    workspaceId: string,
    body: WorkspaceUpdate,
  ): Promise<WorkspaceSummary | null> {
    if (this.state.workspace.saveStatus === 'saving') return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        workspaceId,
        saveStatus: 'saving',
        saveError: null,
      },
    });
    try {
      const updated = await this.api.updateWorkspace(workspaceId, body);
      this.onWorkspaceUpdated?.(updated);
      if (body.logo_file_id !== undefined) {
        void this.loadWorkspaceLogoPreview(updated.logo_file_id ?? null);
      }
      if (this.state.workspace.workspaceId !== workspaceId) return updated;
      this.patch({
        workspace: { ...this.state.workspace, saveStatus: 'saved', saveError: null },
      });
      return updated;
    } catch (error) {
      this.patch({
        workspace: {
          ...this.state.workspace,
          saveStatus: 'error',
          saveError: toApiError(error),
        },
      });
      return null;
    }
  }

  /** `GET /workspaces/{id}/invites` (manage_invites; metadata only). */
  loadWorkspaceInvites(workspaceId: string, force = false): Promise<void> {
    const invites = this.state.workspace.invites;
    if (!force) {
      if (invites.status === 'ready') return Promise.resolve();
      if (invites.status === 'loading' && this.invitesInFlight) return this.invitesInFlight;
    }
    const generation = this.generation;
    this.patch({
      workspace: {
        ...this.state.workspace,
        workspaceId,
        invites: { ...invites, status: 'loading', error: null },
      },
    });
    const promise = (async () => {
      try {
        const response = await this.api.listWorkspaceInvites(workspaceId);
        if (this.isStale(generation) || this.state.workspace.workspaceId !== workspaceId) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            invites: {
              ...this.state.workspace.invites,
              items: response.invites,
              status: 'ready',
              error: null,
            },
          },
        });
      } catch (error) {
        if (this.isStale(generation) || this.state.workspace.workspaceId !== workspaceId) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            invites: {
              ...this.state.workspace.invites,
              status: 'error',
              error: toApiError(error),
            },
          },
        });
      } finally {
        this.invitesInFlight = null;
      }
    })();
    this.invitesInFlight = promise;
    return promise;
  }

  /** `POST /workspaces/{id}/invites`; the raw token is kept for one display. */
  async createWorkspaceInvite(
    workspaceId: string,
    body: WorkspaceInviteCreateRequest,
  ): Promise<WorkspaceInviteCreated | null> {
    if (this.state.workspace.invites.createStatus === 'creating') return null;
    this.patch({
      workspace: {
        ...this.state.workspace,
        invites: {
          ...this.state.workspace.invites,
          createStatus: 'creating',
          createError: null,
          created: null,
        },
      },
    });
    try {
      const created = await this.api.createWorkspaceInvite(workspaceId, body);
      this.patch({
        workspace: {
          ...this.state.workspace,
          invites: {
            ...this.state.workspace.invites,
            items: [
              created.invite,
              ...this.state.workspace.invites.items.filter((item) => item.id !== created.invite.id),
            ],
            createStatus: 'idle',
            createError: null,
            created,
          },
        },
      });
      return created;
    } catch (error) {
      this.patch({
        workspace: {
          ...this.state.workspace,
          invites: {
            ...this.state.workspace.invites,
            createStatus: 'error',
            createError: toApiError(error),
          },
        },
      });
      return null;
    }
  }

  /** `DELETE /workspaces/{id}/invites/{inviteId}` (idempotent revoke). */
  async revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<boolean> {
    if (this.state.workspace.invites.revokePendingId !== null) return false;
    this.patch({
      workspace: {
        ...this.state.workspace,
        invites: {
          ...this.state.workspace.invites,
          revokePendingId: inviteId,
          revokeError: null,
        },
      },
    });
    try {
      await this.api.revokeWorkspaceInvite(workspaceId, inviteId);
      this.patch({
        workspace: {
          ...this.state.workspace,
          invites: {
            ...this.state.workspace.invites,
            items: this.state.workspace.invites.items.map((item) =>
              item.id === inviteId ? { ...item, status: 'REVOKED' } : item,
            ),
            revokePendingId: null,
            revokeError: null,
          },
        },
      });
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      this.patch({
        workspace: {
          ...this.state.workspace,
          invites: {
            ...this.state.workspace.invites,
            // A missing row means it is already gone: drop it like a success.
            items:
              apiError.status === 404
                ? this.state.workspace.invites.items.filter((item) => item.id !== inviteId)
                : this.state.workspace.invites.items,
            revokePendingId: null,
            revokeError: apiError.status === 404 ? null : apiError,
          },
        },
      });
      return apiError.status === 404;
    }
  }

  /** `GET /workspaces/{id}/permissions` (readable by every ACTIVE member). */
  loadWorkspacePermissions(workspaceId: string, force = false): Promise<void> {
    const permissions = this.state.workspace.permissions;
    if (!force) {
      if (permissions.status === 'ready') return Promise.resolve();
      if (permissions.status === 'loading' && this.permissionsInFlight) {
        return this.permissionsInFlight;
      }
    }
    const generation = this.generation;
    this.patch({
      workspace: {
        ...this.state.workspace,
        workspaceId,
        permissions: { ...permissions, status: 'loading', error: null },
      },
    });
    const promise = (async () => {
      try {
        const matrix = await this.api.getWorkspacePermissions(workspaceId);
        if (this.isStale(generation) || this.state.workspace.workspaceId !== workspaceId) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            permissions: {
              ...this.state.workspace.permissions,
              matrix,
              status: 'ready',
              error: null,
            },
          },
        });
      } catch (error) {
        if (this.isStale(generation) || this.state.workspace.workspaceId !== workspaceId) return;
        this.patch({
          workspace: {
            ...this.state.workspace,
            permissions: {
              ...this.state.workspace.permissions,
              status: 'error',
              error: toApiError(error),
            },
          },
        });
      } finally {
        this.permissionsInFlight = null;
      }
    })();
    this.permissionsInFlight = promise;
    return promise;
  }

  /** `PATCH /workspaces/{id}/permissions`; the matrix is replaced wholesale. */
  async updateWorkspacePermissions(
    workspaceId: string,
    entries: WorkspacePermissionEntry[],
  ): Promise<boolean> {
    if (this.state.workspace.permissions.saveStatus === 'saving') return false;
    this.patch({
      workspace: {
        ...this.state.workspace,
        permissions: {
          ...this.state.workspace.permissions,
          saveStatus: 'saving',
          saveError: null,
        },
      },
    });
    try {
      const matrix = await this.api.updateWorkspacePermissions(workspaceId, { entries });
      this.patch({
        workspace: {
          ...this.state.workspace,
          permissions: {
            ...this.state.workspace.permissions,
            matrix,
            status: 'ready',
            saveStatus: 'saved',
            saveError: null,
          },
        },
      });
      return true;
    } catch (error) {
      this.patch({
        workspace: {
          ...this.state.workspace,
          permissions: {
            ...this.state.workspace.permissions,
            saveStatus: 'error',
            saveError: toApiError(error),
          },
        },
      });
      return false;
    }
  }

  /** Clear the one-time invite token from the UI after it was copied. */
  clearCreatedInvite(): void {
    if (!this.state.workspace.invites.created) return;
    this.patch({
      workspace: {
        ...this.state.workspace,
        invites: { ...this.state.workspace.invites, created: null },
      },
    });
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<ProfileWorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
}

export function createProfileWorkspaceStore(deps: ProfileWorkspaceDeps): ProfileWorkspaceStore {
  return new ProfileWorkspaceStore(deps);
}

/** Kept for callers that need a narrow structural type in props/tests. */
export type ProfileWorkspaceApi = ProfileWorkspaceDeps['api'];
export type { WorkspaceRolePermissions };
