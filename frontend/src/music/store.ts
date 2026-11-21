import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { MusicRoomOpen, MusicRoomTrack, MusicRoomTracks } from '../api/types';
import type { CallState } from '../calls/types';
import { createWebAudioMusicGraph } from './audioGraph';

export type MusicLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type MusicOpenStatus = 'idle' | 'opening' | 'done' | 'error';
export type MusicPlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/**
 * The small HTMLMediaElement surface the player needs. Keeping it explicit lets
 * the call suite drive playback without jsdom's unimplemented `play()` while
 * production still passes a real `Audio` element.
 */
export interface MusicAudioElement {
  src: string;
  volume: number;
  currentTime: number;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  ontimeupdate: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onplay: (() => void) | null;
  onpause: (() => void) | null;
}

/**
 * Web Audio bridge: the element plays locally and the same samples are exposed
 * as a `MediaStream` that `CallController.setIncomingMusicStream` mixes into
 * the outgoing call track. The server is never involved.
 */
export interface MusicAudioGraph {
  stream: MediaStream | null;
  resume(): Promise<void>;
  dispose(): void;
}

export type MusicAudioElementFactory = (src: string) => MusicAudioElement;
export type MusicAudioGraphFactory = (element: MusicAudioElement) => MusicAudioGraph | null;

export interface MusicPlaybackState {
  status: MusicPlaybackStatus;
  trackId: string | null;
  error: string | null;
  positionMs: number;
  durationMs: number;
  volume: number;
}

export interface MusicRoomState {
  chatId: string | null;
  status: MusicLoadStatus;
  tracks: MusicRoomTrack[];
  hasMore: boolean;
  error: ApiError | null;
  openStatus: MusicOpenStatus;
  openError: ApiError | null;
  openedChat: MusicRoomOpen['chat'] | null;
  openedCreated: boolean | null;
  playback: MusicPlaybackState;
  /** True only while the call engine confirms the mixed track is outgoing. */
  mixing: boolean;
  mixError: 'unsupported' | null;
}

export interface MusicRoomStoreDeps {
  api: Pick<ChatApi, 'openMusicRoom' | 'getMusicRoom'>;
  /** Presigned download URL of an AUDIO attachment (existing file flow). */
  resolveUrl(attachmentId: string): Promise<string>;
  /** `CallController.setIncomingMusicStream`; false when no call / no mixing. */
  setCallMusic(stream: MediaStream | null): boolean;
  isCallActive(): boolean;
  createElement?: MusicAudioElementFactory;
  createGraph?: MusicAudioGraphFactory;
}

export const EMPTY_MUSIC_PLAYBACK: MusicPlaybackState = {
  status: 'idle',
  trackId: null,
  error: null,
  positionMs: 0,
  durationMs: 0,
  volume: 0.8,
};

export const EMPTY_MUSIC_ROOM_STATE: MusicRoomState = {
  chatId: null,
  status: 'idle',
  tracks: [],
  hasMore: false,
  error: null,
  openStatus: 'idle',
  openError: null,
  openedChat: null,
  openedCreated: null,
  playback: { ...EMPTY_MUSIC_PLAYBACK },
  mixing: false,
  mixError: null,
};

