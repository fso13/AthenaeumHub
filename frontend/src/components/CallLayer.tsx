import { useEffect, useId, useRef, useState } from 'react';
import { chatDisplayName } from '../domain/chatLabel';
import { formatDuration } from '../files/format';
import { t, type MessageKey } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import type { CallErrorCode, CallParticipant, CallState } from '../calls/types';
import { Avatar } from './Avatar';
import {
  CloseIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon,
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
}: {
  participant?: CallParticipant;
  name: string;
  video: boolean;
  stream: MediaStream | null;
  local?: boolean;
  cameraOn?: boolean;
  ringing?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(video && stream && stream.getVideoTracks().length > 0);
  const showVideo = local ? hasVideo && cameraOn : hasVideo;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const state = participant?.connectionState;
  const showConnecting =
    !local && !ringing && state !== undefined && state !== 'connected' && state !== 'failed';
  const showFailed = !local && state === 'failed';

  return (
    <div className={`call-tile${showVideo ? ' is-video' : ''}${local ? ' call-tile--local' : ''}`}>
      {video ? (
        <video
          ref={videoRef}
          className="call-tile__video"
          autoPlay
          playsInline
          muted={local}
          aria-label={local ? t('calls.localPreview') : t('calls.groupVideoAnnounce', { name })}
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
  const titleId = useId();
  const descriptionId = useId();

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
  const participantName = (userId: string): string =>
    state.workspaceMembers.items.find((item) => item.user_id === userId)?.display_name ??
    t('calls.participantFallback');
  const conferenceNames = call.participants.map((item) => participantName(item.userId));
  const infoTitle = conference ? t('calls.groupCall') : peerName;
  const totalParticipants = conference ? call.participants.length + (incoming ? 0 : 1) : 1;
  const gridSize = Math.min(3, Math.max(1, call.participants.length));
  const announceName = conference ? conferenceNames.join(', ') || t('calls.groupCall') : peerName;

  // Reset the confirmation whenever the call goes away.
  useEffect(() => {
    if (!active) setConfirmEnd(false);
  }, [active]);

  // The call surface owns the viewport (full-screen on mobile): no background
  // scrolling while ringing or connected.
  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [active]);

  // Focus trap + Escape for the whole call dialog. `call.phase` is deliberately
  // read through a ref so a phase transition does not steal focus mid-typing.
  const liveRef = useRef({ phase: call.phase, confirmEnd });
  liveRef.current = { phase: call.phase, confirmEnd };
  useEffect(() => {
    if (!active) return;
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
  }, [active, store]);

  useEffect(() => {
    if (confirmEnd) stayRef.current?.focus();
  }, [confirmEnd]);

  // Accepting or connecting unmounts the focused control. Keep keyboard users
  // inside the dialog instead of dropping focus onto <body>.
  useEffect(() => {
    if (!active) return;
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

  return (
    <div className={`call-overlay call-overlay--${call.phase}`}>
      <div
        className="call-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="call-stage">
          {conference ? (
            <div className={`call-grid call-grid--${gridSize}`}>
              {call.participants.map((participant) => (
                <ConferenceTile
                  key={participant.userId}
                  participant={participant}
                  name={participantName(participant.userId)}
                  video={call.video}
                  stream={participant.stream}
                  ringing={incoming}
                />
              ))}
              {call.localStream ? (
                <ConferenceTile
                  name={t('calls.you')}
                  video={call.video}
                  stream={call.localStream}
                  local
                  cameraOn={call.cameraOn}
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
                aria-label={hasRemoteVideo ? t('calls.remoteVideo') : undefined}
              />

              {!hasRemoteVideo ? (
                <div className="call-stage__identity" aria-hidden="true">
                  <Avatar name={peerName} seed={call.chatId ?? peerName} size="profile" />
                </div>
              ) : null}
            </>
          )}

          <div className="call-stage__top">
            <span className="call-kind">
              {call.video ? <VideoIcon aria-hidden="true" /> : <PhoneIcon aria-hidden="true" />}
              {conference
                ? t('calls.participantsCount', { count: totalParticipants })
                : call.video
                  ? t('calls.video')
                  : t('calls.audio')}
            </span>
            {connected && call.startedAt !== null ? <CallTimer startedAt={call.startedAt} /> : null}
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

        <div className="call-controls">
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
              {connected ? (
                <>
                  <button
                    type="button"
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
