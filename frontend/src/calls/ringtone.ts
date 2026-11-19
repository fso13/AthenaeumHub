/**
 * #77: tiny WebAudio ringtone. No external assets, no HTMLAudioElement, and no
 * work before the user (or an incoming call) starts one:
 *  - outgoing calls hear a quiet ringback loop until the first peer connects;
 *  - incoming calls hear a short repeating chirp until accept/reject;
 *  - `stop()` removes every scheduled node, so connect/cancel/error is silent.
 *
 * The context is created lazily because browsers only allow audio after a
 * gesture. `startOutgoing()` runs inside the click handler; `startIncoming()`
 * resumes an already-unlocked context and stays silent if the browser refuses.
 */

export interface CallRingtone {
  startOutgoing(): void;
  startIncoming(): void;
  stop(): void;
  dispose(): void;
}

type AudioContextFactory = () => AudioContext | null;

/** Ringback: 1 s on / 2 s off, intentionally quiet (≈ -26 dBFS). */
const RINGBACK_INTERVAL_MS = 3_000;
/** Incoming: two short chirps every 2.4 s. */
const INCOMING_INTERVAL_MS = 2_400;
const TONE_GAIN = 0.055;

function browserAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scoped = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = scoped.AudioContext ?? scoped.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

class WebAudioCallRingtone implements CallRingtone {
  private readonly createContext: AudioContextFactory;
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly voices = new Set<OscillatorNode>();
  private stopped = false;

  constructor(createContext: AudioContextFactory) {
    this.createContext = createContext;
  }

  startOutgoing(): void {
    this.startPattern(() => this.playRingback(), RINGBACK_INTERVAL_MS);
  }

  startIncoming(): void {
    this.startPattern(() => this.playIncoming(), INCOMING_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const voice of this.voices) {
      try {
        voice.stop();
        voice.disconnect();
      } catch {
        // already stopped
      }
    }
    this.voices.clear();
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context) {
      try {
        void context.close();
      } catch {
        // already closed
      }
    }
  }

  private startPattern(play: () => void, intervalMs: number): void {
    this.stop();
    this.stopped = false;
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === 'suspended') {
      // Nested inside a user gesture this unlocks audio; for an incoming call
      // the browser may keep it suspended and the chirp stays silent.
      void context.resume().catch(() => undefined);
    }
    play();
    this.timer = setInterval(() => {
      if (!this.stopped) play();
    }, intervalMs);
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    this.context = this.createContext();
    return this.context;
  }

  private playRingback(): void {
    const context = this.ensureContext();
    if (!context) return;
    // Two close frequencies beat softly, the classic "waiting for answer" feel.
    this.tone(context, [425, 480], context.currentTime, 1);
  }

  private playIncoming(): void {
    const context = this.ensureContext();
    if (!context) return;
    const start = context.currentTime;
    this.tone(context, [880], start, 0.11);
    this.tone(context, [660], start + 0.2, 0.11);
  }

  private tone(context: AudioContext, frequencies: number[], startAt: number, duration: number) {
    const gain = context.createGain();
    const endAt = startAt + duration;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(TONE_GAIN, startAt + 0.02);
    gain.gain.setValueAtTime(TONE_GAIN, Math.max(startAt + 0.02, endAt - 0.04));
    gain.gain.linearRampToValueAtTime(0, endAt);
    gain.connect(context.destination);

    for (const frequency of frequencies) {
      const voice = context.createOscillator();
      voice.type = 'sine';
      voice.frequency.value = frequency;
      voice.connect(gain);
      voice.start(startAt);
      voice.stop(endAt);
      this.voices.add(voice);
      voice.onended = () => {
        this.voices.delete(voice);
        try {
          voice.disconnect();
          gain.disconnect();
        } catch {
          // already disconnected
        }
      };
    }
  }
}

/** Production factory; returns a no-op implementation where WebAudio is absent. */
export function createWebAudioRingtone(
  createContext: AudioContextFactory = browserAudioContext,
): CallRingtone {
  return new WebAudioCallRingtone(createContext);
}

/** Test/no-audio implementation. */
export function createSilentRingtone(): CallRingtone {
  return {
    startOutgoing() {},
    startIncoming() {},
    stop() {},
    dispose() {},
  };
}
