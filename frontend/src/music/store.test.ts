import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem';
import type { MusicRoomOpen, MusicRoomTrack, MusicRoomTracks } from '../api/types';
import { FakeMediaStream } from '../test/callFakes';
import {
  createMusicRoomStore,
  type MusicAudioElement,
  type MusicAudioGraph,
  type MusicRoomStore,
  type MusicRoomStoreDeps,
} from './store';

const CHAT = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

const TRACKS: MusicRoomTrack[] = [
  {
    id: 'c1000000-0000-4000-8000-000000000001',
    message_id: 'd1000000-0000-4000-8000-000000000001',
    filename: 'sova-night.mp3',
    mime_type: 'audio/mpeg',
    duration_ms: 214_000,
    artwork_url: null,
    title: 'Ночная сова',
    artist: 'Сова',
    size_bytes: 5_242_880,
    created_at: '2026-11-19T21:10:00.000Z',
  },
  {
    id: 'c1000000-0000-4000-8000-000000000002',
    message_id: 'd1000000-0000-4000-8000-000000000002',
    filename: 'forest-walk.flac',
    mime_type: 'audio/flac',
    duration_ms: 187_500,
    artwork_url: null,
    title: 'Прогулка по лесу',
    artist: 'Анна Петрова',
    size_bytes: 31_457_280,
    created_at: '2026-11-18T09:30:00.000Z',
  },
];

class FakeAudio implements MusicAudioElement {
  src = '';
  volume = 1;
  currentTime = 0;
  duration = 214;
  playCalls = 0;
  pauseCalls = 0;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;

  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  removeAttribute(): void {
    this.src = '';
  }
}

function musicTracks(items: MusicRoomTrack[]): MusicRoomTracks {
  return {
    chat_id: CHAT,
    plugin: { plugin_id: 'music-room', enabled: true, available: true, version: '1.0.0' },
    items,
    has_more: false,
  };
}

function openResult(created: boolean): MusicRoomOpen {
  return {
    chat: {
      id: CHAT,
      type: 'GROUP',
      security_mode: 'MANAGED',
      visibility: 'PUBLIC',
      name: 'Музыкальная комната',
      last_seq: 0,
      unread_count: 0,
      created_at: '2026-11-20T10:00:00.000Z',
      join_policy: 'OPEN',
    },
    plugin: { plugin_id: 'music-room', enabled: true, available: true, version: '1.0.0' },
    created,
  };
}

interface SetupOptions {
  tracks?: MusicRoomTrack[];
  callActive?: boolean;
  mixed?: boolean;
}

function setup(options: SetupOptions = {}) {
  const api = {
    openMusicRoom: vi.fn(async () => openResult(true)),
    getMusicRoom: vi.fn(async () => musicTracks(options.tracks ?? TRACKS)),
  };
  const audio = new FakeAudio();
  const stream = new FakeMediaStream(['audio']);
  const graph: MusicAudioGraph = {
    stream: stream as unknown as MediaStream,
    resume: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  let callActive = options.callActive ?? false;
  const setCallMusic = vi.fn(() => options.mixed ?? callActive);
  const deps: MusicRoomStoreDeps = {
    api: api as unknown as MusicRoomStoreDeps['api'],
    resolveUrl: vi.fn(async () => 'https://media.example.test/track.mp3'),
    setCallMusic,
    isCallActive: () => callActive,
    createElement: () => audio,
    createGraph: () => graph,
  };
  const store: MusicRoomStore = createMusicRoomStore(deps);
  return {
    store,
    api,
    audio,
    graph,
    setCallMusic,
    setCallActive(value: boolean) {
      callActive = value;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('#94 music room store', () => {
  it('loads the metadata-only track list once per chat and retries after a failure', async () => {
    const { store, api } = setup();
    await store.ensureTracks(CHAT);
    expect(api.getMusicRoom).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      chatId: CHAT,
      status: 'ready',
      tracks: TRACKS,
      hasMore: false,
    });
    // A second ensure for the same chat does not spend another GET.
    await store.ensureTracks(CHAT);
    expect(api.getMusicRoom).toHaveBeenCalledTimes(1);

    api.getMusicRoom.mockRejectedValueOnce(
      ApiError.client('PLUGIN_NOT_ENABLED', 'Plugin is not enabled', 422),
    );
    await store.loadTracks(CHAT, true);
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().error?.code).toBe('PLUGIN_NOT_ENABLED');

    api.getMusicRoom.mockResolvedValueOnce(musicTracks(TRACKS));
    store.retryTracks();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
  });

  it('opens the room idempotently and keeps the server-created chat only from the response', async () => {
    const { store, api } = setup();
    const first = await store.open(WORKSPACE);
    const second = await store.open(WORKSPACE);
    expect(first?.created).toBe(true);
    expect(second?.chat.id).toBe(CHAT);
    expect(api.openMusicRoom).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      openStatus: 'done',
      openedChat: { id: CHAT },
      openedCreated: true,
    });

    api.openMusicRoom.mockRejectedValueOnce(ApiError.client('FORBIDDEN', 'Not a member', 403));
    expect(await store.open(WORKSPACE)).toBeNull();
    expect(store.getSnapshot().openStatus).toBe('error');
    expect(store.getSnapshot().openError?.status).toBe(403);
  });

  it('never autoplays before a user action and plays/pauses locally', async () => {
    const { store, audio } = setup();
    expect(audio.playCalls).toBe(0);
    expect(store.getSnapshot().playback.status).toBe('idle');

    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(audio.playCalls).toBe(1);
    expect(audio.src).toBe('https://media.example.test/track.mp3');
    expect(store.getSnapshot().playback).toMatchObject({
      status: 'playing',
      trackId: TRACKS[0]?.id,
    });

    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(store.getSnapshot().playback.status).toBe('paused');
    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(store.getSnapshot().playback.status).toBe('playing');
  });

  it('starts and stops host-relay mixing only while a call is active', async () => {
    const { store, setCallMusic, audio } = setup({ callActive: true, mixed: true });
    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(setCallMusic).toHaveBeenLastCalledWith(expect.anything());
    expect(store.getSnapshot().mixing).toBe(true);

    store.pause();
    expect(setCallMusic).toHaveBeenLastCalledWith(null);
    expect(store.getSnapshot().mixing).toBe(false);

    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(store.getSnapshot().mixing).toBe(true);

    // Call end: music stops and the microphone path is restored by the store's
    // bridge to CallController.
    store.handleCallState({
      phase: 'idle',
    } as Parameters<typeof store.handleCallState>[0]);
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(store.getSnapshot().playback.status).toBe('idle');
    expect(setCallMusic).toHaveBeenLastCalledWith(null);
  });

  it('clamps volume and moves through the queue', async () => {
    const { store, audio } = setup();
    store.setVolume(2);
    expect(store.getSnapshot().playback.volume).toBe(1);
    store.setVolume(-1);
    expect(store.getSnapshot().playback.volume).toBe(0);
    store.setVolume(0.35);
    expect(store.getSnapshot().playback.volume).toBe(0.35);

    await store.ensureTracks(CHAT);
    await store.playTrack(TRACKS[0] as MusicRoomTrack);
    expect(audio.volume).toBe(0.35);
    await store.next();
    expect(store.getSnapshot().playback.trackId).toBe(TRACKS[1]?.id);
    await store.previous();
    expect(store.getSnapshot().playback.trackId).toBe(TRACKS[0]?.id);
  });
});
