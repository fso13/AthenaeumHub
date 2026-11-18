import type { ChatApi } from '../api/endpoints';
import { ApiError, toApiError } from '../api/problem';
import { createAdminDirectoryStore, type AdminDirectoryStore } from './adminDirectory';
import type {
  AdminOverview,
  AdminSettings,
  AdminSettingsPatch,
  SetupStatus,
  TestEmailResponse,
} from '../api/types';

export type OpsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type TestEmailStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * E8 first-run setup + platform admin state. Global (installation-wide) data,
 * so it is kept outside the user/chat slices; `reset()` still clears it on
 * logout so a subsequent user cannot read the previous admin's form state.
 */
export interface OpsState {
  setupStatus: SetupStatus | null;
  setupStatusStatus: OpsLoadStatus;
  setupStatusError: ApiError | null;

  settings: AdminSettings | null;
  settingsStatus: OpsLoadStatus;
  settingsError: ApiError | null;

  overview: AdminOverview | null;
  overviewStatus: OpsLoadStatus;
  overviewError: ApiError | null;

  saving: boolean;
  saveError: ApiError | null;

  testEmailStatus: TestEmailStatus;
  testEmailError: ApiError | null;
  /** Recipient of the last accepted test email; never a secret. */
  testEmailTo: string | null;
}

export type OpsApi = Pick<
  ChatApi,
  | 'getSetupStatus'
  | 'getAdminSettings'
  | 'updateAdminSettings'
  | 'sendTestEmail'
  | 'getAdminOverview'
  | 'listAdminUsers'
  | 'listAdminChats'
  | 'getAdminStorage'
  | 'suspendUser'
  | 'activateUser'
  | 'deleteChat'
  | 'listAdminAudit'
>;

export interface OpsStoreDeps {
  api: OpsApi;
}

export function createInitialOpsState(): OpsState {
  return {
    setupStatus: null,
    setupStatusStatus: 'idle',
    setupStatusError: null,
    settings: null,
    settingsStatus: 'idle',
    settingsError: null,
    overview: null,
    overviewStatus: 'idle',
    overviewError: null,
    saving: false,
    saveError: null,
    testEmailStatus: 'idle',
    testEmailError: null,
    testEmailTo: null,
  };
}

/**
 * Thin, testable adapter over the E8 `/setup/status` and `/admin/*` operations.
 * It never stores the SMTP password: the password only exists in the settings
 * form state until `PATCH /admin/settings` completes, then it is dropped.
 */
export class OpsStore {
  /** E9-F admin directory (users/chats/storage) — own subscription surface. */
  readonly directory: AdminDirectoryStore;

  private readonly api: OpsApi;
  private state: OpsState;
  private listeners = new Set<() => void>();
  private setupPromise: Promise<void> | null = null;
  private settingsPromise: Promise<void> | null = null;
  private overviewPromise: Promise<void> | null = null;
  private savePromise: Promise<AdminSettings | null> | null = null;
  private testPromise: Promise<boolean> | null = null;
  /** Invalidates in-flight responses after logout/account switch. */
  private generation = 0;
  private disposed = false;

