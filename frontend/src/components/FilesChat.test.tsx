import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];

function fileOf(size: number, name: string, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function renderFiles(overrides: Parameters<typeof renderApp>[0] = {}) {
  const result = renderApp({
    uploadPartConcurrency: 3,
    uploadScanPollMs: 10,
    uploadScanTimeoutMs: 2_000,
    ...overrides,
  });
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await screen.findByText('Хранилище');
  const input = result.container.querySelector('input[type="file"]');
  if (!input) throw new Error('File input is missing');
  return { ...result, input: input as HTMLInputElement };
}

async function upload(
  user: ReturnType<typeof renderApp>['user'],
  input: HTMLInputElement,
  file: File | File[],
) {
  await user.upload(input, file);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('managed files in chat', () => {
  it('picks a file, uploads it with progress, sends and renders the attachment card', async () => {
    const { user, input, container } = await renderFiles();
    await upload(user, input, fileOf(128, 'report.txt', 'text/plain'));

    expect(await screen.findByText('report.txt')).toBeInTheDocument();
    expect(
      await screen.findByText('Готов к отправке', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(1);
    expect(mockDb.partUploads).toHaveLength(1);

    const textarea = screen.getByLabelText('Текст сообщения');
    await user.type(textarea, 'Файл во вложении');
    await user.keyboard('{Enter}');

    const bubbleText = await screen.findByText('Файл во вложении');
    const article = bubbleText.closest('article');
    expect(article).not.toBeNull();
    expect(within(article as HTMLElement).getByText('report.txt')).toBeInTheDocument();
    expect(within(article as HTMLElement).getByText('Проверен')).toBeInTheDocument();
    expect(
      within(article as HTMLElement).getByText('Ссылка действует 5 минут'),
    ).toBeInTheDocument();
    expect(within(article as HTMLElement).getByText(/128 Б/)).toBeInTheDocument();

    const opened: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      opened.push(this.href);
    });

    await user.click(screen.getByRole('button', { name: 'Скачать' }));
    await waitFor(() => {
      expect(mockDb.downloadRequests).toHaveLength(1);
    });
    expect(opened[0]).toContain('localhost:9002');
    expect(opened[0]).toContain(mockDb.downloadRequests[0]?.attachmentId);
    clickSpy.mockRestore();
    expect(container.querySelectorAll('.attachment-card')).toHaveLength(1);
  });

  it('shows a per-file 413 preflight error and does not upload', async () => {
    const { store, user, input } = await renderFiles();
    mockDb.limits.max_file_bytes = 100;
    await store.files.refreshLimits();

    await upload(user, input, fileOf(2048, 'too-big.bin'));

    expect(await screen.findByText('Файл больше лимита')).toBeInTheDocument();
    expect(screen.getByText(/Максимум 100 Б/)).toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(0);
  });

  it('marks overflow above max_attachments and sends only the allowed batch', async () => {
    const { user, input, store } = await renderFiles();
    mockDb.limits.max_attachments = 2;
    await store.files.refreshLimits();

    await upload(user, input, [
      fileOf(16, 'a.txt', 'text/plain'),
      fileOf(16, 'b.txt', 'text/plain'),
      fileOf(16, 'c.txt', 'text/plain'),
    ]);

    expect(await screen.findByText('c.txt')).toBeInTheDocument();
    expect(await screen.findByText('Слишком много файлов')).toBeInTheDocument();
    expect(mockDb.preflightRequests[0]?.files).toHaveLength(2);
    expect(mockDb.preflightRequests[0]?.files.map((file) => file.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('pauses and resumes an upload from the UI', async () => {
    const { user, input } = await renderFiles({ uploadPartConcurrency: 1 });
    mockDb.partDelayMs = 250;
    await upload(user, input, fileOf(9 * 1024 * 1024, 'pause.bin'));

    const pause = await screen.findByRole('button', { name: /Пауза/ });
    await waitFor(() => {
      expect(screen.getByText(/Часть 1 из 2/)).toBeInTheDocument();
    });
    await user.click(pause);
    expect(await screen.findByText(/Приостановлено/, {}, { timeout: 5_000 })).toBeInTheDocument();
    const uploadId = mockDb.uploadInits[0]?.uploadId;
    expect(uploadId).toBeTruthy();

    mockDb.partDelayMs = 0;
    await user.click(screen.getByRole('button', { name: /Продолжить/ }));
    expect(
      await screen.findByText('Готов к отправке', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(1);
    expect(mockDb.uploadInits[0]?.uploadId).toBe(uploadId);
  });

  it('retries a failed part with the same upload id', async () => {
    const { user, input } = await renderFiles();
    mockDb.forcePartError = {
      status: 409,
      code: 'CHUNK_CONFLICT',
      message: 'conflict',
      partNo: 1,
    };
    await upload(user, input, fileOf(64, 'retry.bin'));

    expect(
      await screen.findByText('Часть файла уже загружена', undefined, { timeout: 4_000 }),
    ).toBeInTheDocument();
    const uploadId = mockDb.uploadInits[0]?.uploadId;
    expect(uploadId).toBeTruthy();

    mockDb.forcePartError = null;
    await user.click(screen.getByRole('button', { name: /Повторить/ }));
    expect(
      await screen.findByText('Готов к отправке', undefined, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(1);
    expect(mockDb.uploadInits[0]?.uploadId).toBe(uploadId);
  });

  it('renders a quarantined scan result and keeps the file unsendable', async () => {
    const { user, input } = await renderFiles();
    mockDb.forceScanStatus = 'INFECTED';
    await upload(user, input, fileOf(64, 'virus.bin'));

    expect(await screen.findByText(/Заблокирован проверкой/)).toBeInTheDocument();
    expect(screen.getByText('Файл заблокирован')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
  });

  it('keeps typed text when the server returns ATTACHMENT_NOT_READY', async () => {
    const { user, input } = await renderFiles();
    await upload(user, input, fileOf(64, 'slow.bin'));
    await screen.findByText('Готов к отправке');

    mockDb.forceSendError = {
      status: 409,
      code: 'ATTACHMENT_NOT_READY',
      message: 'not ready',
      details: { attachment_id: 'x', status: 'SCANNING' },
    };
    const text = 'Текст не должен потеряться';
    await user.type(screen.getByLabelText('Текст сообщения'), text);
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Файл ещё не готов')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуть текст' }));
    expect(screen.getByLabelText('Текст сообщения')).toHaveValue(text);
    mockDb.forceSendError = null;
  });

  it('shows the 423 quarantine message when download is blocked', async () => {
    const { user, input } = await renderFiles();
    await upload(user, input, fileOf(64, 'blocked.pdf', 'application/pdf'));
    await screen.findByText('Готов к отправке');
    const textarea = screen.getByLabelText('Текст сообщения');
    await user.click(textarea);
    await user.keyboard('{Enter}');
    await screen.findByText('blocked.pdf');

    mockDb.forceDownloadError = {
      status: 423,
      code: 'ATTACHMENT_QUARANTINED',
      message: 'quarantined',
    };
    await user.click(screen.getByRole('button', { name: 'Открыть' }));

    expect(await screen.findByText(/Проверка безопасности не пропустила файл/)).toBeInTheDocument();
    mockDb.forceDownloadError = null;
  });

  it('shows 80/95/100 % quota warnings and disables the picker at 100 %', async () => {
    const { store } = await renderFiles();
    const setUsage = async (used: number) => {
      mockDb.limits.usage.used = used;
      mockDb.limits.usage.reserved = 0;
      await store.files.refreshLimits();
    };

    await setUsage(Math.floor(mockDb.limits.usage.limit * 0.81));
    expect(await screen.findByText('Использовано больше 80 % хранилища.')).toBeInTheDocument();

    await setUsage(Math.floor(mockDb.limits.usage.limit * 0.96));
    expect(await screen.findByText('Осталось меньше 5 % хранилища.')).toBeInTheDocument();

    await setUsage(mockDb.limits.usage.limit);
    expect(await screen.findByText(/Хранилище заполнено/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Прикрепить файлы' })).toBeDisabled();
  });

  it('accepts a drag and drop file batch', async () => {
    const { container } = await renderFiles();
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
    const file = fileOf(32, 'dropped.txt', 'text/plain');

    fireEvent.drop(main!, {
      dataTransfer: { files: [file], types: ['Files'] },
    });

    expect(await screen.findByText('dropped.txt')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockDb.uploadInits).toHaveLength(1);
    });
  });

  it('previews images with a presigned URL and never renders SVG', async () => {
    const { user, input } = await renderFiles();
    await upload(user, input, fileOf(64, 'photo.png', 'image/png'));
    await screen.findByText('Готов к отправке');
    const textarea = screen.getByLabelText('Текст сообщения');
    await user.click(textarea);
    await user.keyboard('{Enter}');

    const image = await screen.findByAltText('Превью файла photo.png');
    expect(image.getAttribute('src')).toContain('localhost:9002');
    expect(mockDb.downloadRequests).toHaveLength(1);

    await upload(user, input, fileOf(64, 'icon.svg', 'image/svg+xml'));
    await screen.findByText('icon.svg');
    expect(screen.queryByAltText('Превью файла icon.svg')).not.toBeInTheDocument();
  });
});
