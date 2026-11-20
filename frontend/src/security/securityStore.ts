import type {
  ChatApi,
  ListWorkspaceAuditQuery,
  WorkspaceAuditExportResult,
} from '../api/endpoints';
import { ApiError, toApiError } from '../api/problem';
import type {
  AuditExportFormat,
  DlpAction,
  DlpEventRow,
  DlpPolicy,
  DlpPolicyCreateRequest,
  DlpPolicyUpdateRequest,
  SecurityMode,
  WorkspaceAuditEvent,
  WorkspaceSecurity,
  WorkspaceSecurityUpdateRequest,
  WorkspaceSession,
  WorkspaceSessionRevokeAll,
} from '../api/types';
import {
  AUDIT_PAGE_SIZE,
  DLP_EVENTS_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
  datetimeLocalToIso,
  invalidDateRange,
  isUuid,
} from './model';

/**
 * P0-3 (#81) workspace security store.
 *
 * The page is OWNER/ADMIN-only: every operation is guarded by the server and
 * the UI never calls a manager endpoint for a MEMBER/GUEST (the page passes
 * `isManager`). The store itself also refuses to run without an open
 * workspace, so a late navigation cannot resurrect stale rows.
 *
 * Rules encoded here:
 *  * cursor/next_cursor is opaque and only echoed back;
 *  * pages are appended in server order and de-duplicated by id;
 *  * a filter change starts a new chain and discards the old in-flight page;
 *  * a mutation updates local rows only from the server response, never
 *    optimistically;
 *  * E2EE has no DLP read/write: the store never fetches policies/events there.
 */

export type SecuritySectionStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SecuritySaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type AuditActionFilter = 'ALL' | DlpAction;

export interface DlpPoliciesState {
  items: DlpPolicy[];
  status: SecuritySectionStatus;
  error: ApiError | null;
  saveStatus: SecuritySaveStatus;
  saveError: ApiError | null;
  deleteStatus: 'idle' | 'deleting' | 'error';
  deletingId: string | null;
  deleteError: ApiError | null;
}

export interface DlpEventsState {
  items: DlpEventRow[];
  nextCursor: string | null;
  hasMore: boolean;
  status: SecuritySectionStatus;
  error: ApiError | null;
  loadingMore: boolean;
  moreError: ApiError | null;
  action: AuditActionFilter;
  policyId: string;
}

export interface AuditFilters {
  action: string;
  actorId: string;
  from: string;
  to: string;
}

export interface WorkspaceAuditState {
  items: WorkspaceAuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  status: SecuritySectionStatus;
  error: ApiError | null;
  loadingMore: boolean;
  moreError: ApiError | null;
  filters: AuditFilters;
  /** Client-side `from > to` / UUID / length failure; no request is sent. */
  filterError: ApiError | null;
  exportStatus: 'idle' | 'exporting' | 'done' | 'error';
  exportFormat: AuditExportFormat | null;
  exportRows: number | null;
  exportTruncated: boolean;
  exportFilename: string | null;
  exportError: ApiError | null;
}

export interface WorkspaceSessionsState {
  items: WorkspaceSession[];
  nextCursor: string | null;
  hasMore: boolean;
  status: SecuritySectionStatus;
  error: ApiError | null;
  loadingMore: boolean;
  moreError: ApiError | null;
  revokeStatus: 'idle' | 'revoking' | 'error';
  revokingId: string | null;
  revokeError: ApiError | null;
  revokeAllStatus: 'idle' | 'revoking' | 'done' | 'error';
  revokeAllError: ApiError | null;
  revokeAllResult: WorkspaceSessionRevokeAll | null;
}

export interface WorkspaceSecurityState {
  data: WorkspaceSecurity | null;
  status: SecuritySectionStatus;
  error: ApiError | null;
  saveStatus: SecuritySaveStatus;
  saveError: ApiError | null;
}

export interface SecurityStoreState {
  workspaceId: string | null;
  mode: SecurityMode;
  policies: DlpPoliciesState;
  events: DlpEventsState;
  audit: WorkspaceAuditState;
  sessions: WorkspaceSessionsState;
  settings: WorkspaceSecurityState;
}

