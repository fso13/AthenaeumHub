import { useCallback, useEffect, useState } from 'react';
import type { ApiAttachment, AttachmentScanStatus } from '../api/types';
import { toApiError, type ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import {
  fileTypeLabel,
  formatBytes,
  formatDuration,
  isPdfMime,
  isSafePreviewImage,
  isSupportedAudioMime,
  isSupportedVideoMime,
  isVideoMime,
  safeHttpUrl,
} from '../files/format';
import { isVoiceMedia, songDisplay } from '../files/media';
import { t, type MessageKey } from '../i18n/ru';
import { useFilesStore } from '../store/ChatProvider';
import { AudioAttachment } from './AudioAttachment';
import { ErrorDetails } from './ErrorDetails';
import { AlertIcon, DownloadIcon, FileIcon } from './Icons';
import { MediaLightbox } from './MediaLightbox';
import { SongCard } from './SongCard';
import { VideoAttachment } from './VideoAttachment';
import { VoiceMessage } from './VoiceMessage';

const SCAN_LABEL: Record<AttachmentScanStatus, MessageKey> = {
  PENDING: 'files.scanStatus.PENDING',
  CLEAN: 'files.scanStatus.CLEAN',
  INFECTED: 'files.scanStatus.INFECTED',
  FAILED: 'files.scanStatus.FAILED',
  SKIPPED: 'files.scanStatus.SKIPPED',
};

function scanKey(status: AttachmentScanStatus): MessageKey {
  return SCAN_LABEL[status] ?? 'files.scanStatus.SKIPPED';
}

function scanNoteKey(status: AttachmentScanStatus): MessageKey | null {
  switch (status) {
    case 'PENDING':
      return 'attachments.scanPending';
    case 'INFECTED':
      return 'attachments.quarantinedBlocked';
    case 'FAILED':
      return 'attachments.previewScanFailed';
    case 'SKIPPED':
      return 'attachments.previewScanSkipped';
    default:
      return null;
  }
}

function openExternal(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  // SYSTEM-ANALYSIS §11.6: noopener/noreferrer for every external link.
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function AttachmentList({
  attachments,
  outgoing = false,
}: {
  attachments: readonly ApiAttachment[];
  outgoing?: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className={`attachments${outgoing ? ' attachments--outgoing' : ''}`}>
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentCard attachment={attachment} outgoing={outgoing} />
        </li>
      ))}
    </ul>
  );
}

