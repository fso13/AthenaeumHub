import 'fake-indexeddb/auto';
import axe from 'axe-core';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalArtworkUrl, resetArtworkCacheForTests } from '../files/artworkCache';
import type { ApiAttachment } from '../api/types';
import type { MockUpload } from '../mocks/db';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function syncsafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function frame(id: string, payload: number[]): number[] {
  return [...asciiBytes(id), ...syncsafe(payload.length), 0, 0, ...payload];
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function apic(mime: string, image: number[]): number[] {
  return frame('APIC', [0, ...asciiBytes(mime), 0, 3, 0, ...image]);
}

function id3Song(
  options: {
    title?: string;
    artist?: string;
    album?: string;
    year?: string;
    genre?: string;
    duration?: number;
    artwork?: boolean;
  } = {},
): File {
  const frames: number[][] = [];
  if (options.title !== undefined) frames.push(frame('TIT2', [3, ...utf8(options.title)]));
  if (options.artist !== undefined) frames.push(frame('TPE1', [3, ...utf8(options.artist)]));
  if (options.album !== undefined) frames.push(frame('TALB', [3, ...utf8(options.album)]));
  if (options.year !== undefined) frames.push(frame('TYER', [3, ...utf8(options.year)]));
  if (options.genre !== undefined) frames.push(frame('TCON', [3, ...utf8(options.genre)]));
  if (options.duration !== undefined) {
    frames.push(frame('TLEN', [3, ...utf8(String(options.duration))]));
  }
  if (options.artwork) frames.push(apic('image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const body = frames.flat();
  const bytes = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(body.length), ...body]);
  const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  return new File([bytes, mp3Frame], 'song.mp3', { type: 'audio/mpeg' });
}

async function renderMediaApp(overrides: Parameters<typeof renderApp>[0] = {}) {
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
  return { ...result, input: input as HTMLInputElement };
}

async function uploadFile(
  user: ReturnType<typeof renderApp>['user'],
  input: HTMLInputElement,
  file: File,
): Promise<void> {
  await user.upload(input, file);
  await screen.findByText('Готов к отправке', {}, { timeout: 10_000 });
}

function lastAttachment() {
  return [...mockDb.attachments.values()].at(-1)?.ref ?? null;
}

/** Register a ready attachment so the mock presigned-URL endpoint can serve it. */
function seedReadyAttachment(ref: ApiAttachment): void {
  const uploadId = `${ref.id}-upload`;
  const upload: MockUpload = {
    id: uploadId,
    chatId: '44444444-4444-4444-8444-444444444444',
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

beforeEach(() => {
  resetArtworkCacheForTests();
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:local-artwork-${(counter += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  resetArtworkCacheForTests();
});

describe('song cards and ID3 upload metadata', () => {
  it('uploads ID3 metadata, renders a song card and keeps artwork local-only', async () => {
    const { user, input } = await renderMediaApp();
    await uploadFile(
      user,
      input,
      id3Song({
        title: 'Полёт',
        artist: 'Аквариум',
        album: 'Радио Африка',
        year: '1983-06-01',
        genre: 'Rock',
        duration: 180_000,
        artwork: true,
      }),
    );

    const init = mockDb.uploadInits[0]?.body;
    expect(init?.media).toEqual({
      kind: 'AUDIO',
      metadata_source: 'ID3',
      title: 'Полёт',
      artist: 'Аквариум',
      album: 'Радио Африка',
      year: '1983',
      genre: 'Rock',
      duration_ms: 180_000,
    });
    // Cover bytes never travel to the server; there is no hosted URL yet.
    expect(init?.media?.artwork_url).toBeUndefined();

    const uploadId = mockDb.uploadInits[0]?.uploadId;
    const attachmentId = uploadId ? mockDb.uploads.get(uploadId)?.attachmentId : null;
    await waitFor(async () => {
      expect(await getLocalArtworkUrl(String(attachmentId))).toBe('blob:local-artwork-1');
    });

    await user.type(screen.getByLabelText('Текст сообщения'), 'Песня');
    await user.keyboard('{Enter}');

    const card = (await screen.findByText('Полёт')).closest('.attachment-card');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Аквариум')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/Радио Африка/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/1983/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('3:00')).toBeInTheDocument();
    const cover = within(card as HTMLElement).getByAltText('Обложка: Полёт');
    expect(cover.getAttribute('src')).toBe('blob:local-artwork-1');
    const audio = within(card as HTMLElement).getByLabelText('Песня: Полёт') as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.controls).toBe(true);
    expect(audio.autoplay).toBe(false);

    // The API copy keeps the sanitized media metadata (mock mirrors D1-BE2).
    expect(lastAttachment()?.media).toMatchObject({
      kind: 'AUDIO',
      metadata_source: 'ID3',
      title: 'Полёт',
    });
    expect(mockDb.uploadInits).toHaveLength(1);
  });

  it('falls back to filename, unknown artist and the default cover without tags', async () => {
    const { user, input } = await renderMediaApp();
    const plain = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], 'track.mp3', {
      type: 'audio/mpeg',
    });
    await uploadFile(user, input, plain);
    expect(mockDb.uploadInits[0]?.body.media).toEqual({
      kind: 'AUDIO',
      metadata_source: 'NONE',
    });

    await user.type(screen.getByLabelText('Текст сообщения'), 'Без тегов');
    await user.keyboard('{Enter}');

    const card = (await screen.findByText('track.mp3')).closest('.attachment-card');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Неизвестный исполнитель')).toBeInTheDocument();
    expect((card as HTMLElement).querySelector('.song-card__cover--fallback')).not.toBeNull();
    expect(within(card as HTMLElement).getByLabelText('Аудио: track.mp3')).toBeInTheDocument();
  });

  it('renders hostile ID3 strings as text, never as markup', async () => {
    const { user, input, container } = await renderMediaApp();
    await uploadFile(
      user,
      input,
      id3Song({
        title: '<img src=x onerror=alert(1)>',
        artist: '<script>alert(2)</script>',
        artwork: true,
      }),
    );

    const media = mockDb.uploadInits[0]?.body.media;
    expect(media?.title).not.toContain('<');
    expect(media?.title).not.toContain('>');
    expect(media?.artist).not.toContain('<');
    expect(media?.artist).not.toContain('>');

    await user.type(screen.getByLabelText('Текст сообщения'), 'XSS');
    await user.keyboard('{Enter}');
    await screen.findByText('img src=x onerror=alert(1)');
    expect(container.querySelector('.song-card__body img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('.song-card__body script')).toBeNull();
  });

  it('renders video duration/poster and image metadata from the API', async () => {
    const chat = mockDb.chats['44444444-4444-4444-8444-444444444444'];
    if (!chat) throw new Error('Mock group chat is missing');
    const seq = chat.summary.last_seq + 1;
    chat.summary.last_seq = seq;
    const videoRef: ApiAttachment = {
      id: 'bb000000-0000-4000-8000-0000000000aa',
      filename: 'clip.mp4',
      size_bytes: 4096,
      mime_type: 'video/mp4',
      scan_status: 'CLEAN',
      media: {
        kind: 'VIDEO',
        duration_ms: 65_000,
        width: 1280,
        height: 720,
        artwork_url: 'https://cdn.example/poster.jpg',
        metadata_source: 'SERVER',
      },
    };
    const imageRef: ApiAttachment = {
      id: 'bb000000-0000-4000-8000-0000000000bb',
      filename: 'photo.png',
      size_bytes: 2048,
      mime_type: 'image/png',
      scan_status: 'CLEAN',
      media: { kind: 'IMAGE', width: 800, height: 600, metadata_source: 'SERVER' },
    };
    seedReadyAttachment(videoRef);
    seedReadyAttachment(imageRef);
    chat.messages.push({
      id: `cc000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      chat_id: chat.summary.id,
      seq,
      type: 'TEXT',
      sender_type: 'USER',
      sender_id: '22222222-2222-4222-8222-222222222222',
      sender_display_name: 'Марк Соколов',
      text: 'Видео и фото',
      reply_to_id: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      version: 1,
      reactions: [],
      attachments: [videoRef, imageRef],
    });

    const { container } = await renderMediaApp();
    await screen.findByText('Видео и фото');
    const video = (await screen.findByLabelText('Видео: clip.mp4')) as HTMLVideoElement;
    expect(video.getAttribute('poster')).toBe('https://cdn.example/poster.jpg');
    expect(video.autoplay).toBe(false);
    expect(
      within(video.closest('.attachment-card') as HTMLElement).getByText(/1:05/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1280×720/)).toBeInTheDocument();
    expect(container.querySelectorAll('.attachment-card img')).toHaveLength(1);
    expect(screen.getByAltText('Превью файла photo.png')).toBeInTheDocument();
    expect(screen.getByText(/800×600/)).toBeInTheDocument();
  });

  it('passes an axe audit for a song card', async () => {
    const { user, input } = await renderMediaApp();
    await uploadFile(
      user,
      input,
      id3Song({ title: 'Тишина', artist: 'Кино', album: 'Ночь', year: '1986' }),
    );
    await user.type(screen.getByLabelText('Текст сообщения'), 'Аудит');
    await user.keyboard('{Enter}');
    await screen.findByText('Тишина');

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  }, 30_000);
});