/** Public snapshot alias used by the React subscription hook. */
export type SecurityState = SecurityStoreState;

export type SecurityStoreApi = Pick<
  ChatApi,
  | 'listWorkspaceDlpPolicies'
  | 'createWorkspaceDlpPolicy'
  | 'updateWorkspaceDlpPolicy'
  | 'deleteWorkspaceDlpPolicy'
  | 'listWorkspaceDlpEvents'
  | 'listWorkspaceAudit'
  | 'exportWorkspaceAudit'
  | 'listWorkspaceSessions'
  | 'revokeWorkspaceSession'
  | 'revokeAllWorkspaceSessions'
  | 'getWorkspaceSecurity'
  | 'updateWorkspaceSecurity'
>;

export interface SecurityStoreDeps {
  api: SecurityStoreApi;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  action: '',
  actorId: '',
  from: '',
  to: '',
};

export function createEmptyPoliciesState(): DlpPoliciesState {
  return {
    items: [],
    status: 'idle',
    error: null,
    saveStatus: 'idle',
    saveError: null,
    deleteStatus: 'idle',
    deletingId: null,
    deleteError: null,
  };
}

export function createEmptyEventsState(): DlpEventsState {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    status: 'idle',
    error: null,
    loadingMore: false,
    moreError: null,
    action: 'ALL',
    policyId: '',
  };
}

export function createEmptyAuditState(): WorkspaceAuditState {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    status: 'idle',
    error: null,
    loadingMore: false,
    moreError: null,
    filters: { ...EMPTY_AUDIT_FILTERS },
    filterError: null,
    exportStatus: 'idle',
    exportFormat: null,
    exportRows: null,
    exportTruncated: false,
    exportFilename: null,
    exportError: null,
  };
}

export function createEmptySessionsState(): WorkspaceSessionsState {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    status: 'idle',
    error: null,
    loadingMore: false,
    moreError: null,
    revokeStatus: 'idle',
    revokingId: null,
    revokeError: null,
    revokeAllStatus: 'idle',
    revokeAllError: null,
    revokeAllResult: null,
  };
}

export function createEmptySettingsState(): WorkspaceSecurityState {
  return {
    data: null,
    status: 'idle',
    error: null,
    saveStatus: 'idle',
    saveError: null,
  };
}

export function createInitialSecurityState(): SecurityStoreState {
  return {
    workspaceId: null,
    mode: 'MANAGED',
    policies: createEmptyPoliciesState(),
    events: createEmptyEventsState(),
    audit: createEmptyAuditState(),
    sessions: createEmptySessionsState(),
    settings: createEmptySettingsState(),
  };
}

function appendUnique<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function sortPolicies(policies: DlpPolicy[]): DlpPolicy[] {
  return [...policies].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
}

export class SecurityStore {
  private readonly api: SecurityStoreApi;
  private state: SecurityStoreState;
  private listeners = new Set<() => void>();
  /** Invalidates every in-flight response after close/workspace switch/logout. */
  private generation = 0;
  private disposed = false;
  private policiesInFlight: Promise<void> | null = null;
  private eventsInFlight: Promise<void> | null = null;
  private auditInFlight: Promise<void> | null = null;
  private sessionsInFlight: Promise<void> | null = null;
  private settingsInFlight: Promise<void> | null = null;
  /** Per-section request tokens invalidate a filter change mid-flight. */
  private policiesRequestId = 0;
  private eventsRequestId = 0;
  private auditRequestId = 0;
  private sessionsRequestId = 0;
  private settingsRequestId = 0;
  private exportRequestId = 0;

