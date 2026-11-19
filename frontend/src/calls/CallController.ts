import {
  CALL_CANDIDATE_MAX_BYTES,
  CALL_SDP_MAX_BYTES,
  idleCallState,
  type CallDirection,
  type CallErrorCode,
  type CallIceCandidate,
  type CallNotice,
  type CallSignalKind,
  type CallSignalPayload,
  type CallState,
  type IncomingCallSignal,
} from './types';

/**
 * WebRTC engine for one 1:1 call.
 *
 * Responsibilities:
 *  - getUserMedia on demand (never on mount / never before the user acts);
 *  - one RTCPeerConnection with an injectable `iceServers` list;
 *  - offer/answer/ICE relay over the existing WebSocket (`call.signal`);
 *  - cleanup of every track and peer connection on hangup, failure, peer
 *    hangup and app teardown.
 *
 * It deliberately has no React and no i18n imports: UI state is emitted through
 * `onChange`, errors are stable codes, and all tests can drive it with fake
 * `mediaDevices`/`RTCPeerConnection` implementations.
 */
export interface CallControllerOptions {
  sendSignal(chatId: string, payload: CallSignalPayload): boolean;
  onChange(state: CallState): void;
  createId(): string;
  /** `VITE_WEBRTC_ICE_SERVERS`; empty by default (host candidates only). */
  iceServers?: RTCIceServer[];
  now?: () => number;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: 'user',
};

interface PendingOffer {
  sdp: string;
  video: boolean;
}

export class CallController {
  private readonly options: CallControllerOptions;
  private state: CallState = idleCallState();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private pendingOffer: PendingOffer | null = null;
  private pendingCandidates: CallIceCandidate[] = [];
  private remoteDescriptionSet = false;
  private disposed = false;

  constructor(options: CallControllerOptions) {
    this.options = options;
  }

  getState(): CallState {
    return this.state;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Start an outgoing call. No media is requested until this method is called. */
  start(chatId: string, peerUserId: string | null, video: boolean): void {
    if (this.disposed || this.state.phase !== 'idle') return;
    const callId = this.options.createId();
    this.resetResources();
    this.pendingCandidates = [];
    this.pendingOffer = null;
    this.remoteDescriptionSet = false;
    this.update({
      ...idleCallState(),
      phase: 'outgoing',
      callId,
      chatId,
      direction: 'outgoing',
      video,
      peerUserId,
      mediaPending: true,
      cameraOn: video,
    });
    void this.beginOutgoing(callId, video);
  }

  private async beginOutgoing(callId: string, video: boolean): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.openMedia(video);
    } catch (error) {
      if (callId !== this.state.callId) return;
      this.fail(mapMediaError(error), callId);
      return;
    }
    if (callId !== this.state.callId) {
      stopStream(stream);
      return;
    }

    this.localStream = stream;
    this.update({
      localStream: stream,
      mediaPending: false,
      muted: false,
      cameraOn: video && stream.getVideoTracks().length > 0,
    });

