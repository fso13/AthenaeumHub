import { describe, expect, it } from 'vitest';
import {
  MAX_VOICE_DURATION_MS,
  clampDuration,
  externalArtworkUrl,
  isServerArtworkUrl,
  mediaKindForFile,
  planUploadMedia,
  sanitizeMediaText,
  sanitizeMediaYear,
  songDisplay,
  songMetaLine,
  songTitleOrFilename,
  usesServerArtwork,
  voiceMediaMetadata,
} from './media';

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function syncsafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function frame(id: string, payload: number[]): number[] {
  return [...asciiBytes(id), ...syncsafe(payload.length), 0, 0, ...payload];
}

function id3File(text: string, extra: number[][] = []): File {
  const body = [frame('TIT2', [3, ...new TextEncoder().encode(text)]), ...extra].flat();
  const bytes = new Uint8Array([...asciiBytes('ID3'), 4, 0, 0, ...syncsafe(body.length), ...body]);
  return new File([bytes], 'song.mp3', { type: 'audio/mpeg' });
}

describe('media kind selection', () => {
  it('maps MIME families and common extensions', () => {
    expect(mediaKindForFile({ type: 'audio/mpeg', name: 'a.bin' })).toBe('AUDIO');
    expect(mediaKindForFile({ type: 'video/mp4', name: 'a.bin' })).toBe('VIDEO');
    expect(mediaKindForFile({ type: 'image/png', name: 'a.bin' })).toBe('IMAGE');
    expect(mediaKindForFile({ type: '', name: 'song.MP3' })).toBe('AUDIO');
    expect(mediaKindForFile({ type: '', name: 'clip.webm' })).toBe('VIDEO');
    expect(mediaKindForFile({ type: 'application/pdf', name: 'doc.pdf' })).toBeNull();
    expect(mediaKindForFile({ type: 'text/plain', name: 'a.txt' })).toBeNull();
  });
});

describe('planUploadMedia', () => {
  it('sends sanitized ID3 metadata and keeps artwork local', async () => {
    const plan = await planUploadMedia(id3File('Song <b>title</b>'));
    expect(plan).not.toBeNull();
    expect(plan?.media).toEqual({
      kind: 'AUDIO',
      metadata_source: 'ID3',
      title: 'Song b title /b',
    });
    expect(plan?.artwork).toBeNull();
  });

  it('falls back to NONE for an MP3 without ID3', async () => {
    const file = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], 'plain.mp3', {
      type: 'audio/mpeg',
    });
    const plan = await planUploadMedia(file);
    expect(plan?.media).toEqual({ kind: 'AUDIO', metadata_source: 'NONE' });
    expect(plan?.artwork).toBeNull();
  });

  it('declares only the kind for video/image and omits media for plain files', async () => {
    expect(
      (await planUploadMedia(new File([new Uint8Array(4)], 'clip.mp4', { type: 'video/mp4' })))
        ?.media,
    ).toEqual({ kind: 'VIDEO', metadata_source: 'NONE' });
    expect(
      (await planUploadMedia(new File([new Uint8Array(4)], 'photo.png', { type: 'image/png' })))
        ?.media,
    ).toEqual({ kind: 'IMAGE', metadata_source: 'NONE' });
    expect(
      await planUploadMedia(new File([new Uint8Array(4)], 'notes.txt', { type: 'text/plain' })),
    ).toBeNull();
  });

  it('never throws for an unreadable file', async () => {
    const broken = new File([new Uint8Array(32)], 'broken.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(broken, 'slice', {
      value: () => {
        throw new Error('disk error');
      },
    });
    await expect(planUploadMedia(broken)).resolves.toEqual({
      media: { kind: 'AUDIO', metadata_source: 'NONE' },
      artwork: null,
    });
  });
});

