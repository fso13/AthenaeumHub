import type { ChatApi, PluginPackageUploadOptions } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { AdminPluginPackage, ChatPluginState, Plugin } from '../api/types';
import { readBlobText } from './blob';

export type PluginsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** D1.2 (#86): admin ZIP install lifecycle. */
export type PackageInstallStatus = 'idle' | 'uploading' | 'verifying' | 'done' | 'error';

export interface PackageInstallState {
  status: PackageInstallStatus;
  fileName: string | null;
  loadedBytes: number;
  totalBytes: number;
  /** Contract error; never a raw archive body or server stack. */
  error: ApiError | null;
  installed: AdminPluginPackage | null;
}

export type PackageUninstallStatus = 'idle' | 'running' | 'done' | 'error';

export interface PackageUninstallState {
  pluginId: string | null;
  status: PackageUninstallStatus;
  error: ApiError | null;
}

export const EMPTY_PACKAGE_INSTALL_STATE: PackageInstallState = {
  status: 'idle',
  fileName: null,
  loadedBytes: 0,
  totalBytes: 0,
  error: null,
  installed: null,
};

export const EMPTY_PACKAGE_UNINSTALL_STATE: PackageUninstallState = {
  pluginId: null,
  status: 'idle',
  error: null,
};

/**
 * Feedback for the last server-confirmed PATCH. `changed` is derived by
 * comparing the previous server row with the response: a no-op PATCH returns
 * `200` but the backend deliberately writes no audit event.
 */
export interface PluginToggleResult {
  pluginId: string;
  enabled: boolean;
  changed: boolean;
  at: number;
}

export interface PluginsState {
  catalogStatus: PluginsLoadStatus;
  catalog: Plugin[];
  catalogError: ApiError | null;
  /** Chat whose per-chat rows are currently loaded. */
  chatId: string | null;
  chatStatus: PluginsLoadStatus;
  chatStates: ChatPluginState[];
  chatError: ApiError | null;
  /** Plugin ids with an in-flight PATCH; their switches stay at the server value. */
  pendingPluginIds: string[];
  /** Inline PATCH failure; never replaces the last known server state. */
  toggleError: ApiError | null;
  lastToggle: PluginToggleResult | null;
  /** D1.2 (#86): installed external packages from `GET /admin/plugins`. */
  adminPackagesStatus: PluginsLoadStatus;
  adminPackages: AdminPluginPackage[];
  adminPackagesError: ApiError | null;
  installState: PackageInstallState;
  uninstallState: PackageUninstallState;
}

export interface PluginsStoreDeps {
  api: Pick<
    ChatApi,
    | 'listPlugins'
    | 'listChatPlugins'
    | 'updateChatPlugin'
    | 'listAdminPlugins'
    | 'installPluginPackage'
    | 'uninstallPluginPackage'
    | 'getPluginAsset'
  >;
  now?: () => number;
}

export const EMPTY_PLUGINS_STATE: PluginsState = {
  catalogStatus: 'idle',
  catalog: [],
  catalogError: null,
  chatId: null,
  chatStatus: 'idle',
  chatStates: [],
  chatError: null,
  pendingPluginIds: [],
  toggleError: null,
  lastToggle: null,
  adminPackagesStatus: 'idle',
  adminPackages: [],
  adminPackagesError: null,
  installState: { ...EMPTY_PACKAGE_INSTALL_STATE },
  uninstallState: { ...EMPTY_PACKAGE_UNINSTALL_STATE },
};

/**
 * Project a freshly installed admin package into the public catalog row so the
 * plugins page can render it without a second round trip. `entry_url` mirrors
 * the server contract (`/api/v1/plugins/{id}/assets/{entry}`).
 */
export function externalCatalogEntry(pkg: AdminPluginPackage): Plugin {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    icon: 'plug',
    permissions: pkg.permissions,
    modes: pkg.modes,
    state: 'ACTIVE',
    kind: 'EXTERNAL',
    version: pkg.version,
    author: pkg.author,
    entry_url: `/api/v1/plugins/${pkg.id}/assets/${pkg.entry}`,
  };
}

/**
 * D1.1 (#69) plugins read model. Deliberately has no optimistic update: a
 * switch only moves after `PATCH /chats/{chatId}/plugins/{pluginId}` returns
 * the server row, and a failed call leaves the last known state untouched.
 */
export class PluginsStore {
  private readonly api: PluginsStoreDeps['api'];
  private readonly now: () => number;
  private state: PluginsState = { ...EMPTY_PLUGINS_STATE };
  private readonly listeners = new Set<() => void>();
  private catalogPromise: Promise<void> | null = null;
  private adminPromise: Promise<void> | null = null;
  private chatPromise: Promise<void> | null = null;
  private chatLoadId: string | null = null;
  private disposed = false;