    try {
      const pc = this.createPeer(callId);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: video,
      });
      if (callId !== this.state.callId) return;
      await pc.setLocalDescription(offer);
      if (callId !== this.state.callId) return;
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      if (!sdp) {
        this.fail('connection_failed', callId, true);
        return;
      }
      this.dispatch(callId, 'offer', video, { sdp });
    } catch {
      if (callId === this.state.callId) this.fail('connection_failed', callId, true);
    }
  }

  /** Accept a ringing call: only now is getUserMedia called. */
  accept(): void {
    const incoming = this.pendingOffer;
    const callId = this.state.callId;
    if (this.disposed || this.state.phase !== 'incoming' || !incoming || !callId) return;

    this.update({ phase: 'connecting', mediaPending: true });
    void this.beginAnswer(callId, incoming);
  }

  private async beginAnswer(callId: string, incoming: PendingOffer): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.openMedia(incoming.video);
    } catch (error) {
      if (callId !== this.state.callId) return;
      // The caller is still ringing on the other side; tell it that we gave up.
      this.fail(mapMediaError(error), callId, true);
      return;
    }
    if (callId !== this.state.callId) {
      stopStream(stream);
      return;
    }

    this.localStream = stream;
    this.update({
      localStream: stream,
      mediaPending: false,
      muted: false,
      cameraOn: incoming.video && stream.getVideoTracks().length > 0,
    });

    try {
      const pc = this.createPeer(callId);
      await pc.setRemoteDescription({ type: 'offer', sdp: incoming.sdp });
      if (callId !== this.state.callId) return;
      this.remoteDescriptionSet = true;
      this.pendingOffer = null;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const answer = await pc.createAnswer();
      if (callId !== this.state.callId) return;
      await pc.setLocalDescription(answer);
      if (callId !== this.state.callId) return;
      const sdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
      if (!sdp) {
        this.fail('connection_failed', callId, true);
        return;
      }
      await this.flushPendingCandidates();
      this.dispatch(callId, 'answer', incoming.video, { sdp });
    } catch {
      if (callId === this.state.callId) this.fail('connection_failed', callId, true);
    }
  }

  /** Decline a ringing call without touching media. */
  reject(): void {
    if (this.state.phase !== 'incoming' || !this.state.chatId || !this.state.callId) return;
    this.dispatch(this.state.chatId, 'hangup', this.state.video);
    this.finish(null);
  }

  /** End an outgoing/connected call (the UI asks for confirmation first). */
  hangup(): void {
    if (this.state.phase === 'idle') return;
    if (this.state.chatId && this.state.callId) {
      this.dispatch(this.state.chatId, 'hangup', this.state.video);
    }
    this.finish(null);
  }

  /** Handle one relayed `call.signal` frame. Unknown/stale frames are ignored. */
  handleSignal(frame: IncomingCallSignal): void {
    const payload = frame.payload;
    if (!payload || typeof payload.call_id !== 'string' || payload.call_id.length === 0) return;
    if (typeof payload.video !== 'boolean') return;

    if (payload.kind === 'offer') {
      this.handleOffer(frame);
      return;
    }
    if (this.state.callId !== payload.call_id || this.state.phase === 'idle') return;

    switch (payload.kind) {
      case 'answer':
        this.handleAnswer(payload.call_id, payload.sdp);
        break;
      case 'ice':
        this.handleRemoteIce(payload.candidate);
        break;
      case 'hangup':
        this.remoteHangup();
        break;
      case 'busy':
        this.finish({ code: 'busy' });
        break;
      default:
        break;
    }
  }

  private handleOffer(frame: IncomingCallSignal): void {
    const payload = frame.payload;
    if (!payload.sdp) return;

    if (this.state.phase !== 'idle') {
      // Same call + same offer is a duplicate relay; anything else while we are
      // already busy is answered with `busy` (contract §9.1).
      if (this.state.callId !== payload.call_id) {
        this.sendRaw(frame.chat_id, {
          call_id: payload.call_id,
          kind: 'busy',
          video: payload.video,
        });
      }
      return;
    }

    this.resetResources();
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.pendingOffer = { sdp: payload.sdp, video: payload.video };
    this.update({
      ...idleCallState(),
      phase: 'incoming',
      callId: payload.call_id,
      chatId: frame.chat_id,
      direction: 'incoming',
      video: payload.video,
      peerUserId: frame.from_user_id ?? null,
    });
  }

  private handleAnswer(callId: string, sdp: string | undefined): void {
    if (!sdp || !this.pc) return;
    const pc = this.pc;
    this.update({ phase: 'connecting' });
    void pc
      .setRemoteDescription({ type: 'answer', sdp })
      .then(async () => {
        if (this.pc !== pc || this.state.callId !== callId) return;
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();
      })
      .catch(() => {
        if (this.pc === pc && this.state.callId === callId) {
          this.fail('connection_failed', callId, true);
        }
      });
  }

  private handleRemoteIce(candidate: CallIceCandidate | undefined): void {
    if (!candidate || candidate.candidate.length === 0) return;
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    const pc = this.pc;
    void pc.addIceCandidate(candidate).catch(() => {
      // A single bad candidate must not tear down an otherwise healthy call;
      // connectivity failure still surfaces through connectionState.
    });
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.remoteDescriptionSet) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Ignore a stale candidate; ICE continues with the rest.
      }
    }
  }

  /** `call.unavailable` from the server (peer has no live session). */
  handleUnavailable(callId: string): void {
    if (this.state.callId !== callId) return;
    this.finish({ code: 'peer_offline' });
  }

  /** A recoverable server `error` for a call frame; end the attempt clearly. */
  handleServerError(code: string): void {
    if (this.state.phase === 'idle') return;
    const notice: CallErrorCode =
      code === 'CALL_NOT_SUPPORTED'
        ? 'call_not_supported'
        : code === 'CALL_PAYLOAD_TOO_LARGE'
          ? 'payload_too_large'
          : 'signaling_failed';
    this.finish({ code: notice });
  }

  toggleMute(): void {
    if (this.state.phase === 'idle' || !this.localStream) return;
    const muted = !this.state.muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    this.update({ muted });
  }

  toggleCamera(): void {
    if (this.state.phase === 'idle' || !this.state.video || !this.localStream) return;
    const cameraOn = !this.state.cameraOn;
    for (const track of this.localStream.getVideoTracks()) track.enabled = cameraOn;
    this.update({ cameraOn });
  }

  dismissNotice(): void {
    if (!this.state.notice) return;
    this.update({ notice: null });
  }

  /**
   * Tear everything down without signalling. Called by the store on logout and
   * by the overlay's unmount cleanup; a live socket is disposed separately.
   */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Like `dispose`, but the controller remains reusable (logout/workspace switch). */
  stop(): void {
    this.resetResources();
    this.state = idleCallState();
  }

  private remoteHangup(): void {
    const connected = this.state.phase === 'connected';
    const direction = this.state.direction;
    this.finish({
      code: connected ? 'ended' : direction === 'incoming' ? 'cancelled' : 'declined',
    });
  }

  private finish(notice: CallNotice | null): void {
    this.resetResources();
    this.update({ ...idleCallState(), notice });
  }

  private fail(code: CallErrorCode, callId: string, notifyPeer = false): void {
    if (this.state.callId !== callId) return;
    if (notifyPeer && this.state.chatId) {
      this.dispatch(this.state.chatId, 'hangup', this.state.video);
    }
    this.finish({ code });
  }

  private createPeer(callId: string): RTCPeerConnection {
    const config: RTCConfiguration = { iceServers: this.options.iceServers ?? [] };
    const pc = this.options.createPeerConnection
      ? this.options.createPeerConnection(config)
      : defaultPeerConnection(config);
    this.pc = pc;
    this.remoteDescriptionSet = false;

    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      const raw = event.candidate;
      if (!raw) return;
      const candidate = toIceCandidate(raw);
      if (!candidate || candidate.candidate.length === 0) return;
      this.dispatch(callId, 'ice', this.state.video, { candidate });
    };

    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      const stream = event.streams[0] ?? createStreamFor(event.track);
      if (stream) this.update({ remoteStream: stream });
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        this.update({
          phase: 'connected',
          startedAt: this.state.startedAt ?? this.now(),
        });
      } else if (pc.connectionState === 'failed') {
        this.fail('connection_failed', callId, true);
      }
    };

    return pc;
  }

  private async openMedia(video: boolean): Promise<MediaStream> {
    const devices = this.options.mediaDevices ?? browserMediaDevices();
    if (!devices?.getUserMedia) {
      throw Object.assign(new Error('getUserMedia is unavailable'), { name: 'NotSupportedError' });
    }
    return devices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: video ? VIDEO_CONSTRAINTS : false,
    });
  }

  private dispatch(
    chatId: string,
    kind: CallSignalKind,
    video: boolean,
    extra: Pick<CallSignalPayload, 'sdp' | 'candidate'> = {},
  ): boolean {
    const callId = this.state.callId;
    if (!callId) return false;
    const payload: CallSignalPayload = { call_id: callId, kind, video, ...extra };

    if (kind === 'offer' || kind === 'answer') {
      if (!payload.sdp) {
        this.fail('signaling_failed', callId);
        return false;
      }
      if (utf8Length(payload.sdp) > CALL_SDP_MAX_BYTES) {
        this.fail('payload_too_large', callId, true);
        return false;
      }
    }
    if (kind === 'ice' && payload.candidate) {
      if (utf8Length(JSON.stringify(payload.candidate)) > CALL_CANDIDATE_MAX_BYTES) {
        this.fail('payload_too_large', callId, true);
        return false;
      }
    }

    const sent = this.sendRaw(chatId, payload);
    if (!sent && (kind === 'offer' || kind === 'answer')) {
      // Without an offer/answer the peer cannot reach us; do not leave the
      // overlay waiting forever on a dead socket.
      this.fail('signaling_failed', callId);
      return false;
    }
    return sent;
  }

  private sendRaw(chatId: string, payload: CallSignalPayload): boolean {
    try {
      return this.options.sendSignal(chatId, payload);
    } catch {
      return false;
    }
  }

  private resetResources(): void {
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    if (this.localStream) {
      stopStream(this.localStream);
      this.localStream = null;
    }
    if (this.state.remoteStream) {
      stopStream(this.state.remoteStream);
    }
    this.pendingCandidates = [];
    this.pendingOffer = null;
    this.remoteDescriptionSet = false;
  }

  private update(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }
}