  constructor(deps: OpsStoreDeps) {
    this.api = deps.api;
    this.directory = createAdminDirectoryStore({ api: deps.api });
    this.state = createInitialOpsState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): OpsState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.directory.dispose();
    this.listeners.clear();
  }

  reset(): void {
    this.generation += 1;
    this.setupPromise = null;
    this.settingsPromise = null;
    this.overviewPromise = null;
    this.savePromise = null;
    this.testPromise = null;
    this.directory.reset();
    this.state = createInitialOpsState();
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<OpsState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  async loadSetupStatus(force = false): Promise<void> {
    if (!force && (this.state.setupStatusStatus === 'ready' || this.setupPromise)) {
      return this.setupPromise ?? undefined;
    }
    if (this.setupPromise) return this.setupPromise;

    const generation = this.generation;
    this.patch({ setupStatusStatus: 'loading', setupStatusError: null });
    this.setupPromise = (async () => {
      try {
        const status = await this.api.getSetupStatus();
        if (this.disposed || generation !== this.generation) return;
        this.patch({
          setupStatus: status,
          setupStatusStatus: 'ready',
          setupStatusError: null,
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        this.patch({
          setupStatusStatus: 'error',
          setupStatusError: toApiError(error),
        });
      } finally {
        if (generation === this.generation) this.setupPromise = null;
      }
    })();
    return this.setupPromise;
  }

  async loadSettings(force = false): Promise<void> {
    if (!force && (this.state.settingsStatus === 'ready' || this.settingsPromise)) {
      return this.settingsPromise ?? undefined;
    }
    if (this.settingsPromise) return this.settingsPromise;

    const generation = this.generation;
    this.patch({ settingsStatus: 'loading', settingsError: null });
    this.settingsPromise = (async () => {
      try {
        const settings = await this.api.getAdminSettings();
        if (this.disposed || generation !== this.generation) return;
        this.patch({ settings, settingsStatus: 'ready', settingsError: null });
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        this.patch({ settingsStatus: 'error', settingsError: toApiError(error) });
      } finally {
        if (generation === this.generation) this.settingsPromise = null;
      }
    })();
    return this.settingsPromise;
  }

  async loadOverview(force = false): Promise<void> {
    if (!force && (this.state.overviewStatus === 'ready' || this.overviewPromise)) {
      return this.overviewPromise ?? undefined;
    }
    if (this.overviewPromise) return this.overviewPromise;

    const generation = this.generation;
    this.patch({ overviewStatus: 'loading', overviewError: null });
    this.overviewPromise = (async () => {
      try {
        const overview = await this.api.getAdminOverview();
        if (this.disposed || generation !== this.generation) return;
        this.patch({ overview, overviewStatus: 'ready', overviewError: null });
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        this.patch({ overviewStatus: 'error', overviewError: toApiError(error) });
      } finally {
        if (generation === this.generation) this.overviewPromise = null;
      }
    })();
    return this.overviewPromise;
  }

  /** `/admin` loads both cards in parallel; each card owns its error state. */
  loadAdmin(force = false): Promise<void> {
    return Promise.all([this.loadSettings(force), this.loadOverview(force)]).then(() => undefined);
  }

  /**
   * `PATCH /admin/settings`. `completeSetup=true` is the atomic first-run
   * completion; a repeated completion surfaces `409 SETUP_ALREADY_COMPLETED`
   * and reconciles local state with the server instead of guessing.
   */
  async saveSettings(
    patch: AdminSettingsPatch,
    completeSetup = false,
  ): Promise<AdminSettings | null> {
    if (this.savePromise) return this.savePromise;

    const generation = this.generation;
    this.patch({ saving: true, saveError: null, testEmailStatus: 'idle', testEmailError: null });
    this.savePromise = (async () => {
      try {
        const body: AdminSettingsPatch = { ...patch };
        if (completeSetup) body.complete_setup = true;
        const settings = await this.api.updateAdminSettings(body);
        if (this.disposed || generation !== this.generation) return null;
        this.patch({
          settings,
          settingsStatus: 'ready',
          settingsError: null,
          saving: false,
          saveError: null,
          setupStatus: {
            setup_required: !settings.setup_completed,
            registration_open: settings.registration_open,
          },
          setupStatusStatus: 'ready',
          setupStatusError: null,
        });
        return settings;
      } catch (error) {
        if (this.disposed || generation !== this.generation) return null;
        const apiError = toApiError(error);
        this.patch({ saving: false, saveError: apiError });
        if (apiError.status === 409 && apiError.code === 'SETUP_ALREADY_COMPLETED') {
          // Another admin/tab won the completion race: reload the truth.
          void this.loadSetupStatus(true);
          void this.loadSettings(true);
        }
        return null;
      } finally {
        if (generation === this.generation) this.savePromise = null;
      }
    })();
    return this.savePromise;
  }

  /** `POST /admin/settings/test-email`; 503 SMTP_UNAVAILABLE is surfaced as-is. */
  async sendTestEmail(to: string): Promise<boolean> {
    const email = to.trim();
    if (!email) {
      this.patch({
        testEmailStatus: 'error',
        testEmailError: ApiError.client(
          'VALIDATION_FAILED',
          'Test email recipient is required',
          422,
          { field: 'to' },
        ),
      });
      return false;
    }
    if (this.testPromise) return this.testPromise;

    const generation = this.generation;
    this.patch({ testEmailStatus: 'sending', testEmailError: null });
    this.testPromise = (async () => {
      try {
        const response: TestEmailResponse = await this.api.sendTestEmail({ to: email });
        if (this.disposed || generation !== this.generation) return false;
        if (!response.sent) {
          throw ApiError.client('SMTP_UNAVAILABLE', 'SMTP delivery failed', 503, {
            reason: 'smtp_unavailable',
          });
        }
        this.patch({
          testEmailStatus: 'sent',
          testEmailError: null,
          testEmailTo: response.to,
        });
        return true;
      } catch (error) {
        if (this.disposed || generation !== this.generation) return false;
        this.patch({
          testEmailStatus: 'error',
          testEmailError: toApiError(error),
        });
        return false;
      } finally {
        if (generation === this.generation) this.testPromise = null;
      }
    })();
    return this.testPromise;
  }

  clearSaveError(): void {
    if (this.state.saveError) this.patch({ saveError: null });
  }

  clearTestEmail(): void {
    if (this.state.testEmailStatus !== 'idle' || this.state.testEmailError) {
      this.patch({ testEmailStatus: 'idle', testEmailError: null, testEmailTo: null });
    }
  }
}

export function createOpsStore(deps: OpsStoreDeps): OpsStore {
  return new OpsStore(deps);
}
