/** #194: per-device message feed appearance, all non-secret UI preferences. */
export interface AppearancePreferences {
  density: 'comfortable' | 'compact';
  messageSpacing: 'spacious' | 'compact';
  linkPreviews: boolean;
  hideOwnAvatars: boolean;
  accent: AccentId;
}

const KEY = 'krug.appearance.preferences';

export type AccentId = 'sova-teal' | 'ocean' | 'violet' | 'amber' | 'rose';

type AccentLabelKey =
  | 'settings.accentSova'
  | 'settings.accentOcean'
  | 'settings.accentViolet'
  | 'settings.accentAmber'
  | 'settings.accentRose';

export const ACCENTS: ReadonlyArray<{
  id: AccentId;
  color: string;
  labelKey: AccentLabelKey;
}> = [
  { id: 'sova-teal', color: '#2aa79b', labelKey: 'settings.accentSova' },
  { id: 'ocean', color: '#4c8dff', labelKey: 'settings.accentOcean' },
  { id: 'violet', color: '#9b7bff', labelKey: 'settings.accentViolet' },
  { id: 'amber', color: '#e0a33e', labelKey: 'settings.accentAmber' },
  { id: 'rose', color: '#e56b8c', labelKey: 'settings.accentRose' },
];

const ACCENT_VALUES: Record<AccentId, { base: string; strong: string }> = {
  'sova-teal': { base: '#2aa79b', strong: '#1f8a80' },
  ocean: { base: '#4c8dff', strong: '#3a6fd8' },
  violet: { base: '#9b7bff', strong: '#7f5fe6' },
  amber: { base: '#e0a33e', strong: '#c28628' },
  rose: { base: '#e56b8c', strong: '#c94d70' },
};

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  density: 'comfortable',
  messageSpacing: 'spacious',
  linkPreviews: true,
  hideOwnAvatars: false,
  accent: 'sova-teal',
};

function isAccent(value: unknown): value is AccentId {
  return typeof value === 'string' && ACCENTS.some((entry) => entry.id === value);
}

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
      accent: isAccent(value.accent) ? value.accent : 'sova-teal',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearancePreferences(
  patch: Partial<AppearancePreferences>,
): AppearancePreferences {
  const next = { ...readAppearancePreferences(), ...patch };
  next.accent = isAccent(next.accent) ? next.accent : 'sova-teal';
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
  const accent = ACCENT_VALUES[prefs.accent];
  root.style.setProperty('--accent', accent.base);
  root.style.setProperty('--accent-strong', accent.strong);
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent.base} 16%, transparent)`);
  root.style.setProperty('--accent-softer', `color-mix(in srgb, ${accent.base} 9%, transparent)`);
  root.style.setProperty('--accent-ring', `color-mix(in srgb, ${accent.base} 28%, transparent)`);
}
