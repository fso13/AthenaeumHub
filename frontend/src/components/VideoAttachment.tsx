import { t } from '../i18n/ru';
import { ExpandIcon } from './Icons';

export interface VideoAttachmentProps {
  name: string;
  src: string;
  /** Only an absolutely validated http(s) URL or a local object URL. */
  poster: string | null;
  onError: () => void;
  onDuration?: (durationMs: number) => void;
  /** Opens the same file in the full-screen lightbox player. */
  onExpand?: () => void;
}

/**
 * Inline `<video>` for the allowlisted MP4/WebM/OGG types. No autoplay: the
 * browser never fetches or plays the file before the user presses play.
 * A small expand control opens the lightbox player, matching the image
 * thumbnail → full-screen flow.
 */
export function VideoAttachment({
  name,
  src,
  poster,
  onError,
  onDuration,
  onExpand,
}: VideoAttachmentProps) {
  return (
    <div className="attachment-card__player">
      <video
        className="attachment-card__video"
        src={src}
        poster={poster ?? undefined}
        controls
        preload="metadata"
        playsInline
        aria-label={t('attachments.videoPlayer', { name })}
        onError={onError}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) {
            onDuration?.(Math.round(duration * 1000));
          }
        }}
      />
      {onExpand ? (
        <button
          type="button"
          className="attachment-card__expand"
          onClick={onExpand}
          aria-label={t('attachments.openFullscreen', { name })}
          title={t('attachments.openFullscreen', { name })}
        >
          <ExpandIcon aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