export function AttachmentCard({
  attachment,
  outgoing = false,
}: {
  attachment: ApiAttachment;
  outgoing?: boolean;
}) {
  const files = useFilesStore();
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<ApiError | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [elementDurationMs, setElementDurationMs] = useState<number | null>(null);

  const name = attachment.filename?.trim() || t('attachments.attachmentOnly');
  const media = attachment.media ?? null;
  const image = isSafePreviewImage(attachment.mime_type);
  const video = isSupportedVideoMime(attachment.mime_type);
  const audio = isSupportedAudioMime(attachment.mime_type);
  const inlineMedia = image || video || audio;
  const pdf = isPdfMime(attachment.mime_type);
  const isClean = attachment.scan_status === 'CLEAN';
  // PENDING/INFECTED never get a URL, a player or a download attempt.
  const scanBlocked = attachment.scan_status === 'PENDING' || attachment.scan_status === 'INFECTED';
  const scanLabel = t(scanKey(attachment.scan_status));
  const scanNote = scanNoteKey(attachment.scan_status);
  const blockedReason =
    attachment.scan_status === 'INFECTED'
      ? t('attachments.quarantinedBlocked')
      : t('attachments.scanPending');

  // D1-FE2: media metadata only decorates an already-allowed attachment.
  const song = audio ? songDisplay(media) : null;
  const voiceVariant = audio && isVoiceMedia(media, attachment.filename);
  // An untagged MP3 (metadata_source NONE) still gets the song-card fallback
  // (filename + unknown artist + default cover); legacy attachments without
  // any `media` keep the original audio card unchanged.
  const songVariant =
    audio &&
    media?.kind === 'AUDIO' &&
    !voiceVariant &&
    (song !== null || media.metadata_source === 'NONE');
  const poster = video ? safeHttpUrl(media?.artwork_url) : null;
  const durationMs = elementDurationMs ?? media?.duration_ms ?? null;
  const dimensions =
    media?.width && media?.height
      ? t('attachments.dimensions', { width: media.width, height: media.height })
      : null;
  const showDuration = (audio || video) && durationMs !== null && durationMs > 0;
  const durationLabel = showDuration ? formatDuration(durationMs) : null;

  const closeLightbox = useCallback(() => setLightboxOpen(false), []);
  const showPlayer = (video || audio) && Boolean(mediaUrl) && !mediaFailed;
  const onPlayerDuration = useCallback((value: number) => setElementDurationMs(value), []);

  useEffect(() => {
    let active = true;
    setMediaUrl(null);
    setMediaError(null);
    setMediaFailed(false);
    setMediaLoading(false);
    // Presigned URLs are requested strictly for CLEAN attachments.
    if (!inlineMedia || !isClean) return;

    setMediaLoading(true);
    void files
      .getDownloadUrl(attachment.id)
      .then((download) => {
        if (!active) return;
        setMediaUrl(download.url);
        setMediaLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMediaError(toApiError(error));
        setMediaLoading(false);
      });

    return () => {
      active = false;
    };
  }, [files, attachment.id, inlineMedia, isClean, reloadKey]);

  const retryMedia = useCallback(() => {
    // A stale/expired link must not be served from the store cache.
    files.invalidateDownloadUrl(attachment.id);
    setMediaUrl(null);
    setMediaError(null);
    setMediaFailed(false);
    setReloadKey((key) => key + 1);
  }, [files, attachment.id]);

  const handleDownload = async () => {
    if (scanBlocked) return;
    setBusy(true);
    setDownloadError(null);
    try {
      const download = await files.getDownloadUrl(attachment.id);
      openExternal(download.url);
    } catch (error) {
      setDownloadError(toApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const describedDownload = downloadError ? describeError(downloadError) : null;
  const describedMedia = mediaError ? describeError(mediaError) : null;
  const mediaBroken = Boolean(mediaError) || mediaFailed;
  // A 423/410 preview will not heal on retry; keep only the download fallback.
  const canRetryMedia = describedMedia
    ? describedMedia.retryable || describedMedia.status === 409
    : true;
  const downloadLabel =
    pdf || isVideoMime(attachment.mime_type) ? t('attachments.open') : t('attachments.download');
  const cardClass = `attachment-card${outgoing ? ' attachment-card--outgoing' : ''}${
    showPlayer ? ' attachment-card--player' : ''
  }${songVariant ? ' attachment-card--song' : ''}${voiceVariant ? ' attachment-card--voice' : ''}${
    scanBlocked ? ' attachment-card--blocked' : ''
  }`;

  const songCard =
    songVariant && media ? (
      <SongCard
        attachment={attachment}
        media={media}
        src={mediaFailed ? null : mediaUrl}
        durationMs={durationMs}
        onError={() => setMediaFailed(true)}
        onDuration={onPlayerDuration}
      />
    ) : null;

  const genericBody = (
    <div className="attachment-card__body">
      <span className="attachment-card__name" title={name}>
        {name}
      </span>
      <span className="attachment-card__meta">
        {fileTypeLabel(attachment.mime_type, attachment.filename)} ·{' '}
        {formatBytes(attachment.size_bytes)}
        {durationLabel ? ` · ${durationLabel}` : ''}
        {dimensions ? ` · ${dimensions}` : ''}
      </span>
      <span
        className={`scan-badge scan-badge--${attachment.scan_status.toLowerCase()}`}
        title={scanLabel}
      >
        {scanLabel}
      </span>
    </div>
  );

  return (
    <div className={cardClass}>
      {image ? (
        <div className="attachment-card__media attachment-card__media--image">
          {mediaUrl && !mediaFailed ? (
            <button
              type="button"
              className="attachment-card__image-button"
              onClick={() => setLightboxOpen(true)}
              aria-label={t('attachments.openPreview', { name })}
              title={t('attachments.openPreview', { name })}
            >
              <img
                className="attachment-card__image"
                src={mediaUrl}
                alt={t('attachments.imageAlt', { name })}
                width={media?.width ?? undefined}
                height={media?.height ?? undefined}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setMediaFailed(true)}
              />
            </button>
          ) : (
            <span className="attachment-card__icon" aria-hidden="true">
              <FileIcon />
            </span>
          )}
        </div>
      ) : null}

      {songCard}

      {!image && !songVariant && !showPlayer ? (
        <div className="attachment-card__media">
          <span className="attachment-card__icon" aria-hidden="true">
            <FileIcon />
          </span>
        </div>
      ) : null}

      {video && showPlayer ? (
        <VideoAttachment
          name={name}
          src={mediaUrl!}
          poster={poster}
          onError={() => setMediaFailed(true)}
          onDuration={onPlayerDuration}
        />
      ) : null}

      {voiceVariant && showPlayer ? (
        <VoiceMessage
          name={name}
          src={mediaUrl!}
          durationMs={media?.duration_ms ?? elementDurationMs}
          onError={() => setMediaFailed(true)}
          onDuration={onPlayerDuration}
        />
      ) : null}

      {audio && !songVariant && !voiceVariant && showPlayer ? (
        <AudioAttachment
          name={name}
          src={mediaUrl!}
          onError={() => setMediaFailed(true)}
          onDuration={onPlayerDuration}
        />
      ) : null}

      {songVariant || voiceVariant ? null : genericBody}

      {voiceVariant ? null : (
        <div className="attachment-card__actions">
          <button
            type="button"
            className="button button--small"
            onClick={() => void handleDownload()}
            disabled={busy || scanBlocked}
            aria-busy={busy}
            title={scanBlocked ? blockedReason : t('attachments.linkTtl')}
          >
            {busy ? (
              <span className="spinner" aria-hidden="true" />
            ) : attachment.scan_status === 'INFECTED' ? (
              <AlertIcon aria-hidden="true" />
            ) : (
              <DownloadIcon aria-hidden="true" />
            )}
            {busy ? t('attachments.loading') : downloadLabel}
          </button>
          <span className="attachment-card__ttl">
            {scanBlocked ? t('attachments.downloadBlocked') : t('attachments.linkTtl')}
          </span>
        </div>
      )}

      {!voiceVariant && mediaLoading && inlineMedia && isClean ? (
        <p className="attachment-card__note" role="status">
          {t('attachments.loading')}
        </p>
      ) : null}

      {!voiceVariant && mediaBroken && inlineMedia && isClean ? (
        <div className="attachment-card__error" role="alert">
          <p>{describedMedia?.message ?? t('attachments.mediaError')}</p>
          <div className="attachment-card__error-actions">
            {canRetryMedia ? (
              <button type="button" className="button button--small" onClick={retryMedia}>
                {t('attachments.retryPreview')}
              </button>
            ) : null}
            <button
              type="button"
              className="button button--small"
              onClick={() => void handleDownload()}
              disabled={busy}
            >
              {t('attachments.downloadFile')}
            </button>
          </div>
          {describedMedia ? <ErrorDetails error={mediaError} /> : null}
        </div>
      ) : null}

      {describedDownload && downloadError ? (
        <div className="attachment-card__error" role="alert">
          <p>{describedDownload.message}</p>
          <ErrorDetails error={downloadError} />
        </div>
      ) : null}

      {scanNote ? (
        <p className="attachment-card__note" role="status">
          {t(scanNote)}
        </p>
      ) : null}

      {image ? (
        <MediaLightbox
          open={lightboxOpen && Boolean(mediaUrl)}
          src={mediaUrl}
          name={name}
          onClose={closeLightbox}
          onDownload={() => void handleDownload()}
          onImageError={() => {
            setLightboxOpen(false);
            setMediaFailed(true);
          }}
          busy={busy}
          downloadError={downloadError}
        />
      ) : null}
    </div>
  );
}
