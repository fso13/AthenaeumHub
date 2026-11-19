/**
 * 1:1 call signalling types (contracts/ws-protocol.md §9).
 *
 * The server is a dumb relay: it validates `call_id`/`kind`/`video` and the
 * per-kind SDP/candidate rules, then forwards the payload byte-for-byte. There
 * is no `call.state`, no call id allocation and no persistence, so every piece
 * of UI state below is derived locally from the WS frames.
 */

/** Server-side bounds from §9.4; enforced client-side for an early, honest error. */
export const CALL_SDP_MAX_BYTES = 32_768;
export const CALL_CANDIDATE_MAX_BYTES = 4_096;

export type CallSignalKind = 'offer' | 'answer' | 'ice' | 'hangup' | 'busy';

/**
 * `RTCIceCandidateInit` over the wire. The contract example uses snake_case
 * (`sdp_mid`, `sdp_mline_index`), while the browser API uses camelCase; the
 * parser accepts both and the sender emits the browser shape (the backend
 * relays the object without rewriting it).
 */
export interface CallIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface CallSignalPayload {
  call_id: string;
  kind: CallSignalKind;
  /** `false` is an audio-only call; never inferred from the presence of `sdp`. */
  video: boolean;
  sdp?: string;
  candidate?: CallIceCandidate;
}

/** A relayed `call.signal` event as seen by the recipient (§9.2). */
export interface IncomingCallSignal {
  chat_id: string;
  from_user_id?: string | null;
  from_device_id?: string | null;
  payload: CallSignalPayload;
}

/** `call.unavailable` is delivered only to the caller's session (§9.3). */
export interface CallUnavailableSignal {
  chat_id: string;
  payload: {
    call_id: string;
    kind: CallSignalKind;
    reason: string;
  };
}

export type CallDirection = 'outgoing' | 'incoming';

/** Active-call lifecycle. `idle` means no overlay and no media resources. */
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected';

/**
 * User-facing failure reasons. `CallOverlay` owns the RU copy; the controller
 * never builds UI strings, so the engine stays independent of the i18n layer.
 */
export type CallErrorCode =
  | 'permission_denied'
  | 'device_unavailable'
  | 'insecure_context'
  | 'unsupported'
  | 'connection_failed'
  | 'signaling_failed'
  | 'payload_too_large'
  | 'call_not_supported'
  | 'peer_offline'
  | 'busy'
  | 'declined'
  | 'cancelled'
  | 'ended';

export interface CallNotice {
  code: CallErrorCode;
}

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  chatId: string | null;
  direction: CallDirection | null;
  video: boolean;
  peerUserId: string | null;
  /** Local microphone muted (track.enabled=false; never sent to the server). */
  muted: boolean;
  /** Local camera enabled. Always false for audio-only calls. */
  cameraOn: boolean;
  /** True while getUserMedia is pending, so the UI can say "asking for access". */
  mediaPending: boolean;
  /** Epoch ms when the peer connection reached `connected`; drives the timer. */
  startedAt: number | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Transient result of the previous call; shown as a dismissible notice. */
  notice: CallNotice | null;
}

export function idleCallState(): CallState {
  return {
    phase: 'idle',
    callId: null,
    chatId: null,
    direction: null,
    video: false,
    peerUserId: null,
    muted: false,
    cameraOn: false,
    mediaPending: false,
    startedAt: null,
    localStream: null,
    remoteStream: null,
    notice: null,
  };
}
