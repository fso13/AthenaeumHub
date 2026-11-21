import { useEffect, useId } from 'react';
import type { MusicRoomTrack } from '../../api/types';
import { describeError } from '../../domain/errors';
import { formatBytes, formatDuration, safeHttpUrl } from '../../files/format';
import { t } from '../../i18n/ru';
import { useChatState, useMusicRoomState, useMusicRoomStore } from '../../store/ChatProvider';
import {
  MusicIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
} from '../Icons';

interface MusicRoomPanelProps {
  chatId: string;
  /** Opens the composer file picker (the existing upload flow). */
  onAttachAudio?: () => void;
  /** Navigates to the workspace Files page. */
  onOpenFiles?: () => void;
}

function trackTitle(track: MusicRoomTrack): string {
  return track.title?.trim() || track.filename;
}

function trackArtist(track: MusicRoomTrack): string {
  return track.artist?.trim() || t('music.unknownArtist');
}

function TrackMeta({ track }: { track: MusicRoomTrack }) {
  return (
    <span className="music-track__meta">
      <span>{formatDuration(track.duration_ms)}</span>
      <span aria-hidden="true">·</span>
      <span>{formatBytes(track.size_bytes)}</span>
    </span>
  );
}

function TrackArtwork({ track }: { track: MusicRoomTrack }) {
  const artwork = safeHttpUrl(track.artwork_url);
  if (!artwork) {
    return (
      <span className="music-track__cover music-track__cover--fallback" aria-hidden="true">
        <MusicIcon />
      </span>
    );
  }
  return (
    <img
      className="music-track__cover"
      src={artwork}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
    />
  );
}

/**
 * #94 "Музыкальная комната" chat panel.
 *
 * Reads the metadata-only AUDIO list of a managed channel whose `music-room`
 * plugin is enabled and plays one track locally. When a call is active the
 * store hands the music stream to `CallController.setIncomingMusicStream`, so
 * every call peer hears it through the host's outgoing audio track. There is
 * no server-side bot, player state or SFU: the UI labels exactly what is true.
 */
