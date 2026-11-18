/** Human-facing file/limit formatting. Keep it UI-only: no contract shapes. */

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] as const;

/**
 * Media-codec allowlists for inline playback. Anything outside these lists is
 * still downloadable as a regular file, but never handed to `<video>/<audio>`
 * (scope: MP4/WebM and MP3/OGG/WAV, plus close non-executable relatives).
 */
const INLINE_VIDEO_MIME_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

const INLINE_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
]);

/**
 * Raster-only allowlist. SVG (and any unknown `image/*` subtype that a browser
 * might sniff as markup) is deliberately excluded; such files remain regular
 * downloadable attachments.
 */
const SAFE_PREVIEW_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-ms-bmp',
]);

function normalizeMime(mime: string | null | undefined): string {
  if (typeof mime !== 'string') return '';
  return (mime.split(';', 1)[0] ?? '').trim().toLowerCase();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const value = Math.max(0, bytes);
  if (value < 1024) return `${Math.round(value)} Б`;

  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < UNITS.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(rounded)} ${
    UNITS[unitIndex] ?? 'Б'
  }`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0 %';
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return `${percent} %`;
}

/**
 * Media duration for cards and the recording timer. Fractional seconds are
 * floored so a 0.9 s take still reads `0:00` (never a fake `0:01`), while
 * `Math.max(0, …)` keeps malformed input from rendering `NaN`.
 */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return '—';
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function fileTypeLabel(mime: string | null | undefined, filename?: string | null): string {
  if (mime) {
    if (mime.startsWith('image/')) return 'Изображение';
    if (mime.startsWith('video/')) return 'Видео';
    if (mime === 'application/pdf') return 'PDF';
    if (mime.startsWith('audio/')) return 'Аудио';
    if (mime.startsWith('text/')) return 'Текст';
    if (mime.startsWith('application/zip') || mime.includes('compressed')) return 'Архив';
  }
  const extension = filename?.split('.').pop()?.trim().toUpperCase();
  return extension && extension.length <= 5 ? extension : 'Файл';
}

export function isImageMime(mime: string | null | undefined): mime is string {
  return normalizeMime(mime).startsWith('image/');
}

/**
 * SVG is deliberately never rendered from user files (SYSTEM-ANALYSIS §11.6);
 * it is still downloadable as a regular file. Only explicit raster types are
 * previewable, so no `image/*` subtype can smuggle SVG/HTML into an `<img>`.
 */
export function isSafePreviewImage(mime: string | null | undefined): boolean {
  return SAFE_PREVIEW_IMAGE_MIME_TYPES.has(normalizeMime(mime));
}

export function isPdfMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime) === 'application/pdf';
}

export function isVideoMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime).startsWith('video/');
}

export function isAudioMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime).startsWith('audio/');
}

/** Inline `<video>` is allowed only for an explicit, non-executable allowlist. */
export function isSupportedVideoMime(mime: string | null | undefined): boolean {
  return INLINE_VIDEO_MIME_TYPES.has(normalizeMime(mime));
}

/** Inline `<audio>` is allowed only for an explicit, non-executable allowlist. */
export function isSupportedAudioMime(mime: string | null | undefined): boolean {
  return INLINE_AUDIO_MIME_TYPES.has(normalizeMime(mime));
}

export function extensionOf(filename: string | null | undefined): string {
  const extension = filename?.split('.').pop()?.trim();
  return extension && extension !== filename ? extension.toLowerCase() : '';
}

/**
 * Only absolute http(s) URLs may feed `<img>/<video poster>`. This blocks
 * `javascript:`, `data:` and `blob:` values that a hostile/BE value could
 * otherwise smuggle into the markup. Local object URLs are created by our own
 * artwork cache and never pass through this helper.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
