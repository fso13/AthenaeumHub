import {
  CALL_CANDIDATE_MAX_BYTES,
  CALL_SDP_MAX_BYTES,
  idleCallState,
  type CallDirection,
  type CallErrorCode,
  type CallIceCandidate,
  type CallNotice,
  type CallParticipant,
  type CallSignalKind,
  type CallSignalPayload,
  type CallState,
  type IncomingCallSignal,
} from './types';
import { createWebAudioRingtone, type CallRingtone } from './ringtone';

/**
 * WebRTC engine for one 1:1 call and for GROUP mesh conferences (#77).
 *
 * Responsibilities:
 *  - getUserMedia on demand (never on mount / never before the user acts);
 *  - one RTCPeerConnection per remote peer, with an injectable `iceServers` list;
 *  - offer/answer/ICE relay over the existing WebSocket (`call.signal`);
 *  - conference frames carry `conference:true` and `recipients:[peerId]`; 1:1
 *    frames stay byte-identical to the original contract;
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
  /** #77: injectable so tests can assert ringback/ringtone start-stop exactly. */
  ringtone?: CallRingtone;
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

/** One remote leg of a GROUP mesh conference. */
interface ConferencePeer {
  userId: string;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  /** Caller offer waiting for the user to press "Принять". */
  pendingOffer: PendingOffer | null;
  pendingCandidates: CallIceCandidate[];
  remoteDescriptionSet: boolean;
  /** Last local offer/ICE kept for a late join / presence retry. */
  offerSdp: string | null;
  sentCandidates: CallIceCandidate[];
}

export class CallController {
  private readonly options: CallControllerOptions;
  private readonly ringtone: CallRingtone;
  private state: CallState = idleCallState();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private pendingOffer: PendingOffer | null = null;
  private pendingCandidates: CallIceCandidate[] = [];
  private remoteDescriptionSet = false;
  private conferencePeers = new Map<string, ConferencePeer>();
  /**
   * #77: offers awaiting their first answer, in send order. GROUP
   * `call.unavailable` carries no recipient id (§9.5.3), so this FIFO lets the
   * caller drop the peer whose frame nobody received without touching the rest.
   */
  private pendingOfferRecipients: string[] = [];
  /** 1:1 offer/ICE kept so an offline peer can still receive the call later. */
  private directOfferSdp: string | null = null;
  private directCandidates: CallIceCandidate[] = [];
  private retryTimer: number | null = null;
  private disposed = false;

  constructor(options: CallControllerOptions) {
    this.options = options;
    this.ringtone = options.ringtone ?? createWebAudioRingtone();
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
    this.pendingOfferRecipients = [];
    this.remoteDescriptionSet = false;
    this.directOfferSdp = null;
    this.directCandidates = [];
    this.startRetryLoop();
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
    this.ringtone.startOutgoing();
    void this.beginOutgoing(callId, video);
  }

  /**
   * Start a GROUP mesh conference. One local `getUserMedia` stream is shared by
   * one RTCPeerConnection per selected peer; each peer receives its own offer
   * with `conference:true` and `recipients:[peerId]` under one `call_id`.
   */
  startConference(chatId: string, peerUserIds: readonly string[], video: boolean): void {
    if (this.disposed || this.state.phase !== 'idle') return;
    const peers = uniqueIds(peerUserIds);
    if (peers.length === 0) return;
    const callId = this.options.createId();
    this.resetResources();
    this.pendingCandidates = [];
    this.pendingOffer = null;
    this.pendingOfferRecipients = [];
    this.remoteDescriptionSet = false;
    this.directOfferSdp = null;
    this.directCandidates = [];
    this.startRetryLoop();
    this.update({
      ...idleCallState(),
      phase: 'outgoing',
      callId,
      chatId,
      direction: 'outgoing',
      video,
      peerUserId: peers.length === 1 ? (peers[0] ?? null) : null,
      mediaPending: true,
      cameraOn: video,
      conference: true,
      selectedPeerIds: peers,
      participants: peers.map((userId) => ({
        userId,
        stream: null,
        connectionState: 'new' as RTCPeerConnectionState,
      })),
    });
    this.ringtone.startOutgoing();
    void this.beginConferenceOutgoing(callId, peers, video);
  }

