import axe from 'axe-core';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeviceId } from '../auth/session';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { createFakeE2eeBridge } from '../test/e2eeBridgeFake';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];
const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mime: string) => mime.startsWith('audio/webm'));

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly start = vi.fn(() => {
    this.state = 'recording';
  });
  readonly stop = vi.fn(() => {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['voice-bytes'], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  });

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    MockMediaRecorder.instances.push(this);
  }
}

interface Harness {
  getUserMedia: ReturnType<typeof vi.fn>;
  trackStop: ReturnType<typeof vi.fn>;
}

function installRecorderHarness(
  options: { rejectWith?: unknown; noDevices?: boolean; secure?: boolean } = {},
): Harness {
  const trackStop = vi.fn();
  const getUserMedia = vi.fn();
  if (options.rejectWith !== undefined) getUserMedia.mockRejectedValue(options.rejectWith);
  else {
    getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream);
  }
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    writable: true,
    value: MockMediaRecorder,
  });
  MockMediaRecorder.instances = [];
  MockMediaRecorder.isTypeSupported = vi.fn((mime: string) => mime.startsWith('audio/webm'));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: options.noDevices ? undefined : { getUserMedia },
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: options.secure ?? true,
  });
  return { getUserMedia, trackStop };
}

async function renderChat() {
  const result = renderApp({ uploadScanPollMs: 10, uploadScanTimeoutMs: 2_000 });
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  return result;
}

beforeEach(() => {
  MockMediaRecorder.instances = [];
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  if (originalMediaRecorder === undefined) {
    Reflect.deleteProperty(globalThis, 'MediaRecorder');
  } else {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: originalMediaRecorder,
    });
  }
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
  if (originalSecureContext) {
    Object.defineProperty(window, 'isSecureContext', originalSecureContext);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
});

describe('voice recording', () => {
  it('does not prompt for the microphone before an explicit click', async () => {
    const harness = installRecorderHarness();
    await renderChat();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Записать голосовое сообщение' })).toBeEnabled();
  });

  it('records, shows a timer, uploads AUDIO metadata and auto-sends the voice message', async () => {
    const harness = installRecorderHarness();
    const { user } = await renderChat();

    await user.click(screen.getByRole('button', { name: 'Записать голосовое сообщение' }));
    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByText('Идёт запись')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAccessibleName(/Время записи/);

    // Let the local clock pass one second so the measured duration is real.
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    await user.click(screen.getByRole('button', { name: 'Остановить и отправить' }));

    await waitFor(() => expect(mockDb.uploadInits).toHaveLength(1));
    const init = mockDb.uploadInits[0]?.body;
    expect(init?.mime).toBe('audio/webm');
    expect(init?.encryption_mode).toBe('MANAGED');
    expect(init?.media).toMatchObject({
      kind: 'AUDIO',
      metadata_source: 'CLIENT',
    });
    expect(init?.media?.duration_ms).toBeGreaterThanOrEqual(1_000);
    expect(init?.media?.duration_ms).toBeLessThanOrEqual(600_000);

    const play = await screen.findByRole(
      'button',
      { name: 'Воспроизвести голосовое' },
      { timeout: 10_000 },
    );
    const card = play.closest('.attachment-card');
    expect(card).not.toBeNull();
    const audio = within(card as HTMLElement).getByLabelText(
      /Голосовое сообщение: voice-/,
    ) as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.controls).toBe(false);
    expect(audio.autoplay).toBe(false);
    // Compact skin: filename, size, scan status and download are not rendered.
    expect(within(card as HTMLElement).queryByText(/voice-.*webm/)).toBeNull();
    expect(within(card as HTMLElement).queryByText('Проверен')).toBeNull();
    expect(within(card as HTMLElement).queryByRole('button', { name: /Скачать/ })).toBeNull();
    expect(harness.trackStop).toHaveBeenCalledTimes(1);
  });

  it('shows an honest microphone-permission error with retry', async () => {
    installRecorderHarness({ rejectWith: new DOMException('denied', 'NotAllowedError') });
    const { user } = await renderChat();
    await user.click(screen.getByRole('button', { name: 'Записать голосовое сообщение' }));

    expect(await screen.findByText(/Доступ к микрофону запрещён/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(0);

    // Dismiss returns focus to the mic and closes the panel.
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByText(/Доступ к микрофону запрещён/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Записать голосовое сообщение' })).toHaveFocus();
  });

  it('cancels a take without uploading anything', async () => {
    installRecorderHarness();
    const { user } = await renderChat();
    await user.click(screen.getByRole('button', { name: 'Записать голосовое сообщение' }));
    await screen.findByText('Идёт запись');
    await user.click(screen.getByRole('button', { name: 'Отменить запись' }));

    expect(screen.queryByText('Идёт запись')).not.toBeInTheDocument();
    expect(mockDb.uploadInits).toHaveLength(0);
  });

  it('is disabled with an honest managed-only explanation in an E2EE chat', async () => {
    const harness = installRecorderHarness();
    const chatId = IDS.groupChat;
    mockDb.chats[chatId]!.summary.security_mode = 'E2EE';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: {
        chatId,
        securityMode: 'E2EE',
        modeAction: 'allow_e2ee',
        selfDeviceId: '33333333-3333-4333-8333-333333333333',
        peerDeviceIds: ['55555555-5555-4555-8555-555555555555'],
        devices: [],
        safetyNumbers: [],
      },
    });
    const result = renderApp({}, { enabled: true, bridge });
    stores.push(result.store);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const mic = await screen.findByRole('button', { name: 'Записать голосовое сообщение' });
    expect(mic).toBeDisabled();
    expect(mic.getAttribute('title')).toContain('managed-only');
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it('passes an axe audit with the recording bar open', async () => {
    installRecorderHarness();
    const { user } = await renderChat();
    await user.click(screen.getByRole('button', { name: 'Записать голосовое сообщение' }));
    await screen.findByText('Идёт запись');
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Отменить запись' }));
  });
});
