import { normalizeOutputVolume } from '../prefs/devicePreferences';

/**
 * #107 remote-output controls.
 *
 * The volume/mute state belongs to the local UI and is applied to every remote
 * `<audio>`/`<video>` element (1:1 remote and each mesh tile). Selecting an
 * output device uses the browser's `selectAudioOutput()` picker and
 * `HTMLMediaElement.setSinkId()`. Both are feature-detected: no fake device
 * list is invented when the platform does not support them.
 */
export interface MediaOutputSettings {
  /** 0..100; converted to the element's 0..1 `volume` property. */
  volume: number;
  muted: boolean;
  /** `MediaDeviceInfo.deviceId` from `selectAudioOutput`, or null for system. */
  deviceId: string | null;
}

interface AudioOutputMediaDevices extends MediaDevices {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
}

function audioOutputMediaDevices(): AudioOutputMediaDevices | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return null;
  return navigator.mediaDevices as AudioOutputMediaDevices;
}

/** True when the browser can open its output-device picker. */
export function canSelectAudioOutput(): boolean {
  return supportsSetSinkId() && typeof audioOutputMediaDevices()?.selectAudioOutput === 'function';
}

/** True when this media element exposes the sink-selection API. */
export function supportsSetSinkId(
  element: HTMLMediaElement | null = typeof HTMLMediaElement === 'undefined'
    ? null
    : HTMLMediaElement.prototype,
): boolean {
  return Boolean(element && typeof element.setSinkId === 'function');
}

/**
 * Open the browser's audio-output picker. Resolves to the chosen device, or
 * null when the platform is unsupported. The caller handles rejection (user
 * cancel vs. permission failure) so no success state is invented.
 */
export async function chooseAudioOutputDevice(): Promise<MediaDeviceInfo | null> {
  const devices = audioOutputMediaDevices();
  if (!devices?.selectAudioOutput || !supportsSetSinkId()) return null;
  return devices.selectAudioOutput();
}

/**
 * Apply the settings to one media element. Returns false only when a requested
 * `setSinkId` fails, so the call UI can explain that the device did not switch.
 */
export async function applyMediaOutput(
  element: HTMLMediaElement | null,
  settings: MediaOutputSettings,
): Promise<boolean> {
  if (!element) return true;
  element.volume = normalizeOutputVolume(settings.volume) / 100;
  element.muted = settings.muted;
  if (!settings.deviceId || !supportsSetSinkId(element)) return true;
  if (element.sinkId === settings.deviceId) return true;
  try {
    await element.setSinkId(settings.deviceId);
    return true;
  } catch {
    return false;
  }
}
