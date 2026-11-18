/**
 * Voice recording via `MediaRecorder` (D1-FE2).
 *
 * Rules honoured here:
 *  - no microphone access before an explicit user action (`start`);
 *  - secure context / `MediaRecorder` / `getUserMedia` are checked up front so
 *    the button can render an honest disabled state;
 *  - microphone and recorder tracks are always stopped on cancel, error and
 *    unmount, so the browser indicator never stays on;
 *  - the duration is measured locally (MediaRecorder WebM often has no
 *    duration metadata) and clamped to the backend voice bounds (1 ms..10 min);
 *  - a denied/absent/busy microphone maps to a specific, translated message.
 *
 * This hook is E2EE-agnostic; the caller decides availability (voice uploads
 * are managed-only in D1, so the button is disabled in E2EE chats).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadMediaMetadata } from '../api/types';
import { MAX_VOICE_DURATION_MS, clampDuration, voiceMediaMetadata } from '../files/media';
import type { MessageKey } from '../i18n/ru';

export type VoiceIntent = 'send' | 'attach';
export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error';

export interface VoiceSupport {
  supported: boolean;
  /** Honest explanation for the disabled button (secure context / API). */
  reasonKey: MessageKey | null;
}

export interface RecordedVoice {
  file: File;
  media: UploadMediaMetadata;
  intent: VoiceIntent;
  durationMs: number;
  mime: string;
}

export interface UseVoiceRecorderOptions {
  onRecorded: (result: RecordedVoice) => void;
  maxDurationMs?: number;
  /** Test seam; production uses `Date.now`. */
  now?: () => number;
}

export interface VoiceRecorder {
  status: VoiceStatus;
  elapsedMs: number;
  errorKey: MessageKey | null;
  start: (intent?: VoiceIntent) => Promise<void>;
  /** Stop and emit the take (`onRecorded`) with the original intent. */
  stop: () => void;
  /** Stop, discard chunks and release the microphone. */
  cancel: () => void;
  dismissError: () => void;
}

const RECORDING_TIMESLICE_MS = 1_000;
const TIMER_INTERVAL_MS = 500;

/** Prefer a browser-supported MIME; the backend allows webm/ogg (+codecs). */
export function pickRecorderMime(): string | null {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (typeof Recorder === 'undefined' || typeof Recorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const candidate of candidates) {
    if (Recorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function baseMime(mime: string): string {
  return (mime.split(';', 1)[0] ?? '').trim().toLowerCase() || 'audio/webm';
}

/** Checked on every render: no permission prompt, only capability probing. */
export function getVoiceSupport(): VoiceSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reasonKey: 'voice.unsupported' };
  }
  if (window.isSecureContext === false) {
    return { supported: false, reasonKey: 'voice.insecure' };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, reasonKey: 'voice.unsupported' };
  }
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    return { supported: false, reasonKey: 'voice.noMediaDevices' };
  }
  return { supported: true, reasonKey: null };
}

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Map a DOMException from `getUserMedia`/`MediaRecorder` to an i18n key. */
export function recorderErrorKey(error: unknown): MessageKey {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'voice.errorPermission';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'voice.errorNoDevice';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'voice.errorBusy';
    case 'NotSupportedError':
    case 'TypeError':
      return 'voice.unsupported';
    default:
      return 'voice.errorGeneric';
  }
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // A detached/ended stream is already harmless.
  }
}

