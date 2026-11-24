/** #194: per-device message feed appearance, all non-secret UI preferences. */
export interface AppearancePreferences {
  density: 'comfortable' | 'compact';
  messageSpacing: 'spacious' | 'compact';
  linkPreviews: boolean;
  hideOwnAvatars: boolean;
  accent: 'sova-teal';
}

const KEY = 'krug.appearance.preferences';

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  density: 'comfortable',
  messageSpacing: 'spacious',
  linkPreviews: true,
  hideOwnAvatars: false,
  accent: 'sova-teal',
};

export function readAppearancePreferences(): AppearancePreferences {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const value = JSON.parse(raw) as Partial<AppearancePreferences>;
    return {
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      messageSpacing: value.messageSpacing === 'compact' ? 'compact' : 'spacious',
      linkPreviews: value.linkPreviews !== false,
      hideOwnAvatars: value.hideOwnAvatars === true,
      accent: 'sova-teal',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearancePreferences(
  patch: Partial<AppearancePreferences>,
): AppearancePreferences {
  const next = { ...readAppearancePreferences(), ...patch, accent: 'sova-teal' as const };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode/quota: the current document still gets the classes below.
  }
  applyAppearancePreferences(next);
  return next;
}

export function applyAppearancePreferences(
  prefs: AppearancePreferences = readAppearancePreferences(),
): void {
  const root = document.documentElement;
  root.dataset.density = prefs.density;
  root.dataset.messageSpacing = prefs.messageSpacing;
  root.dataset.linkPreviews = prefs.linkPreviews ? 'on' : 'off';
  root.dataset.hideOwnAvatars = prefs.hideOwnAvatars ? 'on' : 'off';
  // Sova brand teal. Keep the same token names as the theme so every surface
  // (buttons, links, focus rings) follows one accent.
  root.style.setProperty('--accent', '#2aa79b');
  root.style.setProperty('--accent-soft', 'color-mix(in srgb, #2aa79b 16%, transparent)');
  root.style.setProperty('--accent-ring', 'color-mix(in srgb, #2aa79b 28%, transparent)');
}