function createDefaultElement(): MusicAudioElement {
  const element = new Audio();
  element.preload = 'metadata';
  return element as unknown as MusicAudioElement;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

/**
 * #94 Music Room read model + local player + host-relay bridge.
 *
 * There is no server playback state, no playlist mutation and no server bot:
 * the room's tracks are ordinary AUDIO attachments, playback is local, and the
 * music reaches call peers only while this client is in the call and mixing is
 * confirmed by `CallController`. Every state transition is driven by a user
 * action or a completed request, never by autoplay on mount.
 */
export class MusicRoomStore {
  private readonly deps: MusicRoomStoreDeps;
  private state: MusicRoomState = { ...EMPTY_MUSIC_ROOM_STATE };
  private readonly listeners = new Set<() => void>();
  private tracksPromise: Promise<void> | null = null;
  private tracksLoadId: string | null = null;
  private openPromise: Promise<MusicRoomOpen | null> | null = null;
  private element: MusicAudioElement | null = null;
  private graph: MusicAudioGraph | null = null;
  private queue: MusicRoomTrack[] = [];
  private callActive = false;
  private playToken = 0;
  private disposed = false;

  constructor(deps: MusicRoomStoreDeps) {
    this.deps = deps;
    this.callActive = deps.isCallActive();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): MusicRoomState => this.state;

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<MusicRoomState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private playback(patch: Partial<MusicPlaybackState>): void {
    this.patch({ playback: { ...this.state.playback, ...patch } });
  }

  /* ------------------------------------------------------------------ */
  /* Open + track list                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Idempotent find-or-create. The server returns the same channel on repeat,
   * so a double click never creates a second room; the in-flight promise is
   * shared for the same reason.
   */
  async open(workspaceId: string): Promise<MusicRoomOpen | null> {
    if (this.disposed || workspaceId.length === 0) return null;
    if (this.state.openStatus === 'opening' && this.openPromise) return this.openPromise;
    this.patch({ openStatus: 'opening', openError: null });
    this.openPromise = this.runOpen(workspaceId).finally(() => {
      this.openPromise = null;
    });
    return this.openPromise;
  }

  private async runOpen(workspaceId: string): Promise<MusicRoomOpen | null> {
    try {
      const result = await this.deps.api.openMusicRoom(workspaceId);
      if (this.disposed) return null;
      this.patch({
        openStatus: 'done',
        openError: null,
        openedChat: result.chat,
        openedCreated: result.created,
      });
      // Opening the room enables the plugin on the server. Seed the track cache
      // only for the room chat so the chat panel can render immediately.
      if (this.state.chatId !== result.chat.id) {
        this.patch({ chatId: result.chat.id, status: 'idle', tracks: [], error: null });
      }
      return result;
    } catch (error) {
      if (this.disposed) return null;
      this.patch({ openStatus: 'error', openError: toApiError(error) });
      return null;
    }
  }

  async ensureTracks(chatId: string): Promise<void> {
    if (this.disposed) return;
    if (this.state.status === 'ready' && this.state.chatId === chatId) return;
    if (this.state.status === 'loading' && this.tracksLoadId === chatId && this.tracksPromise) {
      return this.tracksPromise;
    }
    return this.loadTracks(chatId);
  }

  async loadTracks(chatId: string, force = false): Promise<void> {
    if (this.disposed) return;
    if (!force && this.state.status === 'ready' && this.state.chatId === chatId) return;
    if (this.state.status === 'loading' && this.tracksLoadId === chatId && this.tracksPromise) {
      return this.tracksPromise;
    }
    const sameChat = this.state.chatId === chatId;
    this.tracksLoadId = chatId;
    this.patch({
      chatId,
      status: 'loading',
      error: null,
      ...(sameChat ? {} : { tracks: [], hasMore: false }),
    });
    this.tracksPromise = this.runLoadTracks(chatId).finally(() => {
      this.tracksPromise = null;
      this.tracksLoadId = null;
    });
    return this.tracksPromise;
  }

  private async runLoadTracks(chatId: string): Promise<void> {
    try {
      const response: MusicRoomTracks = await this.deps.api.getMusicRoom(chatId);
      if (this.disposed || this.state.chatId !== chatId) return;
      this.queue = response.items;
      this.patch({
        status: 'ready',
        tracks: response.items,
        hasMore: response.has_more,
        error: null,
      });
    } catch (error) {
      if (this.disposed || this.state.chatId !== chatId) return;
      this.patch({ status: 'error', error: toApiError(error) });
    }
  }

  retryTracks(): void {
    if (this.state.chatId) void this.loadTracks(this.state.chatId, true);
  }

  /** Clear one-shot open feedback (page leave/retry after reading the error). */
  clearOpenFeedback(): void {
    if (this.state.openStatus === 'idle' && this.state.openError === null) return;
    this.patch({ openStatus: 'idle', openError: null });
  }

  /* ------------------------------------------------------------------ */
  /* Local playback                                                      */
  /* ------------------------------------------------------------------ */

  get currentTrack(): MusicRoomTrack | null {
    const id = this.state.playback.trackId;
    return id ? (this.queue.find((track) => track.id === id) ?? null) : null;
  }

  /** Start a track from the list; repeated presses toggle play/pause. */
  async playTrack(track: MusicRoomTrack): Promise<void> {
    if (this.disposed) return;
    const currentId = this.state.playback.trackId;
    if (currentId === track.id) {
      if (this.state.playback.status === 'playing') {
        this.pause();
        return;
      }
      if (this.state.playback.status === 'paused') {
        await this.resume();
        return;
      }
    }
    await this.start(track);
  }

  async toggle(): Promise<void> {
    const track = this.currentTrack;
    if (track) {
      await this.playTrack(track);
      return;
    }
    const first = this.queue[0];
    if (first) await this.start(first);
  }

  private async start(track: MusicRoomTrack): Promise<void> {
    const element = this.ensureElement();
    if (!element) return;
    const token = ++this.playToken;
    this.playback({
      status: 'loading',
      trackId: track.id,
      error: null,
      positionMs: 0,
      durationMs: track.duration_ms ?? 0,
    });
    try {
      const url = await this.deps.resolveUrl(track.id);
      if (this.disposed || token !== this.playToken) return;
      element.src = url;
      element.volume = this.state.playback.volume;
      element.currentTime = 0;
      this.ensureGraph();
      await this.graph?.resume().catch(() => undefined);
      await element.play();
      if (this.disposed || token !== this.playToken) return;
      this.playback({ status: 'playing', error: null });
      this.syncCall();
    } catch {
      if (this.disposed || token !== this.playToken) return;
      this.playback({ status: 'error', error: 'play_failed' });
      this.syncCall();
    }
  }

  pause(): void {
    if (this.state.playback.status !== 'playing' && this.state.playback.status !== 'loading') {
      return;
    }
    this.playToken += 1;
    this.element?.pause();
    this.playback({ status: 'paused' });
    this.syncCall();
  }

  async resume(): Promise<void> {
    const element = this.element;
    if (!element || this.state.playback.status === 'playing') return;
    try {
      await this.graph?.resume().catch(() => undefined);
      await element.play();
      this.playback({ status: 'playing', error: null });
      this.syncCall();
    } catch {
      this.playback({ status: 'error', error: 'play_failed' });
      this.syncCall();
    }
  }

  /** Strictly user/call-lifecycle initiated; never called on mount. */
  stop(): void {
    this.playToken += 1;
    this.element?.pause();
    this.element?.removeAttribute('src');
    this.playback({ ...EMPTY_MUSIC_PLAYBACK, volume: this.state.playback.volume });
    this.patch({ mixing: false, mixError: null });
    this.deps.setCallMusic(null);
  }

  async next(): Promise<void> {
    const next = this.adjacent(1);
    if (next) await this.start(next);
    else this.stop();
  }

  async previous(): Promise<void> {
    const previous = this.adjacent(-1);
    if (previous) await this.start(previous);
  }

  private adjacent(direction: 1 | -1): MusicRoomTrack | null {
    const id = this.state.playback.trackId;
    const index = this.queue.findIndex((track) => track.id === id);
    if (index < 0) return this.queue[0] ?? null;
    return this.queue[index + direction] ?? null;
  }

  setVolume(value: number): void {
    const volume = clampVolume(value);
    if (this.element) this.element.volume = volume;
    this.playback({ volume });
  }

  /** The music-only stream that the call engine mixes into the outgoing track. */
  getStream(): MediaStream | null {
    return this.graph?.stream ?? null;
  }

  private ensureElement(): MusicAudioElement | null {
    if (this.element) return this.element;
    try {
      const element = (this.deps.createElement ?? createDefaultElement)('');
      element.volume = this.state.playback.volume;
      element.onloadedmetadata = () => {
        const duration = element.duration;
        if (Number.isFinite(duration) && duration > 0) {
          this.playback({ durationMs: Math.round(duration * 1000) });
        }
      };
      element.ontimeupdate = () => {
        if (Number.isFinite(element.currentTime)) {
          this.playback({ positionMs: Math.round(element.currentTime * 1000) });
        }
      };
      element.onended = () => {
        const next = this.adjacent(1);
        if (next) void this.start(next);
        else this.stop();
      };
      element.onerror = () => {
        this.playback({ status: 'error', error: 'play_failed' });
        this.syncCall();
      };
      this.element = element;
      return element;
    } catch {
      this.patch({ mixError: 'unsupported' });
      return null;
    }
  }

  private ensureGraph(): void {
    if (this.graph || !this.element) return;
    const factory = this.deps.createGraph ?? createWebAudioMusicGraph;
    try {
      this.graph = factory(this.element);
    } catch {
      this.graph = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Call relay                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Called by the chat store for every call-state change. On call end the
   * music stops (and the controller restores the microphone); while the call
   * is active the mixed stream is re-armed so a newly connected peer hears it.
   */
  handleCallState(call: CallState): void {
    const active = call.phase !== 'idle';
    const wasActive = this.callActive;
    this.callActive = active;
    if (wasActive && !active) {
      if (this.state.playback.status === 'playing') {
        this.stop();
      } else {
        this.patch({ mixing: false, mixError: null });
        this.deps.setCallMusic(null);
      }
      return;
    }
    if (!active) return;
    if (this.state.playback.status === 'playing') this.syncCall();
  }

  private syncCall(): void {
    if (!this.deps.isCallActive() || this.state.playback.status !== 'playing') {
      const hadMix = this.state.mixing;
      if (hadMix) this.deps.setCallMusic(null);
      if (hadMix || this.state.mixError !== null) this.patch({ mixing: false, mixError: null });
      return;
    }
    const stream = this.getStream();
    if (!stream) {
      this.deps.setCallMusic(null);
      this.patch({ mixing: false, mixError: 'unsupported' });
      return;
    }
    const mixed = this.deps.setCallMusic(stream);
    this.patch({ mixing: mixed, mixError: null });
  }
}

export function createMusicRoomStore(deps: MusicRoomStoreDeps): MusicRoomStore {
  return new MusicRoomStore(deps);
}
