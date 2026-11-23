import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mockSentCallSignals,
  publishMockCallSignal,
  publishMockCallUnavailable,
  type MockCallSignal,
} from '../mocks/realtime';
import { IDS } from '../mocks/fixtures';
import type { ChatStore } from '../store/chatStore';
import {
  createFakeCallMedia,
  createFakeRingtone,
  FakeMediaStream,
  fakeMediaError,
} from '../test/callFakes';
import { renderApp } from '../test/renderApp';
import { readCallOutputVolume, writeCallOutputVolume } from '../prefs/devicePreferences';

const CALL = '00000000-0000-4000-8000-000000000001';
const OTHER_CALL = '00000000-0000-4000-8000-000000000002';
const stores: ChatStore[] = [];

function renderCalls() {
  const media = createFakeCallMedia();
  const ringtone = createFakeRingtone();
  const result = renderApp({ realtimeEnabled: true }, null, {
    mediaDevices: media.mediaDevices,
    createPeerConnection: media.createPeerConnection,
    ringtone,
  });
  stores.push(result.store);
  return { ...result, media, ringtone };
}

async function waitForOnline(store: ChatStore): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await vi.waitFor(
    () => {
      expect(store.getSnapshot().realtimeStatus).toBe('online');
    },
    { timeout: 5_000 },
  );
}

async function openDirect(user: ReturnType<typeof renderCalls>['user']): Promise<void> {
  const nav = screen.getByRole('navigation', { name: 'Чаты' });
  await user.click(within(nav).getByRole('button', { name: /Анна Петрова/ }));
  await screen.findByRole('heading', { name: 'Анна Петрова' });
}

function callButton(container: HTMLElement, kind: 'call' | 'video' = 'call'): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`.chat-head__${kind}`);
  if (!button) throw new Error(`missing .chat-head__${kind}`);
  return button;
}

async function startOutgoing(
  user: ReturnType<typeof renderCalls>['user'],
  container: HTMLElement,
  media: ReturnType<typeof createFakeCallMedia>,
  video = false,
): Promise<{ callId: string; offer: MockCallSignal }> {
  await user.click(callButton(container, video ? 'video' : 'call'));
  await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
  await vi.waitFor(() =>
    expect(mockSentCallSignals().some((item) => item.payload.kind === 'offer')).toBe(true),
  );
  const offer = mockSentCallSignals().find((item) => item.payload.kind === 'offer');
  if (!offer) throw new Error('offer was not sent');
  return { callId: offer.payload.call_id, offer };
}

