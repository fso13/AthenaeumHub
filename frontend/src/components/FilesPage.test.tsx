import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { FileItem } from '../api/types';
import type { MockUpload } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const GROUP = IDS.groupChat;
const ATLAS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function openFiles(user: ReturnType<typeof renderApp>['user']) {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(screen.getByRole('button', { name: 'Файлы' }));
  await screen.findByRole('heading', { name: 'Файлы' });
}

function fileItem(
  id: string,
  filename: string,
  mime: string,
  created: string,
  scanStatus: FileItem['scan_status'] = 'CLEAN',
): FileItem {
  return {
    id,
    filename,
    size_bytes: 1024,
    mime_type: mime,
    scan_status: scanStatus,
    chat_id: GROUP,
    chat_name: 'Команда «Восход»',
    message_id: `00000000-0000-4000-8000-${id.slice(-12)}`,
    created_at: created,
  };
}

/** Bind a READY/CLEAN attachment so preview and download can resolve a URL. */
function seedAtlasUpload(): void {
  const upload: MockUpload = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    chatId: GROUP,
    filename: 'atlas-cover.png',
    size: 1024,
    mime: 'image/png',
    media: null,
    declaredSha256: null,
    partSize: 1024,
    totalParts: 1,
    received: new Map(),
    status: 'BOUND',
    expiresAt: Date.now() + 3_600_000,
    attachmentId: ATLAS_ID,
    scanStatus: 'CLEAN',
    scanPollsRemaining: 0,
    finalizedSha256: 'a'.repeat(64),
    createdAt: Date.now(),
    reservedReleased: true,
  };
  mockDb.uploads.set(upload.id, upload);
  mockDb.attachments.set(ATLAS_ID, {
    ref: {
      id: ATLAS_ID,
      filename: 'atlas-cover.png',
      size_bytes: 1024,
      mime_type: 'image/png',
      scan_status: 'CLEAN',
    },
    uploadId: upload.id,
    messageId: '00000000-0000-4000-8000-aaaaaaaaaaaa',
  });
}

function seedFiles(): void {
  seedAtlasUpload();
  mockDb.fileCenterItems = [
    fileItem(ATLAS_ID, 'atlas-cover.png', 'image/png', '2026-11-18T10:00:00.000Z'),
    fileItem(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'interview-team.m4a',
      'audio/mp4',
      '2026-11-17T10:00:00.000Z',
    ),
    fileItem(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'contract.pdf',
      'application/pdf',
      '2026-11-16T10:00:00.000Z',
      'INFECTED',
    ),
  ];
}

describe('#73 file center', () => {
  it('renders the seven-column table and filters by kind, scan status and search', async () => {
    seedFiles();
    const { user, container } = renderApp();
    await openFiles(user);

    expect(await screen.findByText('atlas-cover.png')).toBeInTheDocument();
    expect(screen.getByText('interview-team.m4a')).toBeInTheDocument();
    expect(screen.getByText('contract.pdf')).toBeInTheDocument();
    expect(container.querySelectorAll('.file-head > span')).toHaveLength(7);
    expect(container.querySelectorAll('.files-table .file-row')).toHaveLength(3);
    expect(mockDb.fileCenterRequests.at(-1)).toMatchObject({
      workspace_id: IDS.workspace,
      limit: '50',
    });

    await user.click(screen.getByRole('button', { name: 'Аудио' }));
    expect(await screen.findByText('interview-team.m4a')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('atlas-cover.png')).toBeNull());
    expect(mockDb.fileCenterRequests.at(-1)).toMatchObject({ kind: 'AUDIO' });

    await user.selectOptions(screen.getByLabelText('Статус проверки'), 'CLEAN');
    await waitFor(() =>
      expect(mockDb.fileCenterRequests.at(-1)).toMatchObject({
        kind: 'AUDIO',
        scan_status: 'CLEAN',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Все' }));
    await user.selectOptions(screen.getByLabelText('Статус проверки'), 'ALL');
    await user.type(screen.getByLabelText('Поиск файлов'), 'atlas');
    await waitFor(() => expect(mockDb.fileCenterRequests.at(-1)?.query).toBe('atlas'));
    expect(await screen.findByText('atlas-cover.png')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('contract.pdf')).toBeNull());
    // Search is literal server-side text; filters stay in the URL-less query.
    expect(screen.getByText('Найдено: 1 · фильтры применены')).toBeInTheDocument();
  });

  it('appends the next cursor page and never duplicates a row', async () => {
    mockDb.fileCenterItems = Array.from({ length: 55 }, (_, index) =>
      fileItem(
        `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
        `file-${String(index).padStart(2, '0')}.txt`,
        'text/plain',
        new Date(Date.UTC(2026, 10, 19, 12, 0, 0) - index * 60_000).toISOString(),
      ),
    );
    const { user } = renderApp();
    await openFiles(user);

    expect(await screen.findByText('file-00.txt')).toBeInTheDocument();
    expect(screen.getByText('Загружено: 50')).toBeInTheDocument();
    expect(mockDb.fileCenterRequests).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(screen.getByText('Загружено: 55')).toBeInTheDocument());

    expect(mockDb.fileCenterRequests).toHaveLength(2);
    expect(mockDb.fileCenterRequests[1]?.cursor).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
    expect(screen.getAllByText(/^file-\d{2}\.txt$/)).toHaveLength(55);
  });

  it('downloads through /attachments/{id}/download-url and previews a CLEAN image', async () => {
    seedFiles();
    const { user, container } = renderApp();
    await openFiles(user);
    expect(await screen.findByText('atlas-cover.png')).toBeInTheDocument();

    // The list is metadata-only; no object key or presigned URL is rendered.
    expect(container.textContent).not.toMatch(/object_key|sha256|localhost:9002/);

    await waitFor(() => expect(container.querySelector('.file-icon img')).not.toBeNull());

    const opened: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      opened.push(this.href);
    });

    await user.click(screen.getByRole('button', { name: 'Скачать: atlas-cover.png' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain('localhost:9002');
    expect(opened[0]).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(mockDb.downloadRequests.length).toBeGreaterThan(0);
    clickSpy.mockRestore();

    // A quarantined attachment cannot be downloaded (backend returns 423).
    expect(screen.getByRole('button', { name: 'Скачать: contract.pdf' })).toBeDisabled();
  });

  it('shows the list error and retries it', async () => {
    seedFiles();
    mockDb.forceFileCenterError = {
      status: 500,
      code: 'INTERNAL',
      message: 'file center failed',
    };
    const { user } = renderApp();
    await openFiles(user);

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Не удалось загрузить файлы' }),
    ).toBeVisible();
    expect(within(alert).getByText('Проверьте соединение и повторите попытку.')).toBeVisible();
    expect(screen.queryByText('atlas-cover.png')).toBeNull();

    mockDb.forceFileCenterError = null;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('atlas-cover.png')).toBeInTheDocument();
  });

  it('renders the honest empty state when the server page is empty', async () => {
    const { user } = renderApp();
    await openFiles(user);

    expect(await screen.findByText('Файлов пока нет')).toBeInTheDocument();
    expect(screen.getByText('Отправьте вложение в чат — оно появится здесь.')).toBeInTheDocument();
    expect(screen.getByText('Загружено: 0')).toBeInTheDocument();
  });

  it('passes an axe audit on the file center', async () => {
    seedFiles();
    const { user } = renderApp();
    await openFiles(user);
    await screen.findByText('atlas-cover.png');

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
