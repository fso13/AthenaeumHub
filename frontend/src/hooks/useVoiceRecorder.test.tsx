import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getVoiceSupport,
  pickRecorderMime,
  recorderErrorKey,
  useVoiceRecorder,
  type RecordedVoice,
} from './useVoiceRecorder';

type RecorderHandler = ((event: Event) => void) | null;

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mime: string) => mime.startsWith('audio/webm'));

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: RecorderHandler = null;
  readonly stream: MediaStream;
  readonly start = vi.fn(() => {
    this.state = 'recording';
  });
  readonly stop = vi.fn(() => {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new Blob(['voice-bytes'], { type: this.mimeType }),
      } as BlobEvent);
    }
    this.onstop?.();
  });

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    MockMediaRecorder.instances.push(this);
  }
}

interface Harness {
  current: number;
  trackStop: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
}

function installMediaHarness(
  options: { rejectWith?: unknown; noDevices?: boolean; secure?: boolean } = {},
): Harness {
  const harness: Harness = {
    current: 1_000,
    trackStop: vi.fn(),
    getUserMedia: vi.fn(),
  };
  const stream = {
    getTracks: () => [{ stop: harness.trackStop } as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
  if (options.rejectWith !== undefined) {
    harness.getUserMedia.mockRejectedValue(options.rejectWith);
  } else {
    harness.getUserMedia.mockResolvedValue(stream);
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
    value: options.noDevices ? undefined : { getUserMedia: harness.getUserMedia },
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: options.secure ?? true,
  });
  return harness;
}

const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function restore(name: 'mediaDevices' | 'isSecureContext'): void {
  if (name === 'mediaDevices') {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
    return;
  }
  if (originalSecureContext) {
    Object.defineProperty(window, 'isSecureContext', originalSecureContext);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalMediaRecorder === undefined) {
    Reflect.deleteProperty(globalThis, 'MediaRecorder');
  } else {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: originalMediaRecorder,
    });
  }
  restore('mediaDevices');
  restore('isSecureContext');
});

function setupRecorder(
  options: { maxDurationMs?: number; onRecorded?: (value: RecordedVoice) => void } = {},
) {
  const onRecorded = vi.fn(options.onRecorded ?? (() => {}));
  const harness = installMediaHarness();
  const view = renderHook(() =>
    useVoiceRecorder({
      onRecorded,
      maxDurationMs: options.maxDurationMs,
      now: () => harness.current,
    }),
  );
  return { ...view, onRecorded, harness };
}

describe('useVoiceRecorder', () => {
  it('records, ticks, stops and emits a voice file with duration and media', async () => {
    const { result, onRecorded, harness } = setupRecorder();

    await act(async () => {
      await result.current.start('send');
    });
    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.current.status).toBe('recording');
    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0]?.start).toHaveBeenCalledWith(1_000);

    harness.current += 2_500;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.elapsedMs).toBe(2_500);

    act(() => {
      result.current.stop();
    });
    expect(result.current.status).toBe('idle');
    expect(harness.trackStop).toHaveBeenCalledTimes(1);
    expect(onRecorded).toHaveBeenCalledTimes(1);

    const recorded = onRecorded.mock.calls[0]?.[0] as RecordedVoice;
    expect(recorded.intent).toBe('send');
    expect(recorded.media).toEqual({
      kind: 'AUDIO',
      duration_ms: 2_500,
      metadata_source: 'CLIENT',
    });
    expect(recorded.mime).toBe('audio/webm');
    expect(recorded.file.type).toBe('audio/webm');
    expect(recorded.file.name).toMatch(/^voice-.+\.webm$/);
    expect(recorded.file.size).toBeGreaterThan(0);
  });

  it('cancel stops tracks, discards the take and emits nothing', async () => {
    const { result, onRecorded, harness } = setupRecorder();
    await act(async () => {
      await result.current.start('send');
    });
    harness.current += 1_000;
    act(() => {
      result.current.cancel();
    });

    expect(result.current.status).toBe('idle');
    expect(harness.trackStop).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('maps a denied permission to an honest error and releases nothing else', async () => {
    const onRecorded = vi.fn();
    installMediaHarness({ rejectWith: new DOMException('denied', 'NotAllowedError') });
    const { result } = renderHook(() => useVoiceRecorder({ onRecorded }));

    await act(async () => {
      await result.current.start('send');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('voice.errorPermission');
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('maps a missing microphone to a specific error', async () => {
    installMediaHarness({ rejectWith: new DOMException('missing', 'NotFoundError') });
    const { result } = renderHook(() => useVoiceRecorder({ onRecorded: vi.fn() }));
    await act(async () => {
      await result.current.start('send');
    });
    expect(result.current.errorKey).toBe('voice.errorNoDevice');
  });

  it('reports an unsupported environment instead of prompting', async () => {
    const harness = installMediaHarness({ noDevices: true });
    const { result } = renderHook(() => useVoiceRecorder({ onRecorded: vi.fn() }));
    expect(getVoiceSupport().supported).toBe(false);
    await act(async () => {
      await result.current.start('send');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('voice.noMediaDevices');
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it('requires a secure context', async () => {
    installMediaHarness({ secure: false });
    const { result } = renderHook(() => useVoiceRecorder({ onRecorded: vi.fn() }));
    await act(async () => {
      await result.current.start('send');
    });
    expect(result.current.errorKey).toBe('voice.insecure');
  });

  it('auto-stops at the 10-minute cap with the clamped duration', async () => {
    const { result, onRecorded, harness } = setupRecorder({ maxDurationMs: 3_000 });
    await act(async () => {
      await result.current.start('send');
    });
    harness.current += 3_500;
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect((onRecorded.mock.calls[0]?.[0] as RecordedVoice).media.duration_ms).toBe(3_000);
  });

  it('releases the microphone on unmount', async () => {
    const { result, harness, unmount } = setupRecorder();
    await act(async () => {
      await result.current.start('send');
    });
    unmount();
    expect(harness.trackStop).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances[0]?.state).toBe('inactive');
  });

  it('surfaces a recorder runtime error', async () => {
    const { result } = setupRecorder();
    await act(async () => {
      await result.current.start('send');
    });
    act(() => {
      MockMediaRecorder.instances[0]?.onerror?.(new Event('error'));
    });
    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('voice.errorRecorder');
  });
});

describe('voice helpers', () => {
  it('maps DOMException names', () => {
    expect(recorderErrorKey(new DOMException('x', 'NotAllowedError'))).toBe(
      'voice.errorPermission',
    );
    expect(recorderErrorKey(new DOMException('x', 'NotReadableError'))).toBe('voice.errorBusy');
    expect(recorderErrorKey(new Error('x'))).toBe('voice.errorGeneric');
  });

  it('falls back to the first supported MIME', () => {
    installMediaHarness();
    expect(pickRecorderMime()).toBe('audio/webm;codecs=opus');
    MockMediaRecorder.isTypeSupported = vi.fn((mime: string) => mime === 'audio/ogg');
    expect(pickRecorderMime()).toBe('audio/ogg');
  });
});
