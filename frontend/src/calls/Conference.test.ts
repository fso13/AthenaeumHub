import { describe, expect, it, vi } from 'vitest';
import { CallController } from './CallController';
import type { CallSignalPayload } from './types';
import {
  createFakeCallMedia,
  createFakeRingtone,
  fakeMediaError,
  FakeMediaStream,
  type FakeCallMedia,
} from '../test/callFakes';

const CHAT = '55555555-5555-4555-8555-555555555555';
const CALL = '00000000-0000-4000-8000-000000000001';
const ANNA = '66666666-6666-4666-8666-666666666666';
const LENA = '88888888-8888-4888-8888-888888888888';
const MARK = '77777777-7777-4777-8777-777777777777';

function setup(media: FakeCallMedia = createFakeCallMedia()) {
  const sent: { chatId: string; payload: CallSignalPayload }[] = [];
  const ringtone = createFakeRingtone();
  const states: ReturnType<CallController['getState']>[] = [];
  const controller = new CallController({
    sendSignal: (chatId, payload) => {
      sent.push({ chatId, payload });
      return true;
    },
    onChange: (state) => states.push(state),
    createId: () => CALL,
    iceServers: [],
    now: () => 1_000,
    mediaDevices: media.mediaDevices,
    createPeerConnection: media.createPeerConnection,
    ringtone,
  });
  return { controller, sent, states, media, ringtone };
}

function incomingOffer(from: string, sdp = 'v=0\r\no=- remote', callId = CALL) {
  return {
    chat_id: CHAT,
    from_user_id: from,
    payload: {
      call_id: callId,
      kind: 'offer' as const,
      video: true,
      conference: true,
      recipients: ['self'],
      sdp,
    },
  };
}

function groupFrame(
  from: string,
  kind: 'answer' | 'ice' | 'hangup' | 'busy',
  extra: Partial<CallSignalPayload> = {},
) {
  return {
    chat_id: CHAT,
    from_user_id: from,
    payload: {
      call_id: CALL,
      kind,
      video: true,
      conference: true,
      recipients: ['self'],
      ...extra,
    },
  };
}

const offers = (sent: { payload: CallSignalPayload }[]) =>
  sent.filter((item) => item.payload.kind === 'offer');
const answers = (sent: { payload: CallSignalPayload }[]) =>
  sent.filter((item) => item.payload.kind === 'answer');
const hangups = (sent: { payload: CallSignalPayload }[]) =>
  sent.filter((item) => item.payload.kind === 'hangup');