  private async beginConferenceOutgoing(
    callId: string,
    peers: readonly string[],
    video: boolean,
  ): Promise<void> {
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

    for (const peerUserId of peers) {
      if (callId !== this.state.callId) return;
      try {
        const peer = this.createConferencePeer(peerUserId);
        if (!peer.pc) continue;
        for (const track of stream.getTracks()) peer.pc.addTrack(track, stream);
        const offer = await peer.pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: video,
        });
        if (callId !== this.state.callId) return;
        await peer.pc.setLocalDescription(offer);
        if (callId !== this.state.callId) return;
        const sdp = peer.pc.localDescription?.sdp ?? offer.sdp ?? '';
        if (!sdp) {
          this.removeConferencePeer(peerUserId);
          continue;
        }
        peer.offerSdp = sdp;
        // A send failure means the socket is down, not that this peer is gone.
        // Keep the leg pending so a reconnect/presence retry can deliver it.
        this.dispatchConference('offer', video, { sdp }, peerUserId);
      } catch {
        this.removeConferencePeer(peerUserId);
      }
    }

    if (this.conferencePeers.size === 0) {
      this.fail('connection_failed', callId, true);
    } else {
      this.syncParticipants();
    }
  }

  /**
   * Invite one more peer into an active outgoing conference. Used by the mesh
   * "add participant" path; a duplicate id is a no-op.
   */
  addParticipant(peerUserId: string): void {
    if (!this.state.conference || this.state.phase === 'idle' || this.state.phase === 'incoming') {
      return;
    }
    if (!this.localStream || !this.state.chatId || this.conferencePeers.has(peerUserId)) return;
    const callId = this.state.callId;
    if (!callId) return;
    const peer = this.createConferencePeer(peerUserId);
    if (!peer.pc) return;
    const pc = peer.pc;
    const stream = this.localStream;
    this.update({ selectedPeerIds: uniqueIds([...this.state.selectedPeerIds, peerUserId]) });
    this.syncParticipants();
    void (async () => {
      try {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: this.state.video,
        });
        if (this.state.callId !== callId || this.conferencePeers.get(peerUserId) !== peer) return;
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
        if (!sdp) {
          this.removeConferencePeer(peerUserId);
          return;
        }
        this.dispatchConference('offer', this.state.video, { sdp }, peerUserId);
      } catch {
        this.removeConferencePeer(peerUserId);
      }
    })();
  }

  /** Drop one remote leg without ending the conference. */
  removeParticipant(peerUserId: string): void {
    if (!this.state.conference) return;
    this.sendConferenceSignal('hangup', peerUserId, this.state.video);
    this.removeConferencePeer(peerUserId);
    if (this.conferencePeers.size === 0) this.finish({ code: 'ended' });
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
      const chatId = this.state.chatId;
      if (!chatId) {
        this.fail('signaling_failed', callId);
        return;
      }
      this.directOfferSdp = sdp;
      this.dispatch(chatId, 'offer', video, { sdp });
    } catch {
      if (callId === this.state.callId) this.fail('connection_failed', callId, true);
    }
  }

  /** Accept a ringing call: only now is getUserMedia called. */
  accept(): void {
    const callId = this.state.callId;
    if (this.disposed || this.state.phase !== 'incoming' || !callId) return;
    if (this.state.conference) {
      this.ringtone.stop();
      this.update({ phase: 'connecting', mediaPending: true });
      void this.beginConferenceAnswer(callId);
      return;
    }
    const incoming = this.pendingOffer;
    if (!incoming) return;

    this.ringtone.stop();
    this.update({ phase: 'connecting', mediaPending: true });
    void this.beginAnswer(callId, incoming);
  }

  private async beginConferenceAnswer(callId: string): Promise<void> {
    const video = this.state.video;
    let stream: MediaStream;
    try {
      stream = await this.openMedia(video);
    } catch (error) {
      if (callId !== this.state.callId) return;
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
      cameraOn: video && stream.getVideoTracks().length > 0,
    });

    const peers = [...this.conferencePeers.values()];
    for (const peer of peers) {
      const offer = peer.pendingOffer;
      if (!offer || callId !== this.state.callId) continue;
      try {
        const pc = this.ensureConferencePc(peer);
        await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
        if (callId !== this.state.callId) return;
        peer.remoteDescriptionSet = true;
        peer.pendingOffer = null;
        this.dequeueOffer(peer.userId);
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        const answer = await pc.createAnswer();
        if (callId !== this.state.callId) return;
        await pc.setLocalDescription(answer);
        if (callId !== this.state.callId) return;
        const sdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
        if (!sdp) {
          this.removeConferencePeer(peer.userId);
          continue;
        }
        await this.flushConferenceCandidates(peer);
        this.dispatchConference('answer', video, { sdp }, peer.userId);
      } catch {
        this.removeConferencePeer(peer.userId);
      }
    }

    if (this.conferencePeers.size === 0) {
      this.fail('connection_failed', callId, true);
    } else {
      this.syncParticipants();
    }
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
      const chatId = this.state.chatId;
      if (!chatId) {
        this.fail('signaling_failed', callId);
        return;
      }
      this.dispatch(chatId, 'answer', incoming.video, { sdp });
    } catch {
      if (callId === this.state.callId) this.fail('connection_failed', callId, true);
    }
  }

  /** Decline a ringing call without touching media. */
  reject(): void {
    if (this.state.phase !== 'incoming' || !this.state.chatId || !this.state.callId) return;
    if (this.state.conference) {
      for (const peer of this.conferencePeers.values()) {
        this.sendConferenceSignal('hangup', peer.userId, this.state.video);
      }
      this.finish(null);
      return;
    }
    this.dispatch(this.state.chatId, 'hangup', this.state.video);
    this.finish(null);
  }

  /** End an outgoing/connected call (the UI asks for confirmation first). */
  hangup(): void {
    if (this.state.phase === 'idle') return;
    if (this.state.chatId && this.state.callId) {
      if (this.state.conference) {
        for (const peer of this.conferencePeers.values()) {
          this.sendConferenceSignal('hangup', peer.userId, this.state.video);
        }
      } else {
        this.dispatch(this.state.chatId, 'hangup', this.state.video);
      }
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
        this.handleAnswer(payload.call_id, payload.sdp, frame.from_user_id ?? null);
        break;
      case 'ice':
        this.handleRemoteIce(payload.candidate, frame.from_user_id ?? null);
        break;
      case 'hangup':
        this.handleRemoteHangup(frame.from_user_id ?? null);
        break;
      case 'busy':
        this.handleRemoteBusy(frame.from_user_id ?? null);
        break;
      default:
        break;
    }
  }

  private handleOffer(frame: IncomingCallSignal): void {
    const payload = frame.payload;
    if (!payload.sdp) return;
    const fromUserId = frame.from_user_id ?? null;
    const conference = payload.conference === true;

    if (this.state.phase !== 'idle') {
      if (this.state.callId !== payload.call_id) {
        // Another call while busy: answer with `busy` (contract §9.1). In a
        // conference this only declines the new call; the live mesh survives.
        this.sendBusy(frame.chat_id, payload.call_id, payload.video, conference, fromUserId);
        return;
      }
      if (conference && this.state.conference && fromUserId) {
        this.handleConferenceOfferFrom(frame, fromUserId);
        return;
      }
      // Same call + same offer is a duplicate relay; anything else is ignored.
      return;
    }

    this.resetResources();
    this.pendingCandidates = [];
    this.pendingOfferRecipients = [];
    this.remoteDescriptionSet = false;
    this.pendingOffer = { sdp: payload.sdp, video: payload.video };

    if (conference) {
      if (!fromUserId) return;
      const peer = this.newConferencePeer(fromUserId);
      peer.pendingOffer = { sdp: payload.sdp, video: payload.video };
      this.conferencePeers.set(peer.userId, peer);
      this.update({
        ...idleCallState(),
        phase: 'incoming',
        callId: payload.call_id,
        chatId: frame.chat_id,
        direction: 'incoming',
        video: payload.video,
        peerUserId: fromUserId,
        conference: true,
        selectedPeerIds: fromUserId ? [fromUserId] : [],
        participants: this.participantSnapshot(),
      });
      this.ringtone.startIncoming();
      return;
    }

    this.update({
      ...idleCallState(),
      phase: 'incoming',
      callId: payload.call_id,
      chatId: frame.chat_id,
      direction: 'incoming',
      video: payload.video,
      peerUserId: fromUserId,
    });
    this.ringtone.startIncoming();
  }

  /**
   * A conference offer for the call we already have. Before accept it is one
   * more ringing caller; after accept it is a mesh participant joining, which
   * this side answers so N-way audio keeps working without an SFU.
   */
  private handleConferenceOfferFrom(frame: IncomingCallSignal, fromUserId: string): void {
    const payload = frame.payload;
    if (!payload.sdp) return;
    const existing = this.conferencePeers.get(fromUserId);
    if (existing) {
      if (existing.pendingOffer || existing.remoteDescriptionSet) return;
    }

    if (this.state.phase === 'incoming' || !this.localStream) {
      const peer = existing ?? this.newConferencePeer(fromUserId);
      if (!existing) this.conferencePeers.set(fromUserId, peer);
      peer.pendingOffer = { sdp: payload.sdp, video: payload.video };
      this.update({
        selectedPeerIds: uniqueIds([...this.state.selectedPeerIds, fromUserId]),
        participants: this.participantSnapshot(),
      });
      return;
    }

    // Already connected: answer the newcomer immediately with the shared local
    // stream. This is the mesh "add participant" path on the answering side.
    const peer = existing ?? this.newConferencePeer(fromUserId);
    if (!existing) this.conferencePeers.set(fromUserId, peer);
    peer.pendingOffer = { sdp: payload.sdp, video: payload.video };
    this.update({
      selectedPeerIds: uniqueIds([...this.state.selectedPeerIds, fromUserId]),
      participants: this.participantSnapshot(),
    });
    void this.answerConferencePeer(peer);
  }

  private async answerConferencePeer(peer: ConferencePeer): Promise<void> {
    const offer = peer.pendingOffer;
    const stream = this.localStream;
    const callId = this.state.callId;
    if (!offer || !stream || !callId || !this.state.conference) return;
    try {
      const pc = this.ensureConferencePc(peer);
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      if (this.state.callId !== callId) return;
      peer.remoteDescriptionSet = true;
      peer.pendingOffer = null;
      this.dequeueOffer(peer.userId);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const answer = await pc.createAnswer();
      if (this.state.callId !== callId) return;
      await pc.setLocalDescription(answer);
      const sdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
      if (!sdp) {
        this.removeConferencePeer(peer.userId);
        return;
      }
      await this.flushConferenceCandidates(peer);
      this.dispatchConference('answer', offer.video, { sdp }, peer.userId);
      this.syncParticipants();
    } catch {
      this.removeConferencePeer(peer.userId);
    }
  }

  private handleAnswer(callId: string, sdp: string | undefined, fromUserId: string | null): void {
    if (!sdp) return;
    if (this.state.conference) {
      const peer = fromUserId ? this.conferencePeers.get(fromUserId) : undefined;
      const pc = peer?.pc;
      if (!peer || !pc) return;
      this.dequeueOffer(peer.userId);
      this.update({ phase: this.state.phase === 'connected' ? 'connected' : 'connecting' });
      void pc
        .setRemoteDescription({ type: 'answer', sdp })
        .then(async () => {
          if (this.state.callId !== callId || this.conferencePeers.get(peer.userId) !== peer) {
            return;
          }
          peer.remoteDescriptionSet = true;
          await this.flushConferenceCandidates(peer);
        })
        .catch(() => this.removeConferencePeer(peer.userId));
      return;
    }
    if (!this.pc) return;
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

  private handleRemoteIce(
    candidate: CallIceCandidate | undefined,
    fromUserId: string | null,
  ): void {
    if (!candidate || candidate.candidate.length === 0) return;
    if (this.state.conference) {
      const peer = fromUserId ? this.conferencePeers.get(fromUserId) : undefined;
      if (!peer) return;
      if (!peer.pc || !peer.remoteDescriptionSet) {
        peer.pendingCandidates.push(candidate);
        return;
      }
      void peer.pc.addIceCandidate(candidate).catch(() => {
        // A single bad candidate must not tear down the mesh.
      });
      return;
    }
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

  private async flushConferenceCandidates(peer: ConferencePeer): Promise<void> {
    const pc = peer.pc;
    if (!pc || !peer.remoteDescriptionSet) return;
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Ignore a stale candidate; ICE continues with the rest.
      }
    }
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

  /** Legacy `call.unavailable`: no longer ends a call; the peer may join later. */
  handleUnavailable(callId: string, _fromUserId: string | null = null): void {
    if (this.state.callId !== callId) return;
    // Keep ringing. Presence and the retry loop resend the offer when the peer
    // appears; a conference stays open even if every invitee is offline.
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
    this.ringtone.dispose();
  }

  /** Like `dispose`, but the controller remains reusable (logout/workspace switch). */
  stop(): void {
    this.resetResources();
    this.state = idleCallState();
  }

  private handleRemoteHangup(fromUserId: string | null): void {
    if (this.state.conference) {
      const connected = this.state.phase === 'connected';
      if (fromUserId) this.removeConferencePeer(fromUserId);
      if (this.conferencePeers.size === 0) {
        this.finish({
          code: connected
            ? 'ended'
            : this.state.direction === 'incoming'
              ? 'cancelled'
              : 'declined',
        });
      }
      return;
    }
    this.remoteHangup();
  }

  private handleRemoteBusy(fromUserId: string | null): void {
    if (this.state.conference) {
      if (fromUserId) this.removeConferencePeer(fromUserId);
      if (this.conferencePeers.size === 0) this.finish({ code: 'busy' });
      return;
    }
    this.finish({ code: 'busy' });
  }

  private remoteHangup(): void {
    const connected = this.state.phase === 'connected';
    const direction = this.state.direction;
    this.finish({
      code: connected ? 'ended' : direction === 'incoming' ? 'cancelled' : 'declined',
    });
  }

  private finish(notice: CallNotice | null): void {
    this.stopRetryLoop();
    this.resetResources();
    this.update({ ...idleCallState(), notice });
  }

  private fail(code: CallErrorCode, callId: string, notifyPeer = false): void {
    if (this.state.callId !== callId) return;
    if (notifyPeer && this.state.chatId) {
      if (this.state.conference) {
        for (const peer of this.conferencePeers.values()) {
          this.sendConferenceSignal('hangup', peer.userId, this.state.video);
        }
      } else {
        this.dispatch(this.state.chatId, 'hangup', this.state.video);
      }
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
      this.directCandidates.push(candidate);
      const chatId = this.state.chatId;
      if (chatId) this.dispatch(chatId, 'ice', this.state.video, { candidate });
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

  private newConferencePeer(userId: string): ConferencePeer {
    return {
      userId,
      pc: null,
      stream: null,
      connectionState: 'new',
      pendingOffer: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      offerSdp: null,
      sentCandidates: [],
    };
  }

  private createConferencePeer(userId: string): ConferencePeer {
    const peer = this.newConferencePeer(userId);
    this.conferencePeers.set(userId, peer);
    this.ensureConferencePc(peer);
    this.syncParticipants();
    return peer;
  }

  private ensureConferencePc(peer: ConferencePeer): RTCPeerConnection {
    if (peer.pc) return peer.pc;
    const config: RTCConfiguration = { iceServers: this.options.iceServers ?? [] };
    const pc = this.options.createPeerConnection
      ? this.options.createPeerConnection(config)
      : defaultPeerConnection(config);
    peer.pc = pc;
    peer.connectionState = pc.connectionState ?? 'new';
    peer.remoteDescriptionSet = false;

    pc.onicecandidate = (event) => {
      if (this.state.callId === null || this.conferencePeers.get(peer.userId) !== peer) return;
      const raw = event.candidate;
      if (!raw) return;
      const candidate = toIceCandidate(raw);
      if (!candidate || candidate.candidate.length === 0) return;
      peer.sentCandidates.push(candidate);
      this.sendConferenceSignal('ice', peer.userId, this.state.video, { candidate });
    };

    pc.ontrack = (event) => {
      if (this.conferencePeers.get(peer.userId) !== peer) return;
      const stream = event.streams[0] ?? createStreamFor(event.track);
      if (!stream) return;
      if (peer.stream && peer.stream !== stream) stopStream(peer.stream);
      peer.stream = stream;
      this.syncParticipants();
    };

    pc.onconnectionstatechange = () => {
      if (this.conferencePeers.get(peer.userId) !== peer) return;
      peer.connectionState = pc.connectionState;
      if (pc.connectionState === 'connected') {
        this.ringtone.stop();
        this.update({
          phase: 'connected',
          startedAt: this.state.startedAt ?? this.now(),
          participants: this.participantSnapshot(),
        });
      } else if (pc.connectionState === 'failed') {
        this.removeConferencePeer(peer.userId);
        if (this.conferencePeers.size === 0)
          this.fail('connection_failed', this.state.callId ?? '');
      } else {
        this.syncParticipants();
      }
    };

    return pc;
  }

  private removeConferencePeer(userId: string): void {
    const peer = this.conferencePeers.get(userId);
    if (!peer) return;
    this.conferencePeers.delete(userId);
    const pc = peer.pc;
    peer.pc = null;
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
    if (peer.stream) {
      stopStream(peer.stream);
      peer.stream = null;
    }
    this.dequeueOffer(userId);
    const participants = this.participantSnapshot();
    const firstStream = participants.find((participant) => participant.stream)?.stream ?? null;
    this.update({
      participants,
      remoteStream: firstStream,
      selectedPeerIds: this.state.selectedPeerIds.filter((id) => id !== userId),
    });
  }

  private dequeueOffer(userId: string): void {
    const index = this.pendingOfferRecipients.indexOf(userId);
    if (index >= 0) this.pendingOfferRecipients.splice(index, 1);
  }

  private participantSnapshot(): CallParticipant[] {
    return [...this.conferencePeers.values()].map((peer) => ({
      userId: peer.userId,
      stream: peer.stream,
      connectionState: peer.connectionState,
    }));
  }

  private syncParticipants(): void {
    const participants = this.participantSnapshot();
    const firstStream = participants.find((participant) => participant.stream)?.stream ?? null;
    this.update({ participants, remoteStream: firstStream });
  }

  private sendBusy(
    chatId: string,
    callId: string,
    video: boolean,
    conference: boolean,
    fromUserId: string | null,
  ): void {
    // GROUP busy is only addressable to its sender: never emit a conference
    // frame without recipients (the server rejects it as WS_FRAME_INVALID).
    if (conference && !fromUserId) return;
    const payload: CallSignalPayload = {
      call_id: callId,
      kind: 'busy',
      video,
      ...(conference ? { conference: true, recipients: [fromUserId as string] } : {}),
    };
    this.sendRaw(chatId, payload);
  }

  private dispatchConference(
    kind: CallSignalKind,
    video: boolean,
    extra: Pick<CallSignalPayload, 'sdp' | 'candidate'>,
    peerUserId: string,
  ): boolean {
    const callId = this.state.callId;
    const chatId = this.state.chatId;
    if (!callId || !chatId) return false;
    const payload: CallSignalPayload = {
      call_id: callId,
      kind,
      video,
      conference: true,
      recipients: [peerUserId],
      ...extra,
    };
    if ((kind === 'offer' || kind === 'answer') && !payload.sdp) {
      this.removeConferencePeer(peerUserId);
      return false;
    }
    if (payload.sdp && utf8Length(payload.sdp) > CALL_SDP_MAX_BYTES) {
      this.fail('payload_too_large', callId, true);
      return false;
    }
    if (
      kind === 'ice' &&
      payload.candidate &&
      utf8Length(JSON.stringify(payload.candidate)) > CALL_CANDIDATE_MAX_BYTES
    ) {
      this.fail('payload_too_large', callId, true);
      return false;
    }
    const sent = this.sendRaw(chatId, payload);
    if (sent && kind === 'offer' && !this.pendingOfferRecipients.includes(peerUserId)) {
      this.pendingOfferRecipients.push(peerUserId);
    }
    return sent;
  }

  private sendConferenceSignal(
    kind: CallSignalKind,
    peerUserId: string,
    video: boolean,
    extra: Pick<CallSignalPayload, 'sdp' | 'candidate'> = {},
  ): boolean {
    return this.dispatchConference(kind, video, extra, peerUserId);
  }

  private startRetryLoop(): void {
    this.stopRetryLoop();
    this.retryTimer = window.setInterval(() => this.retryPending(), 8_000);
  }

  private stopRetryLoop(): void {
    if (this.retryTimer !== null) {
      window.clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Re-deliver offers to peers that have not answered yet (late join). */
  private retryPending(): void {
    if (this.disposed || this.state.phase === 'idle' || this.state.phase === 'incoming') {
      this.stopRetryLoop();
      return;
    }
    const chatId = this.state.chatId;
    const callId = this.state.callId;
    if (!chatId || !callId) return;
    if (this.state.conference) {
      for (const peer of this.conferencePeers.values()) {
        if (peer.connectionState === 'connected' || !peer.offerSdp || !peer.pc) continue;
        if (peer.pc.connectionState === 'connected') continue;
        this.dispatchConference('offer', this.state.video, { sdp: peer.offerSdp }, peer.userId);
        for (const candidate of peer.sentCandidates) {
          this.dispatchConference('ice', this.state.video, { candidate }, peer.userId);
        }
      }
      return;
    }
    if (this.state.phase === 'outgoing' && this.directOfferSdp && this.pc) {
      if (this.pc.connectionState === 'connected') return;
      this.directOfferSdp = this.pc.localDescription?.sdp ?? this.directOfferSdp;
      this.dispatch(chatId, 'offer', this.state.video, { sdp: this.directOfferSdp });
      for (const candidate of this.directCandidates) {
        this.dispatch(chatId, 'ice', this.state.video, { candidate });
      }
    }
  }

  /** Presence ONLINE from the realtime channel: retry a pending invite now. */
  handlePresence(userId: string, online: boolean): void {
    if (!online || this.state.phase === 'idle' || this.state.phase === 'incoming') return;
    if (this.state.conference) {
      const peer = this.conferencePeers.get(userId);
      if (!peer || peer.connectionState === 'connected' || !peer.offerSdp) return;
      this.dispatchConference('offer', this.state.video, { sdp: peer.offerSdp }, userId);
      for (const candidate of peer.sentCandidates) {
        this.dispatchConference('ice', this.state.video, { candidate }, userId);
      }
      return;
    }
    if (
      this.state.peerUserId === userId &&
      this.state.phase === 'outgoing' &&
      this.directOfferSdp
    ) {
      this.dispatch(this.state.chatId ?? '', 'offer', this.state.video, {
        sdp: this.directOfferSdp,
      });
      for (const candidate of this.directCandidates) {
        this.dispatch(this.state.chatId ?? '', 'ice', this.state.video, { candidate });
      }
    }
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
    this.ringtone.stop();
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
    for (const [userId, peer] of this.conferencePeers) {
      const peerPc = peer.pc;
      peer.pc = null;
      if (peerPc) {
        peerPc.onicecandidate = null;
        peerPc.ontrack = null;
        peerPc.onconnectionstatechange = null;
        try {
          peerPc.close();
        } catch {
          // already closed
        }
      }
      if (peer.stream) stopStream(peer.stream);
      peer.stream = null;
      this.conferencePeers.delete(userId);
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
    this.pendingOfferRecipients = [];
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

/** Stable de-duplicated peer ids, preserving picker order. */
function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export type { CallDirection };
