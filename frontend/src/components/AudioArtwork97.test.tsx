import 'fake-indexeddb/auto';
import axe from 'axe-core';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiAttachment, FileItem } from '../api/types';
import { putLocalArtwork, resetArtworkCacheForTests } from '../files/artworkCache';
import type { MockUpload } from '../mocks/db';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const CHAT = '44444444-4444-4444-8444-444444444444';
const ATTACHMENT = 'aa970000-0000-4000-8000-000000000097';
const SECOND = 'aa970000-0000-4000-8000-000000000098';
const ARTWORK_URL = `http://api.test/api/v1/attachments/${ATTACHMENT}/artwork`;
const SECOND_ARTWORK_URL = `http://api.test/api/v1/attachments/${SECOND}/artwork`;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const stores: ChatStore[] = [];
let objectUrlCounter = 0;

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function syncsafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function frame(id: string, payload: number[]): number[] {
  return [...asciiBytes(id), ...syncsafe(payload.length), 0, 0, ...payload];
}

function apic(mime: string, image: number[]): number[] {
  return frame('APIC', [0, ...asciiBytes(mime), 0, 3, 0, ...image]);
}

function id3Mp3(): File {
  const body = [
    ...frame('TIT2', [3, ...new TextEncoder().encode('Дорога')]),
    ...frame('TPE1', [3, ...new TextEncoder().encode('Кино')]),
    ...frame('TALB', [3, ...new TextEncoder().encode('Звезда по имени Солнце')]),
    ...frame('TYER', [3, ...asciiBytes('1989')]),
    ...frame('TLEN', [3, ...asciiBytes('240000')]),
    ...apic('image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  ];
  const bytes = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(body.length), ...body]);
  return new File([bytes, new Uint8Array([0xff, 0xfb, 0x90, 0x64])], 'doroga.mp3', {
    type: 'audio/mpeg',
  });
}

/** Server-extracted AUDIO metadata, as #97 returns it. */
function audioMedia(artworkUrl: string | null) {
  return {
    kind: 'AUDIO' as const,
    metadata_source: 'SERVER' as const,
    title: 'Ночной эфир',
    artist: 'Джаз-квартет',
    album: 'Полночь',
    year: '2019',
    genre: 'Jazz',
    duration_ms: 245_000,
    artwork_url: artworkUrl,
  };
}

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
    finalizedSha256: 'a'.repeat(64),
    createdAt: Date.now(),
    reservedReleased: true,
  };
  mockDb.uploads.set(uploadId, upload);
  mockDb.attachments.set(ref.id, { ref, uploadId, messageId: null });
}

function serverAudioRef(overrides: Partial<ApiAttachment> = {}): ApiAttachment {
  return {
    id: ATTACHMENT,
    filename: 'night-radio.mp3',
    size_bytes: 4096,
    mime_type: 'audio/mpeg',
    scan_status: 'CLEAN',
    media: audioMedia(ARTWORK_URL),
    ...overrides,
  };
}

