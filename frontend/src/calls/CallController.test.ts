import { describe, expect, it, vi } from 'vitest';
import { CallController } from './CallController';
import type { CallSignalPayload } from './types';
import {
  createFakeCallMedia,
  FakeMediaStream,
  fakeMediaError,
  type FakeCallMedia,
} from '../test/callFakes';

const CHAT = '55555555-5555-4555-8555-555555555555';
const CALL = '00000000-0000-4000-8000-000000000001';
const PEER = '66666666-6666-4666-8666-666666666666';

function setup(media: FakeCallMedia = createFakeCallMedia()) {
  const sent: { chatId: string; payload: CallSignalPayload }[] = [];
  const states: ReturnType<CallController['getState']>[] = [];
  const controller = new CallController({
    sendSignal: (chatId, payload) => {
      sent.push({ chatId, payload });
      return true;
    },
    onChange: (state) => states.push(state),
    createId: () => CALL,
    iceServers: [{ urls: 'stun:stun.example.test:3478' }],
    now: () => 1_000,
    mediaDevices: media.mediaDevices,
    createPeerConnection: media.createPeerConnection,
  });
  return { controller, sent, states, media };
}

function offer(overrides: Partial<CallSignalPayload> = {}) {
  return {
    chat_id: CHAT,
    from_user_id: PEER,
    payload: {
      call_id: CALL,
      kind: 'offer' as const,
      video: true,
      sdp: 'v=0\r\no=- remote-offer',
      ...overrides,
    },
  };
}

