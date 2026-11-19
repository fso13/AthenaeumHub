import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebAudioRingtone } from './ringtone';

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator {
  type = 'sine';
  frequency = { value: 0 };
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

function setup() {
  const context = new FakeAudioContext();
  const ringtone = createWebAudioRingtone(() => context as unknown as AudioContext);
  return { context, ringtone };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WebAudio ringtone (#77)', () => {
  it('loops the outgoing ringback and stops every scheduled voice', () => {
    vi.useFakeTimers();
    const { context, ringtone } = setup();

    ringtone.startOutgoing();
    // One ringback burst uses two close frequencies.
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[0]?.start).toHaveBeenCalled();

    vi.advanceTimersByTime(3_000);
    expect(context.oscillators).toHaveLength(4);

    ringtone.stop();
    const stoppedAt = context.oscillators[0]?.stop.mock.calls.length ?? 0;
    expect(stoppedAt).toBeGreaterThan(0);
    vi.advanceTimersByTime(9_000);
    expect(context.oscillators).toHaveLength(4);
  });

  it('plays a short two-chirp incoming signal that repeats until stopped', () => {
    vi.useFakeTimers();
    const { context, ringtone } = setup();

    ringtone.startIncoming();
    expect(context.oscillators).toHaveLength(2);
    vi.advanceTimersByTime(2_400);
    expect(context.oscillators).toHaveLength(4);

    ringtone.stop();
    vi.advanceTimersByTime(5_000);
    expect(context.oscillators).toHaveLength(4);
  });

  it('resumes a suspended context, and stays silent when WebAudio is unavailable', () => {
    const { context, ringtone } = setup();
    context.state = 'suspended';
    ringtone.startOutgoing();
    expect(context.resume).toHaveBeenCalled();
    ringtone.stop();

    const silent = createWebAudioRingtone(() => null);
    expect(() => {
      silent.startOutgoing();
      silent.startIncoming();
      silent.stop();
      silent.dispose();
    }).not.toThrow();
  });

  it('closes the audio context on dispose', () => {
    const { context, ringtone } = setup();
    ringtone.startIncoming();
    ringtone.dispose();
    expect(context.close).toHaveBeenCalled();
  });
});