function defaultPeerConnection(config: RTCConfiguration): RTCPeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('RTCPeerConnection is not available');
  }
  return new RTCPeerConnection(config);
}

function browserMediaDevices(): Pick<MediaDevices, 'getUserMedia'> | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.mediaDevices;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

function createStreamFor(track: MediaStreamTrack | undefined): MediaStream | null {
  if (!track || typeof MediaStream === 'undefined') return null;
  try {
    return new MediaStream([track]);
  } catch {
    return null;
  }
}

function toIceCandidate(raw: RTCIceCandidate): CallIceCandidate | null {
  const maybeJson = (raw as { toJSON?: () => unknown }).toJSON;
  const value =
    typeof maybeJson === 'function'
      ? (maybeJson.call(raw) as unknown)
      : (raw as unknown as Record<string, unknown>);
  if (!isRecord(value)) return null;
  const candidate = value.candidate;
  if (typeof candidate !== 'string') return null;
  const sdpMid = typeof value.sdpMid === 'string' ? value.sdpMid : null;
  const sdpMLineIndex = typeof value.sdpMLineIndex === 'number' ? value.sdpMLineIndex : null;
  const usernameFragment =
    typeof value.usernameFragment === 'string' ? value.usernameFragment : null;
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapMediaError(error: unknown): CallErrorCode {
  const name =
    isRecord(error) && typeof error.name === 'string'
      ? error.name
      : typeof error === 'string'
        ? error
        : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'permission_denied';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'ConstraintNotSatisfiedError' ||
    name === 'NotReadableError' ||
    name === 'TrackStartError' ||
    name === 'AbortError'
  ) {
    return 'device_unavailable';
  }
  if (name === 'NotSupportedError' || name === 'TypeError') return 'unsupported';
  return 'device_unavailable';
}

function utf8Length(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length;
}

export type { CallDirection };
