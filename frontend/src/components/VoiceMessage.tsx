import { formatDuration } from '../files/format';
import { t } from '../i18n/ru';
import { AudioAttachment } from './AudioAttachment';

export interface VoiceMessageProps {
  name: string;
  src: string;
  durationMs: number | null;
  onError: () => void;
  onDuration?: (durationMs: number) => void;
}

/**
 * Voice take presentation: a compact waveform strip, the recorded duration
 * and the native player. The duration is the value measured at record time
 * (or the media metadata), not an estimate.
 */
export function VoiceMessage({ name, src, durationMs, onError, onDuration }: VoiceMessageProps) {
  const duration = formatDuration(durationMs);
  return (
    <div className="voice-message">
      <div className="voice-message__head">
        <span className="voice-message__badge">{t('attachments.voiceMessage')}</span>
        <span className="voice-message__duration" title={t('attachments.durationShort')}>
          {duration}
        </span>
      </div>
      <div className="voice-message__wave" aria-hidden="true">
        {[10, 18, 26, 14, 30, 22, 12, 24, 16, 28, 20, 14].map((height, index) => (
          <span key={index} className="voice-message__bar" style={{ height: `${height}px` }} />
        ))}
      </div>
      <AudioAttachment name={name} src={src} voice onError={onError} onDuration={onDuration} />
    </div>
  );
}
