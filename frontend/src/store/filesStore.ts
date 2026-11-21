import type { ChatApi, ListFilesQuery } from '../api/endpoints';
import { ApiError, toApiError } from '../api/problem';
import type {
  ApiAttachment,
  AttachmentScanStatus,
  DownloadUrl,
  FileItem,
  FileQuotaSummary,
  PreflightFile,
  UploadInitRequest,
  UploadMediaMetadata,
  UploadSession,
  WorkspaceLimits,
  WorkspaceRole,
} from '../api/types';
import type { AppConfig } from '../config/env';
import { newUuid } from '../lib/ids';
import { fileError, isFileRetryable, preflightDecisionError } from '../files/errors';
import { readBlobArrayBuffer, sha256Buffer, sha256File } from '../files/hash';
import { MAX_MESSAGE_ATTACHMENTS, effectiveMaxFileBytes } from '../files/limits';
import { putLocalArtwork } from '../files/artworkCache';
import type { Id3Artwork } from '../files/id3';

const PART_RETRIES = 3;
const DOWNLOAD_URL_SAFETY_MS = 30_000;
/** #97: at most this many rendered cover object URLs stay alive per store. */
const MAX_ARTWORK_URLS = 100;
/** Only the raster types the contract allows may become a cover object URL. */
const SAFE_ARTWORK_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
]);

export type UploadTaskStatus =
  | 'queued'
  | 'preflighting'
  | 'denied'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'scanning'
  | 'ready'
  | 'quarantined'
  | 'error'
  | 'canceled'
  | 'expired';

export interface UploadTask {
  localId: string;
  chatId: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  /** D1-FE2: sanitized metadata sent with upload init (managed-only). */
  media: UploadMediaMetadata | null;
  /** Local-only ID3 artwork; saved to IndexedDB once the attachment exists. */
  artwork: Id3Artwork | null;
  status: UploadTaskStatus;
  progress: number;
  uploadedBytes: number;
  uploadId: string | null;
  partSize: number | null;
  totalParts: number | null;
  receivedParts: number[];
  attachmentId: string | null;
  scanStatus: AttachmentScanStatus | null;
  error: ApiError | null;
  retryable: boolean;
  failedPart: number | null;
  idempotencyKey: string;
  completeKey: string;
  abortKey: string;
  attempts: number;
  createdAt: number;
}

export interface UploadMediaOptions {
  /** Sanitized managed media metadata for this file (D1-FE2). */
  media?: UploadMediaMetadata | null;
  /** Local-only ID3 artwork, cached after upload instead of being sent. */
  artwork?: Id3Artwork | null;
}

export interface FilesState {
  workspaceId: string | null;
  role: WorkspaceRole | null;
  limits: WorkspaceLimits | null;
  limitsStatus: 'idle' | 'loading' | 'ready' | 'error';
  limitsError: ApiError | null;
  tasks: UploadTask[];
  preflightStatus: 'idle' | 'preflighting' | 'error';
  preflightError: ApiError | null;
  /** #73: server-backed file-center page (independent from loaded history). */
  fileCenter: FileCenterState;
  /** #83: global upload progress/error for the file-center "Загрузить" button. */
  fileCenterUpload: FileCenterUploadState;
}

/**
 * One cursor page of `GET /files`. `nextCursor` is only ever the server's
 * opaque value; the store never constructs or mutates it.
 */
export interface FileCenterState {
  items: FileItem[];
  status: 'idle' | 'loading' | 'ready' | 'error' | 'loadingMore';
  error: ApiError | null;
  hasMore: boolean;
  nextCursor: string | null;
  quota: FileQuotaSummary | null;
  /** Last applied filter set (without `cursor`). */
  query: ListFilesQuery;
}

export interface FilesStoreDeps {
  api: Pick<
    ChatApi,
    | 'getWorkspaceLimits'
    | 'listFiles'
    | 'uploadWorkspaceFile'
    | 'renameFile'
    | 'deleteFile'
    | 'preflightUpload'
    | 'initUpload'
    | 'getUpload'
    | 'putUploadPart'
    | 'completeUpload'
    | 'abortUpload'
    | 'attachmentDownloadUrl'
    | 'getAttachmentArtwork'
  >;
  config: Pick<
    AppConfig,
    | 'uploadMaxFileBytes'
    | 'uploadPartConcurrency'
    | 'uploadPartTimeoutMs'
    | 'uploadScanPollMs'
    | 'uploadScanTimeoutMs'
  >;
  now?: () => number;
  createId?: () => string;
}

const ACTIVE_STATUSES: ReadonlySet<UploadTaskStatus> = new Set([
  'queued',
  'preflighting',
  'initializing',
  'uploading',
  'paused',
  'completing',
  'scanning',
  'ready',
]);

export function isActiveUpload(task: UploadTask): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

export function uploadedBytesOf(task: UploadTask): number {
  if (!task.partSize || !task.totalParts) return 0;
  let bytes = 0;
  for (const partNo of task.receivedParts) {
    bytes +=
      partNo < task.totalParts ? task.partSize : task.size - task.partSize * (task.totalParts - 1);
  }
  return Math.min(task.size, bytes);
}

function initialFileCenter(): FileCenterState {
  return {
    items: [],
    status: 'idle',
    error: null,
    hasMore: false,
    nextCursor: null,
    quota: null,
    query: {},
  };
}

/**
 * #83: one-shot global workspace upload (`POST /workspaces/{id}/files`).
 * Deliberately separate from the resumable chat upload tasks: the endpoint is
 * a single multipart request with upload progress and a terminal server verdict.
 */
