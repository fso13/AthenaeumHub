import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../files/format';
import { t } from '../i18n/ru';
import { PauseIcon, PlayIcon } from './Icons';

export interface VoiceMessageProps {
  /** Kept for the accessible audio label; never rendered as a filename. */
  name: string;
  src: string;
  durationMs: number | null;
  onError: () => void;
  onDuration?: (durationMs: number) => void;
}

const WAVE = [8, 14, 22, 12, 27, 18, 10, 21, 30, 16, 24, 12, 19, 9, 25, 15];

/**
 * Compact voice take matching the dashboard reference: only play, waveform,
 * elapsed/duration and speed. Filename, size, scan status and a separate
 * download action deliberately stay out of this card.
 */
export function VoiceMessage({ name, src, durationMs, onError, onDuration }: VoiceMessageProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [loadedMs, setLoadedMs] = useState<number | null>(durationMs);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = rate;
  }, [rate]);

  const duration = loadedMs ?? durationMs ?? 0;
  const progress = duration > 0 ? Math.min(1, currentMs / duration) : 0;
  const elapsed = formatDuration(playing || currentMs > 0 ? currentMs : duration);
  const label = playing ? t('attachments.pauseVoice') : t('attachments.playVoice');

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setFailed(true);
        onError();
      }
    } else {
      audio.pause();
    }
  };

  return (
    <div className={`voice-message${failed ? ' voice-message--failed' : ''}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        aria-label={t('attachments.voicePlayer', { name })}
        onError={() => {
          setFailed(true);
          onError();
        }}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) {
            const ms = Math.round(value * 1000);
            setLoadedMs(ms);
            onDuration?.(ms);
          }
        }}
        onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentMs(0);
        }}
      />
      <button
        type="button"
        className="voice-message__play"
        onClick={() => void toggle()}
        aria-label={label}
        title={label}
        disabled={failed}
      >
        {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
      </button>
      <span className="voice-message__wave" aria-hidden="true">
        {WAVE.map((height, index) => (
          <span
            key={index}
            className={`voice-message__bar${index / WAVE.length <= progress ? ' is-played' : ''}`}
            style={{ height: `${height}px` }}
          />
        ))}
      </span>
      <span
        className="voice-message__time"
        aria-label={t('attachments.voiceTime', { time: elapsed })}
      >
        {elapsed}
      </span>
      <button
        type="button"
        className="voice-message__rate"
        onClick={() => setRate((value) => (value === 1 ? 1.5 : value === 1.5 ? 2 : 1))}
        aria-label={t('attachments.voiceRate', { rate })}
        title={t('attachments.voiceRate', { rate })}
      >
        {rate === 1 ? '1x' : `${rate}x`}
      </button>
      {failed ? (
        <span className="voice-message__error">{t('attachments.voiceUnavailable')}</span>
      ) : null}
    </div>
  );
}
