import { useEffect, useState } from 'react';

/**
 * #107 honest microphone level meter.
 *
 * The level comes from a real `AnalyserNode` over the local microphone track —
 * no random animation. It is only active while the user explicitly opens the
 * mic test, the call is connected and the microphone is not muted. A missing
 * `AudioContext` means the browser cannot measure the level, so the UI hides
 * the control instead of faking it.
 */
interface AudioContextWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
  return typeof candidate === 'function' ? candidate : null;
}

/** Feature detection for rendering the "check microphone" control. */
export function supportsMicLevel(): boolean {
  return audioContextCtor() !== null;
}

export interface MicLevelState {
  supported: boolean;
  /** 0..100; 0 when inactive, muted or unsupported. */
  level: number;
}

export function useMicLevel(
  stream: MediaStream | null,
  active: boolean,
  muted: boolean,
): MicLevelState {
  const supported = supportsMicLevel();
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!active || !stream || muted || !supported) {
      setLevel(0);
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) {
      setLevel(0);
      return;
    }

    let context: AudioContext;
    try {
      context = new Ctor();
    } catch {
      setLevel(0);
      return;
    }

    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
    } catch {
      void context.close?.().catch(() => undefined);
      setLevel(0);
      return;
    }

    const samples = new Float32Array(analyser.fftSize);
    const bytes = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let lastSampleAt = 0;

    const readLevel = (): number => {
      let sum = 0;
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) sum += sample * sample;
        return Math.sqrt(sum / samples.length);
      }
      analyser.getByteTimeDomainData(bytes);
      for (const sample of bytes) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      return Math.sqrt(sum / bytes.length);
    };

    const tick = (time: number) => {
      frame = window.requestAnimationFrame(tick);
      if (time - lastSampleAt < 100) return;
      lastSampleAt = time;
      const rms = readLevel();
      // Map a realistic speech range (-60..0 dBFS) to 0..100.
      const decibels = 20 * Math.log10(Math.max(rms, 1e-8));
      const next = Math.round(Math.min(100, Math.max(0, ((decibels + 60) / 60) * 100)));
      setLevel(next);
    };

    void context.resume?.().catch(() => undefined);
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // already disconnected
      }
      void context.close?.().catch(() => undefined);
      setLevel(0);
    };
  }, [active, muted, stream, supported]);

  return { supported, level: active && !muted ? level : 0 };
}