  constructor(deps: PluginsStoreDeps) {
    this.api = deps.api;
    this.now = deps.now ?? (() => Date.now());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PluginsState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<PluginsState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Read the catalog once per session unless a forced reload is requested. */
  async ensureCatalog(): Promise<void> {
    if (this.state.catalogStatus === 'ready') return;
    if (this.state.catalogStatus === 'loading' && this.catalogPromise) {
      return this.catalogPromise;
    }
    return this.loadCatalog();
  }

  async loadCatalog(force = false): Promise<void> {
    if (!force && this.state.catalogStatus === 'ready') return;
    if (this.state.catalogStatus === 'loading' && this.catalogPromise) {
      return this.catalogPromise;
    }

    this.patch({ catalogStatus: 'loading', catalogError: null });
    this.catalogPromise = this.runLoadCatalog().finally(() => {
      this.catalogPromise = null;
    });
    return this.catalogPromise;
  }

  private async runLoadCatalog(): Promise<void> {
    try {
      const response = await this.api.listPlugins();
      if (this.disposed) return;
      this.patch({ catalogStatus: 'ready', catalog: response.items, catalogError: null });
    } catch (error) {
      if (this.disposed) return;
      this.patch({ catalogStatus: 'error', catalogError: toApiError(error) });
    }
  }

  /** Load per-chat rows once per chat; switching chats drops the old rows. */
  async ensureChat(chatId: string): Promise<void> {
    if (this.state.chatStatus === 'ready' && this.state.chatId === chatId) return;
    if (this.state.chatStatus === 'loading' && this.chatLoadId === chatId && this.chatPromise) {
      return this.chatPromise;
    }
    return this.loadChat(chatId);
  }

  async loadChat(chatId: string, force = false): Promise<void> {
    if (!force && this.state.chatStatus === 'ready' && this.state.chatId === chatId) return;
    if (this.state.chatStatus === 'loading' && this.chatLoadId === chatId && this.chatPromise) {
      return this.chatPromise;
    }

    this.chatLoadId = chatId;
    const sameChat = this.state.chatId === chatId;
    this.patch({
      chatId,
      chatStatus: 'loading',
      chatError: null,
      toggleError: null,
      lastToggle: null,
      ...(sameChat ? {} : { chatStates: [], pendingPluginIds: [] }),
    });

    this.chatPromise = this.runLoadChat(chatId).finally(() => {
      this.chatPromise = null;
      this.chatLoadId = null;
    });
    return this.chatPromise;
  }

  private async runLoadChat(chatId: string): Promise<void> {
    try {
      const response = await this.api.listChatPlugins(chatId);
      if (this.disposed || this.state.chatId !== chatId) return;
      this.patch({ chatStatus: 'ready', chatStates: response.items, chatError: null });
    } catch (error) {
      if (this.disposed || this.state.chatId !== chatId) return;
      this.patch({ chatStatus: 'error', chatError: toApiError(error) });
    }
  }

  /**
   * Change one switch. There is no optimistic update: until the server
   * responds the row keeps its previous value and the toggle is disabled by
   * `pendingPluginIds`. The response replaces only that row.
   */
  async toggle(chatId: string, pluginId: string, enabled: boolean): Promise<void> {
    if (this.disposed || this.state.chatId !== chatId) return;
    if (this.state.pendingPluginIds.includes(pluginId)) return;

    const previous = this.state.chatStates.find((item) => item.plugin_id === pluginId);
    this.patch({
      pendingPluginIds: [...this.state.pendingPluginIds, pluginId],
      toggleError: null,
      lastToggle: null,
    });

    try {
      const response = await this.api.updateChatPlugin(chatId, pluginId, { enabled });
      if (this.disposed || this.state.chatId !== chatId) return;
      const changed = previous ? previous.enabled !== response.enabled : response.enabled;
      this.patch({
        chatStates: this.replaceState(pluginId, response),
        pendingPluginIds: this.state.pendingPluginIds.filter((id) => id !== pluginId),
        lastToggle: {
          pluginId,
          enabled: response.enabled,
          changed,
          at: this.now(),
        },
      });
    } catch (error) {
      if (this.disposed || this.state.chatId !== chatId) return;
      this.patch({
        pendingPluginIds: this.state.pendingPluginIds.filter((id) => id !== pluginId),
        toggleError: toApiError(error),
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* D1.2 (#86): external package administration                        */
  /* ------------------------------------------------------------------ */

  /** Read the installed external packages once per admin session. */
  async ensureAdminPackages(): Promise<void> {
    if (this.state.adminPackagesStatus === 'ready') return;
    if (this.state.adminPackagesStatus === 'loading' && this.adminPromise) return this.adminPromise;
    return this.loadAdminPackages();
  }

  async loadAdminPackages(force = false): Promise<void> {
    if (!force && this.state.adminPackagesStatus === 'ready') return;
    if (this.state.adminPackagesStatus === 'loading' && this.adminPromise) return this.adminPromise;

    this.patch({ adminPackagesStatus: 'loading', adminPackagesError: null });
    this.adminPromise = this.runLoadAdminPackages().finally(() => {
      this.adminPromise = null;
    });
    return this.adminPromise;
  }

  private async runLoadAdminPackages(): Promise<void> {
    try {
      const response = await this.api.listAdminPlugins();
      if (this.disposed) return;
      this.patch({
        adminPackagesStatus: 'ready',
        adminPackages: response.items,
        adminPackagesError: null,
      });
    } catch (error) {
      if (this.disposed) return;
      this.patch({ adminPackagesStatus: 'error', adminPackagesError: toApiError(error) });
    }
  }

  /**
   * Upload one ZIP. The server remains the only authority on the archive and
   * manifest; this store only reflects progress and contract errors. The
   * installed row is prepended after `201`, never before.
   */
  async installPackage(
    file: File,
    options: Pick<PluginPackageUploadOptions, 'signal'> = {},
  ): Promise<void> {
    if (
      this.state.installState.status === 'uploading' ||
      this.state.installState.status === 'verifying'
    ) {
      return;
    }

    const totalBytes = file.size;
    this.patch({
      installState: {
        status: 'uploading',
        fileName: file.name,
        loadedBytes: 0,
        totalBytes,
        error: null,
        installed: null,
      },
    });

    let lastPercent = -1;
    const onProgress = (loaded: number, total: number) => {
      if (this.disposed) return;
      const current = this.state.installState;
      if (current.status !== 'uploading' && current.status !== 'verifying') return;
      const effectiveTotal = total > 0 ? total : current.totalBytes;
      const percent = effectiveTotal > 0 ? Math.floor((loaded / effectiveTotal) * 100) : -1;
      if (percent === lastPercent && percent < 100) return;
      lastPercent = percent;
      this.patch({
        installState: {
          ...current,
          status: effectiveTotal > 0 && loaded >= effectiveTotal ? 'verifying' : 'uploading',
          loadedBytes: loaded,
          totalBytes: effectiveTotal,
        },
      });
    };

    try {
      const installed = await this.api.installPluginPackage(file, {
        signal: options.signal,
        onProgress,
      });
      if (this.disposed) return;
      this.patch({
        installState: {
          status: 'done',
          fileName: file.name,
          loadedBytes: file.size,
          totalBytes: file.size,
          error: null,
          installed,
        },
        adminPackagesStatus: 'ready',
        adminPackagesError: null,
        adminPackages: [
          installed,
          ...this.state.adminPackages.filter((item) => item.id !== installed.id),
        ],
        catalog: [
          ...this.state.catalog.filter((plugin) => plugin.id !== installed.id),
          externalCatalogEntry(installed),
        ],
      });
    } catch (error) {
      if (this.disposed) return;
      const current = this.state.installState;
      this.patch({
        installState: {
          ...current,
          status: 'error',
          error: toApiError(error),
        },
      });
    }
  }

  /** Soft-uninstall; the server owns tombstoning and object cleanup. */
  async uninstallPackage(pluginId: string): Promise<void> {
    if (this.state.uninstallState.status === 'running') return;
    this.patch({ uninstallState: { pluginId, status: 'running', error: null } });
    try {
      await this.api.uninstallPluginPackage(pluginId);
      if (this.disposed) return;
      this.patch({
        uninstallState: { pluginId, status: 'done', error: null },
        adminPackages: this.state.adminPackages.filter((item) => item.id !== pluginId),
        catalog: this.state.catalog.filter((plugin) => plugin.id !== pluginId),
        chatStates: this.state.chatStates.filter((item) => item.plugin_id !== pluginId),
        pendingPluginIds: this.state.pendingPluginIds.filter((id) => id !== pluginId),
      });
    } catch (error) {
      if (this.disposed) return;
      this.patch({
        uninstallState: { pluginId, status: 'error', error: toApiError(error) },
      });
    }
  }

  /** Clear the one-shot install/uninstall feedback (dialog open/close). */
  resetPackageFeedback(): void {
    this.patch({
      installState: { ...EMPTY_PACKAGE_INSTALL_STATE },
      uninstallState: { ...EMPTY_PACKAGE_UNINSTALL_STATE },
    });
  }

  /** Authenticated package asset bytes (entry document when omitted). */
  readPluginAsset(entryUrl: string, assetPath?: string): Promise<Blob> {
    return this.api.getPluginAsset(entryUrl, assetPath);
  }

  /** Authenticated entry HTML used to build the sandboxed `srcdoc`. */
  async readPluginEntry(entryUrl: string): Promise<string> {
    const blob = await this.api.getPluginAsset(entryUrl);
    return readBlobText(blob);
  }

  private replaceState(pluginId: string, next: ChatPluginState): ChatPluginState[] {
    const found = this.state.chatStates.some((item) => item.plugin_id === pluginId);
    if (!found) return [...this.state.chatStates, next];
    return this.state.chatStates.map((item) => (item.plugin_id === pluginId ? next : item));
  }

  clearToggleError(): void {
    if (!this.state.toggleError) return;
    this.patch({ toggleError: null });
  }

  /** Drop all user-scoped state on logout/account switch. */
  reset(): void {
    this.catalogPromise = null;
    this.adminPromise = null;
    this.chatPromise = null;
    this.chatLoadId = null;
    this.state = { ...EMPTY_PLUGINS_STATE, catalog: [], chatStates: [], adminPackages: [] };
    this.emit();
  }
}

export function createPluginsStore(deps: PluginsStoreDeps): PluginsStore {
  return new PluginsStore(deps);
}
