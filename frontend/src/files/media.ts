/**
 * Client-side media metadata for managed uploads (D1-FE2).
 *
 * The contract accepts sanitized metadata at `POST /uploads` init and copies
 * it to `AttachmentRef.media`. This module converts a picked `File` into that
 * payload:
 *
 *  - audio files are probed with the local ID3 parser (`metadata_source=ID3`);
 *  - a file without usable tags falls back to `NONE` (filename/default cover);
 *  - video/image uploads only declare their `kind` (server extraction is D1.1);
 *  - generic files send no `media` at all, unchanged from E4.
 *
 * Strings are trimmed, HTML/control-free and bounded to the same limits the
 * server enforces, so a hostile tag value never turns into a 422 on upload.
 * Artwork bytes are never uploaded: they are cached locally only (managed
 * server extraction is D1.1 and E2EE stays local-only).
 */
import type { AttachmentMedia, MediaKind, UploadMediaMetadata } from '../api/types';
import { extensionOf } from './format';
import { readId3Tags, sanitizeId3Text, type Id3Tags } from './id3';

export const MAX_MEDIA_TEXT_LENGTH = 255;
export const MAX_MEDIA_GENRE_LENGTH = 64;
export const MIN_VOICE_DURATION_MS = 1;
export const MAX_VOICE_DURATION_MS = 600_000;

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'flac',
  'wav',
  'weba',
]);
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
]);

function normalizeMime(mime: string | null | undefined): string {
  if (typeof mime !== 'string') return '';
  return (mime.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** `null` means "do not send media" (generic files keep the E4 payload). */
export function mediaKindForFile(file: Pick<File, 'type' | 'name'>): MediaKind | null {
  const mime = normalizeMime(file.type);
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('image/')) return 'IMAGE';

  const extension = extensionOf(file.name);
  if (AUDIO_EXTENSIONS.has(extension)) return 'AUDIO';
  if (VIDEO_EXTENSIONS.has(extension)) return 'VIDEO';
  if (IMAGE_EXTENSIONS.has(extension)) return 'IMAGE';
  return null;
}

export function sanitizeMediaText(
  value: string | null | undefined,
  maxLength = MAX_MEDIA_TEXT_LENGTH,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = sanitizeId3Text(value, maxLength);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function sanitizeMediaYear(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /\d{4}/.exec(value);
  return match ? match[0] : undefined;
}

export function clampDuration(
  value: number,
  min = MIN_VOICE_DURATION_MS,
  max = MAX_VOICE_DURATION_MS,
): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Metadata for a finished MediaRecorder take: kind AUDIO + exact duration. */
export function voiceMediaMetadata(durationMs: number): UploadMediaMetadata {
  return {
    kind: 'AUDIO',
    duration_ms: clampDuration(durationMs),
    metadata_source: 'CLIENT',
  };
}

function audioMediaFromTags(tags: Id3Tags, durationMs?: number): UploadMediaMetadata {
  const title = sanitizeMediaText(tags.title);
  const artist = sanitizeMediaText(tags.artist);
  const album = sanitizeMediaText(tags.album);
  const year = sanitizeMediaYear(tags.year);
  const genre = sanitizeMediaText(tags.genre, MAX_MEDIA_GENRE_LENGTH);
  const duration = tags.durationMs ?? durationMs;
  const meta: UploadMediaMetadata = {
    kind: 'AUDIO',
    metadata_source: 'NONE',
  };
  if (title !== undefined) meta.title = title;
  if (artist !== undefined) meta.artist = artist;
  if (album !== undefined) meta.album = album;
  if (year !== undefined) meta.year = year;
  if (genre !== undefined) meta.genre = genre;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 1) {
    meta.duration_ms = clampDuration(duration, 1, 604_800_000);
  }
  if (
    title !== undefined ||
    artist !== undefined ||
    album !== undefined ||
    year !== undefined ||
    genre !== undefined
  ) {
    meta.metadata_source = 'ID3';
  }
  return meta;
}

export interface UploadMediaPlan {
  media: UploadMediaMetadata;
  /** APIC bytes for the local-only artwork cache; never sent to the server. */
  artwork: { mime: string; bytes: Uint8Array } | null;
}

/**
 * Inspect one picked file. Never throws: a broken/oversized ID3 tag simply
 * produces the `NONE` fallback card. `null` means the upload init stays
 * media-less (plain files, PDF, archives, text).
 */
export async function planUploadMedia(file: File): Promise<UploadMediaPlan | null> {
  const kind = mediaKindForFile(file);
  if (kind === null) return null;

  if (kind !== 'AUDIO') {
    return { media: { kind, metadata_source: 'NONE' }, artwork: null };
  }

  try {
    const parsed = await readId3Tags(file);
    if (parsed.status !== 'ok') {
      return { media: { kind: 'AUDIO', metadata_source: 'NONE' }, artwork: null };
    }
    return {
      media: audioMediaFromTags(parsed.tags),
      artwork: parsed.artwork,
    };
  } catch {
    return { media: { kind: 'AUDIO', metadata_source: 'NONE' }, artwork: null };
  }
}

/** Convenience for the attach flow: parallel, failure-isolated plans. */
export async function planUploadMediaBatch(
  files: readonly File[],
): Promise<(UploadMediaPlan | null)[]> {
  return Promise.all(files.map((file) => planUploadMedia(file).catch(() => null)));
}

export interface SongDisplay {
  title: string;
  artist: string;
  album: string | null;
  year: string | null;
  genre: string | null;
  durationMs: number | null;
}

function stripExtension(filename: string | null | undefined): string {
  if (typeof filename !== 'string') return '';
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/**
 * A "song" card is an audio attachment with at least one text tag. A plain
 * MP3 or a voice take deliberately falls back to the audio/voice card
 * (unknown artist/default cover) instead of inventing metadata. `ID3` is the
 * MVP source; the same shape stays valid when the server fills `SERVER`.
 */
export function songDisplay(media: AttachmentMedia | null | undefined): SongDisplay | null {
  if (!media || media.kind !== 'AUDIO') return null;
  const title = sanitizeMediaText(media.title);
  const artist = sanitizeMediaText(media.artist);
  const album = sanitizeMediaText(media.album) ?? null;
  const year = sanitizeMediaYear(media.year) ?? null;
  const genre = sanitizeMediaText(media.genre, MAX_MEDIA_GENRE_LENGTH) ?? null;
  if (!title && !artist && !album && !year && !genre) return null;
  return {
    title: title ?? '',
    artist: artist ?? '',
    album,
    year,
    genre,
    durationMs:
      typeof media.duration_ms === 'number' && Number.isFinite(media.duration_ms)
        ? Math.max(0, Math.round(media.duration_ms))
        : null,
  };
}

/** Fill the missing song title from the filename (fallback, never invented). */
export function songTitleOrFilename(
  song: SongDisplay,
  filename: string | null | undefined,
): string {
  return song.title || stripExtension(filename);
}

/** Voice takes carry `metadata_source=CLIENT`; filename is a second signal. */
export function isVoiceMedia(
  media: AttachmentMedia | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (!media || media.kind !== 'AUDIO') return false;
  if (songDisplay(media)) return false;
  return media.metadata_source === 'CLIENT' || /^voice-/i.test(filename ?? '');
}
