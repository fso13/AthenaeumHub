import { useEffect, useState } from 'react';
import type { ApiAttachment, AttachmentMedia } from '../api/types';
import { getLocalArtworkUrl } from '../files/artworkCache';
import { fileTypeLabel, formatBytes, formatDuration, safeHttpUrl } from '../files/format';
import { MAX_MEDIA_GENRE_LENGTH, songDisplay, songTitleOrFilename } from '../files/media';
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
 * Song card: ID3 title/artist/album/year/genre plus artwork and a native
 * player. With no usable tags it degrades to the filename + "unknown artist"
 * + default cover (never invents metadata, never renders tag values as HTML).
 * Artwork comes from a validated http(s) URL or the local-only ID3 cache.
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
  const remoteArtwork = safeHttpUrl(media.artwork_url);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [localArtwork, setLocalArtwork] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLocalArtwork(null);
    // A managed server-provided cover wins; local bytes are the fallback
    // (and the only source while server-side extraction is D1.1).
    if (remoteArtwork && !remoteFailed) return;
    void getLocalArtworkUrl(attachment.id).then((url) => {
      if (active) setLocalArtwork(url);
    });
    return () => {
      active = false;
    };
  }, [attachment.id, remoteArtwork, remoteFailed]);

  const fallbackName = attachment.filename?.trim() || t('song.unknownTitle');
  const title = song
    ? songTitleOrFilename(song, attachment.filename) || t('song.unknownTitle')
    : fallbackName;
  const artist = song?.artist || t('attachments.unknownArtist');
  const album = song?.album ?? null;
  const year = song?.year ?? null;
  const genre = song?.genre ? song.genre.slice(0, MAX_MEDIA_GENRE_LENGTH) : null;
  const artworkSrc = remoteArtwork && !remoteFailed ? remoteArtwork : localArtwork;
  const localOnly = !remoteArtwork && Boolean(localArtwork);
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
              if (remoteArtwork && !remoteFailed) setRemoteFailed(true);
              else setLocalArtwork(null);
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
