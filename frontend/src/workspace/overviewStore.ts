import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { WorkspaceOverview } from '../api/types';

export type WorkspaceOverviewStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * #84 workspace dashboard read model.
 *
 * `GET /workspaces/{id}/overview` returns aggregates and a tiny audit preview
 * only: no message text, E2EE envelopes, filenames, IPs or tokens. The read is
 * scoped to the active workspace and a late response from a previous workspace
 * is discarded, so switching spaces cannot resurrect another tenant's counts.
 */
export interface WorkspaceOverviewState {
  workspaceId: string | null;
  data: WorkspaceOverview | null;
  status: WorkspaceOverviewStatus;
  error: ApiError | null;
}

export interface WorkspaceOverviewStoreDeps {
  api: Pick<ChatApi, 'getWorkspaceOverview'>;
}

export function createInitialWorkspaceOverviewState(): WorkspaceOverviewState {
  return { workspaceId: null, data: null, status: 'idle', error: null };
}

export class WorkspaceOverviewStore {
  private readonly api: WorkspaceOverviewStoreDeps['api'];
  private state: WorkspaceOverviewState = createInitialWorkspaceOverviewState();
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(deps: WorkspaceOverviewStoreDeps) {
    this.api = deps.api;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): WorkspaceOverviewState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.inFlight = null;
    this.listeners.clear();
  }

  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.state = createInitialWorkspaceOverviewState();
    this.emit();
  }

  /** Switch the read model to another workspace and drop the previous rows. */
  setWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.state.workspaceId) return;
    this.generation += 1;
    this.inFlight = null;
    this.state = { workspaceId, data: null, status: 'idle', error: null };
    this.emit();
  }

  async load(force = false): Promise<void> {
    if (this.disposed) return;
    const workspaceId = this.state.workspaceId;
    if (!workspaceId) return;
    if (this.inFlight) return this.inFlight;
    if (!force && this.state.status === 'ready') return;

    const generation = this.generation;
    this.patch({ status: 'loading', error: null });

    this.inFlight = (async () => {
      try {
        const data = await this.api.getWorkspaceOverview(workspaceId);
        if (this.disposed || generation !== this.generation) return;
        this.patch({ data, status: 'ready', error: null });
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        this.patch({ status: 'error', error: toApiError(error) });
      } finally {
        if (generation === this.generation) this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<WorkspaceOverviewState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
}

export function createWorkspaceOverviewStore(
  deps: WorkspaceOverviewStoreDeps,
): WorkspaceOverviewStore {
  return new WorkspaceOverviewStore(deps);
}
