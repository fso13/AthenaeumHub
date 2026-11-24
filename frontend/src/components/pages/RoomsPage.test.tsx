import { act, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { RoomParticipant } from '../../api/types';
import { mockSentCallSignals, publishMockCallSignal } from '../../mocks/realtime';
import { IDS, MOCK_DISPLAY_NAME } from '../../mocks/fixtures';
import { mockDb } from '../../test/server';
import { createFakeCallMedia, createFakeRingtone } from '../../test/callFakes';
import { renderApp } from '../../test/renderApp';
import {
  isRoomParticipantFresh,
  roomMediaMode,
  ROOMS_POLL_INTERVAL_MS,
} from '../../rooms/roomsStore';

const STANDUP = IDS.roomStandup;
const DESIGN = IDS.roomDesign;
const STANDUP_CHAT = IDS.roomStandupChat;

type App = ReturnType<typeof renderApp>;

interface CapturedInterval {
  handler: () => void;
  ms: number;
}

/**
 * Capture interval registrations instead of scheduling them, so the 5 s poll
 * and the 5 s heartbeat can be driven deterministically inside `act`.
 */
function captureIntervals(): CapturedInterval[] {
  const captured: CapturedInterval[] = [];
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, timeout?: number) => {
    captured.push({ handler, ms: timeout ?? 0 });
    return captured.length;
  }) as unknown as typeof window.setInterval);
  return captured;
}

async function runRoomsIntervals(captured: CapturedInterval[]): Promise<void> {
  await act(async () => {
    for (const entry of captured.filter((item) => item.ms === ROOMS_POLL_INTERVAL_MS)) {
      entry.handler();
    }
    await Promise.resolve();
  });
}

async function openRoomsShell(user: App['user']): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(screen.getByRole('button', { name: 'Открыть комнаты' }));
  await screen.findByRole('heading', { name: 'Комнаты', level: 1 });
}

async function openRooms(user: App['user']): Promise<void> {
  await openRoomsShell(user);
  await screen.findByRole('heading', { name: 'Планёрка' });
  // #196: the sidebar plus opens the create form; legacy tests open it explicitly.
  if (screen.queryByRole('heading', { name: 'Новая комната' })) {
    const cancel = screen.getAllByRole('button', { name: 'Отмена' })[0];
    if (cancel) await user.click(cancel);
  }
}

function roomCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const card = heading.closest('li');
  if (!(card instanceof HTMLElement)) throw new Error(`room card not found: ${name}`);
  return card;
}

async function waitForOnline(store: App['store']): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await vi.waitFor(() => expect(store.getSnapshot().realtimeStatus).toBe('online'), {
    timeout: 5_000,
  });
}

function renderRooms(overrides: Parameters<typeof renderApp>[0] = {}) {
  return renderApp(overrides);
}

function renderCallingRooms() {
  const media = createFakeCallMedia();
  const ringtone = createFakeRingtone();
  const result = renderApp({ realtimeEnabled: true }, null, {
    mediaDevices: media.mediaDevices,
    createPeerConnection: media.createPeerConnection,
    ringtone,
  });
  return { ...result, media };
}

