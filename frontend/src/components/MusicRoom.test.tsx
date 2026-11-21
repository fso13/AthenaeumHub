import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { MusicAudioElement } from '../music/store';
import { IDS } from '../mocks/fixtures';
import { mockDb, server } from '../test/server';
import { renderApp } from '../test/renderApp';

const GROUP = IDS.groupChat;
const WORKSPACE = IDS.workspace;

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

function renderMusic() {
  const audio = new FakeAudio();
  const result = renderApp({}, null, {
    musicCreateElement: () => audio,
    musicCreateGraph: () => null,
    musicResolveUrl: async () => 'https://media.example.test/track.mp3',
  });
  return { ...result, audio };
}

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
}

async function openMusicPanel(user: ReturnType<typeof renderMusic>['user']): Promise<HTMLElement> {
  await waitForChat();
  const row = await screen.findByRole('button', { name: /Музыкальная комната/ });
  await user.click(row);
  return screen.findByRole('region', { name: 'Музыкальная комната' });
}

function enableMusicRoom(): void {
  mockDb.chatPlugins.set(GROUP, new Map([['music-room', true]]));
}

describe('#94 Music Room chat panel', () => {
  it('lists track metadata, plays only on user action and pauses locally', async () => {
    enableMusicRoom();
    const { user, store, audio } = renderMusic();
    const panel = await openMusicPanel(user);

    expect(await within(panel).findByText('Ночная сова')).toBeInTheDocument();
    expect(within(panel).getByText('Сова')).toBeInTheDocument();
    expect(within(panel).getByText('Прогулка по лесу')).toBeInTheDocument();
    expect(within(panel).getByText('3:34')).toBeInTheDocument();
    expect(within(panel).getByText('5 МБ')).toBeInTheDocument();
    expect(within(panel).getByText('30 МБ')).toBeInTheDocument();
    expect(within(panel).getByText('DJ Сова')).toBeInTheDocument();
    expect(within(panel).getByText('Без звонка музыка слышна только вам.')).toBeInTheDocument();

    // No autoplay: nothing played before the explicit button press.
    expect(audio.playCalls).toBe(0);
    expect(store.music.getSnapshot().playback.status).toBe('idle');

    await user.click(within(panel).getByRole('button', { name: 'Играть «Ночная сова»' }));
    await waitFor(() => expect(store.music.getSnapshot().playback.status).toBe('playing'));
    expect(audio.playCalls).toBe(1);
    expect(within(panel).getByText('Сейчас играет')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Пауза' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Пауза' }));
    expect(store.music.getSnapshot().playback.status).toBe('paused');
    expect(within(panel).getByRole('button', { name: 'Продолжить' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Следующий трек' }));
    await waitFor(() =>
      expect(store.music.getSnapshot().playback.trackId).toBe(
        'c1000000-0000-4000-8000-000000000002',
      ),
    );
    expect(audio.playCalls).toBe(2);
  });

  it('shows loading, a retryable error and an honest empty state', async () => {
    enableMusicRoom();
    server.use(
      http.get('*/api/v1/chats/:chatId/music-room', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'tracks failed' }, { status: 500 }),
      ),
    );
    const { user } = renderMusic();
    const panel = await openMusicPanel(user);

    const alert = await within(panel).findByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить треки комнаты')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Повторить' })).toBeEnabled();

    server.resetHandlers();
    mockDb.musicRoomTracks.set(GROUP, []);
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await within(panel).findByText('В комнате пока нет аудио.')).toBeInTheDocument();
    expect(
      within(panel).getByText('Музыкальные треки — это обычные аудиовложения канала.'),
    ).toBeInTheDocument();
  });

  it('hides the panel unless the MANAGED chat has the plugin enabled', async () => {
    const { user } = renderMusic();
    await waitForChat();
    // Plugin state is loaded but the server says the toggle is off.
    await waitFor(() => expect(mockDb.chatPluginListRequests.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Музыкальная комната/ })).not.toBeInTheDocument();

    // E2EE chats never offer server plugins, even if a stale row says enabled.
    mockDb.chats[GROUP]!.summary.security_mode = 'E2EE';
    mockDb.chatPlugins.set(GROUP, new Map([['music-room', true]]));
    await user.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(screen.queryByRole('button', { name: /Музыкальная комната/ })).not.toBeInTheDocument();
  });

  it('opens the room from the plugin card idempotently and selects the existing chat', async () => {
    const { user } = renderMusic();
    await waitForChat();

    const openAction = async () => {
      await user.click(screen.getByRole('button', { name: 'Плагины' }));
      await screen.findByRole('heading', { level: 1, name: 'Плагины' });
      const card = await screen.findByRole('article', { name: 'Музыкальная комната' });
      await user.click(within(card).getByRole('button', { name: 'Открыть музыкальную комнату' }));
    };

    await openAction();
    await waitFor(() => expect(mockDb.musicRoomChats.size).toBe(1));
    const roomId = [...mockDb.musicRoomChats.values()][0];
    expect(roomId).toBeTruthy();
    expect(mockDb.musicRoomOpenRequests).toHaveLength(1);
    expect(mockDb.musicRoomOpenRequests[0]?.workspaceId).toBe(WORKSPACE);
    expect(mockDb.musicRoomOpenRequests[0]?.deviceId).toBeTruthy();
    // The dialog closes and the new room becomes the active chat.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Музыкальная комната' })).toBeVisible(),
    );

    await openAction();
    await waitFor(() => expect(mockDb.musicRoomOpenRequests).toHaveLength(2));
    expect(mockDb.musicRoomChats.size).toBe(1);
    expect([...mockDb.musicRoomChats.values()][0]).toBe(roomId);

    await user.click(screen.getByRole('button', { name: 'Плагины' }));
    await screen.findByRole('heading', { level: 1, name: 'Плагины' });
    const select = await screen.findByRole('combobox', { name: 'Чат' });
    await waitFor(() => expect(select).toHaveValue(roomId));
  });

  it('reports an honest open failure with retry', async () => {
    mockDb.forceMusicRoomOpenError = {
      status: 409,
      code: 'CHAT_LIMIT_REACHED',
      message: 'Chat limit reached',
    };
    const { user } = renderMusic();
    await waitForChat();
    await user.click(screen.getByRole('button', { name: 'Плагины' }));
    await screen.findByRole('heading', { level: 1, name: 'Плагины' });
    const card = await screen.findByRole('article', { name: 'Музыкальная комната' });
    await user.click(within(card).getByRole('button', { name: 'Открыть музыкальную комнату' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Не удалось открыть музыкальную комнату' }),
    ).toBeVisible();
    expect(within(alert).getByText('Достигнут лимит чатов — комната не создана.')).toBeVisible();
    expect(mockDb.musicRoomChats.size).toBe(0);

    mockDb.forceMusicRoomOpenError = null;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(mockDb.musicRoomChats.size).toBe(1));
  });

  it('passes an axe audit with the panel expanded', async () => {
    enableMusicRoom();
    const { user } = renderMusic();
    const panel = await openMusicPanel(user);
    expect(panel).toBeInTheDocument();

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