export function MusicRoomPanel({ chatId, onAttachAudio, onOpenFiles }: MusicRoomPanelProps) {
  const store = useMusicRoomStore();
  const music = useMusicRoomState();
  const state = useChatState();
  const titleId = useId();
  const current = music.chatId === chatId ? music : null;
  const playback = current?.playback;
  const tracks = current?.tracks ?? [];
  const currentTrack = playback?.trackId
    ? (tracks.find((track) => track.id === playback.trackId) ?? null)
    : null;
  const callActive = state.call.phase !== 'idle';
  const playing = playback?.status === 'playing';
  const loadingTrack = playback?.status === 'loading';
  const playerBusy = current?.status === 'loading' || playback?.status === 'loading';

  useEffect(() => {
    if (!chatId) return;
    void store.ensureTracks(chatId);
  }, [chatId, store]);

  let callNotice: { text: string; tone: 'ok' | 'warn' } | null = null;
  if (callActive && playing) {
    callNotice = current?.mixing
      ? { text: t('music.callMix'), tone: 'ok' }
      : { text: t('music.callLocal'), tone: 'warn' };
  } else if (!callActive) {
    callNotice = { text: t('music.localOnly'), tone: 'ok' };
  }

  return (
    <section className="music-room" aria-labelledby={titleId}>
      <div className="music-room__head">
        <h3 className="music-room__title" id={titleId}>
          <MusicIcon aria-hidden="true" />
          {t('music.title')}
        </h3>
        <span className="music-room__dj">{t('music.dj')}</span>
      </div>

      {callNotice ? (
        <p className={`music-room__notice music-room__notice--${callNotice.tone}`} role="status">
          {callNotice.text}
        </p>
      ) : null}

      {playing || loadingTrack ? (
        <div className="music-room__now" aria-live="polite">
          <span className="music-room__now-label">{t('music.playing')}</span>
          <span className="music-room__now-title">
            {currentTrack ? trackTitle(currentTrack) : t('music.noTrack')}
          </span>
          <span className="music-room__now-meta">
            {currentTrack ? trackArtist(currentTrack) : ''}
            {currentTrack ? ' · ' : ''}
            {currentTrack ? formatDuration(currentTrack.duration_ms) : ''}
          </span>
        </div>
      ) : null}

      <div className="music-room__player" role="group" aria-label={t('music.player')}>
        <button
          type="button"
          className="icon-button"
          aria-label={t('music.prev')}
          title={t('music.prev')}
          disabled={tracks.length === 0 || playerBusy}
          onClick={() => void store.previous()}
        >
          <SkipBackIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="music-room__play"
          aria-label={
            playing
              ? t('music.pause')
              : playback?.status === 'paused'
                ? t('music.resume')
                : t('music.play')
          }
          title={playing ? t('music.pause') : t('music.play')}
          disabled={tracks.length === 0 || playerBusy}
          onClick={() => {
            if (currentTrack) void store.playTrack(currentTrack);
            else void store.toggle();
          }}
        >
          {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          <span>
            {playing
              ? t('music.pause')
              : playback?.status === 'paused'
                ? t('music.resume')
                : t('music.play')}
          </span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('music.next')}
          title={t('music.next')}
          disabled={tracks.length === 0 || playerBusy}
          onClick={() => void store.next()}
        >
          <SkipForwardIcon aria-hidden="true" />
        </button>
      </div>

      <label className="music-room__volume">
        <VolumeIcon aria-hidden="true" />
        <span className="visually-hidden">{t('music.volume')}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((playback?.volume ?? 0.8) * 100)}
          aria-label={t('music.volume')}
          onChange={(event) => store.setVolume(Number(event.target.value) / 100)}
        />
      </label>

      {playback?.status === 'error' ? (
        <p className="music-room__error" role="alert">
          {t('music.playError')}
        </p>
      ) : null}

      {current?.status === 'loading' ? (
        <p className="music-room__hint" role="status">
          {t('music.loading')}
        </p>
      ) : null}

      {current?.status === 'error' && current.error ? (
        <div className="music-room__error" role="alert">
          <p>{t('music.errorTitle')}</p>
          <p className="music-room__hint">{describeError(current.error).message}</p>
          <button type="button" className="btn-sm" onClick={() => store.retryTracks()}>
            <RefreshIcon aria-hidden="true" />
            {t('music.retry')}
          </button>
        </div>
      ) : null}

      {current?.status === 'ready' && tracks.length === 0 ? (
        <div className="music-room__empty">
          <MusicIcon aria-hidden="true" />
          <p>{t('music.empty')}</p>
          <p className="music-room__hint">{t('music.emptyHint')}</p>
        </div>
      ) : null}

      {tracks.length > 0 ? (
        <ul className="music-room__tracks" aria-label={t('music.tracks')}>
          {tracks.map((track) => {
            const active = playback?.trackId === track.id;
            return (
              <li key={track.id}>
                <button
                  type="button"
                  className={`music-track${active ? ' is-active' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  aria-label={t('music.playTrack', { title: trackTitle(track) })}
                  onClick={() => void store.playTrack(track)}
                >
                  <TrackArtwork track={track} />
                  <span className="music-track__info">
                    <span className="music-track__title">{trackTitle(track)}</span>
                    <span className="music-track__artist">{trackArtist(track)}</span>
                  </span>
                  <TrackMeta track={track} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {current?.hasMore ? <p className="music-room__hint">{t('music.hasMore')}</p> : null}

      <div className="music-room__actions">
        {onAttachAudio ? (
          <button type="button" className="btn-sm" onClick={onAttachAudio}>
            <MusicIcon aria-hidden="true" />
            {t('music.upload')}
          </button>
        ) : null}
        {onOpenFiles ? (
          <button type="button" className="btn-sm" onClick={onOpenFiles}>
            {t('music.files')}
          </button>
        ) : null}
      </div>
    </section>
  );
}