describe('CallController GROUP mesh (#77)', () => {
  it('starts one media stream and one offer per selected peer under one call id', async () => {
    const { controller, sent, media, ringtone } = setup();
    controller.startConference(CHAT, [ANNA, LENA, MARK], true);

    await vi.waitFor(() => expect(offers(sent)).toHaveLength(3));
    expect(media.constraints).toHaveLength(1);
    expect(media.constraints[0]?.video).toMatchObject({ facingMode: 'user' });
    expect(media.peers).toHaveLength(3);
    expect(ringtone.outgoingStarts).toBe(1);

    const sentOffers = offers(sent).map((item) => item.payload);
    expect(new Set(sentOffers.map((payload) => payload.call_id))).toEqual(new Set([CALL]));
    expect(sentOffers.map((payload) => payload.recipients?.[0])).toEqual([ANNA, LENA, MARK]);
    for (const payload of sentOffers) {
      expect(payload).toMatchObject({ kind: 'offer', video: true, conference: true });
    }

    const state = controller.getState();
    expect(state.conference).toBe(true);
    expect(state.phase).toBe('outgoing');
    expect(state.selectedPeerIds).toEqual([ANNA, LENA, MARK]);
    expect(state.participants.map((item) => item.userId)).toEqual([ANNA, LENA, MARK]);
  });

  it('routes each answer and ICE candidate by from_user_id and connects the mesh', async () => {
    const { controller, sent, media, ringtone } = setup();
    controller.startConference(CHAT, [ANNA, LENA, MARK], true);
    await vi.waitFor(() => expect(media.peers).toHaveLength(3));

    controller.handleSignal(groupFrame(LENA, 'answer', { sdp: 'v=0\r\no=- answer-lena' }));
    controller.handleSignal(groupFrame(MARK, 'answer', { sdp: 'v=0\r\no=- answer-mark' }));
    await vi.waitFor(() => expect(media.peers[1]?.remoteDescription?.type).toBe('answer'));
    await vi.waitFor(() => expect(media.peers[2]?.remoteDescription?.type).toBe('answer'));
    expect(media.peers[0]?.remoteDescription).toBeNull();

    controller.handleSignal(
      groupFrame(MARK, 'ice', {
        candidate: { candidate: 'candidate:7 1 udp 1 192.0.2.30 9000 typ host' },
      }),
    );
    await vi.waitFor(() => expect(media.peers[2]?.addedCandidates).toHaveLength(1));
    expect(media.peers[0]?.addedCandidates).toHaveLength(0);
    expect(media.peers[1]?.addedCandidates).toHaveLength(0);

    // Unknown senders never leak into another participant's peer connection.
    controller.handleSignal(
      groupFrame('00000000-0000-4000-8000-000000000099', 'ice', {
        candidate: { candidate: 'candidate:8 1 udp 1 192.0.2.31 9001 typ host' },
      }),
    );
    expect(media.peers.reduce((sum, peer) => sum + peer.addedCandidates.length, 0)).toBe(1);

    media.peers[1]?.fireTrack(new FakeMediaStream(['audio', 'video']) as unknown as MediaStream);
    media.peers[1]?.simulateConnectionState('connected');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('connected'));
    expect(ringtone.stops).toBeGreaterThan(0);
    const participant = controller.getState().participants.find((item) => item.userId === LENA);
    expect(participant?.connectionState).toBe('connected');
    expect(participant?.stream).not.toBeNull();

    expect(sent.filter((item) => item.payload.kind === 'ice')).toHaveLength(0);
  });

  it('keeps the conference alive when one peer hangs up or is busy, then ends at zero', async () => {
    const { controller, sent, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA, MARK], false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(3));
    for (const peer of media.peers) peer.simulateConnectionState('connected');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('connected'));

    controller.handleSignal(groupFrame(ANNA, 'hangup'));
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([LENA, MARK]);
    expect(controller.getState().phase).toBe('connected');

    controller.handleSignal(groupFrame(LENA, 'busy'));
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([MARK]);
    expect(controller.getState().phase).toBe('connected');

    controller.handleSignal(groupFrame(MARK, 'hangup'));
    await vi.waitFor(() => expect(controller.getState().phase).toBe('idle'));
    expect(controller.getState().notice?.code).toBe('ended');
    expect(controller.getState().participants).toHaveLength(0);
    expect(media.peers.every((peer) => peer.closed)).toBe(true);
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
    expect(hangups(sent)).toHaveLength(0);
  });

  it('drops a failed leg without tearing down the remaining peers', async () => {
    const { controller, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA], true);
    await vi.waitFor(() => expect(media.peers).toHaveLength(2));

    media.peers[0]?.simulateConnectionState('failed');
    await vi.waitFor(() =>
      expect(controller.getState().participants.map((item) => item.userId)).toEqual([LENA]),
    );
    expect(controller.getState().phase).toBe('outgoing');
    expect(media.peers[0]?.closed).toBe(true);
    expect(media.peers[1]?.closed).toBe(false);
  });

  it('rings an incoming group offer, answers every caller and ends when all leave', async () => {
    const { controller, sent, media, ringtone } = setup();
    controller.handleSignal(incomingOffer(ANNA, 'v=0\r\no=- anna'));
    controller.handleSignal(incomingOffer(LENA, 'v=0\r\no=- lena'));

    expect(controller.getState()).toMatchObject({
      phase: 'incoming',
      conference: true,
      callId: CALL,
      chatId: CHAT,
    });
    expect(controller.getState().selectedPeerIds).toEqual([ANNA, LENA]);
    expect(controller.getState().participants).toHaveLength(2);
    expect(ringtone.incomingStarts).toBe(1);
    expect(media.constraints).toHaveLength(0);

    controller.handleSignal(
      groupFrame(ANNA, 'ice', {
        candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host' },
      }),
    );
    controller.handleSignal(
      groupFrame(LENA, 'ice', {
        candidate: { candidate: 'candidate:2 1 udp 1 192.0.2.2 5001 typ host' },
      }),
    );

    controller.accept();
    await vi.waitFor(() => expect(answers(sent)).toHaveLength(2));
    expect(media.constraints).toHaveLength(1);
    expect(media.peers).toHaveLength(2);
    expect(ringtone.stops).toBeGreaterThan(0);
    expect(answers(sent).map((item) => item.payload.recipients?.[0])).toEqual([ANNA, LENA]);
    for (const payload of answers(sent).map((item) => item.payload)) {
      expect(payload).toMatchObject({ conference: true, video: true });
    }
    await vi.waitFor(() => expect(media.peers[0]?.addedCandidates).toHaveLength(1));
    await vi.waitFor(() => expect(media.peers[1]?.addedCandidates).toHaveLength(1));

    media.peers[0]?.simulateConnectionState('connected');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('connected'));
    controller.handleSignal(groupFrame(ANNA, 'hangup'));
    expect(controller.getState().phase).toBe('connected');
    controller.handleSignal(groupFrame(LENA, 'hangup'));
    await vi.waitFor(() => expect(controller.getState().phase).toBe('idle'));
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
  });

  it('declines a group offer by sending hangup to every caller without media', async () => {
    const { controller, sent, media } = setup();
    controller.handleSignal(incomingOffer(ANNA));
    controller.handleSignal(incomingOffer(MARK));

    controller.reject();
    expect(controller.getState().phase).toBe('idle');
    expect(media.constraints).toHaveLength(0);
    expect(media.peers).toHaveLength(0);
    expect(hangups(sent).map((item) => item.payload.recipients?.[0])).toEqual([ANNA, MARK]);
    for (const payload of hangups(sent).map((item) => item.payload)) {
      expect(payload).toMatchObject({ conference: true, video: true });
    }
  });

  it('answers a newcomer that joins an already connected mesh', async () => {
    const { controller, sent, media } = setup();
    controller.handleSignal(incomingOffer(ANNA));
    controller.accept();
    await vi.waitFor(() => expect(answers(sent)).toHaveLength(1));
    media.peers[0]?.simulateConnectionState('connected');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('connected'));

    controller.handleSignal(incomingOffer(MARK, 'v=0\r\no=- mark'));
    await vi.waitFor(() => expect(media.peers).toHaveLength(2));
    await vi.waitFor(() => expect(answers(sent)).toHaveLength(2));
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([ANNA, MARK]);
  });

  it('invites an extra participant and can drop one explicitly', async () => {
    const { controller, sent, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA], false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(2));

    controller.addParticipant(MARK);
    await vi.waitFor(() =>
      expect(offers(sent).some((item) => item.payload.recipients?.[0] === MARK)).toBe(true),
    );
    expect(media.peers).toHaveLength(3);
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([
      ANNA,
      LENA,
      MARK,
    ]);

    controller.removeParticipant(MARK);
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([ANNA, LENA]);
    expect(media.peers[2]?.closed).toBe(true);
    expect(hangups(sent).some((item) => item.payload.recipients?.[0] === MARK)).toBe(true);
    expect(controller.getState().phase).toBe('outgoing');
  });

  it('answers busy to a different group call without touching the live mesh', async () => {
    const { controller, sent, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA], false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(2));

    controller.handleSignal(
      incomingOffer(MARK, 'v=0\r\no=- other-call', '00000000-0000-4000-8000-000000000099'),
    );
    const busy = sent.find((item) => item.payload.kind === 'busy');
    expect(busy?.payload).toMatchObject({
      conference: true,
      recipients: [MARK],
      call_id: '00000000-0000-4000-8000-000000000099',
    });
    expect(controller.getState().callId).toBe(CALL);
    expect(controller.getState().phase).toBe('outgoing');
    expect(controller.getState().participants).toHaveLength(2);
    expect(media.peers).toHaveLength(2);
  });

  it('keeps every offline invitee pending when call.unavailable is received', async () => {
    const { controller, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA, MARK], false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(3));

    controller.handleUnavailable(CALL);
    expect(controller.getState().participants.map((item) => item.userId)).toEqual([
      ANNA,
      LENA,
      MARK,
    ]);
    expect(controller.getState().phase).toBe('outgoing');

    controller.handleSignal(groupFrame(LENA, 'answer', { sdp: 'v=0\r\no=- lena' }));
    await vi.waitFor(() => expect(media.peers[1]?.remoteDescription?.type).toBe('answer'));
    controller.handleUnavailable(CALL);
    expect(controller.getState().participants.map((item) => item.userId)).toContain(ANNA);
  });

  it('retries an offline invitee when presence turns online without dropping others', async () => {
    const { controller, sent, media } = setup();
    controller.startConference(CHAT, [ANNA, LENA, MARK], false);
    await vi.waitFor(() => expect(media.peers).toHaveLength(3));
    const before = sent.filter((item) => item.payload.kind === 'offer').length;

    controller.handlePresence(ANNA, true);
    await vi.waitFor(() =>
      expect(sent.filter((item) => item.payload.kind === 'offer')).toHaveLength(before + 1),
    );
    expect(controller.getState().participants).toHaveLength(3);
    const retried = sent.filter((item) => item.payload.kind === 'offer').at(-1);
    expect(retried?.payload.recipients).toEqual([ANNA]);
    expect(controller.getState().phase).toBe('outgoing');
  });

  it('keeps 1:1 payloads free of the conference extension', async () => {
    const { controller, sent } = setup();
    controller.start(CHAT, ANNA, false);
    await vi.waitFor(() => expect(offers(sent)).toHaveLength(1));
    const payload = offers(sent)[0]?.payload;
    expect(payload).not.toHaveProperty('conference');
    expect(payload).not.toHaveProperty('recipients');
  });

  it('starts ringback on a user action and stops it on media failure', async () => {
    const media = createFakeCallMedia();
    media.failNextGetUserMedia(fakeMediaError('NotAllowedError'));
    const { controller, ringtone } = setup(media);
    controller.startConference(CHAT, [ANNA], false);
    expect(ringtone.outgoingStarts).toBe(1);
    await vi.waitFor(() => expect(controller.getState().notice?.code).toBe('permission_denied'));
    expect(ringtone.stops).toBeGreaterThan(0);
    expect(controller.getState().phase).toBe('idle');
  });
});
