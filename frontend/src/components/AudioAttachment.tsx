import { t } from '../i18n/ru';

export interface AudioAttachmentProps {
  name: string;
  src: string;
  voice?: boolean;
  onError: () => void;
  onDuration?: (durationMs: number) => void;
}

/**
 * Native audio player for a non-song audio attachment (or an MP3 without
 * usable ID3 tags). `preload="metadata"` keeps the presigned URL lazy;
 * playback only starts on a user action.
 */
export function AudioAttachment({
  name,
  src,
  voice = false,
  onError,
  onDuration,
}: AudioAttachmentProps) {
  return (
    <div className={`attachment-card__player${voice ? ' attachment-card__player--voice' : ''}`}>
      <audio
        className="attachment-card__audio"
        src={src}
        controls
        preload="metadata"
        aria-label={
          voice ? t('attachments.voicePlayer', { name }) : t('attachments.audioPlayer', { name })
        }
        onError={onError}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) {
            onDuration?.(Math.round(duration * 1000));
          }
        }}
      />
    </div>
  );
}