describe('CallController', () => {
  it('does not touch media or the peer connection before the user starts a call', () => {
    const { media } = setup();
    expect(media.constraints).toHaveLength(0);
    expect(media.peers).toHaveLength(0);
  });

  it('starts an audio call with audio-only constraints and relays the offer', async () => {
    const { controller, sent, media } = setup();
    controller.start(CHAT, PEER, false);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(media.constraints[0]?.audio).toBeTruthy();
    expect(media.constraints[0]?.video).toBe(false);
    expect(media.peers[0]?.config.iceServers).toEqual([{ urls: 'stun:stun.example.test:3478' }]);
    expect(sent[0]?.payload).toMatchObject({
      call_id: CALL,
      kind: 'offer',
      video: false,
      sdp: 'v=0\r\no=- fake-offer',
    });
    expect(controller.getState().phase).toBe('outgoing');
  });

  it('accepts an incoming video call only after accept() and buffers early ICE', async () => {
    const { controller, sent, media } = setup();
    controller.handleSignal(offer());
    expect(controller.getState()).toMatchObject({
      phase: 'incoming',
      callId: CALL,
      chatId: CHAT,
      video: true,
      peerUserId: PEER,
    });
    expect(media.constraints).toHaveLength(0);

    controller.handleSignal({
      chat_id: CHAT,
      from_user_id: PEER,
      payload: {
        call_id: CALL,
        kind: 'ice',
        video: true,
        candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0' },
      },
    });
    controller.accept();

    await vi.waitFor(() => expect(sent.some((item) => item.payload.kind === 'answer')).toBe(true));
    await vi.waitFor(() => expect(media.peers[0]?.addedCandidates).toHaveLength(1));
    expect(media.peers[0]?.remoteDescription?.type).toBe('offer');
    expect(media.constraints[0]?.video).toBeTruthy();
  });

  it('relays local ICE and applies remote candidates', async () => {
    const { controller, sent, media } = setup();
    controller.start(CHAT, PEER, false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(1));

    media.peers[0]?.fireIceCandidate({
      candidate: 'candidate:2 1 udp 1 192.0.2.2 6000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await vi.waitFor(() => expect(sent.some((item) => item.payload.kind === 'ice')).toBe(true));
    const ice = sent.find((item) => item.payload.kind === 'ice');
    expect(ice?.payload.candidate).toMatchObject({
      candidate: 'candidate:2 1 udp 1 192.0.2.2 6000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    controller.handleSignal({
      chat_id: CHAT,
      from_user_id: PEER,
      payload: {
        call_id: CALL,
        kind: 'answer',
        video: false,
        sdp: 'v=0\r\no=- answer',
      },
    });
    await vi.waitFor(() => expect(media.peers[0]?.remoteDescription?.type).toBe('answer'));
    controller.handleSignal({
      chat_id: CHAT,
      from_user_id: PEER,
      payload: {
        call_id: CALL,
        kind: 'ice',
        video: false,
        candidate: { candidate: 'candidate:3 1 udp 1 192.0.2.3 7000 typ host' },
      },
    });
    await vi.waitFor(() => expect(media.peers[0]?.addedCandidates).toHaveLength(1));
  });

  it('toggles mute/camera on the local tracks and stops them on hangup', async () => {
    const { controller, sent, media } = setup();
    controller.start(CHAT, PEER, true);
    await vi.waitFor(() => expect(media.peers).toHaveLength(1));

    controller.accept(); // not an incoming call: must be a no-op
    expect(controller.getState().phase).toBe('outgoing');
    controller.toggleMute();
    controller.toggleCamera();

    const stream = media.streams[0];
    expect(stream?.fakeTracks.find((track) => track.kind === 'audio')?.enabled).toBe(false);
    expect(stream?.fakeTracks.find((track) => track.kind === 'video')?.enabled).toBe(false);
    expect(controller.getState()).toMatchObject({ muted: true, cameraOn: false });

    controller.hangup();
    expect(sent.some((item) => item.payload.kind === 'hangup')).toBe(true);
    expect(controller.getState().phase).toBe('idle');
    expect(stream?.fakeTracks.every((track) => track.stopped)).toBe(true);
    expect(media.peers[0]?.closed).toBe(true);
  });

  it('sends busy for a second offer while a call is active', async () => {
    const { controller, sent, media } = setup();
    controller.start(CHAT, PEER, false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(1));

    controller.handleSignal(
      offer({
        call_id: '00000000-0000-4000-8000-000000000002',
        sdp: 'v=0\r\no=- second',
      }),
    );
    const busy = sent.find((item) => item.payload.kind === 'busy');
    expect(busy?.payload.call_id).toBe('00000000-0000-4000-8000-000000000002');
    expect(controller.getState().callId).toBe(CALL);
  });

  it('maps getUserMedia errors and never creates a peer connection', async () => {
    const media = createFakeCallMedia();
    media.failNextGetUserMedia(fakeMediaError('NotAllowedError'));
    const { controller, sent } = setup(media);

    controller.start(CHAT, PEER, false);
    await vi.waitFor(() => expect(controller.getState().notice?.code).toBe('permission_denied'));
    expect(controller.getState().phase).toBe('idle');
    expect(media.peers).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('ends the attempt on call.unavailable and ignores stale call ids', async () => {
    const { controller, media } = setup();
    controller.start(CHAT, PEER, false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(1));

    controller.handleUnavailable('00000000-0000-4000-8000-000000000099');
    expect(controller.getState().phase).toBe('outgoing');

    controller.handleUnavailable(CALL);
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      notice: { code: 'peer_offline' },
    });
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
  });

  it('sets remote video from ontrack and reports a failed connection', async () => {
    const { controller, sent, media } = setup();
    controller.start(CHAT, PEER, true);
    await vi.waitFor(() => expect(media.peers).toHaveLength(1));
    const remote = new FakeMediaStream(['audio', 'video']);
    media.peers[0]?.fireTrack(remote as unknown as MediaStream);
    expect(controller.getState().remoteStream).toBe(remote);

    media.peers[0]?.simulateConnectionState('failed');
    await vi.waitFor(() => expect(sent.some((item) => item.payload.kind === 'hangup')).toBe(true));
    expect(controller.getState().notice?.code).toBe('connection_failed');
    expect(controller.getState().phase).toBe('idle');
  });
});
