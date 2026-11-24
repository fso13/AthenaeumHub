import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  applyMediaOutput,
  canSelectAudioOutput,
  chooseAudioOutputDevice,
} from '../calls/mediaOutput';
import type { CallErrorCode, CallParticipant, CallState } from '../calls/types';
import { chatDisplayName } from '../domain/chatLabel';
import { formatDuration } from '../files/format';
import { useMicLevel } from '../hooks/useMicLevel';
import { t, type MessageKey } from '../i18n/ru';
import { readCallOutputVolume, writeCallOutputVolume } from '../prefs/devicePreferences';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { Avatar } from './Avatar';
import {
  CloseIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  VideoIcon,
  VideoOffIcon,
  ExpandIcon,
  MonitorIcon,
  MinimizeIcon,
  SettingsIcon,
} from './Icons';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const ERROR_KEYS: Record<CallErrorCode, MessageKey> = {
  permission_denied: 'calls.error.permissionDenied',
  device_unavailable: 'calls.error.deviceUnavailable',
  insecure_context: 'calls.error.insecureContext',
  unsupported: 'calls.error.unsupported',
  connection_failed: 'calls.error.connectionFailed',
  signaling_failed: 'calls.error.signalingFailed',
  payload_too_large: 'calls.error.payloadTooLarge',
  call_not_supported: 'calls.error.callNotSupported',
  peer_offline: 'calls.error.peerOffline',
  busy: 'calls.error.busy',
  declined: 'calls.error.declined',
  cancelled: 'calls.error.cancelled',
  ended: 'calls.error.ended',
};

function statusLabel(call: CallState): string {
  if (call.phase === 'incoming') {
    if (call.conference) return t('calls.groupIncoming');
    return call.video ? t('calls.incomingVideo') : t('calls.incoming');
  }
  if (call.phase === 'outgoing') {
    if (call.mediaPending) {
      return call.video ? t('calls.requestingMediaVideo') : t('calls.requestingMedia');
    }
    return t('calls.calling');
  }
  if (call.phase === 'connecting') {
    if (call.mediaPending) {
      return call.video ? t('calls.requestingMediaVideo') : t('calls.requestingMedia');
    }
    return t('calls.connecting');
  }
  if (call.phase === 'connected') return t('calls.connected');
  return '';
}

/**
 * One remote (or local) tile in a GROUP video/avatar grid. The video element is
 * hidden until the stream actually carries video, so audio-only conferences
 * show initials instead of a black rectangle.
 */
