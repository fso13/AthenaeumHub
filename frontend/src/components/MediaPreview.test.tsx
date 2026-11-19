import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];

function fileOf(size: number, name: string, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function renderMedia(overrides: Parameters<typeof renderApp>[0] = {}) {
  const result = renderApp({
    uploadPartConcurrency: 2,
    uploadScanPollMs: 10,
    uploadScanTimeoutMs: 2_000,
    ...overrides,
  });
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  const input = result.container.querySelector('input[type="file"]');
  if (!input) throw new Error('File input is missing');
  return { ...result, input: input as HTMLInputElement, app: result.container };
}

async function sendFile(
  user: ReturnType<typeof renderApp>['user'],
  input: HTMLInputElement,
  file: File | File[],
): Promise<void> {
  await user.upload(input, file);
  await screen.findAllByText('Готов к отправке', {}, { timeout: 10_000 });
  const textarea = screen.getByLabelText('Текст сообщения');
  await user.click(textarea);
  await user.keyboard('{Enter}');
}

function seedAttachmentMessage(
  attachment: {
    id: string;
    filename: string;
    mime_type: string;
    scan_status: 'PENDING' | 'INFECTED' | 'FAILED' | 'SKIPPED';
  },
  text: string,
): void {
  const chat = mockDb.chats[IDS.groupChat];
  if (!chat) throw new Error('Mock group chat is missing');
  const seq = chat.summary.last_seq + 1;
  chat.summary.last_seq = seq;
  chat.messages.push({
    id: `cc000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: IDS.groupChat,
    seq,
    type: 'TEXT',
    sender_id: IDS.mark,
    sender_display_name: 'Марк Соколов',
    text,
    reply_to_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
    attachments: [
      {
        id: attachment.id,
        filename: attachment.filename,
        size_bytes: 2048,
        mime_type: attachment.mime_type,
        scan_status: attachment.scan_status,
      },
    ],
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('media previews in attachment cards', () => {
  it('opens an image lightbox with dialog semantics, Esc, focus return and download', async () => {
    const { user, input } = await renderMedia();
    await sendFile(user, input, fileOf(64, 'photo.png', 'image/png'));

    const image = await screen.findByAltText('Превью файла photo.png');
    expect(image.getAttribute('src')).toContain('localhost:9002');
    expect(mockDb.downloadRequests).toHaveLength(1);

    const thumbnail = image.closest('button');
    expect(thumbnail).not.toBeNull();
    await user.click(image);

    const dialog = await screen.findByRole('dialog', {
      name: 'Просмотр: photo.png',
    });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByAltText('Превью файла photo.png')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Закрыть просмотр' })).toHaveFocus();

    // Tab cycles inside the dialog instead of escaping to the page behind it.
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Скачать' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Закрыть просмотр' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Скачать' })).toHaveFocus();

    const opened: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      opened.push(this.href);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Скачать' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain('localhost:9002');
    expect(mockDb.downloadRequests).toHaveLength(1);
    clickSpy.mockRestore();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Focus returns to the thumbnail that opened the dialog.
    expect(thumbnail).toHaveFocus();

    // Backdrop click closes too.
    await user.click(image);
    await screen.findByRole('dialog', { name: 'Просмотр: photo.png' });
    fireEvent.click(screen.getByTestId('media-lightbox'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('renders an inline video player without autoplay or poster', async () => {
    const { user, input } = await renderMedia();
    await sendFile(user, input, fileOf(64, 'clip.mp4', 'video/mp4'));

    const video = (await screen.findByLabelText('Видео: clip.mp4')) as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.controls).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video).toHaveAttribute('playsinline');
    expect(video).not.toHaveAttribute('autoplay');
    expect(video.autoplay).toBe(false);
    expect(video).not.toHaveAttribute('poster');
    expect(video.getAttribute('src')).toContain('localhost:9002');
    expect(mockDb.downloadRequests).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeEnabled();
    expect(screen.getByText('Ссылка действует 5 минут')).toBeInTheDocument();
  });

  it('renders inline audio controls next to the filename and size', async () => {
    const { user, input } = await renderMedia();
    await sendFile(user, input, fileOf(64, 'track.mp3', 'audio/mpeg'));

    const audio = (await screen.findByLabelText('Аудио: track.mp3')) as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(audio.getAttribute('src')).toContain('localhost:9002');
    expect(mockDb.downloadRequests).toHaveLength(1);

    const card = audio.closest('.attachment-card');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('track.mp3')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/64 Б/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/Аудио/)).toBeInTheDocument();
  });

  it('never renders SVG or HTML attachments as media', async () => {
    const { user, input, app } = await renderMedia();
    await sendFile(user, input, [
      fileOf(64, 'icon.svg', 'image/svg+xml'),
      fileOf(64, 'page.html', 'text/html'),
    ]);

    expect(await screen.findByText('icon.svg')).toBeInTheDocument();
    expect(screen.getByText('page.html')).toBeInTheDocument();
    const cards = app.querySelector('.attachment-card');
    expect(cards).not.toBeNull();
    expect(app.querySelectorAll('.attachment-card img')).toHaveLength(0);
    expect(app.querySelectorAll('.attachment-card video')).toHaveLength(0);
    expect(app.querySelectorAll('.attachment-card audio')).toHaveLength(0);
    // No presigned URL is requested for non-previewable MIME types.
    expect(mockDb.downloadRequests).toHaveLength(0);
  });

  it('shows quarantine/pending status without a URL, player or download', async () => {
    seedAttachmentMessage(
      {
        id: 'bb000000-0000-4000-8000-000000000001',
        filename: 'virus.mp4',
        mime_type: 'video/mp4',
        scan_status: 'INFECTED',
      },
      'Заражённый файл',
    );
    seedAttachmentMessage(
      {
        id: 'bb000000-0000-4000-8000-000000000002',
        filename: 'pending.png',
        mime_type: 'image/png',
        scan_status: 'PENDING',
      },
      'Файл на проверке',
    );

    const { app } = await renderMedia();
    expect(await screen.findByText('virus.mp4')).toBeInTheDocument();
    expect(screen.getByText('pending.png')).toBeInTheDocument();

    expect(app.querySelectorAll('.attachment-card img')).toHaveLength(0);
    expect(app.querySelectorAll('.attachment-card video')).toHaveLength(0);
    expect(app.querySelectorAll('.attachment-card audio')).toHaveLength(0);
    expect(mockDb.downloadRequests).toHaveLength(0);

    expect(screen.getByText('Заблокирован')).toBeInTheDocument();
    expect(screen.getByText('На проверке')).toBeInTheDocument();
    expect(screen.getByText(/Файл заблокирован проверкой/)).toBeInTheDocument();
    expect(screen.getByText('Файл на проверке — скачивание пока недоступно')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Скачать' })).toBeDisabled();
  });

  it('explains a failed presigned URL and retries with a fresh link', async () => {
    const { user, input } = await renderMedia();
    await user.upload(input, fileOf(64, 'photo.png', 'image/png'));
    await screen.findByText('Готов к отправке', {}, { timeout: 10_000 });

    mockDb.forceDownloadError = {
      status: 409,
      code: 'SCAN_PENDING',
      message: 'scan pending',
    };
    const textarea = screen.getByLabelText('Текст сообщения');
    await user.click(textarea);
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText('Скачивание станет доступно после проверки безопасности.'),
    ).toBeInTheDocument();
    expect(screen.queryByAltText('Превью файла photo.png')).not.toBeInTheDocument();

    mockDb.forceDownloadError = null;
    await user.click(screen.getByRole('button', { name: 'Обновить ссылку' }));
    expect(await screen.findByAltText('Превью файла photo.png')).toBeInTheDocument();
    expect(mockDb.downloadRequests).toHaveLength(1);

    // A broken image (expired URL) shows a clear retry/download fallback.
    fireEvent.error(screen.getByAltText('Превью файла photo.png'));
    expect(await screen.findByText(/Не удалось загрузить превью/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скачать файл' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Обновить ссылку' }));
    expect(await screen.findByAltText('Превью файла photo.png')).toBeInTheDocument();
    expect(mockDb.downloadRequests).toHaveLength(2);
  });
});
