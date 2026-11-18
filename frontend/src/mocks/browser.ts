import { setupWorker } from 'msw/browser';
import type {
  AdminUser,
  Notification,
  WorkspaceLimits,
  WorkspaceRole,
  WorkspaceSummary,
} from '../api/types';
import {
  createMockDb,
  insertMockMessage,
  insertMockNotification,
  resetMockDb,
  setMockPlatformAdmin,
  setMockSetupRequired,
  setMockWorkspaces,
  type ForcedFileError,
  type ForcedSendError,
  type MockDb,
} from './db';
import { createHandlers } from './handlers';
import { IDS, MOCK_DEMO_EMAIL } from './fixtures';
import {
  dropMockRealtimeConnections,
  publishMockMessageCreated,
  publishMockReceipt,
  publishMockTyping,
  resetMockRealtime,
} from './realtime';

export const mockDb: MockDb = createMockDb();
export const worker = setupWorker(...createHandlers(mockDb));

export interface KrugMockControls {
  /** Fail the next N send attempts with 500 INTERNAL (debug/E2E only). */
  failNextSend(count?: number): void;
  forceSendError(error: ForcedSendError | null): void;
  insertMessage(chatId: string, text: string): void;
  /** Drop live WS connections with a real close code (default 1013). */
  dropRealtime(code?: number): void;
  emitTyping(chatId: string, userId: string, ttlMs?: number): void;
  emitReceipt(chatId: string, userId: string, lastReadSeq: number): void;
  /** E2E/debug: simulate the first login with no workspaces. */
  setWorkspaces(workspaces: WorkspaceSummary[]): void;
  /** E6-F notification knobs (mock-only, E2E/debug). */
  notifications: {
    failNextList(count?: number): void;
    failNextRead(count?: number): void;
    failNextPrefs(count?: number): void;
    forceListError(error: ForcedSendError | null): void;
    forceReadError(error: ForcedSendError | null): void;
    forcePrefsError(error: ForcedSendError | null): void;
    insert(notification: Partial<Notification> & { title: string }): void;
    reset(): void;
  };
  /** E4-F file pipeline knobs (mock-only). */
  files: {
    setLimits(patch: Partial<WorkspaceLimits>): void;
    failNextPart(count?: number): void;
    setScanPolls(count: number): void;
    forceScanStatus(status: 'CLEAN' | 'INFECTED' | null): void;
    forcePreflightError(error: ForcedFileError | null): void;
    forceInitError(error: ForcedFileError | null): void;
    forcePartError(error: ForcedFileError | null): void;
    forceCompleteError(error: ForcedFileError | null): void;
    forceDownloadError(error: ForcedFileError | null): void;
    reset(): void;
  };
  /** E8/R-03..R-04 platform-admin and setup knobs (mock-only). */
  admin: {
    setPlatformAdmin(value: boolean): void;
    setSetupRequired(value: boolean): void;
    forceTestEmailError(error: ForcedSendError | null): void;
  };
  /** E8/R-01 chat-limit knobs (mock-only). */
  chats: {
    setMaxChatsPerUser(limit: number): void;
    setMaxChatsPerWorkspace(limit: number): void;
    forceCreateError(error: ForcedSendError | null): void;
  };
  /** D1-FE5 profile: clear the device list for the honest empty state. */
  devices: {
    clear(): void;
  };
  reset(): void;
}

declare global {
  interface Window {
    __krugMocks?: KrugMockControls;
    /** Set by Playwright via addInitScript to exercise onboarding. */
    __krugEmptyWorkspaces?: boolean;
    /** Set by Playwright via addInitScript before the app boots. */
    __krugMockLimits?: Partial<WorkspaceLimits>;
    /** E2E/R-03: boot with an incomplete first-run setup. */
    __krugSetupRequired?: boolean;
    /** E2E/R-04: boot as a non-admin user (default true in the demo fixture). */
    __krugPlatformAdmin?: boolean;
    /** E9-F E2E: seed N admin-directory users to exercise cursor pagination. */
    __krugAdminUsersSeed?: number;
    /** E11-F E2E: seed N audit events (contract fields only, no metadata). */
    __krugAuditSeed?: number;
    /** D1-QA1 E2E: per-chat unread overrides applied before the first read. */
    __krugUnreadCounts?: Record<string, number>;
    /** D1-QA1 E2E: boot with a specific workspace role (read-only settings). */
    __krugWorkspaceRole?: WorkspaceRole;
  }
}

