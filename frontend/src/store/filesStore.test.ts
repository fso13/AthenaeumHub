import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiError } from '../api/problem';
import { IDS } from '../mocks/fixtures';
import { createTestConfig, createTestStore } from '../test/renderApp';
import { mockDb } from '../test/server';
import type { ChatStore } from './chatStore';
import type { UploadTask, UploadTaskStatus } from './filesStore';

const stores: ChatStore[] = [];

function fileOf(size: number, name = 'report.bin', type = 'application/octet-stream'): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function boot(overrides: Parameters<typeof createTestConfig>[0] = {}): Promise<ChatStore> {
  const store = createTestStore(
    createTestConfig({
      uploadPartConcurrency: 3,
      uploadScanPollMs: 5,
      uploadScanTimeoutMs: 2_000,
      ...overrides,
    }),
  );
  stores.push(store);
  await store.bootstrap();
  await vi.waitFor(() => {
    expect(store.files.getSnapshot().limitsStatus).toBe('ready');
  });
  return store;
}

function task(store: ChatStore, name: string): UploadTask {
  const found = store.files.getSnapshot().tasks.find((item) => item.name === name);
  if (!found) throw new Error(`Upload task not found: ${name}`);
  return found;
}

async function waitStatus(
  store: ChatStore,
  name: string,
  status: UploadTaskStatus,
  timeout = 8_000,
): Promise<UploadTask> {
  await vi.waitFor(
    () => {
      const current = task(store, name);
      if (current.status !== status) {
        throw new Error(
          `${name}: expected ${status}, got ${current.status} ` +
            `(${current.error?.status ?? '?'} ${current.error?.code ?? '?'}: ${current.error?.message ?? ''} ${JSON.stringify(current.error?.details ?? {})})`,
        );
      }
    },
    { timeout },
  );
  return task(store, name);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('managed files store', () => {
  it('preflights, uploads parts with progress, completes, scans and refreshes limits', async () => {
    const store = await boot();
    const file = fileOf(1024, 'notes.txt', 'text/plain');
    const statuses: UploadTaskStatus[] = [];
    store.files.subscribe(() => {
      const current = store.files.getSnapshot().tasks[0]?.status;
      if (current && statuses[statuses.length - 1] !== current) statuses.push(current);
    });

    await store.files.addFiles([file], IDS.groupChat);
    const uploaded = await waitStatus(store, 'notes.txt', 'ready');

    expect(uploaded.progress).toBe(1);
    expect(uploaded.uploadedBytes).toBe(1024);
    expect(uploaded.attachmentId).not.toBeNull();
    expect(statuses).toContain('uploading');
    expect(statuses).toContain('scanning');

    expect(mockDb.preflightRequests).toHaveLength(1);
    expect(mockDb.uploadInits).toHaveLength(1);
    expect(mockDb.uploadInits[0]?.body).toMatchObject({
      chat_id: IDS.groupChat,
      filename: 'notes.txt',
      size: 1024,
      encryption_mode: 'MANAGED',
    });
    expect(mockDb.partUploads).toHaveLength(1);
    expect(mockDb.completeRequests).toHaveLength(1);
    expect(mockDb.completeRequests[0]?.body.parts_count).toBe(1);
    expect(mockDb.limits.usage).toMatchObject({ used: 1024, reserved: 0 });
  });

  it('denies an oversized file from preflight and never starts an upload', async () => {
    const store = await boot();
    mockDb.limits.max_file_bytes = 100;
    await store.files.refreshLimits();

    await store.files.addFiles([fileOf(2048, 'big.bin')], IDS.groupChat);
    const denied = await waitStatus(store, 'big.bin', 'denied');

    expect(denied.error?.status).toBe(413);
    expect(denied.error?.code).toBe('FILE_TOO_LARGE');
    expect(denied.error?.details).toMatchObject({ limit: 100, actual: 2048 });
    expect(mockDb.uploadInits).toHaveLength(0);
  });

  it('maps a top-level 409 QUOTA_EXCEEDED preflight failure to every file', async () => {
    const store = await boot();
    mockDb.forcePreflightError = {
      status: 409,
      code: 'QUOTA_EXCEEDED',
      message: 'quota',
      details: { used: 100, reserved: 0, limit: 100, required: 10 },
      once: true,
    };

    await store.files.addFiles([fileOf(10, 'quota.bin')], IDS.groupChat);
    const denied = await waitStatus(store, 'quota.bin', 'denied');

    expect(denied.error?.status).toBe(409);
    expect(denied.error?.code).toBe('QUOTA_EXCEEDED');
    expect(store.files.getSnapshot().preflightStatus).toBe('error');
  });

  it('caps the batch at max_attachments and marks overflow with TOO_MANY_FILES', async () => {
    const store = await boot();
    mockDb.limits.max_attachments = 2;
    await store.files.refreshLimits();

    await store.files.addFiles(
      [fileOf(10, 'a.txt'), fileOf(10, 'b.txt'), fileOf(10, 'c.txt')],
      IDS.groupChat,
    );

    const denied = store.files.getSnapshot().tasks.find((item) => item.name === 'c.txt');
    expect(denied?.status).toBe('denied');
    expect(denied?.error?.status).toBe(422);
    expect(denied?.error?.code).toBe('TOO_MANY_FILES');
    expect(mockDb.preflightRequests[0]?.files.map((file) => file.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('resumes from GET /uploads/{id}: only missing parts are re-uploaded with the same upload id', async () => {
    const store = await boot();
    const file = fileOf(9 * 1024 * 1024, 'resume.bin');
    mockDb.forcePartError = {
      status: 409,
      code: 'CHUNK_CONFLICT',
      message: 'conflict',
      partNo: 2,
    };

    await store.files.addFiles([file], IDS.groupChat);
    const failed = await waitStatus(store, 'resume.bin', 'error', 12_000);
    const uploadId = failed.uploadId;
    expect(uploadId).not.toBeNull();
    expect(failed.failedPart).toBe(2);
    expect(failed.retryable).toBe(true);

    mockDb.forcePartError = null;
    await store.files.retryTask(failed.localId);
    const ready = await waitStatus(store, 'resume.bin', 'ready', 12_000);

    expect(ready.uploadId).toBe(uploadId);
    expect(ready.receivedParts).toEqual([1, 2]);
    const successfulParts = mockDb.partUploads
      .filter((part) => part.uploadId === uploadId)
      .map((part) => part.partNo);
    expect(successfulParts.filter((partNo) => partNo === 1)).toHaveLength(1);
    expect(successfulParts.filter((partNo) => partNo === 2)).toHaveLength(1);
  });

  it('retries a 422 CHUNK_HASH_MISMATCH automatically with the same part number', async () => {
    const store = await boot();
    mockDb.forcePartError = {
      status: 422,
      code: 'CHUNK_HASH_MISMATCH',
      message: 'hash mismatch',
      partNo: 1,
      once: true,
    };

    await store.files.addFiles([fileOf(1024, 'hash.bin')], IDS.groupChat);
    const ready = await waitStatus(store, 'hash.bin', 'ready');

    expect(ready.receivedParts).toEqual([1]);
    expect(mockDb.partUploads.filter((part) => part.partNo === 1)).toHaveLength(1);
  });

  it('pauses scheduling, resumes from the received parts and finishes', async () => {
    const store = await boot({ uploadPartConcurrency: 1 });
    const file = fileOf(9 * 1024 * 1024, 'pause.bin');
    mockDb.partDelayMs = 40;

    await store.files.addFiles([file], IDS.groupChat);
    await vi.waitFor(() => {
      expect(task(store, 'pause.bin').status).toBe('uploading');
    });
    await store.files.pauseTask(task(store, 'pause.bin').localId);
    expect(task(store, 'pause.bin').status).toBe('paused');
    const pausedParts = task(store, 'pause.bin').receivedParts.length;
    expect(pausedParts).toBeLessThan(2);

    mockDb.partDelayMs = 0;
    await store.files.resumeTask(task(store, 'pause.bin').localId);
    const ready = await waitStatus(store, 'pause.bin', 'ready', 12_000);
    expect(ready.receivedParts).toEqual([1, 2]);
  });

  it('cancels an upload, calls abort and releases the reservation', async () => {
    const store = await boot();
    mockDb.partDelayMs = 100;
    await store.files.addFiles([fileOf(9 * 1024 * 1024, 'cancel.bin')], IDS.groupChat);
    await vi.waitFor(() => {
      expect(task(store, 'cancel.bin').uploadId).not.toBeNull();
    });

    const localId = task(store, 'cancel.bin').localId;
    await store.files.cancelTask(localId);

    expect(task(store, 'cancel.bin').status).toBe('canceled');
    expect(mockDb.aborts).toHaveLength(1);
    expect(mockDb.limits.usage.reserved).toBe(0);
  });

  it('keeps a quarantined file unselectable and reports 423 on download', async () => {
    const store = await boot();
    mockDb.forceScanStatus = 'INFECTED';

    await store.files.addFiles([fileOf(64, 'virus.bin')], IDS.groupChat);
    const quarantined = await waitStatus(store, 'virus.bin', 'quarantined');

    expect(quarantined.error?.status).toBe(423);
    expect(quarantined.error?.code).toBe('ATTACHMENT_QUARANTINED');
    expect(store.files.readyAttachments(IDS.groupChat)).toHaveLength(0);
    expect(quarantined.attachmentId).not.toBeNull();

    try {
      await store.files.getDownloadUrl(quarantined.attachmentId!);
      throw new Error('Expected download to fail');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      if (isApiError(error)) {
        expect(error.status).toBe(423);
        expect(error.code).toBe('ATTACHMENT_QUARANTINED');
      }
    }
  });

  it('returns a cached presigned URL with the 5 minute TTL', async () => {
    const store = await boot();
    await store.files.addFiles([fileOf(32, 'url.txt', 'text/plain')], IDS.groupChat);
    const ready = await waitStatus(store, 'url.txt', 'ready');
    const attachmentId = ready.attachmentId!;

    const first = await store.files.getDownloadUrl(attachmentId);
    expect(Date.parse(first.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(first.url).toContain(attachmentId);
    expect(mockDb.downloadRequests).toHaveLength(1);

    const second = await store.files.getDownloadUrl(attachmentId);
    expect(second.url).toBe(first.url);
    expect(mockDb.downloadRequests).toHaveLength(1);

    // An expired/failed media URL is dropped from the cache and re-issued.
    store.files.invalidateDownloadUrl(attachmentId);
    await store.files.getDownloadUrl(attachmentId);
    expect(mockDb.downloadRequests).toHaveLength(2);
  });

  it('sends an attachment-only message, renders server attachments and marks the upload bound', async () => {
    const store = await boot();
    await store.files.addFiles([fileOf(128, 'photo.png', 'image/png')], IDS.groupChat);
    await waitStatus(store, 'photo.png', 'ready');
    const ready = store.files.readyAttachments(IDS.groupChat);
    expect(ready).toHaveLength(1);

    await store.send(IDS.groupChat, '', null, ready);
    await vi.waitFor(() => {
      expect(store.getSnapshot().slices[IDS.groupChat]?.outbox).toHaveLength(0);
    });

    const messages = store.getSnapshot().slices[IDS.groupChat]?.messages ?? [];
    const sent = messages[messages.length - 1];
    expect(sent?.text).toBeNull();
    expect(sent?.attachments?.[0]).toMatchObject({
      id: ready[0]?.id,
      filename: 'photo.png',
      scan_status: 'CLEAN',
    });
    expect(store.files.getSnapshot().tasks).toHaveLength(0);
    expect(mockDb.uploadInits).toHaveLength(1);
  });

  it('denies preflight for a chat the user cannot access', async () => {
    const store = await boot();
    const unknownChat = '99999999-9999-4999-8999-999999999999';

    await store.files.addFiles([fileOf(16, 'foreign.bin')], unknownChat);
    const denied = await waitStatus(store, 'foreign.bin', 'denied');

    expect(denied.error?.status).toBe(404);
    expect(mockDb.preflightRequests).toHaveLength(0);
    expect(mockDb.uploadInits).toHaveLength(0);
  });

  it('rejects an attachment that belongs to another chat (403)', async () => {
    const store = await boot();
    await store.files.addFiles([fileOf(32, 'group.txt', 'text/plain')], IDS.groupChat);
    await waitStatus(store, 'group.txt', 'ready');
    const ready = store.files.readyAttachments(IDS.groupChat);
    expect(ready).toHaveLength(1);

    await store.loadChat(IDS.directChat);
    await store.send(IDS.directChat, 'В другой чат', null, ready);
    await vi.waitFor(() => {
      expect(store.getSnapshot().slices[IDS.directChat]?.outbox[0]?.status).toBe('failed');
    });

    const failed = store.getSnapshot().slices[IDS.directChat]?.outbox[0];
    expect(failed?.error?.status).toBe(403);
    expect(failed?.error?.code).toBe('FORBIDDEN');
    expect(failed?.text).toBe('В другой чат');
  });

  it('keeps the message text when the server rejects a not-ready attachment', async () => {
    const store = await boot({ uploadScanPollMs: 10_000, uploadScanTimeoutMs: 20_000 });
    mockDb.scanPolls = 50;
    await store.files.addFiles([fileOf(128, 'slow.bin')], IDS.groupChat);
    await waitStatus(store, 'slow.bin', 'scanning');
    expect(task(store, 'slow.bin').attachmentId).not.toBeNull();

    const attachmentId = task(store, 'slow.bin').attachmentId!;
    await store.send(IDS.groupChat, 'Текст не должен потеряться', null, [
      {
        id: attachmentId,
        filename: 'slow.bin',
        size_bytes: 128,
        mime_type: null,
        scan_status: 'PENDING',
      },
    ]);

    await vi.waitFor(() => {
      expect(store.getSnapshot().slices[IDS.groupChat]?.outbox[0]?.status).toBe('failed');
    });
    const failed = store.getSnapshot().slices[IDS.groupChat]?.outbox[0];
    expect(failed?.text).toBe('Текст не должен потеряться');
    expect(failed?.error?.status).toBe(409);
    expect(failed?.error?.code).toBe('ATTACHMENT_NOT_READY');
  });
});