async function answerAndConnect(
  media: ReturnType<typeof createFakeCallMedia>,
  callId: string,
  video: boolean,
): Promise<void> {
  // Let the answer promise settle after the synchronous frame delivery.
  await act(async () => {
    publishMockCallSignal({
      chat_id: IDS.directChat,
      from_user_id: IDS.anna,
      payload: { call_id: callId, kind: 'answer', video, sdp: 'v=0\r\no=- answer' },
    });
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(media.peers[0]?.remoteDescription?.type).toBe('answer'));
  act(() => media.peers[0]?.simulateConnectionState('connected'));
  await screen.findByText('Звонок идёт');
}

async function openGroupPicker(
  user: ReturnType<typeof renderCalls>['user'],
  container: HTMLElement,
  video = false,
): Promise<HTMLElement> {
  await user.click(callButton(container, video ? 'video' : 'call'));
  const dialog = await screen.findByRole('dialog', { name: 'Новый звонок' });
  await within(dialog).findByRole('checkbox', { name: 'Анна Петрова' });
  return dialog;
}

async function startGroupConference(
  user: ReturnType<typeof renderCalls>['user'],
  container: HTMLElement,
  media: ReturnType<typeof createFakeCallMedia>,
  video = false,
): Promise<{ callId: string; dialog: HTMLElement }> {
  const dialog = await openGroupPicker(user, container, video);
  await user.click(within(dialog).getByRole('button', { name: 'Выбрать всех' }));
  await user.click(within(dialog).getByRole('button', { name: 'Позвонить' }));
  await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
  await vi.waitFor(() =>
    expect(mockSentCallSignals().filter((item) => item.payload.kind === 'offer')).toHaveLength(3),
  );
  const offer = mockSentCallSignals().find((item) => item.payload.kind === 'offer');
  if (!offer) throw new Error('group offer was not sent');
  return { callId: offer.payload.call_id, dialog };
}

/** Answer all three mesh offers and connect every fake peer. */
async function answerGroup(
  media: ReturnType<typeof createFakeCallMedia>,
  callId: string,
  video: boolean,
): Promise<void> {
  const peers = [
    { peer: media.peers[0], userId: IDS.anna },
    { peer: media.peers[1], userId: IDS.lena },
    { peer: media.peers[2], userId: IDS.mark },
  ];
  await act(async () => {
    for (const { userId } of peers) {
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: userId,
        payload: {
          call_id: callId,
          kind: 'answer',
          video,
          conference: true,
          recipients: [IDS.user],
          sdp: `v=0\r\no=- answer-${userId}`,
        },
      });
    }
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(peers.every(({ peer }) => peer?.remoteDescription)).toBe(true));
  act(() => {
    for (const { peer } of peers) {
      peer?.simulateConnectionState('connected');
      peer?.fireTrack(
        new FakeMediaStream(video ? ['audio', 'video'] : ['audio']) as unknown as MediaStream,
      );
    }
  });
  await screen.findByText('Звонок идёт');
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('1:1 calls', () => {
  it('enables GROUP call actions and opens the participant picker', async () => {
    const { user, container, store } = renderCalls();
    await waitForOnline(store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const phone = callButton(container, 'call');
    const video = callButton(container, 'video');
    expect(phone).toBeEnabled();
    expect(video).toBeEnabled();
    expect(phone).toHaveAttribute('title', 'Позвонить');

    const dialog = await openGroupPicker(user, container);
    expect(within(dialog).getByText(/Кому позвонить:/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Позвонить' })).toBeDisabled();
    expect(within(dialog).queryByRole('checkbox', { name: /Дмитрий/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Анна Петрова' })).not.toBeChecked();
  });

  it('opens the picker from the details call row as well as the header', async () => {
    const { user, container, store } = renderCalls();
    await waitForOnline(store);
    const details = container.querySelector<HTMLElement>('.details');
    expect(details).not.toBeNull();
    await user.click(within(details as HTMLElement).getByRole('button', { name: 'Позвонить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый звонок' });
    expect(within(dialog).getByRole('button', { name: 'Позвонить' })).toBeDisabled();
  });

  it('lets the picker select one member and start a 1-peer conference', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);

    const dialog = await openGroupPicker(user, container);
    const call = within(dialog).getByRole('button', { name: 'Позвонить' });
    expect(call).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Лена Волкова' }));
    expect(call).toBeEnabled();
    await user.click(call);

    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    await vi.waitFor(() =>
      expect(mockSentCallSignals().filter((item) => item.payload.kind === 'offer')).toHaveLength(1),
    );
    const offer = mockSentCallSignals().find((item) => item.payload.kind === 'offer');
    expect(offer?.payload).toMatchObject({
      kind: 'offer',
      video: false,
      conference: true,
      recipients: [IDS.lena],
    });
    expect(screen.queryByRole('dialog', { name: 'Новый звонок' })).not.toBeInTheDocument();
  });

  it('starts an audio call, relays offer/ICE, connects, mutes and confirms hangup', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);

    expect(callButton(container, 'call')).toBeEnabled();
    const { callId, offer } = await startOutgoing(user, container, media);
    expect(offer.payload).toMatchObject({ call_id: callId, kind: 'offer', video: false });
    expect(media.constraints[0]?.audio).toBeTruthy();
    expect(media.constraints[0]?.video).toBe(false);
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(/Анна Петрова/);
    expect(screen.getByText('Вызываем…')).toBeInTheDocument();

    await answerAndConnect(media, callId, false);
    expect(screen.getByText('0:00')).toBeInTheDocument();

    act(() =>
      media.peers[0]?.fireIceCandidate({
        candidate: 'candidate:1 1 udp 1 192.0.2.10 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      }),
    );
    await vi.waitFor(() =>
      expect(mockSentCallSignals().some((item) => item.payload.kind === 'ice')).toBe(true),
    );
    const ice = mockSentCallSignals().find((item) => item.payload.kind === 'ice');
    expect(ice?.payload.candidate?.candidate).toContain('192.0.2.10');
    expect(ice?.payload).not.toHaveProperty('sdp');

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: callId,
          kind: 'ice',
          video: false,
          candidate: { candidate: 'candidate:9 1 udp 1 192.0.2.11 6000 typ host' },
        },
      }),
    );
    await vi.waitFor(() => expect(media.peers[0]?.addedCandidates).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Выключить микрофон' }));
    expect(media.streams[0]?.fakeTracks.find((track) => track.kind === 'audio')?.enabled).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Включить микрофон' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Завершить звонок' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Завершить звонок?' });
    expect(store.getSnapshot().call.phase).toBe('connected');
    await user.click(within(confirm).getByRole('button', { name: 'Завершить' }));

    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    expect(mockSentCallSignals().some((item) => item.payload.kind === 'hangup')).toBe(true);
    expect(media.peers[0]?.closed).toBe(true);
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('runs a video call with local preview, remote track, camera toggle and Escape confirmation', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);

    const { callId, offer } = await startOutgoing(user, container, media, true);
    expect(offer.payload.video).toBe(true);
    expect(media.constraints[0]?.video).toMatchObject({ facingMode: 'user' });
    expect(await screen.findByLabelText('Ваше видео')).toBeInTheDocument();

    await answerAndConnect(media, callId, true);
    act(() =>
      media.peers[0]?.fireTrack(new FakeMediaStream(['audio', 'video']) as unknown as MediaStream),
    );
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Видео собеседника')).toHaveClass('is-video'),
    );

    await user.click(screen.getByRole('button', { name: 'Выключить камеру' }));
    expect(media.streams[0]?.fakeTracks.find((track) => track.kind === 'video')?.enabled).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Включить камеру' })).toBeInTheDocument();
    expect(container.querySelector('.call-local')).toHaveClass('is-off');

    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Завершить звонок?' });
    expect(store.getSnapshot().call.phase).toBe('connected');
    await user.click(within(confirm).getByRole('button', { name: 'Продолжить разговор' }));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(store.getSnapshot().call.phase).toBe('connected');

    await user.click(screen.getByRole('button', { name: 'Завершить звонок' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Завершить' }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
  });

  it('shows an incoming call on another chat, traps focus, accepts with buffered ICE and ends on peer hangup', async () => {
    const { user, store, media } = renderCalls();
    await waitForOnline(store);
    expect(store.getSnapshot().activeChatId).toBe(IDS.groupChat);

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: { call_id: CALL, kind: 'offer', video: true, sdp: 'v=0\r\no=- remote' },
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Анна Петрова')).toBeInTheDocument();
    expect(within(dialog).getByText('Входящий видеозвонок')).toBeInTheDocument();
    expect(store.getSnapshot().activeChatId).toBe(IDS.groupChat);
    await vi.waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Принять' })).toHaveFocus(),
    );

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: CALL,
          kind: 'ice',
          video: true,
          candidate: { candidate: 'candidate:5 1 udp 1 192.0.2.20 7000 typ host' },
        },
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Принять' }));

    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    expect(media.constraints[0]?.video).toBeTruthy();
    await vi.waitFor(() =>
      expect(mockSentCallSignals().some((item) => item.payload.kind === 'answer')).toBe(true),
    );
    await vi.waitFor(() => expect(media.peers[0]?.addedCandidates).toHaveLength(1));

    act(() => media.peers[0]?.simulateConnectionState('connected'));
    await screen.findByText('Звонок идёт');

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: { call_id: CALL, kind: 'hangup', video: true },
      }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    expect(document.querySelector('.call-notice')).toHaveTextContent('Звонок завершён');
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
  });

  it('declines an incoming call without requesting media and sends hangup', async () => {
    const { user, store, media } = renderCalls();
    await waitForOnline(store);

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: { call_id: CALL, kind: 'offer', video: false, sdp: 'v=0\r\no=- remote' },
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Входящий звонок')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отклонить' }));

    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    expect(media.constraints).toHaveLength(0);
    expect(media.peers).toHaveLength(0);
    expect(mockSentCallSignals().some((item) => item.payload.kind === 'hangup')).toBe(true);
  });

  it('answers a second offer with busy while a call is active', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);
    await startOutgoing(user, container, media);

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: OTHER_CALL,
          kind: 'offer',
          video: false,
          sdp: 'v=0\r\no=- second',
        },
      }),
    );
    await vi.waitFor(() =>
      expect(mockSentCallSignals().some((item) => item.payload.kind === 'busy')).toBe(true),
    );
    const busy = mockSentCallSignals().find((item) => item.payload.kind === 'busy');
    expect(busy?.payload.call_id).toBe(OTHER_CALL);
    expect(store.getSnapshot().call.phase).toBe('outgoing');
  });

  it('shows a permission error and keeps the call closed', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);
    media.failNextGetUserMedia(fakeMediaError('NotAllowedError'));

    await user.click(callButton(container, 'call'));
    const notice = await waitFor(() => {
      const element = document.querySelector('.call-notice');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(notice).toHaveTextContent('Нет доступа к микрофону или камере');
    expect(store.getSnapshot().call.phase).toBe('idle');
    expect(media.peers).toHaveLength(0);
    await user.click(within(notice).getByRole('button', { name: 'Скрыть уведомление о звонке' }));
    expect(document.querySelector('.call-notice')).toBeNull();
  });

  it('shows a device error for a video call', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);
    media.failNextGetUserMedia(fakeMediaError('NotFoundError'));

    await user.click(callButton(container, 'video'));
    await vi.waitFor(() =>
      expect(document.querySelector('.call-notice')).toHaveTextContent(
        'Микрофон или камера недоступны',
      ),
    );
    expect(store.getSnapshot().call.phase).toBe('idle');
  });

  it('keeps ringing when the peer has no live session', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);
    const { callId } = await startOutgoing(user, container, media);

    act(() => publishMockCallUnavailable({ chat_id: IDS.directChat, call_id: callId }));
    await waitFor(() => expect(store.getSnapshot().call.phase).toBe('outgoing'));
    expect(document.querySelector('.call-notice')).toBeNull();
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(false);
  });

  it('reports a failed peer connection and cleans up', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);
    const { callId } = await startOutgoing(user, container, media, true);
    await answerAndConnect(media, callId, true);

    act(() => media.peers[0]?.simulateConnectionState('failed'));
    await vi.waitFor(() =>
      expect(document.querySelector('.call-notice')).toHaveTextContent(
        'Не удалось установить соединение',
      ),
    );
    expect(store.getSnapshot().call.phase).toBe('idle');
    await vi.waitFor(() =>
      expect(mockSentCallSignals().some((item) => item.payload.kind === 'hangup')).toBe(true),
    );
  });

  it('passes an axe audit with the incoming call dialog open', async () => {
    const { store } = renderCalls();
    await waitForOnline(store);
    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: { call_id: CALL, kind: 'offer', video: true, sdp: 'v=0\r\no=- remote' },
      }),
    );
    const dialog = await screen.findByRole('dialog');

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    expect(dialog).toBeInTheDocument();
  });
});