export interface FileCenterUploadState {
  status: 'idle' | 'uploading' | 'done' | 'error';
  filename: string | null;
  /** 0..100; stays at 0 when the browser cannot report the total. */
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  error: ApiError | null;
}

/** Result of a rename/delete mutation; the server error is surfaced verbatim. */
export type FileMutationResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

function initialFileCenterUpload(): FileCenterUploadState {
  return {
    status: 'idle',
    filename: null,
    progress: 0,
    loadedBytes: 0,
    totalBytes: 0,
    error: null,
  };
}

function initialState(): FilesState {
  return {
    workspaceId: null,
    role: null,
    limits: null,
    limitsStatus: 'idle',
    limitsError: null,
    tasks: [],
    preflightStatus: 'idle',
    preflightError: null,
    fileCenter: initialFileCenter(),
    fileCenterUpload: initialFileCenterUpload(),
  };
}

export class FilesStore {
  private readonly api: FilesStoreDeps['api'];
  private readonly config: FilesStoreDeps['config'];
  private readonly now: () => number;
  private readonly createId: () => string;

  private state: FilesState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly pumping = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly polling = new Set<string>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly downloadCache = new Map<
    string,
    { url: string; expiresAtMs: number; sizeBytes: number; sha256: string }
  >();
  private readonly downloadInFlight = new Map<string, Promise<DownloadUrl>>();
  /**
   * #97: authenticated cover bytes as per-attachment object URLs. Kept out of
   * the React state: a cover is decorative, so resolving one must not
   * re-render an entire page. URLs are revoked on invalidation, workspace
   * switch, `reset()` and `dispose()`.
   */
  private readonly artworkUrls = new Map<string, string>();
  private readonly artworkInFlight = new Map<string, Promise<string | null>>();
  /** Per-id request token: a forced reload must not be deleted by an old finally. */
  private readonly artworkTokens = new Map<string, object>();
  /** #83: the single in-flight one-shot global upload. */
  private fileUploadController: AbortController | null = null;
  private limitsPromise: Promise<void> | null = null;
  /** #73: invalidates stale file-center responses after filter/workspace changes. */
  private fileCenterSeq = 0;
  private disposed = false;

  constructor(deps: FilesStoreDeps) {
    this.api = deps.api;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.createId = deps.createId ?? newUuid;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): FilesState => this.state;

  dispose(): void {
    this.disposed = true;
    this.fileUploadController?.abort();
    this.fileUploadController = null;
    this.abortControllers();
    this.listeners.clear();
    this.downloadCache.clear();
    this.downloadInFlight.clear();
    this.revokeAllArtworkUrls();
    this.artworkInFlight.clear();
    this.artworkTokens.clear();
  }

  /** Workspace switch is the only quota scope; abort uploads from the old one. */
  setWorkspace(workspaceId: string | null, role: WorkspaceRole | null = null): void {
    const changed = workspaceId !== this.state.workspaceId;
    if (!changed && role === this.state.role && this.state.limitsStatus !== 'error') return;

    if (changed && this.state.tasks.length > 0) {
      for (const task of this.state.tasks) void this.cancelTask(task.localId);
      this.patch({ tasks: [] });
    }
    // Covers belong to the previous workspace's attachments; never leak them.
    if (changed) this.revokeAllArtworkUrls();

    this.patch({
      workspaceId,
      role,
      limits: changed ? null : this.state.limits,
      limitsStatus: workspaceId ? 'loading' : 'idle',
      limitsError: null,
      ...(changed
        ? { fileCenter: initialFileCenter(), fileCenterUpload: initialFileCenterUpload() }
        : {}),
    });
    if (changed) this.fileCenterSeq += 1;
    if (workspaceId) void this.refreshLimits();
  }

