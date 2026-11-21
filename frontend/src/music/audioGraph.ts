import type { MusicAudioElement, MusicAudioGraph } from './store';

type AudioContextCtor = new () => AudioContext;

function resolveAudioContext(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const candidate =
    (window as unknown as { AudioContext?: AudioContextCtor }).AudioContext ??
    (
      window as unknown as {
        webkitAudioContext?: AudioContextCtor;
      }
    ).webkitAudioContext;
  return candidate ?? null;
}

/**
 * #94 default Web Audio graph: the `<audio>` element is the single playback
 * source, its sound is monitored locally through `ctx.destination`, and the
 * same samples leave through a `MediaStreamDestination` that the call engine
 * mixes with the microphone. Returns `null` where Web Audio is unavailable
 * (jsdom, very old browsers) — playback still works locally, but the UI says
 * that peers cannot hear it.
 */
export function createWebAudioMusicGraph(element: MusicAudioElement): MusicAudioGraph | null {
  const Ctor = resolveAudioContext();
  if (!Ctor) return null;
  try {
    const context = new Ctor();
    const source = context.createMediaElementSource(element as unknown as HTMLAudioElement);
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(context.destination);
    gain.connect(destination);
    const stream = destination.stream;
    let disposed = false;
    return {
      stream,
      resume: () => {
        // May stay suspended until a second user gesture; playback itself is
        // already user-initiated, so this is only a best-effort unlock.
        void context.resume().catch(() => undefined);
        return Promise.resolve();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // The graph may already be closed by the browser.
        }
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