describe('GROUP mesh calls (#77)', () => {
  it('runs a 3-peer mesh: one local stream, three offers, routed answers/ICE and a video grid', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);

    const { callId } = await startGroupConference(user, container, media, true);
    expect(media.constraints).toHaveLength(1);
    expect(media.constraints[0]?.video).toMatchObject({ facingMode: 'user' });
    expect(media.peers).toHaveLength(3);

    const offers = mockSentCallSignals().filter((item) => item.payload.kind === 'offer');
    expect(offers.map((item) => item.payload.recipients?.[0]).sort()).toEqual(
      [IDS.anna, IDS.lena, IDS.mark].sort(),
    );
    for (const offer of offers) {
      expect(offer.payload).toMatchObject({
        call_id: callId,
        kind: 'offer',
        video: true,
        conference: true,
      });
      expect(offer.payload).not.toHaveProperty('sdp', '');
    }

    await answerGroup(media, callId, true);

    const tiles = container.querySelectorAll('.call-tile');
    expect(tiles).toHaveLength(4);
    expect(container.querySelectorAll('.call-tile.is-video')).toHaveLength(4);
    const names = [...container.querySelectorAll('.call-tile__name')].map(
      (element) => element.textContent,
    );
    expect(names).toEqual(expect.arrayContaining(['Анна Петрова', 'Лена Волкова', 'Марк Соколов']));
    expect(screen.getByText('Участников: 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Ваше видео')).toBeInTheDocument();

    // ICE is routed to the leg of the participant that sent it.
    act(() =>
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.mark,
        payload: {
          call_id: callId,
          kind: 'ice',
          video: true,
          conference: true,
          recipients: [IDS.user],
          candidate: { candidate: 'candidate:7 1 udp 1 192.0.2.40 9000 typ host' },
        },
      }),
    );
    await vi.waitFor(() => expect(media.peers[2]?.addedCandidates).toHaveLength(1));
    expect(media.peers[0]?.addedCandidates).toHaveLength(0);
    expect(media.peers[1]?.addedCandidates).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Выключить микрофон' }));
    expect(media.streams[0]?.fakeTracks.find((track) => track.kind === 'audio')?.enabled).toBe(
      false,
    );
    await user.click(screen.getByRole('button', { name: 'Выключить камеру' }));
    expect(container.querySelector('.call-tile--local')).not.toHaveClass('is-video');
  });

  it('removes one participant without ending the call and ends at zero remotes', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    const { callId } = await startGroupConference(user, container, media, false);
    await answerGroup(media, callId, false);
    expect(container.querySelectorAll('.call-tile')).toHaveLength(4);

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: callId,
          kind: 'hangup',
          video: false,
          conference: true,
          recipients: [IDS.user],
        },
      }),
    );
    await vi.waitFor(() => expect(container.querySelectorAll('.call-tile')).toHaveLength(3));
    expect(store.getSnapshot().call.phase).toBe('connected');
    expect(screen.getByText('Участников: 3')).toBeInTheDocument();

    act(() => {
      for (const userId of [IDS.lena, IDS.mark]) {
        publishMockCallSignal({
          chat_id: IDS.groupChat,
          from_user_id: userId,
          payload: {
            call_id: callId,
            kind: 'hangup',
            video: false,
            conference: true,
            recipients: [IDS.user],
          },
        });
      }
    });
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    expect(document.querySelector('.call-notice')).toHaveTextContent('Звонок завершён');
    expect(media.peers.every((peer) => peer.closed)).toBe(true);
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
  });

  it('rings an incoming group call, accepts and answers every caller', async () => {
    const { user, store, media } = renderCalls();
    await waitForOnline(store);

    act(() => {
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: CALL,
          kind: 'offer',
          video: true,
          conference: true,
          recipients: [IDS.user],
          sdp: 'v=0\r\no=- anna-offer',
        },
      });
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.mark,
        payload: {
          call_id: CALL,
          kind: 'offer',
          video: true,
          conference: true,
          recipients: [IDS.user],
          sdp: 'v=0\r\no=- mark-offer',
        },
      });
    });

    const dialog = await screen.findByRole('dialog', { name: 'Групповой звонок' });
    expect(within(dialog).getByText('Входящий групповой звонок')).toBeInTheDocument();
    expect(await within(dialog).findByText('Анна Петрова')).toBeInTheDocument();
    expect(await within(dialog).findByText('Марк Соколов')).toBeInTheDocument();
    expect(store.getSnapshot().call.conference).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Принять' }));
    await vi.waitFor(() =>
      expect(mockSentCallSignals().filter((item) => item.payload.kind === 'answer')).toHaveLength(
        2,
      ),
    );
    expect(media.constraints).toHaveLength(1);
    expect(media.peers).toHaveLength(2);
    const answers = mockSentCallSignals().filter((item) => item.payload.kind === 'answer');
    expect(answers.map((item) => item.payload.recipients?.[0]).sort()).toEqual(
      [IDS.anna, IDS.mark].sort(),
    );

    act(() => {
      media.peers[0]?.simulateConnectionState('connected');
      media.peers[1]?.simulateConnectionState('connected');
      media.peers[0]?.fireTrack(new FakeMediaStream(['audio', 'video']) as unknown as MediaStream);
      media.peers[1]?.fireTrack(new FakeMediaStream(['audio', 'video']) as unknown as MediaStream);
    });
    await screen.findByText('Звонок идёт');
    expect(screen.getByText('Участников: 3')).toBeInTheDocument();

    act(() =>
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.anna,
        payload: {
          call_id: CALL,
          kind: 'hangup',
          video: true,
          conference: true,
          recipients: [IDS.user],
        },
      }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('connected'));
    act(() =>
      publishMockCallSignal({
        chat_id: IDS.groupChat,
        from_user_id: IDS.mark,
        payload: {
          call_id: CALL,
          kind: 'hangup',
          video: true,
          conference: true,
          recipients: [IDS.user],
        },
      }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
  });

  it('starts ringback on user action, stops on connect, and rings incoming until reject', async () => {
    const { user, container, store, media, ringtone } = renderCalls();
    await waitForOnline(store);
    await openDirect(user);

    await user.click(callButton(container, 'call'));
    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    expect(ringtone.outgoingStarts).toBe(1);
    const offer = mockSentCallSignals().find((item) => item.payload.kind === 'offer');
    if (!offer) throw new Error('offer was not sent');
    await answerAndConnect(media, offer.payload.call_id, false);
    expect(ringtone.stops).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Завершить звонок' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Завершить' }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));

    const before = ringtone.incomingStarts;
    act(() =>
      publishMockCallSignal({
        chat_id: IDS.directChat,
        from_user_id: IDS.anna,
        payload: { call_id: OTHER_CALL, kind: 'offer', video: false, sdp: 'v=0\r\no=- ring' },
      }),
    );
    await screen.findByRole('dialog');
    expect(ringtone.incomingStarts).toBe(before + 1);
    await user.click(screen.getByRole('button', { name: 'Отклонить' }));
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    expect(media.constraints).toHaveLength(1);
  });

  it('passes an axe audit with the participant picker open', async () => {
    const { user, container, store } = renderCalls();
    await waitForOnline(store);
    await openGroupPicker(user, container);

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });

  it('passes an axe audit with the conference grid open', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    const { callId } = await startGroupConference(user, container, media, true);
    await answerGroup(media, callId, true);

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

describe('#107 call output controls', () => {
  async function connectedVideoCall() {
    const result = renderCalls();
    await waitForOnline(result.store);
    await openDirect(result.user);
    const { callId } = await startOutgoing(result.user, result.container, result.media, true);
    await answerAndConnect(result.media, callId, true);
    act(() =>
      result.media.peers[0]?.fireTrack(
        new FakeMediaStream(['audio', 'video']) as unknown as MediaStream,
      ),
    );
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Видео собеседника')).toHaveClass('is-video'),
    );
    const remote = result.container.querySelector('.call-stage__remote');
    if (!(remote instanceof HTMLVideoElement)) throw new Error('remote video not rendered');
    return { ...result, remote };
  }

  it('applies the 0..100 output volume to the remote element and persists it per device', async () => {
    const { user, remote, store } = await connectedVideoCall();

    const slider = screen.getByRole('slider', { name: 'Громкость звука' });
    expect(slider).toHaveValue('100');
    fireEvent.change(slider, { target: { value: '35' } });

    await vi.waitFor(() => expect(remote.volume).toBeCloseTo(0.35, 2));
    expect(readCallOutputVolume()).toBe(35);
    expect(screen.getByText('35%')).toBeInTheDocument();

    // The output mute is separate from the microphone mute and never leaks
    // into signalling.
    await user.click(screen.getByRole('button', { name: 'Выключить звук' }));
    expect(remote.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Включить звук' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Выключить микрофон' }));
    expect(remote.muted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Включить звук' }));
    expect(remote.muted).toBe(false);
    expect(store.getSnapshot().call.phase).toBe('connected');
  });

  it('restores the device-persisted volume on the next mount', async () => {
    writeCallOutputVolume(42);
    const { remote } = await connectedVideoCall();

    expect(screen.getByRole('slider', { name: 'Громкость звука' })).toHaveValue('42');
    expect(screen.getByText('42%')).toBeInTheDocument();
    await vi.waitFor(() => expect(remote.volume).toBeCloseTo(0.42, 2));
  });

  it('applies volume and output mute to every remote mesh tile', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    const { callId } = await startGroupConference(user, container, media, true);
    await answerGroup(media, callId, true);

    const remoteTiles = [
      ...container.querySelectorAll('.call-tile:not(.call-tile--local) video'),
    ].filter((element): element is HTMLVideoElement => element instanceof HTMLVideoElement);
    expect(remoteTiles).toHaveLength(3);

    fireEvent.change(screen.getByRole('slider', { name: 'Громкость звука' }), {
      target: { value: '20' },
    });
    await vi.waitFor(() => {
      for (const tile of remoteTiles) expect(tile.volume).toBeCloseTo(0.2, 2);
    });

    await user.click(screen.getByRole('button', { name: 'Выключить звук' }));
    expect(remoteTiles.every((tile) => tile.muted)).toBe(true);
    const local = container.querySelector('.call-tile--local video');
    expect(local).toHaveProperty('muted', true);
  });

  it('keeps a real media element for audio-only mesh tiles and shows avatars', async () => {
    const { user, container, store, media } = renderCalls();
    await waitForOnline(store);
    const { callId } = await startGroupConference(user, container, media, false);
    await answerGroup(media, callId, false);

    const tiles = [...container.querySelectorAll('.call-tile')];
    expect(tiles).toHaveLength(4);
    expect(container.querySelectorAll('.call-tile.is-video')).toHaveLength(0);
    expect(tiles.every((tile) => tile.querySelector('.call-tile__identity') !== null)).toBe(true);
    // Each remote tile still has a media element so remote audio is audible.
    const remoteVideos = container.querySelectorAll('.call-tile:not(.call-tile--local) video');
    expect(remoteVideos).toHaveLength(3);
    expect(media.constraints[0]?.video).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Завершить звонок' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Завершить' }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
  });

  it('uses the browser output picker and setSinkId, then shows the selected label', async () => {
    const selectAudioOutput = vi.fn(async () => ({
      deviceId: 'speaker-2',
      kind: 'audiooutput' as MediaDeviceKind,
      label: 'Наушники',
      groupId: 'group-1',
    }));
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const originalSink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId');
    const setSinkId = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { ...(originalMediaDevices?.value ?? {}), selectAudioOutput },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId,
    });

    try {
      const { user, remote } = await connectedVideoCall();
      const button = screen.getByRole('button', { name: 'Выбрать устройство вывода звука' });
      await user.click(button);

      await vi.waitFor(() => expect(selectAudioOutput).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledWith('speaker-2'));
      expect(remote.volume).toBeGreaterThan(0);
      expect(
        screen.getByRole('button', { name: 'Выбрать устройство вывода звука' }),
      ).toHaveTextContent('Наушники');
    } finally {
      if (originalMediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
      } else {
        Reflect.deleteProperty(navigator, 'mediaDevices');
      }
      if (originalSink) {
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', originalSink);
      } else {
        Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId');
      }
    }
  });

  it('renders an honest system-output fallback when selectAudioOutput is unavailable', async () => {
    const { store } = await connectedVideoCall();
    expect(screen.queryByRole('button', { name: 'Выбрать устройство вывода звука' })).toBeNull();
    const fallback = screen.getByText('Системный звук');
    expect(fallback).toHaveAttribute(
      'title',
      'Браузер не поддерживает выбор устройства вывода — используется системное.',
    );
    expect(store.getSnapshot().call.phase).toBe('connected');
  });

  it('measures the microphone through a real AnalyserNode and never fakes a level', async () => {
    const originalAudioContext = Object.getOwnPropertyDescriptor(window, 'AudioContext');
    const analyser = {
      fftSize: 512,
      smoothingTimeConstant: 0.6,
      getFloatTimeDomainData(target: Float32Array) {
        target.fill(0.1);
      },
      getByteTimeDomainData(target: Uint8Array) {
        target.fill(128 + 13);
      },
    };
    const context = {
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
      createAnalyser: () => analyser,
      resume: async () => undefined,
      close: async () => undefined,
    };
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class {
        constructor() {
          return context;
        }
      },
    });

    try {
      const { user } = await connectedVideoCall();
      const control = screen.getByRole('button', { name: 'Проверить микрофон' });
      expect(control).toHaveAttribute('aria-pressed', 'false');
      await user.click(control);

      const meter = await screen.findByRole('meter', { name: 'Уровень микрофона' });
      await vi.waitFor(() =>
        expect(Number(meter.getAttribute('aria-valuenow'))).toBeGreaterThan(0),
      );
      expect(screen.getByRole('button', { name: 'Остановить проверку микрофона' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await user.click(screen.getByRole('button', { name: 'Выключить микрофон' }));
      await vi.waitFor(() =>
        expect(screen.getByRole('meter', { name: 'Уровень микрофона' })).toHaveAttribute(
          'aria-valuenow',
          '0',
        ),
      );
    } finally {
      if (originalAudioContext) {
        Object.defineProperty(window, 'AudioContext', originalAudioContext);
      } else {
        Reflect.deleteProperty(window, 'AudioContext');
      }
    }
  });
});