  async refreshLimits(): Promise<void> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId) return;
    if (this.limitsPromise) return this.limitsPromise;

    this.patch({ limitsStatus: 'loading', limitsError: null });
    this.limitsPromise = (async () => {
      try {
        const limits = await this.api.getWorkspaceLimits(workspaceId);
        if (this.disposed || this.state.workspaceId !== workspaceId) return;
        this.patch({ limits, limitsStatus: 'ready', limitsError: null });
      } catch (error) {
        if (this.disposed || this.state.workspaceId !== workspaceId) return;
        this.patch({ limitsStatus: 'error', limitsError: toApiError(error) });
      } finally {
        this.limitsPromise = null;
      }
    })();
    return this.limitsPromise;
  }

  /**
   * #73: replace the current page with a fresh server query. The workspace id
   * defaults to the active one; an absent workspace is a client-side error, so
   * the page can render an explicit retry state instead of an invented list.
   */
  async loadFiles(query: ListFilesQuery = {}): Promise<void> {
    if (this.disposed) return;
    const workspaceId = query.workspaceId ?? this.state.workspaceId ?? undefined;
    const seq = ++this.fileCenterSeq;
    if (!workspaceId) {
      this.patch({
        fileCenter: {
          ...this.state.fileCenter,
          items: [],
          status: 'error',
          error: ApiError.client(
            'WORKSPACE_REQUIRED',
            'No active workspace for the file center',
            409,
          ),
          hasMore: false,
          nextCursor: null,
          query: { ...query, cursor: undefined },
        },
      });
      return;
    }

    const applied: ListFilesQuery = { ...query, workspaceId, cursor: undefined };
    this.patch({
      fileCenter: {
        ...this.state.fileCenter,
        items: [],
        status: 'loading',
        error: null,
        hasMore: false,
        nextCursor: null,
        query: applied,
      },
    });

    try {
      const page = await this.api.listFiles(applied);
      if (this.disposed || seq !== this.fileCenterSeq) return;
      this.patch({
        fileCenter: {
          items: page.items,
          status: 'ready',
          error: null,
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
          quota: page.quota,
          query: applied,
        },
      });
    } catch (error) {
      if (this.disposed || seq !== this.fileCenterSeq) return;
      this.patch({
        fileCenter: {
          ...this.state.fileCenter,
          items: [],
          status: 'error',
          error: toApiError(error),
          hasMore: false,
          nextCursor: null,
        },
      });
    }
  }

  /** #73: append exactly one server cursor page; never duplicates a row. */
  async loadMoreFiles(): Promise<void> {
    if (this.disposed) return;
    const center = this.state.fileCenter;
    if (center.status === 'loading' || center.status === 'loadingMore') return;
    if (!center.hasMore || !center.nextCursor) return;

    const seq = ++this.fileCenterSeq;
    this.patch({
      fileCenter: { ...center, status: 'loadingMore', error: null },
    });

    try {
      const page = await this.api.listFiles({
        ...center.query,
        cursor: center.nextCursor,
      });
      if (this.disposed || seq !== this.fileCenterSeq) return;
      const seen = new Set(center.items.map((item) => item.id));
      const appended = page.items.filter((item) => !seen.has(item.id));
      this.patch({
        fileCenter: {
          ...this.state.fileCenter,
          items: [...center.items, ...appended],
          status: 'ready',
          error: null,
          hasMore: page.page.has_more,
          nextCursor: page.page.next_cursor ?? null,
          quota: page.quota ?? center.quota,
          query: center.query,
        },
      });
    } catch (error) {
      if (this.disposed || seq !== this.fileCenterSeq) return;
      this.patch({
        fileCenter: {
          ...this.state.fileCenter,
          status: 'error',
          error: toApiError(error),
        },
      });
    }
  }

  /**
   * #83: re-run the last applied file-center query (filters preserved, cursor
   * dropped). Used after an upload so the new server row appears on page one.
   */
  reloadFileCenter(): Promise<void> {
    return this.loadFiles({ ...this.state.fileCenter.query, cursor: undefined });
  }

  /**
   * #83: one-shot global upload with real progress. Returns the server row or
   * `null` on failure/cancel; the explicit `fileCenterUpload` state carries the
   * translated error surface. The server remains the source of the new row.
   */
  async uploadFile(file: File): Promise<FileItem | null> {
    if (this.disposed) return null;
    const workspaceId = this.state.workspaceId;
    if (!workspaceId) {
      this.patch({
        fileCenterUpload: {
          ...initialFileCenterUpload(),
          status: 'error',
          filename: file.name,
          error: ApiError.client(
            'WORKSPACE_REQUIRED',
            'No active workspace for the file upload',
            409,
          ),
        },
      });
      return null;
    }
    if (this.state.fileCenterUpload.status === 'uploading') return null;

    const controller = new AbortController();
    this.fileUploadController = controller;
    const total = file.size;
    this.patch({
      fileCenterUpload: {
        status: 'uploading',
        filename: file.name,
        progress: 0,
        loadedBytes: 0,
        totalBytes: total,
        error: null,
      },
    });

    try {
      const item = await this.api.uploadWorkspaceFile(workspaceId, file, {
        signal: controller.signal,
        onProgress: (loaded, reportedTotal) => {
          if (this.disposed || this.fileUploadController !== controller) return;
          const size = reportedTotal > 0 ? reportedTotal : total;
          const progress = size > 0 ? Math.min(100, Math.round((loaded * 100) / size)) : 0;
          this.patch({
            fileCenterUpload: {
              ...this.state.fileCenterUpload,
              loadedBytes: loaded,
              totalBytes: size,
              progress,
            },
          });
        },
      });
      if (this.disposed || this.state.workspaceId !== workspaceId) return null;
      this.patch({
        fileCenterUpload: {
          status: 'done',
          filename: file.name,
          progress: 100,
          loadedBytes: total,
          totalBytes: total,
          error: null,
        },
      });
      await this.reloadFileCenter();
      void this.refreshLimits();
      return item;
    } catch (error) {
      if (this.disposed) return null;
      if (controller.signal.aborted) {
        this.patch({ fileCenterUpload: initialFileCenterUpload() });
        return null;
      }
      this.patch({
        fileCenterUpload: {
          ...this.state.fileCenterUpload,
          status: 'error',
          error: toApiError(error),
        },
      });
      return null;
    } finally {
      if (this.fileUploadController === controller) this.fileUploadController = null;
    }
  }

  /** Cancel an in-flight global upload (the server request is aborted). */
  cancelFileUpload(): void {
    this.fileUploadController?.abort();
    this.fileUploadController = null;
  }

  /** Clear a finished/failed upload banner without touching the list. */
  clearFileUpload(): void {
    if (this.state.fileCenterUpload.status === 'uploading') return;
    this.patch({ fileCenterUpload: initialFileCenterUpload() });
  }

  /** #83: owner-only display-name rename; the row is replaced by the server row. */
  async renameFile(fileId: string, name: string): Promise<FileMutationResult<FileItem>> {
    try {
      const item = await this.api.renameFile(fileId, { name }, this.createId());
      if (!this.disposed) {
        const center = this.state.fileCenter;
        this.patch({
          fileCenter: {
            ...center,
            items: center.items.map((row) => (row.id === fileId ? { ...row, ...item } : row)),
          },
        });
      }
      return { ok: true, value: item };
    } catch (error) {
      return { ok: false, error: toApiError(error) };
    }
  }

  /** #83: soft delete (owner or OWNER/ADMIN); the row disappears on `204`. */
  async deleteFile(fileId: string): Promise<FileMutationResult<void>> {
    try {
      await this.api.deleteFile(fileId, this.createId());
      this.invalidateArtwork(fileId);
      if (!this.disposed) {
        const center = this.state.fileCenter;
        this.patch({
          fileCenter: {
            ...center,
            items: center.items.filter((row) => row.id !== fileId),
          },
        });
        void this.refreshLimits();
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: toApiError(error) };
    }
  }

  tasksFor(chatId: string | null): UploadTask[] {
    if (!chatId) return [];
    return this.state.tasks.filter((task) => task.chatId === chatId);
  }

  private attachmentFromTask(task: UploadTask): ApiAttachment {
    return {
      id: task.attachmentId!,
      filename: task.name,
      size_bytes: task.size,
      mime_type: task.mime || null,
      scan_status: 'CLEAN',
      ...(task.media ? { media: { ...task.media } } : {}),
    };
  }

  readyAttachments(chatId: string | null): ApiAttachment[] {
    return this.tasksFor(chatId)
      .filter((task) => task.status === 'ready' && task.attachmentId)
      .map((task) => this.attachmentFromTask(task));
  }

  /**
   * Resolve one upload to its ready attachment (voice "stop and send").
   * Resolves `null` on denial/error/cancel/quarantine/timeout, so callers
   * never wait forever and never send a half-uploaded attachment.
   */
  waitForReady(localId: string, timeoutMs = 180_000): Promise<ApiAttachment | null> {
    const initial = this.getTask(localId);
    if (!initial) return Promise.resolve(null);
    if (initial.status === 'ready' && initial.attachmentId) {
      return Promise.resolve(this.attachmentFromTask(initial));
    }
    const terminal: ReadonlySet<UploadTaskStatus> = new Set([
      'denied',
      'error',
      'canceled',
      'expired',
      'quarantined',
    ]);
    if (terminal.has(initial.status)) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: () => void = () => {};
      const finish = (value: ApiAttachment | null) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      const evaluate = () => {
        const task = this.getTask(localId);
        if (!task) {
          finish(null);
          return;
        }
        if (task.status === 'ready' && task.attachmentId) {
          finish(this.attachmentFromTask(task));
        } else if (terminal.has(task.status)) {
          finish(null);
        }
      };
      unsubscribe = this.subscribe(evaluate);
      timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      evaluate();
    });
  }

  /** Remove tasks bound to a successfully created message. */
  markBound(attachmentIds: readonly string[]): void {
    if (attachmentIds.length === 0) return;
    const bound = new Set(attachmentIds);
    this.patch({
      tasks: this.state.tasks.filter(
        (task) => !(task.attachmentId && bound.has(task.attachmentId)),
      ),
    });
  }

  async addFiles(
    files: readonly File[],
    chatId: string,
    mediaOptions: readonly (UploadMediaOptions | null)[] = [],
  ): Promise<UploadTask[]> {
    if (this.disposed || files.length === 0) return [];
    const maxAttachments = Math.min(
      MAX_MESSAGE_ATTACHMENTS,
      this.state.limits?.max_attachments ?? MAX_MESSAGE_ATTACHMENTS,
    );
    const active = this.state.tasks.filter(
      (task) => task.chatId === chatId && isActiveUpload(task),
    );
    const slots = Math.max(0, maxAttachments - active.length);
    const clientMax = Math.min(
      this.config.uploadMaxFileBytes,
      effectiveMaxFileBytes(this.state.limits, this.state.role) ?? this.config.uploadMaxFileBytes,
    );

    const created: UploadTask[] = files.map((file, index) =>
      this.newTask(file, chatId, clientMax, mediaOptions[index] ?? null),
    );
    const eligible = created.filter((task) => task.status === 'queued');
    const batch = eligible.slice(0, slots);
    const overflow = eligible.slice(slots);
    const overflowError = fileError(
      'TOO_MANY_FILES',
      'Too many files in one message',
      { limit: maxAttachments, actual: active.length + eligible.length },
      422,
    );

    const normalized = created.map((task) => {
      if (overflow.includes(task)) {
        return {
          ...task,
          status: 'denied' as const,
          error: overflowError,
          retryable: false,
        };
      }
      return task;
    });

    this.patch({ tasks: [...this.state.tasks, ...normalized] });
    if (batch.length > 0) {
      await this.preflightBatch(
        batch.map((task) => task.localId),
        chatId,
      );
    }
    return normalized;
  }

  async retryTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task) return;
    if (task.status === 'expired' || task.status === 'denied') {
      await this.restartTask(localId);
      return;
    }
    if (task.status !== 'error' && task.status !== 'paused') return;
    if (task.status === 'error' && !task.retryable) return;

    this.patchTask(localId, {
      status: task.uploadId ? 'uploading' : 'queued',
      error: null,
      failedPart: null,
    });
    if (task.uploadId) {
      await this.startTask(localId);
    } else {
      await this.preflightBatch([localId], task.chatId);
    }
  }

  async restartTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task) return;
    if (task.uploadId) {
      try {
        await this.api.abortUpload(task.uploadId, task.abortKey);
      } catch {
        // Best effort: the upload may already be expired/aborted.
      }
    }
    this.patchTask(localId, {
      status: 'queued',
      progress: 0,
      uploadedBytes: 0,
      uploadId: null,
      partSize: null,
      totalParts: null,
      receivedParts: [],
      attachmentId: null,
      scanStatus: null,
      error: null,
      retryable: true,
      failedPart: null,
      idempotencyKey: this.createId(),
      completeKey: this.createId(),
      abortKey: this.createId(),
      attempts: 0,
    });
    await this.preflightBatch([localId], task.chatId);
  }

  pauseTask(localId: string): void {
    const task = this.getTask(localId);
    if (!task || task.status !== 'uploading') return;
    this.patchTask(localId, { status: 'paused' });
  }

  async resumeTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task || task.status !== 'paused') return;
    this.patchTask(localId, { status: 'uploading', error: null, failedPart: null });
    await this.startTask(localId);
  }

  async cancelTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task || task.status === 'canceled') return;

    this.abortControllers(localId);
    this.patchTask(localId, { status: 'canceled', error: null, retryable: false });

    if (task.uploadId) {
      try {
        await this.api.abortUpload(task.uploadId, task.abortKey);
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.status !== 410) {
          // The local cancellation still wins; surface the server reason.
          this.patchTask(localId, { error: apiError });
        }
      }
      void this.refreshLimits();
    }
  }

  async removeTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task) return;
    if (task.uploadId && task.status !== 'canceled' && task.status !== 'denied') {
      try {
        await this.api.abortUpload(task.uploadId, task.abortKey);
      } catch {
        // Best effort.
      }
    }
    this.patch({ tasks: this.state.tasks.filter((item) => item.localId !== localId) });
    if (task.uploadId) void this.refreshLimits();
  }

  /**
   * Media previews can outlive a presigned URL (or fail after the browser
   * already fetched a stale one). Dropping the cached entry makes the next
   * `getDownloadUrl` issue a fresh link; the in-flight request is untouched.
   */
  invalidateDownloadUrl(attachmentId: string): void {
    this.downloadCache.delete(attachmentId);
  }

  /**
   * #97: resolve the authenticated server cover for an attachment to a
   * per-attachment `blob:` object URL.
   *
   * The URL from `media.artwork_url` must never be put into `<img src>`: it is
   * an authenticated API endpoint and only the API client carries the bearer
   * token. The bytes are fetched once, cached (one entry per attachment id)
   * and reused by every card/row that renders the same cover. `404` (no
   * extracted cover), `401`, `409` and `423` resolve to `null` so the caller
   * falls back to the local ID3 cover or the default artwork without an error
   * surface.
   */
  getAttachmentArtworkUrl(
    attachmentId: string,
    options: { force?: boolean } = {},
  ): Promise<string | null> {
    if (this.disposed || !attachmentId) return Promise.resolve(null);
    if (options.force) {
      this.revokeArtworkUrl(attachmentId);
      this.artworkInFlight.delete(attachmentId);
      this.artworkTokens.delete(attachmentId);
    } else {
      const cached = this.artworkUrls.get(attachmentId);
      if (cached !== undefined) return Promise.resolve(cached);
      const pending = this.artworkInFlight.get(attachmentId);
      if (pending) return pending;
    }

    const token = {};
    this.artworkTokens.set(attachmentId, token);
    const promise = (async (): Promise<string | null> => {
      try {
        const blob = await this.api.getAttachmentArtwork(attachmentId);
        if (this.disposed) return null;
        // A forced/invalidated reload owns the cache now; never let an older
        // response overwrite (or resurrect) its cover.
        if (this.artworkTokens.get(attachmentId) !== token) return null;
        const mime = (blob.type || '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
        if (!SAFE_ARTWORK_MIME.has(mime) || blob.size === 0) return null;
        const url = this.createArtworkObjectUrl(blob);
        if (!url) return null;
        this.revokeArtworkUrl(attachmentId);
        this.artworkUrls.set(attachmentId, url);
        this.pruneArtworkUrls();
        return url;
      } catch {
        // Decorative cover only: the card keeps its local/default fallback.
        return null;
      } finally {
        if (this.artworkTokens.get(attachmentId) === token) {
          this.artworkTokens.delete(attachmentId);
          this.artworkInFlight.delete(attachmentId);
        }
      }
    })();

    this.artworkInFlight.set(attachmentId, promise);
    return promise;
  }

  /** Drop one cached cover (expired bytes, replaced artwork, deleted row). */
  invalidateArtwork(attachmentId: string): void {
    this.revokeArtworkUrl(attachmentId);
    this.artworkInFlight.delete(attachmentId);
    this.artworkTokens.delete(attachmentId);
  }

  private createArtworkObjectUrl(blob: Blob): string | null {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  private revokeArtworkUrl(attachmentId: string): void {
    const url = this.artworkUrls.get(attachmentId);
    this.artworkUrls.delete(attachmentId);
    if (url === undefined) return;
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Revocation is best-effort; the entry is dropped either way.
    }
  }

  private revokeAllArtworkUrls(): void {
    for (const attachmentId of [...this.artworkUrls.keys()]) this.revokeArtworkUrl(attachmentId);
  }

  /** Bounded cache: drop the oldest object URLs instead of growing forever. */
  private pruneArtworkUrls(): void {
    while (this.artworkUrls.size > MAX_ARTWORK_URLS) {
      const oldest = this.artworkUrls.keys().next();
      if (oldest.done) return;
      this.revokeArtworkUrl(oldest.value);
    }
  }

  async getDownloadUrl(attachmentId: string): Promise<DownloadUrl> {
    const now = this.now();
    const cached = this.downloadCache.get(attachmentId);
    if (cached && cached.expiresAtMs - DOWNLOAD_URL_SAFETY_MS > now) {
      return {
        url: cached.url,
        expires_at: new Date(cached.expiresAtMs).toISOString(),
        size_bytes: cached.sizeBytes,
        sha256: cached.sha256,
      };
    }

    const inFlight = this.downloadInFlight.get(attachmentId);
    if (inFlight) return inFlight;

    const promise = this.api
      .attachmentDownloadUrl(attachmentId)
      .then((download) => {
        const expiresAtMs = Date.parse(download.expires_at);
        this.downloadCache.set(attachmentId, {
          url: download.url,
          expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now + 5 * 60_000,
          sizeBytes: download.size_bytes,
          sha256: download.sha256,
        });
        return download;
      })
      .finally(() => {
        this.downloadInFlight.delete(attachmentId);
      });
    this.downloadInFlight.set(attachmentId, promise);
    return promise;
  }

  reset(): void {
    this.fileCenterSeq += 1;
    this.fileUploadController?.abort();
    this.fileUploadController = null;
    this.abortControllers();
    this.patch(initialState());
    this.downloadCache.clear();
    this.downloadInFlight.clear();
    this.revokeAllArtworkUrls();
    this.artworkInFlight.clear();
    this.artworkTokens.clear();
    this.pumping.clear();
    this.starting.clear();
    this.polling.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private emit(next: FilesState): void {
    if (this.disposed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<FilesState>): void {
    this.emit({ ...this.state, ...patch });
  }

  private patchTask(localId: string, patch: Partial<UploadTask>): void {
    this.patch({
      tasks: this.state.tasks.map((task) =>
        task.localId === localId ? { ...task, ...patch } : task,
      ),
    });
  }

  private getTask(localId: string): UploadTask | undefined {
    return this.state.tasks.find((task) => task.localId === localId);
  }

  private newTask(
    file: File,
    chatId: string,
    maxFileBytes: number,
    mediaOptions: UploadMediaOptions | null = null,
  ): UploadTask {
    const base: UploadTask = {
      localId: this.createId(),
      chatId,
      file,
      name: file.name || 'file',
      size: file.size,
      mime: file.type || '',
      media: mediaOptions?.media ? { ...mediaOptions.media } : null,
      artwork: mediaOptions?.artwork ?? null,
      status: 'queued',
      progress: 0,
      uploadedBytes: 0,
      uploadId: null,
      partSize: null,
      totalParts: null,
      receivedParts: [],
      attachmentId: null,
      scanStatus: null,
      error: null,
      retryable: true,
      failedPart: null,
      idempotencyKey: this.createId(),
      completeKey: this.createId(),
      abortKey: this.createId(),
      attempts: 0,
      createdAt: this.now(),
    };

    if (file.size < 1) {
      return {
        ...base,
        status: 'denied',
        error: fileError('VALIDATION_FAILED', 'File is empty', { reason: 'size' }, 422),
        retryable: false,
      };
    }
    if (file.size > maxFileBytes) {
      return {
        ...base,
        status: 'denied',
        error: fileError(
          'FILE_TOO_LARGE',
          'File exceeds the limit',
          { limit: maxFileBytes, actual: file.size, client: true },
          413,
        ),
        retryable: false,
      };
    }
    return base;
  }

  private async preflightBatch(localIds: string[], chatId: string): Promise<void> {
    const tasks = localIds
      .map((id) => this.getTask(id))
      .filter((task): task is UploadTask => Boolean(task));
    if (tasks.length === 0) return;

    for (const task of tasks) {
      if (task.status === 'queued') this.patchTask(task.localId, { status: 'preflighting' });
    }
    this.patch({ preflightStatus: 'preflighting', preflightError: null });

    const files: PreflightFile[] = tasks.map((task) => ({
      name: task.name,
      size: task.size,
      ...(task.mime ? { mime: task.mime } : {}),
    }));

    let response;
    try {
      response = await this.api.preflightUpload(chatId, files, this.createId());
    } catch (error) {
      const apiError = toApiError(error);
      for (const task of tasks) {
        this.patchTask(task.localId, {
          status: 'denied',
          error: apiError,
          retryable: false,
        });
      }
      this.patch({ preflightStatus: 'error', preflightError: apiError });
      return;
    }

    if (this.disposed) return;
    this.applyPreflightMeta(response);
    const started: string[] = [];

    tasks.forEach((task, index) => {
      const decision =
        response.files[index]?.name === task.name
          ? response.files[index]
          : response.files.find((item) => item.name === task.name);
      if (!decision) {
        this.patchTask(task.localId, {
          status: 'denied',
          error: fileError('PREFLIGHT_DENIED', 'Preflight returned no decision', undefined, 422),
          retryable: false,
        });
        return;
      }
      if (decision.allowed) {
        this.patchTask(task.localId, {
          status: 'queued',
          error: null,
          retryable: true,
        });
        started.push(task.localId);
      } else {
        this.patchTask(task.localId, {
          status: 'denied',
          error: preflightDecisionError(decision),
          retryable: false,
        });
      }
    });

    this.patch({ preflightStatus: 'idle', preflightError: null });
    for (const id of started) void this.startTask(id);
  }

  private applyPreflightMeta(response: {
    max_file_bytes: number;
    max_attachments: number;
    quota: { used: number; reserved: number; limit: number };
  }): void {
    const limits = this.state.limits;
    if (!limits) return;
    this.patch({
      limits: {
        ...limits,
        max_file_bytes: response.max_file_bytes,
        max_attachments: response.max_attachments,
        usage: { ...response.quota },
      },
    });
  }

  private async startTask(localId: string): Promise<void> {
    if (this.disposed || this.starting.has(localId)) return;
    const task = this.getTask(localId);
    if (!task) return;
    if (
      task.status !== 'queued' &&
      task.status !== 'uploading' &&
      task.status !== 'paused' &&
      task.status !== 'error'
    ) {
      return;
    }

    this.starting.add(localId);
    try {
      if (!task.uploadId) {
        this.patchTask(localId, { status: 'initializing', error: null, failedPart: null });
        const body: UploadInitRequest = {
          chat_id: task.chatId,
          filename: task.name,
          size: task.size,
          ...(task.mime ? { mime: task.mime } : {}),
          encryption_mode: 'MANAGED',
          ...(task.media ? { media: { ...task.media } } : {}),
        };
        let session: UploadSession;
        try {
          session = await this.api.initUpload(body, task.idempotencyKey);
        } catch (error) {
          this.failTask(localId, toApiError(error));
          return;
        }
        this.applySession(localId, session);
      } else {
        try {
          const session = await this.api.getUpload(task.uploadId);
          this.applySession(localId, session);
        } catch (error) {
          this.failTask(localId, toApiError(error));
          return;
        }
      }

      const current = this.getTask(localId);
      if (!current || current.status !== 'uploading') return;
      await this.pump(localId);
    } finally {
      this.starting.delete(localId);
    }
  }

  private applySession(localId: string, session: UploadSession): void {
    const task = this.getTask(localId);
    if (!task) return;
    const runtimeStatus = session.status as string;
    const receivedParts = [...(session.received_parts ?? [])].sort((a, b) => a - b);
    const base = {
      uploadId: session.upload_id,
      partSize: session.part_size,
      totalParts: session.total_parts,
      receivedParts,
      attachmentId: session.attachment_id ?? null,
      uploadedBytes: 0,
    };
    const probe: UploadTask = { ...task, ...base };
    const uploadedBytes = uploadedBytesOf(probe);
    const progress = task.size > 0 ? Math.min(1, uploadedBytes / task.size) : 0;

    if (runtimeStatus === 'READY' || runtimeStatus === 'BOUND') {
      if (!session.attachment_id) {
        this.patchTask(localId, {
          ...base,
          uploadedBytes,
          progress,
          status: 'error',
          error: fileError(
            'ATTACHMENT_ID_MISSING',
            'Upload is ready but has no attachment id',
            undefined,
            503,
          ),
          retryable: true,
        });
        return;
      }
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress: 1,
        status: 'ready',
        scanStatus: 'CLEAN',
        error: null,
        retryable: false,
      });
      // D1-FE2: keep ID3 artwork local-only, keyed by the final attachment id.
      if (task.artwork) void putLocalArtwork(session.attachment_id, task.artwork);
      void this.refreshLimits();
      return;
    }
    if (runtimeStatus === 'QUARANTINED') {
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress,
        status: 'quarantined',
        scanStatus: 'INFECTED',
        error: fileError(
          'ATTACHMENT_QUARANTINED',
          'Attachment is quarantined',
          { reason: 'INFECTED' },
          423,
        ),
        retryable: false,
      });
      return;
    }
    if (runtimeStatus === 'EXPIRED') {
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress,
        status: 'expired',
        error: fileError('UPLOAD_EXPIRED', 'Upload has expired', undefined, 410),
        retryable: true,
      });
      return;
    }
    if (runtimeStatus === 'ABORTED') {
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress,
        status: 'canceled',
        retryable: false,
      });
      return;
    }
    if (runtimeStatus === 'FAILED') {
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress,
        status: 'error',
        error: fileError('SCAN_FAILED', 'Scan failed', undefined, 503),
        retryable: true,
      });
      return;
    }
    if (runtimeStatus === 'SCANNING') {
      this.patchTask(localId, {
        ...base,
        uploadedBytes,
        progress,
        status: 'scanning',
        scanStatus: 'PENDING',
        error: null,
        retryable: true,
      });
      void this.pollScan(localId);
      return;
    }

    this.patchTask(localId, {
      ...base,
      uploadedBytes,
      progress,
      status: 'uploading',
      scanStatus: null,
      error: null,
    });
  }

  private async pump(localId: string): Promise<void> {
    if (this.disposed || this.pumping.has(localId)) return;
    this.pumping.add(localId);
    let failure: ApiError | null = null;
    let failedPartNo: number | null = null;

    try {
      while (!failure) {
        const task = this.getTask(localId);
        if (!task || task.status !== 'uploading' || !task.uploadId) return;
        const missing = this.missingParts(task);
        if (missing.length === 0) {
          await this.completeTask(localId);
          return;
        }

        const queue = missing;
        let cursor = 0;
        const workers = Array.from(
          { length: Math.max(1, this.config.uploadPartConcurrency) },
          async () => {
            while (!failure) {
              const current = this.getTask(localId);
              if (!current || current.status !== 'uploading') return;
              const partNo = queue[cursor];
              cursor += 1;
              if (partNo === undefined) return;
              // A sibling worker may have completed this part while this one
              // was waiting; skip it instead of uploading twice.
              if (current.receivedParts.includes(partNo)) continue;
              try {
                await this.uploadPart(localId, partNo);
              } catch (error) {
                failure = toApiError(error);
                failedPartNo = partNo;
                return;
              }
            }
          },
        );
        await Promise.all(workers);
      }
    } finally {
      this.pumping.delete(localId);
    }

    if (failure) {
      this.failTask(localId, failure, failedPartNo ?? undefined);
    }
  }

  private missingParts(task: UploadTask): number[] {
    if (!task.totalParts) return [];
    const received = new Set(task.receivedParts);
    const missing: number[] = [];
    for (let partNo = 1; partNo <= task.totalParts; partNo += 1) {
      if (!received.has(partNo)) missing.push(partNo);
    }
    return missing;
  }

  private async uploadPart(localId: string, partNo: number): Promise<void> {
    const task = this.getTask(localId);
    if (!task || !task.uploadId || !task.partSize || !task.totalParts) return;
    if (task.status !== 'uploading') return;

    const start = (partNo - 1) * task.partSize;
    const end = Math.min(start + task.partSize, task.size);
    const chunk = task.file.slice(start, end);

    let lastError: ApiError | null = null;
    for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
      if (this.disposed) throw ApiError.client('ABORTED', 'Store disposed');
      const current = this.getTask(localId);
      if (!current || current.status !== 'uploading') {
        throw ApiError.client('ABORTED', 'Upload paused or cancelled');
      }

      const controller = new AbortController();
      this.trackController(localId, controller);
      try {
        const buffer = await readBlobArrayBuffer(chunk);
        const sha = await sha256Buffer(buffer);
        const part = await this.api.putUploadPart(task.uploadId, partNo, buffer, sha, {
          signal: controller.signal,
          timeoutMs: this.config.uploadPartTimeoutMs,
        });
        if (!part.received)
          throw fileError('CHUNK_UPLOAD_REJECTED', 'Part was not received', undefined, 409);
        this.markPartReceived(localId, partNo);
        return;
      } catch (error) {
        lastError = toApiError(error);
        if (lastError.isAborted) throw lastError;
        const retryable = isFileRetryable(lastError);
        if (!retryable || attempt >= PART_RETRIES) throw lastError;
        const retryAfter = lastError.retryAfterSeconds;
        await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : 250 * 2 ** (attempt - 1));
      } finally {
        this.untrackController(localId, controller);
      }
    }
    throw lastError ?? fileError('CHUNK_UPLOAD_FAILED', 'Part upload failed', undefined, 503);
  }

  private markPartReceived(localId: string, partNo: number): void {
    const task = this.getTask(localId);
    if (!task) return;
    if (task.receivedParts.includes(partNo)) return;
    const receivedParts = [...task.receivedParts, partNo].sort((a, b) => a - b);
    const probe = { ...task, receivedParts };
    const uploadedBytes = uploadedBytesOf(probe);
    this.patchTask(localId, {
      receivedParts,
      uploadedBytes,
      progress: task.size > 0 ? Math.min(1, uploadedBytes / task.size) : 0,
    });
  }

  private async completeTask(localId: string): Promise<void> {
    const task = this.getTask(localId);
    if (!task || !task.uploadId || !task.totalParts) return;
    if (task.status !== 'uploading') return;

    this.patchTask(localId, { status: 'completing', progress: 1 });
    try {
      const sha256 = await sha256File(task.file);
      const result = await this.api.completeUpload(
        task.uploadId,
        { sha256, parts_count: task.totalParts },
        task.completeKey,
      );
      this.applySession(localId, result.session);
    } catch (error) {
      this.failTask(localId, toApiError(error));
    }
  }

  private async pollScan(localId: string): Promise<void> {
    if (this.polling.has(localId) || this.disposed) return;
    this.polling.add(localId);
    const deadline = this.now() + this.config.uploadScanTimeoutMs;
    try {
      while (!this.disposed) {
        const task = this.getTask(localId);
        if (!task || task.status !== 'scanning' || !task.uploadId) return;
        if (this.now() >= deadline) {
          this.failTask(
            localId,
            fileError('SCAN_TIMEOUT', 'Scan status polling timed out', undefined, 504),
          );
          return;
        }
        await this.sleep(this.config.uploadScanPollMs);
        const current = this.getTask(localId);
        if (!current || current.status !== 'scanning' || !current.uploadId) return;
        try {
          const session = await this.api.getUpload(current.uploadId);
          this.applySession(localId, session);
          const after = this.getTask(localId);
          if (!after || after.status !== 'scanning') return;
        } catch (error) {
          this.failTask(localId, toApiError(error));
          return;
        }
      }
    } finally {
      this.polling.delete(localId);
    }
  }

  private failTask(localId: string, error: ApiError, failedPart?: number): void {
    if (this.disposed || error.isAborted) return;
    const task = this.getTask(localId);
    if (!task || task.status === 'canceled') return;
    if (error.code === 'TOO_MANY_FILES' || error.code === 'FILE_TOO_LARGE') {
      this.patchTask(localId, {
        status: 'denied',
        error,
        retryable: false,
        failedPart: failedPart ?? null,
      });
      return;
    }
    const expired = error.status === 410;
    const quarantined = error.code === 'ATTACHMENT_QUARANTINED';
    this.patchTask(localId, {
      status: expired ? 'expired' : quarantined ? 'quarantined' : 'error',
      error,
      retryable: !expired && !quarantined && isFileRetryable(error),
      failedPart: failedPart ?? null,
      attempts: task.attempts + 1,
    });
    if (expired) void this.refreshLimits();
  }

  private trackController(localId: string, controller: AbortController): void {
    const set = this.controllers.get(localId) ?? new Set<AbortController>();
    set.add(controller);
    this.controllers.set(localId, set);
  }

  private untrackController(localId: string, controller: AbortController): void {
    const set = this.controllers.get(localId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.controllers.delete(localId);
  }

  private abortControllers(localId?: string): void {
    const sets = localId
      ? ([this.controllers.get(localId)].filter(Boolean) as Set<AbortController>[])
      : [...this.controllers.values()];
    for (const set of sets) {
      for (const controller of set) {
        try {
          controller.abort();
        } catch {
          // AbortController.abort is idempotent; ignore platform quirks.
        }
      }
    }
    if (localId) this.controllers.delete(localId);
    else this.controllers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }
}

export function createFilesStore(deps: FilesStoreDeps): FilesStore {
  return new FilesStore(deps);
}
