import { vi } from 'vitest';
import type { CallRingtone } from '../calls/ringtone';

/**
 * Deterministic getUserMedia/RTCPeerConnection fakes for the §9 call suite.
 * jsdom has neither API, and the call engine only depends on the small surface
 * below, so tests can drive ICE, tracks, connection state and failures without
 * a browser or a real peer.
 */

export class FakeMediaStreamTrack {
  readonly kind: 'audio' | 'video';
  enabled = true;
  stopped = false;

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeMediaStream {
  private readonly source: FakeMediaStreamTrack[];

  constructor(kinds: readonly ('audio' | 'video')[]) {
    this.source = kinds.map((kind) => new FakeMediaStreamTrack(kind));
  }

  getTracks(): MediaStreamTrack[] {
    return this.source as unknown as MediaStreamTrack[];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.source.filter((track) => track.kind === 'audio') as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.source.filter((track) => track.kind === 'video') as unknown as MediaStreamTrack[];
  }

  /** Test view over the same tracks, typed to expose `enabled`/`stopped`. */
  get fakeTracks(): readonly FakeMediaStreamTrack[] {
    return this.source;
  }
}

export class FakeRTCPeerConnection {
  readonly config: RTCConfiguration;
  readonly addedTracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  closed = false;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;

  constructor(config: RTCConfiguration) {
    this.config = config;
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.addedTracks.push({ track, stream });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\no=- fake-offer' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\no=- fake-answer' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  /** Test: fire the local ICE callback the way a browser would. */
  fireIceCandidate(candidate: RTCIceCandidateInit): void {
    this.onicecandidate?.({
      candidate: {
        ...candidate,
        toJSON: () => candidate,
      } as unknown as RTCIceCandidate,
    } as RTCPeerConnectionIceEvent);
  }

  /** Test: deliver a remote track (usually the peer's audio/video). */
  fireTrack(stream: MediaStream): void {
    const track = stream.getTracks()[0];
    if (!track) return;
    this.ontrack?.({ streams: [stream], track } as unknown as RTCTrackEvent);
  }

  /** Test: switch the connection state and notify the controller. */
  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }
}

export interface FakeCallMedia {
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>;
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  streams: FakeMediaStream[];
  peers: FakeRTCPeerConnection[];
  constraints: MediaStreamConstraints[];
  failNextGetUserMedia(error: unknown): void;
}

export interface FakeCallMediaOptions {
  /** Track layout for a successful getUserMedia; defaults to audio + video. */
  withVideo?: boolean;
  withAudio?: boolean;
}

export function createFakeCallMedia(options: FakeCallMediaOptions = {}): FakeCallMedia {
  const streams: FakeMediaStream[] = [];
  const peers: FakeRTCPeerConnection[] = [];
  const constraints: MediaStreamConstraints[] = [];
  let nextError: unknown = null;
  const withAudio = options.withAudio ?? true;
  const withVideo = options.withVideo ?? true;

  const getUserMedia = vi.fn(async (requested: MediaStreamConstraints): Promise<MediaStream> => {
    constraints.push(requested);
    if (nextError !== null) {
      const error = nextError;
      nextError = null;
      throw error;
    }
    const kinds: ('audio' | 'video')[] = [];
    if (withAudio && requested.audio) kinds.push('audio');
    if (withVideo && requested.video) kinds.push('video');
    const stream = new FakeMediaStream(kinds);
    streams.push(stream);
    return stream as unknown as MediaStream;
  });

  const createPeerConnection = vi.fn((config: RTCConfiguration): RTCPeerConnection => {
    const peer = new FakeRTCPeerConnection(config);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });

  return {
    mediaDevices: { getUserMedia },
    createPeerConnection,
    streams,
    peers,
    constraints,
    failNextGetUserMedia(error: unknown) {
      nextError = error;
    },
  };
}

/** DOMException-shaped media error without relying on jsdom's DOMException. */
export function fakeMediaError(name: string, message = name): { name: string; message: string } {
  return { name, message };
}

export interface FakeRingtone extends CallRingtone {
  readonly outgoingStarts: number;
  readonly incomingStarts: number;
  readonly stops: number;
  readonly disposedCount: number;
}

/** Deterministic stand-in for the WebAudio loop (#77 ringback/ringtone tests). */
export function createFakeRingtone(): FakeRingtone {
  let outgoingStarts = 0;
  let incomingStarts = 0;
  let stops = 0;
  let disposedCount = 0;
  return {
    get outgoingStarts() {
      return outgoingStarts;
    },
    get incomingStarts() {
      return incomingStarts;
    },
    get stops() {
      return stops;
    },
    get disposedCount() {
      return disposedCount;
    },
    startOutgoing() {
      outgoingStarts += 1;
    },
    startIncoming() {
      incomingStarts += 1;
    },
    stop() {
      stops += 1;
    },
    dispose() {
      disposedCount += 1;
    },
  };
}