describe.skip('#105 комнаты: список, присутствие и звонок (legacy rooms page)', () => {
  it('renders only server participants with the count and my presence flag', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    expect(screen.getByRole('heading', { name: 'Дизайн-ревью' })).toBeInTheDocument();
    const standup = roomCard('Планёрка');
    expect(within(standup).getByText('Участников: 2')).toBeInTheDocument();
    expect(within(standup).getByText('Анна Петрова')).toBeInTheDocument();
    expect(within(standup).getByText('Марк Соколов')).toBeInTheDocument();
    expect(within(standup).queryByText('Вы в комнате')).toBeNull();
    expect(within(standup).queryByText('Лена Волкова')).toBeNull();

    const design = roomCard('Дизайн-ревью');
    expect(within(design).getByText('1 участник')).toBeInTheDocument();
    expect(within(design).getByText('Лена Волкова')).toBeInTheDocument();
    expect(within(design).queryByText('Анна Петрова')).toBeNull();

    expect(mockDb.roomListRequests.at(-1)).toMatchObject({
      workspaceId: IDS.workspace,
      deviceId: expect.any(String),
    });
  });

  it('polls the room list every five seconds', async () => {
    const intervals = captureIntervals();
    const { user } = renderRooms();
    await openRooms(user);
    const before = mockDb.roomListRequests.length;

    await runRoomsIntervals(intervals);

    await waitFor(() => expect(mockDb.roomListRequests.length).toBeGreaterThan(before));
    expect(within(roomCard('Планёрка')).getByText('Участников: 2')).toBeInTheDocument();
  });

  it('creates a room, trims the name and prepends the server row', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(screen.getByRole('button', { name: 'Создать комнату' }));
    await screen.findByRole('heading', { name: 'Новая комната' });
    await user.type(screen.getByLabelText('Название комнаты'), '  Утренний стендап  ');
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    await screen.findByRole('heading', { name: 'Утренний стендап' });
    expect(mockDb.roomRequests.at(-1)).toMatchObject({
      action: 'create',
      workspaceId: IDS.workspace,
      body: { name: 'Утренний стендап', media_mode: 'VIDEO' },
    });
    expect(mockDb.rooms.some((room) => room.name === 'Утренний стендап')).toBe(true);
    const items = within(screen.getByRole('list', { name: 'Комнаты' })).getAllByRole('listitem');
    expect(
      within(items[0]!).getByRole('heading', { name: 'Утренний стендап' }),
    ).toBeInTheDocument();
  });

  it.skip('creates an AUDIO room with the contract media_mode and shows the audio chip', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(screen.getByRole('button', { name: 'Создать комнату' }));
    await user.type(screen.getByLabelText('Название комнаты'), 'Аудио-брифинг');
    await user.click(screen.getByRole('button', { name: 'Аудио' }));
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    await screen.findByRole('heading', { name: 'Аудио-брифинг' });
    expect(mockDb.roomRequests.at(-1)).toMatchObject({
      action: 'create',
      workspaceId: IDS.workspace,
      body: { name: 'Аудио-брифинг', media_mode: 'AUDIO' },
    });
    const created = mockDb.rooms.find((room) => room.name === 'Аудио-брифинг');
    expect(created?.mediaMode).toBe('AUDIO');
    expect(within(roomCard('Аудио-брифинг')).getByText('Аудио')).toBeInTheDocument();
  });

  it.skip('renders the server media mode chip on every room card', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    expect(within(roomCard('Планёрка')).getByText('Видео')).toBeInTheDocument();
    expect(within(roomCard('Дизайн-ревью')).getByText('Аудио')).toBeInTheDocument();
  });

  it.skip('changes the media mode through a partial PATCH and updates the card', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Сделать комнату «Планёрка» аудиокомнатой',
      }),
    );

    await waitFor(() =>
      expect(mockDb.roomRequests.at(-1)).toMatchObject({
        action: 'media_mode',
        roomId: STANDUP,
        workspaceId: IDS.workspace,
        body: { media_mode: 'AUDIO' },
      }),
    );
    await waitFor(() =>
      expect(within(roomCard('Планёрка')).getByText('Аудио')).toBeInTheDocument(),
    );
    expect(mockDb.rooms.find((room) => room.id === STANDUP)?.mediaMode).toBe('AUDIO');
    expect(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Сделать комнату «Планёрка» видеокомнатой',
      }),
    ).toBeInTheDocument();
  });

  it.skip('surfaces a forbidden media-mode change without an optimistic flip', async () => {
    mockDb.forceRoomUpdateError = { status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Сделать комнату «Планёрка» аудиокомнатой',
      }),
    );
    expect(await screen.findByText('Недостаточно прав для этой комнаты.')).toBeInTheDocument();
    expect(within(roomCard('Планёрка')).getByText('Видео')).toBeInTheDocument();
    expect(mockDb.rooms.find((room) => room.id === STANDUP)?.mediaMode).toBe('VIDEO');
  });

  it('validates the name and surfaces the chat-limit error honestly', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(screen.getByRole('button', { name: 'Создать комнату' }));
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    expect(await screen.findByText('Введите название комнаты.')).toBeInTheDocument();
    expect(mockDb.roomRequests).toHaveLength(0);

    mockDb.forceRoomCreateError = {
      status: 409,
      code: 'CHAT_LIMIT_REACHED',
      message: 'Chat limit reached',
      details: { scope: 'WORKSPACE', limit: 10, used: 10 },
    };
    await user.type(screen.getByLabelText('Название комнаты'), 'Лимит');
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    expect(await screen.findByText(/Достигнут лимит чатов \(пространство\)/)).toBeInTheDocument();

    // A retry after the server condition clears succeeds without a reload.
    mockDb.forceRoomCreateError = null;
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await screen.findByRole('heading', { name: 'Лимит' });
  });

  it('hides participants whose heartbeat is outside the 30 s TTL', async () => {
    const stale: RoomParticipant = {
      user_id: IDS.olga,
      display_name: 'Ольга Соколова',
      joined_at: new Date(Date.now() - 120_000).toISOString(),
      last_seen_at: new Date(Date.now() - 31_000).toISOString(),
    };
    mockDb.rooms.find((room) => room.id === STANDUP)?.participants.push(stale);

    const { user } = renderRooms();
    await openRooms(user);

    const standup = roomCard('Планёрка');
    expect(within(standup).queryByText('Ольга Соколова')).toBeNull();
    expect(within(standup).getByText('Участников: 2')).toBeInTheDocument();
  });

  it('joins with presence, heartbeats every five seconds and starts no call offline', async () => {
    const intervals = captureIntervals();
    const { user, store } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    expect(await screen.findByText('Вы в комнате')).toBeInTheDocument();
    expect(mockDb.roomPresenceRequests.at(-1)).toMatchObject({
      roomId: STANDUP,
      action: 'join',
    });
    const standup = roomCard('Планёрка');
    expect(within(standup).getByText('Участников: 3')).toBeInTheDocument();
    expect(within(standup).getByText(MOCK_DISPLAY_NAME)).toBeInTheDocument();
    // No WebSocket in this configuration: the mesh must not silently appear.
    expect(
      within(standup).getByText('Звонок недоступен: нет соединения реального времени.'),
    ).toBeInTheDocument();
    expect(store.getSnapshot().call.phase).toBe('idle');

    const joinsBefore = mockDb.roomPresenceRequests.filter((item) => item.action === 'join').length;
    await runRoomsIntervals(intervals);
    await waitFor(() =>
      expect(
        mockDb.roomPresenceRequests.filter((item) => item.action === 'join').length,
      ).toBeGreaterThan(joinsBefore),
    );
  });

  it('leaves with an idempotent DELETE and stops the heartbeat', async () => {
    const intervals = captureIntervals();
    const { user } = renderRooms();
    await openRooms(user);
    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    await screen.findByText('Вы в комнате');
    await runRoomsIntervals(intervals);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Выйти из комнаты «Планёрка»' }),
    );
    await waitFor(() =>
      expect(mockDb.roomPresenceRequests.at(-1)).toMatchObject({
        roomId: STANDUP,
        action: 'leave',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Вы в комнате')).toBeNull());
    expect(within(roomCard('Планёрка')).getByText('Участников: 2')).toBeInTheDocument();

    const joinsBefore = mockDb.roomPresenceRequests.filter((item) => item.action === 'join').length;
    await runRoomsIntervals(intervals);
    expect(mockDb.roomPresenceRequests.filter((item) => item.action === 'join').length).toBe(
      joinsBefore,
    );
  });

  it('starts the mesh conference to the participants already present', async () => {
    const { user, store, media } = renderCallingRooms();
    await waitForOnline(store);
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    await vi.waitFor(() => {
      expect(mockSentCallSignals().filter((item) => item.payload.kind === 'offer')).toHaveLength(2);
    });
    const offers = mockSentCallSignals().filter((item) => item.payload.kind === 'offer');
    for (const offer of offers) {
      expect(offer.chat_id).toBe(STANDUP_CHAT);
      expect(offer.payload.conference).toBe(true);
      expect(offer.payload.video).toBe(true);
    }
    expect(offers.map((offer) => offer.payload.recipients?.[0]).sort()).toEqual(
      [IDS.anna, IDS.mark].sort(),
    );
    expect(store.getSnapshot().call.phase).toBe('outgoing');

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Выйти из комнаты «Планёрка»' }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    await vi.waitFor(() =>
      expect(mockDb.roomPresenceRequests.at(-1)).toMatchObject({
        roomId: STANDUP,
        action: 'leave',
      }),
    );
    expect(media.streams[0]?.fakeTracks.every((track) => track.stopped)).toBe(true);
  });

  it('joins an AUDIO room with video=false and never requests a camera', async () => {
    const { user, store, media } = renderCallingRooms();
    await waitForOnline(store);
    await openRooms(user);

    await user.click(
      within(roomCard('Дизайн-ревью')).getByRole('button', {
        name: 'Войти в комнату «Дизайн-ревью»',
      }),
    );
    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    expect(media.constraints[0]?.audio).toBeTruthy();
    expect(media.constraints[0]?.video).toBe(false);
    await vi.waitFor(() =>
      expect(mockSentCallSignals().filter((item) => item.payload.kind === 'offer')).toHaveLength(1),
    );
    const offer = mockSentCallSignals().find((item) => item.payload.kind === 'offer');
    expect(offer?.payload).toMatchObject({ video: false, conference: true });
    expect(store.getSnapshot().call.video).toBe(false);
    expect(offer?.chat_id).toBe(IDS.roomDesignChat);

    await user.click(
      within(roomCard('Дизайн-ревью')).getByRole('button', {
        name: 'Выйти из комнаты «Дизайн-ревью»',
      }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
  });

  it('lets an already-present participant accept an incoming room conference', async () => {
    const { user, store, media } = renderCallingRooms();
    await waitForOnline(store);
    await openRooms(user);

    // Simulate the other side: it saw this room in the list and starts the mesh.
    act(() => {
      publishMockCallSignal({
        chat_id: STANDUP_CHAT,
        from_user_id: IDS.anna,
        payload: {
          call_id: '00000000-0000-4000-8000-000000000077',
          kind: 'offer',
          video: true,
          conference: true,
          recipients: [IDS.user],
          sdp: 'v=0\r\no=- room-offer',
        },
      });
    });
    expect(await screen.findByText('Входящий групповой звонок')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Групповой звонок' });
    await user.click(within(dialog).getByRole('button', { name: 'Принять' }));

    await vi.waitFor(() => expect(media.constraints).toHaveLength(1));
    await vi.waitFor(() =>
      expect(mockSentCallSignals().some((item) => item.payload.kind === 'answer')).toBe(true),
    );
    expect(store.getSnapshot().call.chatId).toBe(STANDUP_CHAT);
    expect(store.getSnapshot().call.conference).toBe(true);
  });

  it('shows rename/close to the creator and to workspace OWNER/ADMIN only', async () => {
    mockDb.me.workspaces[0]!.role = 'MEMBER';
    const { user } = renderRooms();
    await openRooms(user);

    const owned = roomCard('Планёрка');
    expect(
      within(owned).getByRole('button', { name: 'Переименовать комнату «Планёрка»' }),
    ).toBeInTheDocument();
    expect(
      within(owned).getByRole('button', { name: 'Закрыть комнату «Планёрка»' }),
    ).toBeInTheDocument();

    const foreign = roomCard('Дизайн-ревью');
    expect(
      within(foreign).queryByRole('button', { name: 'Переименовать комнату «Дизайн-ревью»' }),
    ).toBeNull();
    expect(
      within(foreign).queryByRole('button', { name: 'Закрыть комнату «Дизайн-ревью»' }),
    ).toBeNull();
    expect(
      within(foreign).queryByRole('button', {
        name: 'Сделать комнату «Дизайн-ревью» видеокомнатой',
      }),
    ).toBeNull();
  });

  it('gives ADMIN rename but not close on a room they did not create', async () => {
    mockDb.me.workspaces[0]!.role = 'ADMIN';
    const { user } = renderRooms();
    await openRooms(user);

    const foreign = roomCard('Дизайн-ревью');
    expect(
      within(foreign).getByRole('button', { name: 'Переименовать комнату «Дизайн-ревью»' }),
    ).toBeInTheDocument();
    expect(
      within(foreign).queryByRole('button', { name: 'Закрыть комнату «Дизайн-ревью»' }),
    ).toBeNull();
  });

  it('renames through PATCH and keeps the card in sync with the response', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Переименовать комнату «Планёрка»',
      }),
    );
    const input = await screen.findByLabelText('Новое название комнаты «Планёрка»');
    await user.clear(input);
    await user.type(input, 'Утренний брифинг');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByRole('heading', { name: 'Утренний брифинг' })).toBeInTheDocument();
    expect(mockDb.roomRequests.at(-1)).toMatchObject({
      action: 'rename',
      roomId: STANDUP,
      workspaceId: IDS.workspace,
      body: { name: 'Утренний брифинг' },
    });
    expect(mockDb.rooms.find((room) => room.id === STANDUP)?.name).toBe('Утренний брифинг');
    expect(screen.queryByRole('heading', { name: 'Планёрка' })).toBeNull();
  });

  it('validates a rename locally and surfaces a server permission error', async () => {
    const { user } = renderRooms();
    await openRooms(user);
    await user.click(
      within(roomCard('Планёрка')).getByRole('button', {
        name: 'Переименовать комнату «Планёрка»',
      }),
    );
    const input = await screen.findByLabelText('Новое название комнаты «Планёрка»');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Введите название комнаты.')).toBeInTheDocument();
    expect(mockDb.roomRequests).toHaveLength(0);

    mockDb.forceRoomUpdateError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Forbidden',
    };
    await user.type(input, 'Нельзя');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Недостаточно прав для этой комнаты.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Планёрка' })).toBeInTheDocument();
  });

  it('closes a room after an inline confirmation and drops it from the list', async () => {
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Закрыть комнату «Планёрка»' }),
    );
    expect(
      await screen.findByText('Закрыть комнату «Планёрка»?', { selector: 'p' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Закрыть комнату' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Планёрка' })).toBeNull());
    expect(mockDb.roomRequests.at(-1)).toMatchObject({ action: 'close', roomId: STANDUP });
    expect(mockDb.rooms.find((room) => room.id === STANDUP)?.status).toBe('CLOSED');
    // The backing channel is soft-deleted together with the room.
    expect(mockDb.chats[STANDUP_CHAT]).toBeUndefined();
  });

  it('keeps the room and shows the error when close is forbidden', async () => {
    mockDb.forceRoomCloseError = { status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Закрыть комнату «Планёрка»' }),
    );
    await user.click(screen.getByRole('button', { name: 'Закрыть комнату' }));
    expect(await screen.findByText('Недостаточно прав для этой комнаты.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Планёрка' })).toBeInTheDocument();
    expect(mockDb.rooms.find((room) => room.id === STANDUP)?.status).toBe('ACTIVE');
  });

  it('shows the loading error with a working retry', async () => {
    mockDb.forceRoomListError = {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal error',
    };
    const { user } = renderRooms();
    await openRoomsShell(user);
    expect(await screen.findByText('Не удалось загрузить комнаты.')).toBeInTheDocument();

    mockDb.forceRoomListError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByRole('heading', { name: 'Планёрка' });
    expect(screen.queryByText('Не удалось загрузить комнаты.')).toBeNull();
  });

  it('keeps the last rows when a background poll fails and recovers on retry', async () => {
    const intervals = captureIntervals();
    const { user } = renderRooms();
    await openRooms(user);

    mockDb.forceRoomListError = {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal error',
    };
    await runRoomsIntervals(intervals);
    expect(
      await screen.findByText('Список не обновился — показаны последние данные.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Планёрка' })).toBeInTheDocument();

    mockDb.forceRoomListError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() =>
      expect(screen.queryByText('Список не обновился — показаны последние данные.')).toBeNull(),
    );
  });

  it('surfaces a closed room when join returns 409 ROOM_CLOSED', async () => {
    mockDb.forceRoomPresenceError = { status: 409, code: 'ROOM_CLOSED', message: 'Room is closed' };
    const { user } = renderRooms();
    await openRooms(user);

    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    expect(await screen.findByText('Комната закрыта.')).toBeInTheDocument();
    expect(screen.queryByText('Вы в комнате')).toBeNull();
    expect(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    ).toBeInTheDocument();
  });

  it('renders the empty state with a create entry point', async () => {
    mockDb.rooms = [];
    const { user } = renderRooms();
    await openRoomsShell(user);

    expect(await screen.findByRole('heading', { name: 'Комнат пока нет' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Создать комнату' })).toHaveLength(2);
  });

  it('leaves presence and stops the room call when navigating away', async () => {
    const { user, store } = renderCallingRooms();
    await waitForOnline(store);
    await openRooms(user);
    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('outgoing'));

    await user.click(screen.getByRole('button', { name: 'Файлы' }));
    await screen.findByRole('heading', { name: 'Файлы', level: 1 });
    await vi.waitFor(() => expect(store.getSnapshot().call.phase).toBe('idle'));
    await waitFor(() =>
      expect(mockDb.roomPresenceRequests.at(-1)).toMatchObject({
        roomId: STANDUP,
        action: 'leave',
      }),
    );
  });

  it('moves presence when joining another room', async () => {
    const { user } = renderRooms();
    await openRooms(user);
    await user.click(
      within(roomCard('Планёрка')).getByRole('button', { name: 'Войти в комнату «Планёрка»' }),
    );
    await screen.findByText('Вы в комнате');

    await user.click(
      within(roomCard('Дизайн-ревью')).getByRole('button', {
        name: 'Войти в комнату «Дизайн-ревью»',
      }),
    );
    await waitFor(() => {
      const presence = mockDb.roomPresenceRequests.slice(-2);
      expect(presence[0]).toMatchObject({ roomId: STANDUP, action: 'leave' });
      expect(presence[1]).toMatchObject({ roomId: DESIGN, action: 'join' });
    });
    await waitFor(() => {
      const standup = roomCard('Планёрка');
      expect(within(standup).queryByText('Вы в комнате')).toBeNull();
      expect(within(roomCard('Дизайн-ревью')).getByText('Вы в комнате')).toBeInTheDocument();
    });
  });

  it('has no serious or critical accessibility violations', async () => {
    const { user } = renderRooms();
    await openRooms(user);
    await user.click(screen.getByRole('button', { name: 'Создать комнату' }));
    await screen.findByRole('heading', { name: 'Новая комната' });

    // jsdom has no canvas; axe's icon-ligature check only needs a null context.
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

describe('#105 rooms: presence TTL helper', () => {
  it('accepts a heartbeat inside the 30 s window', () => {
    const now = Date.parse('2026-11-23T10:00:00.000Z');
    expect(isRoomParticipantFresh('2026-11-23T09:59:35.000Z', now)).toBe(true);
    expect(isRoomParticipantFresh('2026-11-23T10:00:00.000Z', now)).toBe(true);
  });

  it('rejects an expired or malformed timestamp', () => {
    const now = Date.parse('2026-11-23T10:00:00.000Z');
    expect(isRoomParticipantFresh('2026-11-23T09:59:29.999Z', now)).toBe(false);
    expect(isRoomParticipantFresh('not-a-date', now)).toBe(false);
  });
});

describe('#107 room media mode fallback', () => {
  it('uses AUDIO/VIDEO when present and falls back to VIDEO for a legacy row', () => {
    expect(roomMediaMode({ media_mode: 'AUDIO' })).toBe('AUDIO');
    expect(roomMediaMode({ media_mode: 'VIDEO' })).toBe('VIDEO');
    expect(roomMediaMode({})).toBe('VIDEO');
  });
});
