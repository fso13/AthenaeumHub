/**
 * #94 host-relay music mixing.
 *
 * The server has no SFU and never mixes audio. When a participant is in a call
 * and starts the Music Room player, this client builds a Web Audio destination
 * stream that contains the microphone **and** the music, then replaces the
 * outgoing audio sender of every `RTCPeerConnection`. Every peer of the call
 * therefore hears the music through the host's regular WebRTC audio track.
 *
 * The mixer is deliberately tiny and injectable: jsdom has no Web Audio, and
 * the call suite can assert start/stop without a real audio graph.
 */
export interface MixedCallAudio {
  /** Audio track that carries microphone + music; sent to every peer. */
  track: MediaStreamTrack;
  /** Detach the graph and release the destination stream. */
  dispose(): void;
}

export interface CallMusicMixer {
  /**
   * Build the mixed outgoing track. Returns `null` when the platform cannot
   * mix audio; callers must then keep the plain microphone track and say so
   * honestly instead of pretending peers can hear the music.
   */
  mix(mic: MediaStream, music: MediaStream): MixedCallAudio | null;
}

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

/** Browser implementation: mic + music → MediaStreamDestination. */
export function createWebAudioMusicMixer(): CallMusicMixer {
  return {
    mix(mic, music) {
      const Ctor = resolveAudioContext();
      if (!Ctor) return null;
      try {
        const context = new Ctor();
        // A context created after an awaited download may start suspended.
        void context.resume().catch(() => undefined);
        const destination = context.createMediaStreamDestination();
        const micSource = context.createMediaStreamSource(mic);
        const musicSource = context.createMediaStreamSource(music);
        // Both sources feed the outgoing call; the music is also audible
        // locally through the player's own audio element (never through the
        // microphone path, so there is no feedback loop).
        micSource.connect(destination);
        musicSource.connect(destination);
        const track = destination.stream.getAudioTracks()[0];
        if (!track) {
          void context.close();
          return null;
        }
        let disposed = false;
        return {
          track,
          dispose() {
            if (disposed) return;
            disposed = true;
            try {
              micSource.disconnect();
              musicSource.disconnect();
            } catch {
              // Graph may already be closed by the browser.
            }
            void context.close().catch(() => undefined);
          },
        };
      } catch {
        return null;
      }
    },
  };
}
