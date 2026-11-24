/**
 * #190: remembered collapsed/expanded state of the sidebar sections.
 * Per-user, non-secret UI preference; no chat ids or message content here.
 */
export interface SidebarSectionsState {
  channels: boolean;
  directs: boolean;
  rooms: boolean;
}

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionsState = {
  channels: false,
  directs: false,
  rooms: false,
};

function storageKey(userId: string | null): string {
  return `krug.sidebar.sections.${userId ?? 'anonymous'}`;
}

export function readSidebarSections(userId: string | null): SidebarSectionsState {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_SIDEBAR_SECTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SIDEBAR_SECTIONS;
    const value = parsed as Partial<SidebarSectionsState>;
    return {
      channels: value.channels === true,
      directs: value.directs === true,
      rooms: value.rooms === true,
    };
  } catch {
    return DEFAULT_SIDEBAR_SECTIONS;
  }
}

export function writeSidebarSections(
  userId: string | null,
  state: SidebarSectionsState,
): SidebarSectionsState {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Private mode/quota: folding still works for this session.
  }
  return state;
}
