import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiAttachment, ApiMessage } from '../api/types';
import type { MockUpload } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const CHAT = IDS.groupChat;
const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function seedReadyAttachment(ref: ApiAttachment): void {
  const uploadId = `${ref.id}-upload`;
  const upload: MockUpload = {
    id: uploadId,
    chatId: CHAT,
    filename: ref.filename ?? 'file',
    size: ref.size_bytes,
    mime: ref.mime_type ?? null,
    media: ref.media ?? null,
    declaredSha256: null,
    partSize: ref.size_bytes,
    totalParts: 1,
    received: new Map(),
    status: 'READY',
    expiresAt: Date.now() + 3_600_000,
    attachmentId: ref.id,
    scanStatus: 'CLEAN',
    scanPollsRemaining: 0,
    finalizedSha256: null,
    createdAt: Date.now(),
    reservedReleased: true,
  };
  mockDb.uploads.set(uploadId, upload);
  mockDb.attachments.set(ref.id, { ref, uploadId, messageId: null });
}

function seedMediaMessage(text: string, attachments: ApiAttachment[]): void {
  const chat = mockDb.chats[CHAT];
  if (!chat) throw new Error('Mock group chat is missing');
  const seq = chat.summary.last_seq + 1;
  chat.summary.last_seq = seq;
  const message: ApiMessage = {
    id: `cc000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: CHAT,
    seq,
    type: 'TEXT',
    sender_type: 'USER',
    sender_id: IDS.mark,
    sender_display_name: 'Марк Соколов',
    text,
    reply_to_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
    attachments,
  };
  chat.messages.push(message);
}

const IMAGE: ApiAttachment = {
  id: 'bb000000-0000-4000-8000-0000000000c1',
  filename: 'photo.png',
  size_bytes: 2048,
  mime_type: 'image/png',
  scan_status: 'CLEAN',
  media: { kind: 'IMAGE', width: 800, height: 600, metadata_source: 'SERVER' },
};

const VIDEO: ApiAttachment = {
  id: 'bb000000-0000-4000-8000-0000000000c2',
  filename: 'clip.mp4',
  size_bytes: 4096,
  mime_type: 'video/mp4',
  scan_status: 'CLEAN',
  media: {
    kind: 'VIDEO',
    width: 1280,
    height: 720,
    duration_ms: 65_000,
    artwork_url: 'https://cdn.example/poster-c1.jpg',
    metadata_source: 'SERVER',
  },
};

async function renderMedia(): Promise<ReturnType<typeof renderApp>> {
  const result = renderApp();
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  return result;
}

describe('Telegram-style media attachments', () => {
  it('renders an image as full-width rounded media with its aspect ratio and no card chrome', async () => {
    seedReadyAttachment(IMAGE);
    seedMediaMessage('Фото', [IMAGE]);
    const result = await renderMedia();

    const image = await screen.findByAltText('Превью файла photo.png');
    const card = image.closest('.attachment-card');
    expect(card).not.toBeNull();
    expect(card).toHaveClass('attachment-card--media');
    // The media box reserves the server-declared aspect ratio before/while the
    // image decodes, so the feed does not jump.
    const stage = image.closest('.attachment-card__media') as HTMLElement;
    expect(stage.style.aspectRatio).toBe('800 / 600');
    // Filename/download stay in the DOM but recede into the caption.
    expect(within(card as HTMLElement).getByText('photo.png')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/800×600/)).toBeInTheDocument();

    await result.user.click(image);
    const dialog = await screen.findByRole('dialog', { name: 'Просмотр: photo.png' });
    expect(within(dialog).getByAltText('Превью файла photo.png')).toBeInTheDocument();
  });

  it('opens a video in the full-screen player with its poster and restores focus on close', async () => {
    seedReadyAttachment(VIDEO);
    seedMediaMessage('Видео', [VIDEO]);
    const result = await renderMedia();

    const video = (await screen.findByLabelText('Видео: clip.mp4')) as HTMLVideoElement;
    expect(video.getAttribute('poster')).toBe('https://cdn.example/poster-c1.jpg');
    const card = video.closest('.attachment-card');
    expect(card).toHaveClass('attachment-card--media');

    const expand = within(card as HTMLElement).getByRole('button', {
      name: 'Открыть на весь экран: clip.mp4',
    });
    expand.focus();
    await result.user.click(expand);

    const dialog = await screen.findByRole('dialog', { name: 'Просмотр: clip.mp4' });
    const full = within(dialog).getByLabelText('Видео: clip.mp4') as HTMLVideoElement;
    expect(full.tagName).toBe('VIDEO');
    expect(full.controls).toBe(true);
    expect(full.getAttribute('poster')).toBe('https://cdn.example/poster-c1.jpg');
    expect(full.getAttribute('src')).toContain('localhost:9002');

    await result.user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Просмотр: clip.mp4' })).not.toBeInTheDocument(),
    );
    expect(expand).toHaveFocus();
  });

  it('keeps non-media files in the compact card layout', async () => {
    const fileAttachment: ApiAttachment = {
      id: 'bb000000-0000-4000-8000-0000000000c3',
      filename: 'report.pdf',
      size_bytes: 1024,
      mime_type: 'application/pdf',
      scan_status: 'CLEAN',
    };
    seedReadyAttachment(fileAttachment);
    seedMediaMessage('Документ', [fileAttachment]);
    await renderMedia();

    const name = await screen.findByText('report.pdf');
    const card = name.closest('.attachment-card');
    expect(card).not.toBeNull();
    expect(card).not.toHaveClass('attachment-card--media');
  });
});