function ConferenceTile({
  participant,
  name,
  video,
  stream,
  local = false,
  cameraOn = true,
  ringing = false,
  featured = false,
  outputVolume,
  outputMuted,
  outputDeviceId,
  onOutputError,
}: {
  participant?: CallParticipant;
  name: string;
  video: boolean;
  stream: MediaStream | null;
  local?: boolean;
  cameraOn?: boolean;
  ringing?: boolean;
  featured?: boolean;
  outputVolume: number;
  outputMuted: boolean;
  outputDeviceId: string | null;
  onOutputError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(video && stream && stream.getVideoTracks().length > 0);
  const showVideo = local ? hasVideo && cameraOn : hasVideo;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  // #107: every remote tile is a real media element even for audio-only calls,
  // so the speaker is audible while the tile keeps showing the avatar.
  useEffect(() => {
    if (local) return;
    let active = true;
    void applyMediaOutput(videoRef.current, {
      volume: outputVolume,
      muted: outputMuted,
      deviceId: outputDeviceId,
    }).then((ok) => {
      if (!ok && active) onOutputError?.();
    });
    return () => {
      active = false;
    };
  }, [local, onOutputError, outputDeviceId, outputMuted, outputVolume, stream]);

  const state = participant?.connectionState;
  const showConnecting =
    !local && !ringing && state !== undefined && state !== 'connected' && state !== 'failed';
  const showFailed = !local && state === 'failed';

  return (
    <div
      className={`call-tile${showVideo ? ' is-video' : ''}${local ? ' call-tile--local' : ''}${featured ? ' call-tile--featured' : ''}`}
    >
      {video || !local ? (
        <video
          ref={videoRef}
          className="call-tile__video"
          autoPlay
          playsInline
          muted={local ? true : outputMuted}
          aria-hidden={!local && !video ? true : undefined}
          aria-label={
            local
              ? t('calls.localPreview')
              : video
                ? t('calls.groupVideoAnnounce', { name })
                : undefined
          }
        />
      ) : null}
      <div className="call-tile__identity">
        <Avatar name={name} seed={participant?.userId ?? name} size="profile" />
      </div>
      <div className="call-tile__meta">
        <span className="call-tile__name">{name}</span>
        {showFailed ? (
          <span className="call-tile__state call-tile__state--error">
            {t('calls.participantFailed')}
          </span>
        ) : showConnecting ? (
          <span className="call-tile__state">{t('calls.connectingPeer')}</span>
        ) : null}
      </div>
      {local && video && !cameraOn ? (
        <span className="call-tile__camera-off">{t('calls.audioOnly')}</span>
      ) : null}
    </div>
  );
}

/**
 * Lightweight active-speaker detector for the minimized call tile. It samples
 * the remote audio tracks with a short analyser window; no audio is recorded or
 * sent anywhere. If the browser cannot create an AudioContext, the UI falls
 * back to the participant with an enabled camera.
 */
function useActiveSpeaker(participants: CallParticipant[], active: boolean): string | null {
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const signature = participants
    .map((participant) => `${participant.userId}:${participant.stream?.id ?? ''}`)
    .join('|');
  useEffect(() => {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!active || !Context) {
      setSpeakerId(null);
      return;
    }
    let context: AudioContext;
    try {
      context = new Context();
    } catch {
      setSpeakerId(null);
      return;
    }
    const analysers: { userId: string; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }[] =
      [];
    for (const participant of participants) {
      if (!participant.stream || participant.stream.getAudioTracks().length === 0) continue;
      try {
        const source = context.createMediaStreamSource(participant.stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analysers.push({
          userId: participant.userId,
          analyser,
          data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        });
      } catch {
        // A peer stream can disappear between snapshots; ignore that leg.
      }
    }
    void context.resume().catch(() => undefined);
    const timer = window.setInterval(() => {
      let bestId: string | null = null;
      let bestLevel = 0.02;
      for (const item of analysers) {
        item.analyser.getByteTimeDomainData(item.data);
        let sum = 0;
        for (const value of item.data) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const level = Math.sqrt(sum / item.data.length);
        if (level > bestLevel) {
          bestLevel = level;
          bestId = item.userId;
        }
      }
      setSpeakerId(bestId);
    }, 250);
    return () => {
      window.clearInterval(timer);
      void context.close().catch(() => undefined);
      setSpeakerId(null);
    };
    // The signature keeps the effect stable while connection states change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, signature]);
  return speakerId;
}

/** Square speaker tile in the minimized call bar (#181). */
function MiniCallTile({
  name,
  seed,
  stream,
  cameraOn,
}: {
  name: string;
  seed: string;
  stream: MediaStream | null;
  cameraOn: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(stream && stream.getVideoTracks().some((track) => track.enabled));
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="call-mini__tile" aria-label={name}>
      {hasVideo && cameraOn ? (
        <video ref={ref} className="call-mini__video" autoPlay muted playsInline />
      ) : (
        <>
          <Avatar name={name} seed={seed} size="sm" />
          <span className="call-mini__person" title={name}>
            {name}
          </span>
        </>
      )}
    </div>
  );
}

function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="call-timer" aria-hidden="true">
      {formatDuration(Math.max(0, now - startedAt))}
    </span>
  );
}

/**
 * §9 call layer.
 *
 * Mounted once in the app shell, so an incoming call is visible while the user
 * is reading another chat. It renders:
 *  - a ringing incoming dialog (focus trap, initial focus on "Принять");
 *  - an outgoing/connecting/connected overlay with mute/camera/hangup;
 *  - a dismissible notice for permission, device and signalling failures.
 *
 * Escape never drops a live call silently: it opens an explicit confirmation.
 * For a ringing call Escape declines (no media exists yet).
 */
export function CallLayer() {
  const store = useChatStore();
  const state = useChatState();
  const call = state.call;
  const active = call.phase !== 'idle';
  const dialogRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const hangupRef = useRef<HTMLButtonElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [windowOffset, setWindowOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [featuredUserId, setFeaturedUserId] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');
  const [controlError, setControlError] = useState<MessageKey | null>(null);
  const [outputVolume, setOutputVolume] = useState(readCallOutputVolume);
  const [outputMuted, setOutputMuted] = useState(false);
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null);
  const [outputDeviceLabel, setOutputDeviceLabel] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<MessageKey | null>(null);
  const [micTest, setMicTest] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const canChooseOutput = canSelectAudioOutput();
  const micLevel = useMicLevel(call.localStream, call.phase === 'connected' && micTest, call.muted);
  const reportOutputError = useCallback(() => {
    setOutputError('calls.outputDeviceError');
  }, []);

  const chat = call.chatId ? (state.chats.find((item) => item.id === call.chatId) ?? null) : null;
  const peer = call.peerUserId
    ? (state.workspaceMembers.items.find((item) => item.user_id === call.peerUserId) ?? null)
    : null;
  const peerName = chat
    ? chatDisplayName(chat, state.workspaceMembers.items)
    : (peer?.display_name ?? t('calls.peerFallback'));
  const hasRemoteVideo = Boolean(
    call.remoteStream && call.remoteStream.getVideoTracks().length > 0,
  );
  const hasLocalVideo = Boolean(call.localStream && call.localStream.getVideoTracks().length > 0);
  const conference = call.conference;
  const incoming = call.phase === 'incoming';
  const connected = call.phase === 'connected';
  // Only a ringing incoming call owns the screen. Outgoing, connecting and
  // connected calls are non-modal so the app remains usable.
  // A call is a modal, resizable window (latest UX decision).
  const floating = false;
  const activeSpeakerId = useActiveSpeaker(call.participants, connected);
  const participantName = (userId: string): string =>
    state.workspaceMembers.items.find((item) => item.user_id === userId)?.display_name ??
    t('calls.participantFallback');
  const conferenceNames = call.participants.map((item) => participantName(item.userId));
  const infoTitle = conference ? t('calls.groupCall') : peerName;
  const totalParticipants = conference ? call.participants.length + (incoming ? 0 : 1) : 1;
  const gridSize = Math.min(3, Math.max(1, call.participants.length));
  const announceName = conference ? conferenceNames.join(', ') || t('calls.groupCall') : peerName;

  // Reset the confirmation whenever the call goes away. Output mute and the
  // optional mic test are session-local; the volume itself is persisted.
  useEffect(() => {
    if (active) return;
    setConfirmEnd(false);
    setCollapsed(false);
    setWindowOffset({ x: 0, y: 0 });
    setFeaturedUserId(null);
    setMaximized(false);
    setSettingsOpen(false);
    setControlError(null);
    setOutputMuted(false);
    setMicTest(false);
    setOutputError(null);
  }, [active]);

  // The call surface owns the viewport (full-screen on mobile): no background
  // scrolling while ringing or connected.
  useEffect(() => {
    // A minimized call is non-modal; the expanded call owns the viewport.
    if (!active || collapsed) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [active, collapsed]);

  // Focus trap + Escape for the whole call dialog. `call.phase` is deliberately
  // read through a ref so a phase transition does not steal focus mid-typing.
  const liveRef = useRef({ phase: call.phase, confirmEnd });
  liveRef.current = { phase: call.phase, confirmEnd };
  useEffect(() => {
    if (!active || collapsed) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      if (liveRef.current.phase === 'incoming') acceptRef.current?.focus();
      else dialogRef.current?.focus();
    }, 0);

    const handleKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (liveRef.current.confirmEnd) {
          setConfirmEnd(false);
        } else if (liveRef.current.phase === 'incoming') {
          store.rejectIncomingCall();
        } else {
          setConfirmEnd(true);
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [active, collapsed, store]);

  // The call is non-modal after ringing, but Escape still asks for
  // confirmation while focus is inside the call widget.
  useEffect(() => {
    if (!active || incoming || collapsed) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const dialog = dialogRef.current;
      if (!dialog || !dialog.contains(document.activeElement)) return;
      event.preventDefault();
      if (confirmEnd) setConfirmEnd(false);
      else setConfirmEnd(true);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [active, incoming, collapsed, confirmEnd]);

  useEffect(() => {
    if (confirmEnd) stayRef.current?.focus();
  }, [confirmEnd]);

  // Accepting or connecting unmounts the focused control. Keep keyboard users
  // inside the dialog instead of dropping focus onto <body>.
  useEffect(() => {
    if (!active || collapsed) return;
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || !element.isConnected || element === document.body) {
      dialogRef.current?.focus();
    }
  }, [active, call.phase]);

  // Incoming conference callers need display names even when the chat details
  // (the usual member-directory loader) has never been opened.
  useEffect(() => {
    if (!active || !call.conference) return;
    if (state.workspaceMembers.status === 'idle') void store.loadWorkspaceMembers();
  }, [active, call.conference, state.workspaceMembers.status, store]);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = call.localStream;
  }, [call.localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = call.remoteStream;
  }, [call.remoteStream]);

  // #107: apply the saved volume/mute/sink to the 1:1 remote media element.
  // Mesh tiles do the same in `ConferenceTile`; local preview is always muted.
  useEffect(() => {
    let current = true;
    void applyMediaOutput(remoteVideoRef.current, {
      volume: outputVolume,
      muted: outputMuted,
      deviceId: outputDeviceId,
    }).then((ok) => {
      if (!ok && current) reportOutputError();
    });
    return () => {
      current = false;
    };
  }, [call.remoteStream, outputDeviceId, outputMuted, outputVolume, reportOutputError]);

  const changeOutputVolume = (value: number) => {
    setOutputError(null);
    setOutputVolume(writeCallOutputVolume(value));
  };

  const chooseOutput = async () => {
    setOutputError(null);
    try {
      const device = await chooseAudioOutputDevice();
      if (!device) {
        setOutputError('calls.outputDeviceUnsupported');
        return;
      }
      setOutputDeviceId(device.deviceId);
      setOutputDeviceLabel(device.label.trim() || null);
    } catch (error) {
      const name =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name?: unknown }).name ?? '')
          : '';
      // A closed browser picker is not a failure.
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setOutputError('calls.outputDeviceDenied');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setOutputError('calls.outputDeviceMissing');
      } else {
        setOutputError('calls.outputDeviceError');
      }
    }
  };

  // Unmount cleanup: navigating away (or logout) must stop tracks and close the
  // peer connection. `endCall` is a no-op when idle, so StrictMode's double
  // mount cannot break a later call.
  useEffect(() => {
    return () => {
      store.endCall();
    };
  }, [store]);

  if (!active) {
    if (!call.notice) return null;
    return (
      <div className="call-notice" role="alert">
        <span className="call-notice__icon" aria-hidden="true">
          <PhoneOffIcon />
        </span>
        <div className="call-notice__body">
          <strong>{t('calls.errorTitle')}</strong>
          <p>{t(ERROR_KEYS[call.notice.code])}</p>
        </div>
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={() => store.dismissCallNotice()}
          aria-label={t('calls.dismiss')}
          title={t('calls.dismiss')}
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </div>
    );
  }

  const miniParticipant =
    (activeSpeakerId
      ? call.participants.find((participant) => participant.userId === activeSpeakerId)
      : null) ??
    call.participants.find((participant) =>
      participant.stream?.getVideoTracks().some((track) => track.enabled),
    ) ??
    call.participants[0] ??
    null;
  const miniStream = miniParticipant?.stream ?? (conference ? call.localStream : call.remoteStream);
  const miniName = miniParticipant
    ? participantName(miniParticipant.userId)
    : conference
      ? t('calls.you')
      : peerName;
  const miniSeed = miniParticipant?.userId ?? (conference ? 'local' : (call.chatId ?? peerName));
  const miniCameraOn = miniParticipant
    ? Boolean(miniParticipant.stream?.getVideoTracks().some((track) => track.enabled))
    : call.cameraOn;

  if (!incoming && collapsed) {
    return (
      <div className="call-mini" role="region" aria-label={t('calls.miniLabel')}>
        <MiniCallTile name={miniName} seed={miniSeed} stream={miniStream} cameraOn={miniCameraOn} />
        <span className="call-mini__title">{infoTitle}</span>
        {call.startedAt !== null ? (
          <CallTimer startedAt={call.startedAt} />
        ) : (
          <span className="call-mini__status">{statusLabel(call)}</span>
        )}
        <button
          type="button"
          disabled={!call.localStream}
          className={`call-mini__button${call.muted ? ' is-active' : ''}`}
          onClick={() => store.toggleCallMute()}
          aria-pressed={call.muted}
          aria-label={call.muted ? t('calls.unmute') : t('calls.mute')}
          title={call.muted ? t('calls.unmute') : t('calls.mute')}
        >
          {call.muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        {call.video ? (
          <button
            type="button"
            disabled={!call.localStream}
            className={`call-mini__button${call.cameraOn ? '' : ' is-active'}`}
            onClick={() => store.toggleCallCamera()}
            aria-pressed={call.cameraOn}
            aria-label={call.cameraOn ? t('calls.cameraOff') : t('calls.cameraOn')}
            title={call.cameraOn ? t('calls.cameraOff') : t('calls.cameraOn')}
          >
            {call.cameraOn ? <VideoIcon /> : <VideoOffIcon />}
          </button>
        ) : null}
        <button
          type="button"
          className="call-mini__button"
          onClick={() => setCollapsed(false)}
          aria-label={t('calls.expand')}
          title={t('calls.expand')}
        >
          <ExpandIcon />
        </button>
        <button
          type="button"
          className="call-mini__button call-mini__button--danger"
          onClick={() => store.endCall()}
          aria-label={t('calls.hangup')}
          title={t('calls.hangup')}
        >
          <PhoneOffIcon />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`call-overlay call-overlay--${call.phase}${floating ? ' call-overlay--floating' : ''}`}
    >
      <div
        className={`call-dialog${floating ? ' call-dialog--floating' : ''}${maximized ? ' call-dialog--maximized' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={dialogRef}
        tabIndex={-1}
        style={{ transform: `translate(${windowOffset.x}px, ${windowOffset.y}px)` }}
      >
        <div className="call-stage">
          {conference ? (
            <div className={`call-grid call-grid--${gridSize}`}>
              {(featuredUserId
                ? [...call.participants].sort((a, b) =>
                    a.userId === featuredUserId ? -1 : b.userId === featuredUserId ? 1 : 0,
                  )
                : call.participants
              ).map((participant) => (
                <ConferenceTile
                  key={participant.userId}
                  participant={participant}
                  name={participantName(participant.userId)}
                  video={call.video}
                  stream={participant.stream}
                  ringing={incoming}
                  featured={featuredUserId === participant.userId}
                  outputVolume={outputVolume}
                  outputMuted={outputMuted}
                  outputDeviceId={outputDeviceId}
                  onOutputError={reportOutputError}
                />
              ))}
              {call.localStream ? (
                <ConferenceTile
                  name={t('calls.you')}
                  video={call.video}
                  stream={call.localStream}
                  local
                  cameraOn={call.cameraOn}
                  outputVolume={outputVolume}
                  outputMuted={outputMuted}
                  outputDeviceId={outputDeviceId}
                  onOutputError={reportOutputError}
                />
              ) : null}
            </div>
          ) : (
            <>
              <video
                ref={remoteVideoRef}
                className={`call-stage__remote${hasRemoteVideo ? ' is-video' : ''}`}
                autoPlay
                playsInline
                muted={outputMuted}
                aria-label={hasRemoteVideo ? t('calls.remoteVideo') : undefined}
              />

              {!hasRemoteVideo ? (
                <div className="call-stage__identity" aria-hidden="true">
                  <Avatar name={peerName} seed={call.chatId ?? peerName} size="profile" />
                </div>
              ) : null}
            </>
          )}

          <div
            className="call-stage__top call-drag-handle"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              dragRef.current = {
                x: event.clientX,
                y: event.clientY,
                ox: windowOffset.x,
                oy: windowOffset.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              setWindowOffset({
                x: drag.ox + event.clientX - drag.x,
                y: drag.oy + event.clientY - drag.y,
              });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
          >
            <span className="call-kind">
              {call.video ? <VideoIcon aria-hidden="true" /> : <PhoneIcon aria-hidden="true" />}
              {conference
                ? t('calls.participantsCount', { count: totalParticipants })
                : call.video
                  ? t('calls.video')
                  : t('calls.audio')}
            </span>
            {connected && call.startedAt !== null ? <CallTimer startedAt={call.startedAt} /> : null}
            {!incoming ? (
              <button
                type="button"
                className="call-minimize"
                onClick={() => setCollapsed(true)}
                aria-label={t('calls.minimize')}
                title={t('calls.minimize')}
              >
                <MinimizeIcon />
              </button>
            ) : null}
          </div>

          <div className="call-stage__info">
            <h2 id={titleId} className="call-peer">
              {infoTitle}
            </h2>
            <p id={descriptionId} className="call-status" role="status" aria-live="polite">
              {statusLabel(call)}
            </p>
            {incoming ? (
              <p className="visually-hidden" role="alert">
                {conference
                  ? t('calls.groupIncomingAnnounce', { names: announceName })
                  : t('calls.incomingAnnounce', { name: peerName })}
              </p>
            ) : null}
          </div>

          {!conference && call.video && hasLocalVideo ? (
            <div className={`call-local${call.cameraOn ? '' : ' is-off'}`}>
              <video
                ref={localVideoRef}
                className="call-local__video"
                autoPlay
                muted
                playsInline
                aria-label={t('calls.localPreview')}
              />
              {!call.cameraOn ? (
                <span className="call-local__off">{t('calls.cameraOff')}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {connected && settingsOpen ? (
          <section className="call-devices" aria-label={t('calls.deviceSettings')}>
            <div className="call-devices__head">
              <strong>{t('calls.deviceSettings')}</strong>
              <button
                type="button"
                className="icon-button icon-button--small"
                onClick={() => setSettingsOpen(false)}
                aria-label={t('calls.deviceClose')}
                title={t('calls.deviceClose')}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
            {call.video ? (
              <label className="call-devices__field">
                <span>{t('calls.camera')}</span>
                <select
                  value={cameraId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCameraId(next);
                    setControlError(null);
                    void store.switchCallCamera(next).catch(() => {
                      setControlError('calls.deviceSwitchError');
                    });
                  }}
                >
                  <option value="">{t('calls.deviceDefault')}</option>
                  {devices
                    .filter((device) => device.kind === 'videoinput')
                    .map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `${t('calls.camera')} ${index + 1}`}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <label className="call-devices__field">
              <span>{t('calls.microphone')}</span>
              <select
                value={microphoneId}
                onChange={(event) => {
                  const next = event.target.value;
                  setMicrophoneId(next);
                  setControlError(null);
                  void store.switchCallMicrophone(next).catch(() => {
                    setControlError('calls.deviceSwitchError');
                  });
                }}
              >
                <option value="">{t('calls.deviceDefault')}</option>
                {devices
                  .filter((device) => device.kind === 'audioinput')
                  .map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `${t('calls.microphone')} ${index + 1}`}
                    </option>
                  ))}
              </select>
            </label>
            {controlError ? (
              <p className="call-devices__error" role="alert">
                {t(controlError)}
              </p>
            ) : null}
          </section>
        ) : null}

        {connected ? (
          <div className="call-people" role="group" aria-label={t('calls.participantsList')}>
            <button
              type="button"
              className={`call-person-chip${featuredUserId === null ? ' is-active' : ''}`}
              onClick={() => setFeaturedUserId(null)}
            >
              {t('calls.allParticipants')}
            </button>
            {call.participants.map((participant) => (
              <button
                type="button"
                key={participant.userId}
                className={`call-person-chip${featuredUserId === participant.userId ? ' is-active' : ''}`}
                onClick={() => setFeaturedUserId(participant.userId)}
              >
                {participantName(participant.userId)}
              </button>
            ))}
          </div>
        ) : null}

        <div className="call-controls">
          {connected ? (
            <div className="call-audio" role="group" aria-label={t('calls.audioControls')}>
              <div className="call-audio__row">
                <button
                  type="button"
                  className={`call-audio__button${outputMuted ? ' is-active' : ''}`}
                  onClick={() => {
                    setOutputError(null);
                    setOutputMuted((current) => !current);
                  }}
                  aria-pressed={outputMuted}
                  aria-label={outputMuted ? t('calls.outputUnmute') : t('calls.outputMute')}
                  title={outputMuted ? t('calls.outputUnmute') : t('calls.outputMute')}
                >
                  {outputMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
                  <span>{outputMuted ? t('calls.outputUnmute') : t('calls.outputMute')}</span>
                </button>

                <label className="call-audio__volume">
                  <span className="call-audio__volume-label">{t('calls.volume')}</span>
                  <input
                    className="call-audio__range"
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={outputVolume}
                    aria-valuetext={t('calls.volumeValue', { value: outputVolume })}
                    onChange={(event) => changeOutputVolume(Number(event.target.value))}
                  />
                  <span className="call-audio__volume-value" aria-hidden="true">
                    {t('calls.volumeValue', { value: outputVolume })}
                  </span>
                </label>

                {canChooseOutput ? (
                  <button
                    type="button"
                    className="call-audio__button"
                    onClick={() => void chooseOutput()}
                    aria-label={t('calls.outputDeviceChooseAria')}
                    title={t('calls.outputDeviceChooseAria')}
                  >
                    <SpeakerIcon />
                    <span>
                      {outputDeviceLabel
                        ? t('calls.outputDeviceSelected', { name: outputDeviceLabel })
                        : t('calls.outputDeviceChoose')}
                    </span>
                  </button>
                ) : (
                  <span className="call-audio__note" title={t('calls.outputDeviceUnsupported')}>
                    <SpeakerIcon />
                    {t('calls.outputDeviceSystem')}
                  </span>
                )}

                {micLevel.supported ? (
                  <button
                    type="button"
                    className={`call-audio__button${micTest ? ' is-active' : ''}`}
                    onClick={() => setMicTest((current) => !current)}
                    aria-pressed={micTest}
                    title={micTest ? t('calls.micTestStop') : t('calls.micTestStart')}
                  >
                    <MicIcon />
                    <span>{micTest ? t('calls.micTestStop') : t('calls.micTestStart')}</span>
                  </button>
                ) : null}
              </div>

              {micTest && micLevel.supported ? (
                <div className="call-audio__meter-row">
                  <span className="call-audio__meter-label">{t('calls.micLevel')}</span>
                  <div
                    className="call-meter"
                    role="meter"
                    aria-label={t('calls.micLevel')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={micLevel.level}
                    aria-valuetext={t('calls.volumeValue', { value: micLevel.level })}
                  >
                    <span className="call-meter__fill" style={{ width: `${micLevel.level}%` }} />
                  </div>
                  <span className="call-audio__volume-value" aria-hidden="true">
                    {t('calls.volumeValue', { value: micLevel.level })}
                  </span>
                  <span className="call-audio__hint">
                    {call.muted ? t('calls.micLevelMuted') : t('calls.micLevelHint')}
                  </span>
                </div>
              ) : null}

              {outputError ? (
                <p className="call-audio__error" role="alert">
                  {t(outputError)}
                </p>
              ) : null}
            </div>
          ) : null}

          {controlError && !settingsOpen ? (
            <p className="call-control-error" role="alert">
              {t(controlError)}
            </p>
          ) : null}

          <div className="call-controls__buttons">
            {incoming ? (
              <>
                <button
                  type="button"
                  ref={acceptRef}
                  className="call-button call-button--accept"
                  onClick={() => store.acceptIncomingCall()}
                >
                  <PhoneIcon aria-hidden="true" />
                  {t('calls.accept')}
                </button>
                <button
                  type="button"
                  className="call-button call-button--danger"
                  onClick={() => store.rejectIncomingCall()}
                >
                  <PhoneOffIcon aria-hidden="true" />
                  {t('calls.reject')}
                </button>
              </>
            ) : (
              <>
                {!incoming ? (
                  <>
                    <button
                      type="button"
                      disabled={!call.localStream}
                      className={`call-button call-button--round${call.muted ? ' is-active' : ''}`}
                      onClick={() => store.toggleCallMute()}
                      aria-pressed={call.muted}
                      aria-label={call.muted ? t('calls.unmute') : t('calls.mute')}
                      title={call.muted ? t('calls.unmute') : t('calls.mute')}
                    >
                      {call.muted ? <MicOffIcon /> : <MicIcon />}
                    </button>
                    {call.video ? (
                      <button
                        type="button"
                        disabled={!call.localStream}
                        className={`call-button call-button--round${
                          call.cameraOn ? '' : ' is-active'
                        }`}
                        onClick={() => store.toggleCallCamera()}
                        aria-pressed={call.cameraOn}
                        aria-label={call.cameraOn ? t('calls.cameraOff') : t('calls.cameraOn')}
                        title={call.cameraOn ? t('calls.cameraOff') : t('calls.cameraOn')}
                      >
                        {call.cameraOn ? <VideoIcon /> : <VideoOffIcon />}
                      </button>
                    ) : null}
                    {call.video ? (
                      <button
                        type="button"
                        disabled={!call.localStream}
                        className={`call-button call-button--round${
                          call.screenSharing ? ' is-active' : ''
                        }`}
                        onClick={() => {
                          setControlError(null);
                          const action = call.screenSharing
                            ? store.stopCallScreenShare()
                            : store.startCallScreenShare();
                          void action
                            .then((ok) => {
                              if (!ok) setControlError('calls.screenShareError');
                            })
                            .catch(() => setControlError('calls.screenShareError'));
                        }}
                        aria-pressed={Boolean(call.screenSharing)}
                        aria-label={
                          call.screenSharing ? t('calls.screenShareStop') : t('calls.screenShare')
                        }
                        title={
                          call.screenSharing ? t('calls.screenShareStop') : t('calls.screenShare')
                        }
                      >
                        <MonitorIcon />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`call-button call-button--round${settingsOpen ? ' is-active' : ''}`}
                      onClick={() => {
                        setControlError(null);
                        setSettingsOpen((open) => !open);
                        if (!settingsOpen) {
                          void navigator.mediaDevices
                            ?.enumerateDevices()
                            .then((list) => setDevices(list))
                            .catch(() => setDevices([]));
                        }
                      }}
                      aria-pressed={settingsOpen}
                      aria-label={t('calls.deviceSettings')}
                      title={t('calls.deviceSettings')}
                    >
                      <SettingsIcon />
                    </button>
                    <button
                      type="button"
                      className="call-button call-button--round"
                      onClick={() => setMaximized((value) => !value)}
                      aria-pressed={maximized}
                      aria-label={maximized ? t('calls.restore') : t('calls.maximize')}
                      title={maximized ? t('calls.restore') : t('calls.maximize')}
                    >
                      <ExpandIcon />
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  ref={hangupRef}
                  className="call-button call-button--danger call-button--round"
                  onClick={() => (connected ? setConfirmEnd(true) : store.endCall())}
                  aria-label={connected ? t('calls.hangup') : t('calls.cancel')}
                  title={connected ? t('calls.hangup') : t('calls.cancel')}
                >
                  <PhoneOffIcon />
                </button>
              </>
            )}
          </div>
        </div>

        {confirmEnd ? (
          <div
            className="call-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${titleId}-confirm`}
            aria-describedby={`${titleId}-confirm-text`}
          >
            <p id={`${titleId}-confirm`} className="call-confirm__title">
              {t('calls.confirmTitle')}
            </p>
            <p id={`${titleId}-confirm-text`} className="call-confirm__text">
              {conference ? t('calls.confirmTextGroup') : t('calls.confirmText')}
            </p>
            <div className="call-confirm__actions">
              <button
                type="button"
                ref={stayRef}
                className="call-button"
                onClick={() => setConfirmEnd(false)}
              >
                {t('calls.confirmStay')}
              </button>
              <button
                type="button"
                className="call-button call-button--danger"
                onClick={() => {
                  setConfirmEnd(false);
                  store.endCall();
                }}
              >
                {t('calls.confirmEnd')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