describe('media sanitizers', () => {
  it('strips HTML/control characters and truncates', () => {
    expect(sanitizeMediaText(' <script>x</script>\u0000 ')).toBe('script x /script');
    expect(sanitizeMediaText('a'.repeat(300))?.length).toBe(255);
    expect(sanitizeMediaText('   ')).toBeUndefined();
  });

  it('keeps only a four-digit year', () => {
    expect(sanitizeMediaYear('2019-05-01')).toBe('2019');
    expect(sanitizeMediaYear('MMXIX')).toBeUndefined();
  });

  it('clamps voice duration into the backend bounds', () => {
    expect(clampDuration(0)).toBe(1);
    expect(clampDuration(1234.6)).toBe(1235);
    expect(clampDuration(MAX_VOICE_DURATION_MS + 1)).toBe(MAX_VOICE_DURATION_MS);
    expect(clampDuration(Number.NaN)).toBe(1);
    expect(voiceMediaMetadata(4321)).toEqual({
      kind: 'AUDIO',
      duration_ms: 4321,
      metadata_source: 'CLIENT',
    });
  });
});

describe('song display', () => {
  it('renders a song card only when text metadata exists', () => {
    expect(
      songDisplay({
        kind: 'AUDIO',
        metadata_source: 'ID3',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        year: '2020',
        genre: 'Rock',
        duration_ms: 215000,
      }),
    ).toMatchObject({ title: 'Song', artist: 'Artist', album: 'Album', year: '2020' });
    expect(songDisplay({ kind: 'AUDIO', metadata_source: 'NONE' })).toBeNull();
    expect(songDisplay({ kind: 'AUDIO', metadata_source: 'CLIENT', duration_ms: 4000 })).toBeNull();
  });

  it('falls back to the filename for a missing title only', () => {
    const song = songDisplay({ kind: 'AUDIO', metadata_source: 'ID3', artist: 'Artist' });
    expect(song).not.toBeNull();
    expect(songTitleOrFilename(song!, 'My Track.mp3')).toBe('My Track');
    expect(songTitleOrFilename(song!, 'My Track.mp3')).not.toBe('Unknown');
  });
});

describe('#97 artwork URL policy', () => {
  const id = 'aa970000-0000-4000-8000-000000000097';
  const serverUrl = `http://localhost:8081/api/v1/attachments/${id}/artwork`;

  it('recognizes the authenticated artwork endpoint only for the same attachment', () => {
    expect(isServerArtworkUrl(id, serverUrl)).toBe(true);
    expect(isServerArtworkUrl(id, `${serverUrl}?token=leak`)).toBe(true);
    expect(isServerArtworkUrl(id, 'https://cdn.example/art/cover.jpg')).toBe(false);
    expect(isServerArtworkUrl(id, 'http://localhost:8081/api/v1/attachments/other/artwork')).toBe(
      false,
    );
    expect(isServerArtworkUrl(id, 'not a url')).toBe(false);
    expect(isServerArtworkUrl('', serverUrl)).toBe(false);
  });

  it('routes SERVER audio to the blob endpoint and keeps public posters direct', () => {
    expect(
      usesServerArtwork(id, {
        kind: 'AUDIO',
        metadata_source: 'SERVER',
        artwork_url: serverUrl,
      }),
    ).toBe(true);
    expect(
      usesServerArtwork(id, {
        kind: 'AUDIO',
        metadata_source: 'SERVER',
        artwork_url: null,
      }),
    ).toBe(true);
    expect(
      usesServerArtwork(id, {
        kind: 'VIDEO',
        metadata_source: 'SERVER',
        artwork_url: 'https://cdn.example/poster.jpg',
      }),
    ).toBe(false);
    expect(
      externalArtworkUrl(id, {
        kind: 'AUDIO',
        metadata_source: 'SERVER',
        artwork_url: serverUrl,
      }),
    ).toBeNull();
    expect(
      externalArtworkUrl(id, {
        kind: 'VIDEO',
        metadata_source: 'SERVER',
        artwork_url: 'https://cdn.example/poster.jpg',
      }),
    ).toBe('https://cdn.example/poster.jpg');
  });

  it('builds a compact song line for the file-center row', () => {
    const song = songDisplay({
      kind: 'AUDIO',
      metadata_source: 'SERVER',
      title: 'Ночной эфир',
      artist: 'Квартет',
      album: 'Полночь',
      year: '2019',
      duration_ms: 245_000,
    });
    expect(songMetaLine(song, 245_000)).toBe('Ночной эфир · Квартет · Полночь · 2019 · 4:05');
    expect(songMetaLine(null, null)).toBe('');
  });
});
