import { useEffect, useState } from 'react';
import type { ApiAttachment, AttachmentMedia } from '../api/types';
import { fileTypeLabel, formatBytes, formatDuration } from '../files/format';
import {
  MAX_MEDIA_GENRE_LENGTH,
  songDisplay,
  songTitleOrFilename,
  usesServerArtwork,
} from '../files/media';
import { useArtwork, useLocalArtworkFallback } from '../hooks/useArtwork';
import { t } from '../i18n/ru';
import { MusicIcon } from './Icons';

export interface SongCardProps {
  attachment: ApiAttachment;
  media: AttachmentMedia;
  /** Presigned URL of the audio; `null` until the download link resolves. */
  src: string | null;
  durationMs: number | null;
  onError: () => void;
  onDuration?: (durationMs: number) => void;
}

/**
 * Song card: server/ID3 title, artist, album, year and genre plus artwork and
 * a native player. With no usable tags it degrades to the filename + "unknown
 * artist" + default cover (never invents metadata, never renders tag values as
 * HTML).
 *
 * Artwork priority (#97): the server cover is fetched as an authenticated blob
 * (its `artwork_url` is an authenticated endpoint, so `<img src=artwork_url>`
 * would be a `401`); a client-supplied public URL renders directly; the local
 * ID3 cache is the fallback; then the default `MusicIcon`.
 */
export function SongCard({
  attachment,
  media,
  src,
  durationMs,
  onError,
  onDuration,
}: SongCardProps) {
  const song = songDisplay(media);
  const artwork = useArtwork(attachment.id, media);
  const serverArtwork = usesServerArtwork(attachment.id, media);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [localFailed, setLocalFailed] = useState(false);
  // Only look for local bytes once the server/external cover is not pending
  // and did not resolve (or was rejected by the browser): the server cover
  // always wins while it is available.
  const localArtwork = useLocalArtworkFallback(
    attachment.id,
    remoteFailed ||
      artwork.status === 'empty' ||
      (!serverArtwork && artwork.status !== 'loading' && artwork.url === null),
  );

  useEffect(() => {
    setRemoteFailed(false);
  }, [artwork.url]);

  useEffect(() => {
    setLocalFailed(false);
  }, [localArtwork]);

  const fallbackName = attachment.filename?.trim() || t('song.unknownTitle');
  const title = song
    ? songTitleOrFilename(song, attachment.filename) || t('song.unknownTitle')
    : fallbackName;
  const artist = song?.artist || t('attachments.unknownArtist');
  const album = song?.album ?? null;
  const year = song?.year ?? null;
  const genre = song?.genre ? song.genre.slice(0, MAX_MEDIA_GENRE_LENGTH) : null;
  const remoteArtwork = artwork.url && !remoteFailed ? artwork.url : null;
  const localOnly = remoteArtwork === null && localArtwork !== null && !localFailed;
  const artworkSrc = remoteArtwork ?? (localFailed ? null : localArtwork);
  const totalDuration = durationMs ?? song?.durationMs ?? null;

  return (
    <div className="song-card">
      <div
        className="song-card__artwork"
        title={localOnly ? t('attachments.metadataLocalOnly') : undefined}
      >
        {artworkSrc ? (
          <img
            className="song-card__cover"
            src={artworkSrc}
            alt={t('attachments.artworkAlt', { title })}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => {
              if (remoteArtwork) setRemoteFailed(true);
              else setLocalFailed(true);
            }}
          />
        ) : (
          <span className="song-card__cover song-card__cover--fallback" aria-hidden="true">
            <MusicIcon />
          </span>
        )}
      </div>

      <div className="song-card__body">
        <span className="song-card__title" title={attachment.filename ?? undefined}>
          {title}
        </span>
        <span className="song-card__artist">{artist}</span>
        <span className="song-card__meta">
          {song
            ? `${album ?? t('attachments.unknownAlbum')}${year ? ` · ${year}` : ''}${
                genre ? ` · ${genre}` : ''
              }`
            : `${fileTypeLabel(attachment.mime_type, attachment.filename)} · ${formatBytes(
                attachment.size_bytes,
              )}`}
        </span>
      </div>
      <span className="song-card__duration">{formatDuration(totalDuration)}</span>

      {src ? (
        <audio
          className="song-card__audio"
          src={src}
          controls
          preload="metadata"
          aria-label={
            song
              ? t('attachments.songPlayer', { title })
              : t('attachments.audioPlayer', { name: fallbackName })
          }
          onError={onError}
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) {
              onDuration?.(Math.round(value * 1000));
            }
          }}
        />
      ) : null}
    </div>
  );
}
