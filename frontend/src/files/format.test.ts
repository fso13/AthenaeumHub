import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  fileTypeLabel,
  formatBytes,
  formatDuration,
  formatPercent,
  isAudioMime,
  isPdfMime,
  isSafePreviewImage,
  isSupportedAudioMime,
  isSupportedVideoMime,
  isVideoMime,
  safeHttpUrl,
} from './format';

describe('file formatting', () => {
  it('formats bytes with binary units', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(1023)).toBe('1023 Б');
    expect(formatBytes(1024)).toBe('1 КБ');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 МБ');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1,5 ГБ');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('formats usage percent', () => {
    expect(formatPercent(0)).toBe('0 %');
    expect(formatPercent(0.804)).toBe('80 %');
    expect(formatPercent(2)).toBe('100 %');
  });

  it('labels known MIME types and falls back to the extension', () => {
    expect(fileTypeLabel('image/png')).toBe('Изображение');
    expect(fileTypeLabel('video/mp4')).toBe('Видео');
    expect(fileTypeLabel('application/pdf')).toBe('PDF');
    expect(fileTypeLabel('application/octet-stream', 'report.ZIP')).toBe('ZIP');
    expect(fileTypeLabel(null, 'brief')).toBe('BRIEF');
    expect(fileTypeLabel(null, 'a.verylongextension')).toBe('Файл');
  });

  it('never treats SVG as a renderable preview image', () => {
    expect(isSafePreviewImage('image/png')).toBe(true);
    expect(isSafePreviewImage('image/jpeg')).toBe(true);
    expect(isSafePreviewImage('image/webp')).toBe(true);
    expect(isSafePreviewImage('image/gif')).toBe(true);
    expect(isSafePreviewImage('image/svg+xml')).toBe(false);
    expect(isSafePreviewImage('image/svg+xml; charset=utf-8')).toBe(false);
    expect(isSafePreviewImage('image/svg')).toBe(false);
    expect(isSafePreviewImage('text/html')).toBe(false);
    expect(isSafePreviewImage('application/pdf')).toBe(false);
  });

  it('recognises PDF/video links and extensions', () => {
    expect(isPdfMime('application/pdf')).toBe(true);
    expect(isPdfMime('application/pdf; charset=binary')).toBe(true);
    expect(isVideoMime('video/webm')).toBe(true);
    expect(isVideoMime('audio/mpeg')).toBe(false);
    expect(extensionOf('atlas.brief.PDF')).toBe('pdf');
    expect(extensionOf('README')).toBe('');
  });

  it('allows inline playback only for the media allowlists', () => {
    expect(isSupportedVideoMime('video/mp4')).toBe(true);
    expect(isSupportedVideoMime('video/webm')).toBe(true);
    expect(isSupportedVideoMime('video/mp4; codecs="avc1"')).toBe(true);
    expect(isSupportedVideoMime('video/quicktime')).toBe(false);
    expect(isSupportedVideoMime('text/html')).toBe(false);

    expect(isAudioMime('audio/mpeg')).toBe(true);
    expect(isSupportedAudioMime('audio/mpeg')).toBe(true);
    expect(isSupportedAudioMime('audio/ogg')).toBe(true);
    expect(isSupportedAudioMime('audio/wav')).toBe(true);
    expect(isSupportedAudioMime('audio/svg+xml')).toBe(false);
    expect(isSupportedAudioMime('video/mp4')).toBe(false);
  });
});

describe('media formatting helpers', () => {
  it('formats durations for voice and song cards', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(999)).toBe('0:00');
    expect(formatDuration(7_000)).toBe('0:07');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });

  it('accepts only absolute http(s) URLs for remote artwork/posters', () => {
    expect(safeHttpUrl('https://cdn.example/cover.jpg')).toBe('https://cdn.example/cover.jpg');
    expect(safeHttpUrl('http://cdn.example/cover.jpg')).toBe('http://cdn.example/cover.jpg');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:image/svg+xml,<svg/>')).toBeNull();
    expect(safeHttpUrl('blob:http://localhost/x')).toBeNull();
    expect(safeHttpUrl('/relative.jpg')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
  });
});