/** Mock-only debug controls; never part of the production API surface. */
export function installMockControls(): void {
  window.__krugMocks = {
    failNextSend(count = 1) {
      mockDb.failNextSend = Math.max(0, count);
    },
    forceSendError(error) {
      mockDb.forceSendError = error;
    },
    insertMessage(chatId, text) {
      const message = insertMockMessage(mockDb, chatId, text);
      publishMockMessageCreated(mockDb, message);
    },
    dropRealtime(code = 1013) {
      dropMockRealtimeConnections(code);
    },
    emitTyping(chatId, userId, ttlMs = 5_000) {
      publishMockTyping(mockDb, chatId, userId, new Date(Date.now() + ttlMs).toISOString());
    },
    emitReceipt(chatId, userId, lastReadSeq) {
      publishMockReceipt(mockDb, chatId, userId, lastReadSeq);
    },
    setWorkspaces(workspaces) {
      setMockWorkspaces(mockDb, workspaces);
    },
    notifications: {
      failNextList(count = 1) {
        mockDb.failNextNotifications = Math.max(0, count);
      },
      failNextRead(count = 1) {
        mockDb.failNextNotificationRead = Math.max(0, count);
      },
      failNextPrefs(count = 1) {
        mockDb.failNextNotificationPrefs = Math.max(0, count);
      },
      forceListError(error) {
        mockDb.forceNotificationsError = error;
      },
      forceReadError(error) {
        mockDb.forceNotificationReadError = error;
      },
      forcePrefsError(error) {
        mockDb.forceNotificationPrefsError = error;
      },
      insert(notification) {
        insertMockNotification(mockDb, notification);
      },
      reset() {
        mockDb.notifications = [];
        mockDb.failNextNotifications = 0;
        mockDb.failNextNotificationRead = 0;
        mockDb.failNextNotificationPrefs = 0;
        mockDb.forceNotificationsError = null;
        mockDb.forceNotificationReadError = null;
        mockDb.forceNotificationPrefsError = null;
      },
    },
    files: {
      setLimits(patch) {
        mockDb.limits = {
          ...mockDb.limits,
          ...patch,
          usage: { ...mockDb.limits.usage, ...(patch.usage ?? {}) },
        };
      },
      failNextPart(count = 1) {
        mockDb.failNextPart = Math.max(0, count);
      },
      setScanPolls(count) {
        mockDb.scanPolls = Math.max(0, Math.floor(count));
      },
      forceScanStatus(status) {
        mockDb.forceScanStatus = status;
      },
      forcePreflightError(error) {
        mockDb.forcePreflightError = error;
      },
      forceInitError(error) {
        mockDb.forceInitError = error;
      },
      forcePartError(error) {
        mockDb.forcePartError = error;
      },
      forceCompleteError(error) {
        mockDb.forceCompleteError = error;
      },
      forceDownloadError(error) {
        mockDb.forceDownloadError = error;
      },
      reset() {
        resetMockDb(mockDb);
      },
    },
    admin: {
      setPlatformAdmin(value) {
        setMockPlatformAdmin(mockDb, value);
      },
      setSetupRequired(value) {
        setMockSetupRequired(mockDb, value);
      },
      forceTestEmailError(error) {
        mockDb.forceTestEmailError = error;
      },
    },
    chats: {
      setMaxChatsPerUser(limit) {
        mockDb.admin.maxChatsPerUser = limit;
        mockDb.limits = { ...mockDb.limits, max_chats_per_user: limit };
      },
      setMaxChatsPerWorkspace(limit) {
        mockDb.admin.maxChatsPerWorkspace = limit;
      },
      forceCreateError(error) {
        mockDb.forceChatCreateError = error;
      },
    },
    devices: {
      clear() {
        mockDb.devices.length = 0;
        mockDb.deviceRequests.clear();
      },
    },
    reset() {
      dropMockRealtimeConnections(1000, 'mock reset');
      resetMockRealtime();
      resetMockDb(mockDb);
    },
  };
}

export async function startMockWorker(): Promise<MockDb> {
  installMockControls();
  if (window.__krugSetupRequired) {
    setMockSetupRequired(mockDb, true);
  }
  if (window.__krugPlatformAdmin === false) {
    setMockPlatformAdmin(mockDb, false);
  }
  if (window.__krugEmptyWorkspaces) {
    setMockWorkspaces(mockDb, []);
  }
  if (window.__krugWorkspaceRole) {
    const role = window.__krugWorkspaceRole;
    mockDb.me = {
      ...mockDb.me,
      workspaces: mockDb.me.workspaces.map((workspace) => ({ ...workspace, role })),
    };
  }
  if (window.__krugUnreadCounts) {
    for (const [chatId, count] of Object.entries(window.__krugUnreadCounts)) {
      const chat = mockDb.chats[chatId];
      if (!chat || !Number.isFinite(count)) continue;
      chat.summary.unread_count = Math.max(0, Math.floor(count));
    }
  }
  if (typeof window.__krugAdminUsersSeed === 'number' && window.__krugAdminUsersSeed > 0) {
    // E2E/R-05: deterministic rows; the admin directory filters/paginates them
    // exactly like server aggregates (no content fields).
    const count = Math.min(200, Math.floor(window.__krugAdminUsersSeed));
    mockDb.adminDirectory.usersOverride = Array.from({ length: count }, (_, index) => {
      const suffix = String(index + 1).padStart(2, '0');
      const user: AdminUser = {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        email: `seed-${suffix}@example.test`,
        display_name: `Демо-пользователь ${suffix}`,
        is_platform_admin: false,
        status: 'ACTIVE',
        workspaces_count: 1,
        chats_count: 1,
        storage_used_bytes: index * 1024,
        created_at: new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString(),
      };
      return user;
    });
  }
  if (typeof window.__krugAuditSeed === 'number' && window.__krugAuditSeed > 0) {
    // E11-F: deterministic contract-shaped rows; alternating actions make the
    // exact-action filter observable in E2E.
    const count = Math.min(200, Math.floor(window.__krugAuditSeed));
    mockDb.adminDirectory.auditEventsOverride = Array.from({ length: count }, (_, index) => {
      const suspended = index % 2 === 0;
      return {
        id: `bbbbbbbb-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        action: suspended ? 'admin.user.suspended' : 'admin.chat.deleted',
        actor_id: IDS.user,
        actor_email: MOCK_DEMO_EMAIL,
        target_type: suspended ? 'user' : 'chat',
        target_id: suspended ? IDS.anna : IDS.groupChat,
        created_at: new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString(),
      };
    });
  }
  if (window.__krugMockLimits) {
    const override = window.__krugMockLimits;
    mockDb.limits = {
      ...mockDb.limits,
      ...override,
      usage: { ...mockDb.limits.usage, ...(override.usage ?? {}) },
    };
  }
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: '/mockServiceWorker.js' },
    quiet: false,
  });
  return mockDb;
}