  constructor(deps: SecurityStoreDeps) {
    this.api = deps.api;
    this.state = createInitialSecurityState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SecurityStoreState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  /** Logout/workspace switch drops every manager-scoped row. */
  reset(): void {
    this.generation += 1;
    this.policiesInFlight = null;
    this.eventsInFlight = null;
    this.auditInFlight = null;
    this.sessionsInFlight = null;
    this.settingsInFlight = null;
    this.policiesRequestId += 1;
    this.eventsRequestId += 1;
    this.auditRequestId += 1;
    this.sessionsRequestId += 1;
    this.settingsRequestId += 1;
    this.exportRequestId += 1;
    this.state = createInitialSecurityState();
    this.emit();
  }

  close(): void {
    if (this.state.workspaceId === null) return;
    this.reset();
  }

  /** Open the page for a workspace; reloads the sections on every mount. */
  async open(workspaceId: string, mode: SecurityMode): Promise<void> {
    if (workspaceId !== this.state.workspaceId || mode !== this.state.mode) {
      this.generation += 1;
      this.policiesInFlight = null;
      this.eventsInFlight = null;
      this.auditInFlight = null;
      this.sessionsInFlight = null;
      this.settingsInFlight = null;
      this.policiesRequestId += 1;
      this.eventsRequestId += 1;
      this.auditRequestId += 1;
      this.sessionsRequestId += 1;
      this.settingsRequestId += 1;
      this.exportRequestId += 1;
      this.state = {
        ...createInitialSecurityState(),
        workspaceId,
        mode,
      };
      this.emit();
    }
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    const tasks: Promise<void>[] = [
      this.loadSettings(true),
      this.loadAudit(true),
      this.loadSessions(true),
    ];
    if (this.state.mode === 'MANAGED') {
      tasks.push(this.loadPolicies(true), this.loadEvents(true));
    }
    await Promise.all(tasks);
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<SecurityStoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private sameWorkspace(): string | null {
    return this.state.workspaceId;
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  /* ---------------------------------------------------------------------- */
  /* DLP policies                                                           */
  /* ---------------------------------------------------------------------- */

  async loadPolicies(force = false): Promise<void> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.mode !== 'MANAGED') return;
    if (this.policiesInFlight) return this.policiesInFlight;
    if (!force && this.state.policies.status === 'ready') return;

    const generation = this.generation;
    const requestId = ++this.policiesRequestId;
    this.patch({
      policies: {
        ...this.state.policies,
        status: 'loading',
        error: null,
      },
    });
    this.policiesInFlight = (async () => {
      try {
        const list = await this.api.listWorkspaceDlpPolicies(workspaceId);
        if (this.isStale(generation) || requestId !== this.policiesRequestId) return;
        this.patch({
          policies: {
            ...this.state.policies,
            items: sortPolicies(list.items),
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || requestId !== this.policiesRequestId) return;
        this.patch({
          policies: { ...this.state.policies, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && requestId === this.policiesRequestId) {
          this.policiesInFlight = null;
        }
      }
    })();
    return this.policiesInFlight;
  }

  async createPolicy(body: DlpPolicyCreateRequest): Promise<DlpPolicy | null> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.policies.saveStatus === 'saving') return null;
    const generation = this.generation;
    this.patch({
      policies: {
        ...this.state.policies,
        saveStatus: 'saving',
        saveError: null,
        deleteStatus: 'idle',
        deletingId: null,
        deleteError: null,
      },
    });
    try {
      const policy = await this.api.createWorkspaceDlpPolicy(workspaceId, body);
      if (this.isStale(generation)) return null;
      this.patch({
        policies: {
          ...this.state.policies,
          items: sortPolicies([
            ...this.state.policies.items.filter((item) => item.id !== policy.id),
            policy,
          ]),
          status: 'ready',
          saveStatus: 'saved',
          saveError: null,
        },
      });
      return policy;
    } catch (error) {
      if (this.isStale(generation)) return null;
      this.patch({
        policies: {
          ...this.state.policies,
          saveStatus: 'error',
          saveError: toApiError(error),
        },
      });
      return null;
    }
  }

  async updatePolicy(policyId: string, body: DlpPolicyUpdateRequest): Promise<DlpPolicy | null> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.policies.saveStatus === 'saving') return null;
    const generation = this.generation;
    this.patch({
      policies: {
        ...this.state.policies,
        saveStatus: 'saving',
        saveError: null,
        deleteStatus: 'idle',
        deletingId: null,
        deleteError: null,
      },
    });
    try {
      const policy = await this.api.updateWorkspaceDlpPolicy(workspaceId, policyId, body);
      if (this.isStale(generation)) return null;
      this.patch({
        policies: {
          ...this.state.policies,
          items: sortPolicies(
            this.state.policies.items.map((item) => (item.id === policy.id ? policy : item)),
          ),
          saveStatus: 'saved',
          saveError: null,
        },
      });
      return policy;
    } catch (error) {
      if (this.isStale(generation)) return null;
      this.patch({
        policies: {
          ...this.state.policies,
          saveStatus: 'error',
          saveError: toApiError(error),
        },
      });
      return null;
    }
  }

  async deletePolicy(policyId: string): Promise<boolean> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.policies.deleteStatus === 'deleting') return false;
    const generation = this.generation;
    this.patch({
      policies: {
        ...this.state.policies,
        deleteStatus: 'deleting',
        deletingId: policyId,
        deleteError: null,
        saveStatus: 'idle',
        saveError: null,
      },
    });
    try {
      await this.api.deleteWorkspaceDlpPolicy(workspaceId, policyId);
      if (this.isStale(generation)) return false;
      this.patch({
        policies: {
          ...this.state.policies,
          items: this.state.policies.items.filter((item) => item.id !== policyId),
          deleteStatus: 'idle',
          deletingId: null,
          deleteError: null,
        },
        // Historical events keep the name snapshot; the live policy link is gone.
        events: {
          ...this.state.events,
          items: this.state.events.items.map((event) =>
            event.policy_id === policyId ? { ...event, policy_id: null } : event,
          ),
        },
      });
      this.resetEventPolicyFilter(policyId);
      return true;
    } catch (error) {
      if (this.isStale(generation)) return false;
      const apiError = toApiError(error);
      const rowGone = apiError.status === 404;
      this.patch({
        policies: {
          ...this.state.policies,
          items: rowGone
            ? this.state.policies.items.filter((item) => item.id !== policyId)
            : this.state.policies.items,
          deleteStatus: 'error',
          deletingId: null,
          deleteError: apiError,
        },
        events: rowGone
          ? {
              ...this.state.events,
              items: this.state.events.items.map((event) =>
                event.policy_id === policyId ? { ...event, policy_id: null } : event,
              ),
            }
          : this.state.events,
      });
      if (rowGone) this.resetEventPolicyFilter(policyId);
      return false;
    }
  }

  /** If the deleted rule was the event filter, fall back to "all rules". */
  private resetEventPolicyFilter(policyId: string): void {
    if (this.state.events.policyId !== policyId) return;
    this.eventsRequestId += 1;
    this.eventsInFlight = null;
    this.patch({
      events: { ...this.state.events, policyId: '', items: [], nextCursor: null, hasMore: false },
    });
    if (this.state.mode === 'MANAGED') void this.loadEvents(true);
  }

  clearPolicySaveError(): void {
    if (!this.state.policies.saveError && this.state.policies.saveStatus !== 'saved') return;
    this.patch({
      policies: {
        ...this.state.policies,
        saveStatus: 'idle',
        saveError: null,
      },
    });
  }

  clearPolicyDeleteError(): void {
    if (!this.state.policies.deleteError) return;
    this.patch({
      policies: { ...this.state.policies, deleteStatus: 'idle', deleteError: null },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* DLP events                                                             */
  /* ---------------------------------------------------------------------- */

  setEventsAction(action: AuditActionFilter): void {
    if (action === this.state.events.action) return;
    this.eventsRequestId += 1;
    this.eventsInFlight = null;
    this.patch({
      events: {
        ...this.state.events,
        action,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
      },
    });
    void this.loadEvents(true);
  }

  setEventsPolicy(policyId: string): void {
    if (policyId === this.state.events.policyId) return;
    this.eventsRequestId += 1;
    this.eventsInFlight = null;
    this.patch({
      events: {
        ...this.state.events,
        policyId,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
      },
    });
    void this.loadEvents(true);
  }

  /** Reset both event filters atomically (one request, one new chain). */
  resetEventFilters(): void {
    if (this.state.events.policyId === '' && this.state.events.action === 'ALL') return;
    this.eventsRequestId += 1;
    this.eventsInFlight = null;
    this.patch({
      events: {
        ...this.state.events,
        action: 'ALL',
        policyId: '',
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
      },
    });
    void this.loadEvents(true);
  }

  async loadEvents(force = false): Promise<void> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.mode !== 'MANAGED') return;
    if (this.eventsInFlight) return this.eventsInFlight;
    if (!force && this.state.events.status === 'ready') return;

    const generation = this.generation;
    const requestId = ++this.eventsRequestId;
    this.patch({
      events: { ...this.state.events, status: 'loading', error: null, moreError: null },
    });
    this.eventsInFlight = (async () => {
      try {
        const page = await this.api.listWorkspaceDlpEvents(workspaceId, {
          policyId: this.state.events.policyId || undefined,
          action: this.state.events.action === 'ALL' ? undefined : this.state.events.action,
          limit: DLP_EVENTS_PAGE_SIZE,
        });
        if (this.isStale(generation) || requestId !== this.eventsRequestId) return;
        this.patch({
          events: {
            ...this.state.events,
            items: page.items,
            nextCursor: page.next_cursor ?? null,
            hasMore: page.has_more,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || requestId !== this.eventsRequestId) return;
        this.patch({
          events: { ...this.state.events, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && requestId === this.eventsRequestId) {
          this.eventsInFlight = null;
        }
      }
    })();
    return this.eventsInFlight;
  }

  async loadMoreEvents(): Promise<void> {
    const workspaceId = this.sameWorkspace();
    const cursor = this.state.events.nextCursor;
    if (!workspaceId || !cursor || this.state.events.loadingMore) return;
    const generation = this.generation;
    const requestId = this.eventsRequestId;
    this.patch({
      events: { ...this.state.events, loadingMore: true, moreError: null },
    });
    try {
      const page = await this.api.listWorkspaceDlpEvents(workspaceId, {
        policyId: this.state.events.policyId || undefined,
        action: this.state.events.action === 'ALL' ? undefined : this.state.events.action,
        cursor,
        limit: DLP_EVENTS_PAGE_SIZE,
      });
      if (this.isStale(generation) || requestId !== this.eventsRequestId) return;
      this.patch({
        events: {
          ...this.state.events,
          items: appendUnique(this.state.events.items, page.items),
          nextCursor: page.next_cursor ?? null,
          hasMore: page.has_more,
          loadingMore: false,
          moreError: null,
        },
      });
    } catch (error) {
      if (this.isStale(generation) || requestId !== this.eventsRequestId) return;
      this.patch({
        events: {
          ...this.state.events,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Workspace audit and export                                             */
  /* ---------------------------------------------------------------------- */

  async loadAudit(force = false): Promise<void> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId) return;
    if (this.auditInFlight) return this.auditInFlight;
    if (!force && this.state.audit.status === 'ready') return;

    const generation = this.generation;
    const requestId = ++this.auditRequestId;
    this.patch({
      audit: { ...this.state.audit, status: 'loading', error: null, moreError: null },
    });
    this.auditInFlight = (async () => {
      try {
        const page = await this.api.listWorkspaceAudit(
          workspaceId,
          this.auditQuery({ cursor: undefined }),
        );
        if (this.isStale(generation) || requestId !== this.auditRequestId) return;
        this.patch({
          audit: {
            ...this.state.audit,
            items: page.items,
            nextCursor: page.next_cursor ?? null,
            hasMore: page.has_more,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || requestId !== this.auditRequestId) return;
        this.patch({
          audit: { ...this.state.audit, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && requestId === this.auditRequestId) {
          this.auditInFlight = null;
        }
      }
    })();
    return this.auditInFlight;
  }

  /** Validate, then start a fresh page chain with the applied filters. */
  applyAuditFilters(filters: AuditFilters): boolean {
    this.auditRequestId += 1;
    this.auditInFlight = null;
    const action = filters.action.trim();
    const actorId = filters.actorId.trim();
    const from = filters.from;
    const to = filters.to;

    if (action.length > 120) {
      this.patch({
        audit: {
          ...this.state.audit,
          filterError: ApiError.client('VALIDATION_FAILED', 'action is longer than 120', 400, {
            field: 'action',
          }),
        },
      });
      return false;
    }
    if (actorId.length > 0 && !isUuid(actorId)) {
      this.patch({
        audit: {
          ...this.state.audit,
          filterError: ApiError.client('VALIDATION_FAILED', 'actor_id must be a UUID', 400, {
            field: 'actor_id',
          }),
        },
      });
      return false;
    }
    if (invalidDateRange(from, to)) {
      this.patch({
        audit: {
          ...this.state.audit,
          filterError: ApiError.client('VALIDATION_FAILED', 'from is after to', 400, {
            field: 'from',
          }),
        },
      });
      return false;
    }

    this.exportRequestId += 1;
    this.patch({
      audit: {
        ...this.state.audit,
        filters: { action, actorId, from, to },
        filterError: null,
        items: [],
        nextCursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        loadingMore: false,
        moreError: null,
        exportStatus: 'idle',
        exportFormat: null,
        exportRows: null,
        exportTruncated: false,
        exportFilename: null,
        exportError: null,
      },
    });
    void this.loadAudit(true);
    return true;
  }

  clearAuditFilters(): void {
    this.applyAuditFilters({ ...EMPTY_AUDIT_FILTERS });
  }

  async loadMoreAudit(): Promise<void> {
    const workspaceId = this.sameWorkspace();
    const cursor = this.state.audit.nextCursor;
    if (!workspaceId || !cursor || this.state.audit.loadingMore) return;
    const generation = this.generation;
    const requestId = this.auditRequestId;
    this.patch({
      audit: { ...this.state.audit, loadingMore: true, moreError: null },
    });
    try {
      const page = await this.api.listWorkspaceAudit(workspaceId, this.auditQuery({ cursor }));
      if (this.isStale(generation) || requestId !== this.auditRequestId) return;
      this.patch({
        audit: {
          ...this.state.audit,
          items: appendUnique(this.state.audit.items, page.items),
          nextCursor: page.next_cursor ?? null,
          hasMore: page.has_more,
          loadingMore: false,
          moreError: null,
        },
      });
    } catch (error) {
      if (this.isStale(generation) || requestId !== this.auditRequestId) return;
      this.patch({
        audit: {
          ...this.state.audit,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  private auditQuery(options: { cursor?: string }): ListWorkspaceAuditQuery {
    const { action, actorId, from, to } = this.state.audit.filters;
    return {
      action: action.trim() || undefined,
      actorId: actorId.trim() || undefined,
      from: datetimeLocalToIso(from),
      to: datetimeLocalToIso(to),
      cursor: options.cursor,
      limit: AUDIT_PAGE_SIZE,
    };
  }

  /**
   * Export through the API as a Blob. `X-Export-Rows`/`X-Export-Truncated` are
   * the authoritative summary; for JSON the body is read as a fallback when
   * the headers are absent. The returned blob is never re-encoded.
   */
  async exportAudit(format: AuditExportFormat): Promise<WorkspaceAuditExportResult | null> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.audit.exportStatus === 'exporting') return null;
    const generation = this.generation;
    const requestId = ++this.exportRequestId;
    const query = this.auditQuery({});
    this.patch({
      audit: {
        ...this.state.audit,
        exportStatus: 'exporting',
        exportFormat: format,
        exportError: null,
        exportRows: null,
        exportTruncated: false,
        exportFilename: null,
      },
    });
    try {
      const result = await this.api.exportWorkspaceAudit(workspaceId, {
        format,
        action: query.action,
        actorId: query.actorId,
        from: query.from,
        to: query.to,
      });
      if (this.isStale(generation) || requestId !== this.exportRequestId) return null;

      let rows = result.rows;
      let truncated = result.truncated;
      if (format === 'json' && (rows === null || !truncated)) {
        try {
          if (typeof result.blob.text !== 'function') throw new Error('Blob.text unavailable');
          const parsed = JSON.parse(await result.blob.text()) as {
            exported_rows?: unknown;
            truncated?: unknown;
          };
          if (rows === null && typeof parsed.exported_rows === 'number') {
            rows = parsed.exported_rows;
          }
          if (parsed.truncated === true) truncated = true;
        } catch {
          // The headers stay authoritative; a non-JSON body is still downloaded.
        }
      }
      this.patch({
        audit: {
          ...this.state.audit,
          exportStatus: 'done',
          exportFormat: format,
          exportRows: rows,
          exportTruncated: truncated,
          exportFilename: result.filename,
          exportError: null,
        },
      });
      return { ...result, rows, truncated };
    } catch (error) {
      if (this.isStale(generation) || requestId !== this.exportRequestId) return null;
      this.patch({
        audit: {
          ...this.state.audit,
          exportStatus: 'error',
          exportError: toApiError(error),
        },
      });
      return null;
    }
  }

  clearAuditExportNotice(): void {
    if (this.state.audit.exportStatus === 'idle' && !this.state.audit.exportError) return;
    this.exportRequestId += 1;
    this.patch({
      audit: {
        ...this.state.audit,
        exportStatus: 'idle',
        exportFormat: null,
        exportRows: null,
        exportTruncated: false,
        exportFilename: null,
        exportError: null,
      },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                               */
  /* ---------------------------------------------------------------------- */

  async loadSessions(force = false): Promise<void> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId) return;
    if (this.sessionsInFlight) return this.sessionsInFlight;
    if (!force && this.state.sessions.status === 'ready') return;

    const generation = this.generation;
    const requestId = ++this.sessionsRequestId;
    this.patch({
      sessions: { ...this.state.sessions, status: 'loading', error: null, moreError: null },
    });
    this.sessionsInFlight = (async () => {
      try {
        const page = await this.api.listWorkspaceSessions(workspaceId, {
          limit: SESSIONS_PAGE_SIZE,
        });
        if (this.isStale(generation) || requestId !== this.sessionsRequestId) return;
        this.patch({
          sessions: {
            ...this.state.sessions,
            items: page.items,
            nextCursor: page.next_cursor ?? null,
            hasMore: page.has_more,
            status: 'ready',
            error: null,
            loadingMore: false,
            moreError: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || requestId !== this.sessionsRequestId) return;
        this.patch({
          sessions: { ...this.state.sessions, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && requestId === this.sessionsRequestId) {
          this.sessionsInFlight = null;
        }
      }
    })();
    return this.sessionsInFlight;
  }

  async loadMoreSessions(): Promise<void> {
    const workspaceId = this.sameWorkspace();
    const cursor = this.state.sessions.nextCursor;
    if (!workspaceId || !cursor || this.state.sessions.loadingMore) return;
    const generation = this.generation;
    const requestId = this.sessionsRequestId;
    this.patch({
      sessions: { ...this.state.sessions, loadingMore: true, moreError: null },
    });
    try {
      const page = await this.api.listWorkspaceSessions(workspaceId, {
        cursor,
        limit: SESSIONS_PAGE_SIZE,
      });
      if (this.isStale(generation) || requestId !== this.sessionsRequestId) return;
      this.patch({
        sessions: {
          ...this.state.sessions,
          items: appendUnique(this.state.sessions.items, page.items),
          nextCursor: page.next_cursor ?? null,
          hasMore: page.has_more,
          loadingMore: false,
          moreError: null,
        },
      });
    } catch (error) {
      if (this.isStale(generation) || requestId !== this.sessionsRequestId) return;
      this.patch({
        sessions: {
          ...this.state.sessions,
          loadingMore: false,
          moreError: toApiError(error),
        },
      });
    }
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.sessions.revokeStatus === 'revoking') return false;
    const generation = this.generation;
    this.patch({
      sessions: {
        ...this.state.sessions,
        revokeStatus: 'revoking',
        revokingId: sessionId,
        revokeError: null,
      },
    });
    try {
      await this.api.revokeWorkspaceSession(workspaceId, sessionId);
      if (this.isStale(generation)) return false;
      this.patch({
        sessions: {
          ...this.state.sessions,
          items: this.state.sessions.items.filter((item) => item.id !== sessionId),
          revokeStatus: 'idle',
          revokingId: null,
          revokeError: null,
        },
      });
      return true;
    } catch (error) {
      if (this.isStale(generation)) return false;
      const apiError = toApiError(error);
      this.patch({
        sessions: {
          ...this.state.sessions,
          items:
            apiError.status === 404
              ? this.state.sessions.items.filter((item) => item.id !== sessionId)
              : this.state.sessions.items,
          revokeStatus: 'error',
          revokingId: null,
          revokeError: apiError,
        },
      });
      return false;
    }
  }

  async revokeAllSessions(): Promise<WorkspaceSessionRevokeAll | null> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.sessions.revokeAllStatus === 'revoking') return null;
    const generation = this.generation;
    this.patch({
      sessions: {
        ...this.state.sessions,
        revokeAllStatus: 'revoking',
        revokeAllError: null,
        revokeAllResult: null,
        revokeError: null,
      },
    });
    try {
      const result = await this.api.revokeAllWorkspaceSessions(workspaceId);
      if (this.isStale(generation)) return null;
      this.patch({
        sessions: {
          ...this.state.sessions,
          // The server spares the caller's current session.
          items: this.state.sessions.items.filter((item) => item.current),
          revokeAllStatus: 'done',
          revokeAllError: null,
          revokeAllResult: result,
        },
      });
      void this.loadSessions(true);
      return result;
    } catch (error) {
      if (this.isStale(generation)) return null;
      this.patch({
        sessions: {
          ...this.state.sessions,
          revokeAllStatus: 'error',
          revokeAllError: toApiError(error),
        },
      });
      return null;
    }
  }

  clearRevokeError(): void {
    if (!this.state.sessions.revokeError) return;
    this.patch({
      sessions: { ...this.state.sessions, revokeStatus: 'idle', revokeError: null },
    });
  }

  clearRevokeAllError(): void {
    if (!this.state.sessions.revokeAllError) return;
    this.patch({
      sessions: { ...this.state.sessions, revokeAllStatus: 'idle', revokeAllError: null },
    });
  }

  clearRevokeAllResult(): void {
    if (!this.state.sessions.revokeAllResult) return;
    this.patch({
      sessions: { ...this.state.sessions, revokeAllStatus: 'idle', revokeAllResult: null },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Security settings                                                      */
  /* ---------------------------------------------------------------------- */

  async loadSettings(force = false): Promise<void> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId) return;
    if (this.settingsInFlight) return this.settingsInFlight;
    if (!force && this.state.settings.status === 'ready') return;

    const generation = this.generation;
    const requestId = ++this.settingsRequestId;
    this.patch({
      settings: { ...this.state.settings, status: 'loading', error: null },
    });
    this.settingsInFlight = (async () => {
      try {
        const data = await this.api.getWorkspaceSecurity(workspaceId);
        if (this.isStale(generation) || requestId !== this.settingsRequestId) return;
        this.patch({
          settings: {
            ...this.state.settings,
            data,
            status: 'ready',
            error: null,
          },
        });
      } catch (error) {
        if (this.isStale(generation) || requestId !== this.settingsRequestId) return;
        this.patch({
          settings: { ...this.state.settings, status: 'error', error: toApiError(error) },
        });
      } finally {
        if (generation === this.generation && requestId === this.settingsRequestId) {
          this.settingsInFlight = null;
        }
      }
    })();
    return this.settingsInFlight;
  }

  async saveSettings(patch: WorkspaceSecurityUpdateRequest): Promise<boolean> {
    const workspaceId = this.sameWorkspace();
    if (!workspaceId || this.state.settings.saveStatus === 'saving') return false;
    if (Object.keys(patch).length === 0) return true;
    const generation = this.generation;
    this.patch({
      settings: {
        ...this.state.settings,
        saveStatus: 'saving',
        saveError: null,
      },
    });
    try {
      const data = await this.api.updateWorkspaceSecurity(workspaceId, patch);
      if (this.isStale(generation)) return false;
      this.patch({
        settings: {
          ...this.state.settings,
          data,
          status: 'ready',
          error: null,
          saveStatus: 'saved',
          saveError: null,
        },
      });
      return true;
    } catch (error) {
      if (this.isStale(generation)) return false;
      this.patch({
        settings: {
          ...this.state.settings,
          saveStatus: 'error',
          saveError: toApiError(error),
        },
      });
      return false;
    }
  }

  clearSettingsSave(): void {
    if (this.state.settings.saveStatus === 'idle' && !this.state.settings.saveError) return;
    this.patch({
      settings: {
        ...this.state.settings,
        saveStatus: 'idle',
        saveError: null,
      },
    });
  }
}

export function createSecurityStore(deps: SecurityStoreDeps): SecurityStore {
  return new SecurityStore(deps);
}