function pushChatMessage(refs: ApiAttachment[], text: string): void {
  const chat = mockDb.chats[CHAT];
  if (!chat) throw new Error('Mock chat is missing');
  const seq = chat.summary.last_seq + 1;
  chat.summary.last_seq = seq;
  chat.messages.push({
    id: `cc970000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: CHAT,
    seq,
    type: 'TEXT',
    sender_type: 'USER',
    sender_id: '22222222-2222-4222-8222-222222222222',
    sender_display_name: 'Марк Соколов',
    text,
    reply_to_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    version: 1,
    reactions: [],
    attachments: refs,
  });
}

function audioFileItem(id: string, media: FileItem['media']): FileItem {
  return {
    id,
    filename: 'night-radio.mp3',
    size_bytes: 4096,
    mime_type: 'audio/mpeg',
    scan_status: 'CLEAN',
    chat_id: null,
    chat_name: null,
    message_id: null,
    created_at: '2026-11-18T10:00:00.000Z',
    media,
  };
}

async function renderFilesApp() {
  const result = renderApp();
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await result.user.click(screen.getByRole('button', { name: 'Файлы' }));
  await screen.findByRole('heading', { name: 'Файлы' });
  return result;
}

beforeEach(() => {
  resetArtworkCacheForTests();
  objectUrlCounter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:artwork-${(objectUrlCounter += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  resetArtworkCacheForTests();
  vi.restoreAllMocks();
});

describe('#97 server audio metadata and artwork UI', () => {
  it('renders server title/artist/album/year/duration and the authenticated cover', async () => {
    const ref = serverAudioRef();
    seedReadyAttachment(ref);
    mockDb.attachmentArtworks.set(ATTACHMENT, { mime: 'image/png', bytes: PNG_BYTES });
    pushChatMessage([ref], 'Серверные метаданные');

    const { container } = renderApp();
    await screen.findByText('Серверные метаданные');

    const title = await screen.findByText('Ночной эфир');
    const card = title.closest('.song-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('Джаз-квартет')).toBeInTheDocument();
    expect(within(card).getByText(/Полночь/)).toBeInTheDocument();
    expect(within(card).getByText(/2019/)).toBeInTheDocument();
    expect(within(card).getByText(/Jazz/)).toBeInTheDocument();
    expect(within(card).getByText('4:05')).toBeInTheDocument();

    const cover = within(card).getByAltText('Обложка: Ночной эфир') as HTMLImageElement;
    await waitFor(() => expect(cover.getAttribute('src')).toMatch(/^blob:/));
    // The authenticated endpoint never becomes an <img src> (it would be 401).
    expect(card.querySelector(`img[src*="/artwork"]`)).toBeNull();
    expect(container.innerHTML).not.toContain(ARTWORK_URL);
    // One blob fetch even though the card and row both ask for the cover.
    expect(mockDb.artworkRequests).toEqual([{ attachmentId: ATTACHMENT, authorized: true }]);
  });

  it('falls back to the local ID3 cover when the server has no artwork (404)', async () => {
    const ref = serverAudioRef();
    seedReadyAttachment(ref);
    await putLocalArtwork(ATTACHMENT, {
      mime: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    pushChatMessage([ref], 'Без серверной обложки');

    renderApp();
    await screen.findByText('Без серверной обложки');
    const title = await screen.findByText('Ночной эфир');
    const cover = within(title.closest('.song-card') as HTMLElement).getByAltText(
      'Обложка: Ночной эфир',
    ) as HTMLImageElement;

    await waitFor(() => expect(cover.getAttribute('src')).toMatch(/^blob:/));
    expect(mockDb.artworkRequests).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('swallows a 401 from the artwork endpoint and keeps the default cover', async () => {
    const ref = serverAudioRef();
    seedReadyAttachment(ref);
    mockDb.attachmentArtworks.set(ATTACHMENT, { mime: 'image/png', bytes: PNG_BYTES });
    mockDb.forceArtworkError = {
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Authentication is missing',
    };
    pushChatMessage([ref], 'Чужая обложка');

    renderApp();
    await screen.findByText('Чужая обложка');
    const title = await screen.findByText('Ночной эфир');
    const card = title.closest('.song-card') as HTMLElement;

    await waitFor(() => expect(card.querySelector('.song-card__cover--fallback')).not.toBeNull());
    expect(card.querySelector('img')).toBeNull();
    expect(screen.queryByText('Authentication is missing')).toBeNull();
    expect(mockDb.artworkRequests.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the cover and tags on the files page row, and degrades without artwork', async () => {
    seedReadyAttachment(serverAudioRef());
    seedReadyAttachment(serverAudioRef({ id: SECOND, media: audioMedia(SECOND_ARTWORK_URL) }));
    mockDb.attachmentArtworks.set(ATTACHMENT, { mime: 'image/png', bytes: PNG_BYTES });
    mockDb.fileCenterItems = [
      audioFileItem(ATTACHMENT, audioMedia(ARTWORK_URL)),
      audioFileItem(SECOND, audioMedia(SECOND_ARTWORK_URL)),
    ];

    await renderFilesApp();

    expect(await screen.findAllByText(/Ночной эфир/)).toHaveLength(2);
    expect(screen.getAllByText(/Джаз-квартет/)).toHaveLength(2);
    expect(screen.getAllByText(/4:05/)).toHaveLength(2);

    await waitFor(() => expect(document.querySelector('.file-icon img')).not.toBeNull());
    const covers = [...document.querySelectorAll<HTMLImageElement>('.file-icon img')];
    expect(covers.some((image) => (image.getAttribute('src') ?? '').startsWith('blob:'))).toBe(
      true,
    );
    expect(document.querySelector('.file-icon img[src*="/artwork"]')).toBeNull();
    // The second row has no extracted bytes: the extension badge is shown.
    await waitFor(() => expect(screen.getByText('MP3')).toBeInTheDocument());
  });

  it('displays server metadata right after a FilesPage upload refresh', async () => {
    const { user } = await renderFilesApp();
    await user.upload(screen.getByLabelText('Выбрать файл'), id3Mp3());

    expect(
      await screen.findByText('Файл «doroga.mp3» загружен и поставлен на проверку.'),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Дорога/)).toBeInTheDocument();
    expect(screen.getByText(/Кино/)).toBeInTheDocument();
    expect(screen.getByText(/Звезда по имени Солнце/)).toBeInTheDocument();
    expect(screen.getByText(/1989/)).toBeInTheDocument();
    expect(screen.getByText(/4:00/)).toBeInTheDocument();
    expect(mockDb.fileUploadRequests).toHaveLength(1);

    const item = mockDb.fileCenterItems[0];
    expect(item?.media).toMatchObject({
      kind: 'AUDIO',
      metadata_source: 'SERVER',
      title: 'Дорога',
      artist: 'Кино',
    });
    expect(item?.media?.artwork_url).toMatch(/\/attachments\/.+\/artwork$/);
    // The extracted APIC cover is served only after the authenticated refresh.
    await waitFor(() => expect(document.querySelector('.file-icon img')).not.toBeNull());
    expect(document.querySelector('.file-icon img[src*="/artwork"]')).toBeNull();
    expect(mockDb.artworkRequests).toEqual([{ attachmentId: String(item?.id), authorized: true }]);
  });

  it('caches one object URL per attachment and revokes it on reset', async () => {
    const ref = serverAudioRef();
    seedReadyAttachment(ref);
    mockDb.attachmentArtworks.set(ATTACHMENT, { mime: 'image/png', bytes: PNG_BYTES });
    pushChatMessage([ref], 'Кэш обложки');

    const { store } = renderApp();
    stores.push(store);
    await screen.findByText('Кэш обложки');

    const [first, second] = await Promise.all([
      store.files.getAttachmentArtworkUrl(ATTACHMENT),
      store.files.getAttachmentArtworkUrl(ATTACHMENT),
    ]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(first);

    store.files.reset();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  });

  it('passes an axe audit with a server cover on the files page', async () => {
    seedReadyAttachment(serverAudioRef());
    mockDb.attachmentArtworks.set(ATTACHMENT, { mime: 'image/png', bytes: PNG_BYTES });
    mockDb.fileCenterItems = [audioFileItem(ATTACHMENT, audioMedia(ARTWORK_URL))];
    const { user } = await renderFilesApp();
    await user.click(screen.getByRole('button', { name: 'Аудио' }));
    await screen.findByText(/Ночной эфир/);

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