function voiceFilename(mime: string): string {
  const extension = mime.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `voice-${stamp}.${extension}`;
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions): VoiceRecorder {
  const onRecordedRef = useRef(options.onRecorded);
  onRecordedRef.current = options.onRecorded;
  const now = options.now ?? Date.now;
  const maxDurationMs = Math.max(1, options.maxDurationMs ?? MAX_VOICE_DURATION_MS);

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  const statusRef = useRef<VoiceStatus>('idle');
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const intentRef = useRef<VoiceIntent>('send');
  const canceledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const stopRef = useRef<() => void>(() => {});
  /** Invalidates a pending `getUserMedia` promise after cancel/unmount. */
  const attemptRef = useRef(0);

  const updateStatus = useCallback((next: VoiceStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const fail = useCallback(
    (key: MessageKey) => {
      releaseRecorder();
      chunksRef.current = [];
      updateStatus('error');
      if (mountedRef.current) {
        setErrorKey(key);
        setElapsedMs(0);
      }
    },
    [releaseRecorder, updateStatus],
  );

  const finalize = useCallback(() => {
    const durationMs = clampDuration(now() - startedAtRef.current, 1, maxDurationMs);
    const recorder = recorderRef.current;
    const recordedMime = baseMime(recorder?.mimeType || 'audio/webm');
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const wasCanceled = canceledRef.current;
    releaseRecorder();

    if (wasCanceled) {
      updateStatus('idle');
      if (mountedRef.current) setElapsedMs(0);
      return;
    }
    const blob = new Blob(chunks, { type: recordedMime });
    if (blob.size < 1) {
      fail('voice.errorEmpty');
      return;
    }
    const file = new File([blob], voiceFilename(recordedMime), { type: recordedMime });
    const result: RecordedVoice = {
      file,
      media: voiceMediaMetadata(durationMs),
      intent: intentRef.current,
      durationMs,
      mime: recordedMime,
    };
    updateStatus('idle');
    if (mountedRef.current) setElapsedMs(0);
    onRecordedRef.current(result);
  }, [fail, maxDurationMs, now, releaseRecorder, updateStatus]);

  const stop = useCallback(() => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'requesting') return;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      if (statusRef.current === 'requesting') {
        // Permission is still pending: cancel cleanly instead of hanging.
        canceledRef.current = true;
        attemptRef.current += 1;
        releaseRecorder();
        updateStatus('idle');
      }
      return;
    }
    updateStatus('stopping');
    try {
      recorder.stop();
    } catch (error) {
      fail(recorderErrorKey(error));
    }
  }, [fail, releaseRecorder, updateStatus]);
  stopRef.current = stop;

  const cancel = useCallback(() => {
    canceledRef.current = true;
    attemptRef.current += 1;
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // The recorder may already be inactive.
      }
    }
    releaseRecorder();
    chunksRef.current = [];
    updateStatus('idle');
    if (mountedRef.current) {
      setElapsedMs(0);
      setErrorKey(null);
    }
  }, [clearTimer, releaseRecorder, updateStatus]);

  const dismissError = useCallback(() => {
    if (statusRef.current !== 'error') return;
    updateStatus('idle');
    if (mountedRef.current) setErrorKey(null);
  }, [updateStatus]);

  const start = useCallback(
    async (intent: VoiceIntent = 'send') => {
      if (statusRef.current === 'requesting' || statusRef.current === 'recording') return;
      if (statusRef.current === 'stopping') return;
      const support = getVoiceSupport();
      if (!support.supported) {
        updateStatus('error');
        if (mountedRef.current) setErrorKey(support.reasonKey ?? 'voice.unsupported');
        return;
      }

      canceledRef.current = false;
      intentRef.current = intent;
      chunksRef.current = [];
      const attempt = attemptRef.current + 1;
      attemptRef.current = attempt;
      if (mountedRef.current) {
        setErrorKey(null);
        setElapsedMs(0);
      }
      updateStatus('requesting');

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        if (mountedRef.current) setErrorKey(recorderErrorKey(error));
        updateStatus('error');
        return;
      }

      if (attempt !== attemptRef.current || canceledRef.current || !mountedRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;

      let recorder: MediaRecorder;
      try {
        const mime = pickRecorderMime();
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (error) {
        stopStream(stream);
        streamRef.current = null;
        if (mountedRef.current) setErrorKey(recorderErrorKey(error));
        updateStatus('error');
        return;
      }

      recorderRef.current = recorder;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        fail('voice.errorRecorder');
      };
      recorder.onstop = () => finalize();

      startedAtRef.current = now();
      try {
        recorder.start(RECORDING_TIMESLICE_MS);
      } catch (error) {
        fail(recorderErrorKey(error));
        return;
      }
      updateStatus('recording');
      timerRef.current = setInterval(() => {
        if (statusRef.current !== 'recording') return;
        const elapsed = Math.max(0, now() - startedAtRef.current);
        if (mountedRef.current) setElapsedMs(elapsed);
        if (elapsed >= maxDurationMs) {
          stopRef.current();
        }
      }, TIMER_INTERVAL_MS);
    },
    [fail, finalize, maxDurationMs, now, updateStatus],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      canceledRef.current = true;
      attemptRef.current += 1;
      clearTimer();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Already stopped.
          }
        }
      }
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [clearTimer]);

  return { status, elapsedMs, errorKey, start, stop, cancel, dismissError };
}
