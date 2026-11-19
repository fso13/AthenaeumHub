import type {
  ApiAttachment,
  ChatSummary,
  SecurityMode,
  WorkspaceLimits,
  WorkspaceRole,
} from '../../api/types';
import { formatBytes } from '../../files/format';
import type { AppState } from '../../store/chatStore';
import { t, type MessageKey } from '../../i18n/ru';

export type FileKind = 'image' | 'doc' | 'audio' | 'video' | 'other';

export interface FileEntry {
  attachment: ApiAttachment;
  chatId: string;
  chatName: string;
  createdAt: string;
}

const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  OWNER: 'members.role.OWNER',
  ADMIN: 'members.role.ADMIN',
  MEMBER: 'members.role.MEMBER',
  GUEST: 'members.role.GUEST',
};

const TARIFF_LABEL: Record<WorkspaceLimits['tariff'], MessageKey> = {
  COMMUNITY: 'tariff.COMMUNITY',
  FAMILY: 'tariff.FAMILY',
  TEAM: 'tariff.TEAM',
  ENTERPRISE: 'tariff.ENTERPRISE',
};

const KIND_LABEL: Record<FileKind, MessageKey> = {
  image: 'fileKind.image',
  doc: 'fileKind.doc',
  audio: 'fileKind.audio',
  video: 'fileKind.video',
  other: 'fileKind.other',
};

export function roleLabel(role: WorkspaceRole | null | undefined): string {
  return role ? t(ROLE_LABEL[role]) : '—';
}

export function tariffLabel(tariff: WorkspaceLimits['tariff'] | null | undefined): string {
  return tariff ? t(TARIFF_LABEL[tariff]) : '—';
}

export function fileKindLabel(kind: FileKind): string {
  return t(KIND_LABEL[kind]);
}

/** Classify a file by MIME first, then by a conservative extension fallback. */
export function fileKind(mimeType: string | null | undefined, filename: string | null | undefined) {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image' as const;
  if (mime.startsWith('audio/')) return 'audio' as const;
  if (mime.startsWith('video/')) return 'video' as const;
  if (
    mime.startsWith('text/') ||
    mime === 'application/pdf' ||
    mime.includes('word') ||
    mime.includes('officedocument') ||
    mime === 'application/json'
  ) {
    return 'doc' as const;
  }
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image' as const;
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus'].includes(ext)) return 'audio' as const;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video' as const;
  if (
    [
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'md',
      'fig',
      'yaml',
      'yml',
    ].includes(ext)
  ) {
    return 'doc' as const;
  }
  return 'other' as const;
}

export function fileName(attachment: ApiAttachment): string {
  return attachment.filename?.trim() || t('files.unnamed');
}

/** Attachments already loaded by `/messages`, newest first, deduped by id. */
export function collectFiles(state: AppState): FileEntry[] {
  const seen = new Set<string>();
  const entries: FileEntry[] = [];
  for (const chat of state.chats) {
    const slice = state.slices[chat.id];
    if (!slice) continue;
    for (const message of slice.messages) {
      for (const attachment of message.attachments ?? []) {
        if (seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        entries.push({
          attachment,
          chatId: chat.id,
          chatName: chatDisplayName(chat, state),
          createdAt: message.created_at,
        });
      }
    }
  }
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** DIRECT chats have no server name (D-S4-02); derive it from the directory. */
export function chatDisplayName(chat: ChatSummary, state: AppState): string {
  if (chat.name) return chat.name;
  if (chat.type === 'DIRECT' && chat.peer_id) {
    return (
      state.workspaceMembers.items.find((member) => member.user_id === chat.peer_id)
        ?.display_name ?? t('chat.direct')
    );
  }
  return t('chat.group');
}

export function storagePercent(limits: WorkspaceLimits | null): number {
  if (!limits || limits.usage.limit <= 0) return 0;
  return Math.min(100, Math.round((limits.usage.used / limits.usage.limit) * 100));
}

export function storageUsed(limits: WorkspaceLimits | null): string {
  if (!limits) return '—';
  return formatBytes(limits.usage.used);
}

export function storageLimit(limits: WorkspaceLimits | null): string {
  if (!limits) return '—';
  return formatBytes(limits.usage.limit);
}

export function totalUnread(state: AppState): number {
  return state.chats.reduce((total, chat) => total + Math.max(0, chat.unread_count), 0);
}

/** D1 UX fidelity 2: mode label for the page eyebrow. */
export function securityModeLabel(mode: SecurityMode | null | undefined): string {
  return mode === 'E2EE' ? t('page.mode.e2ee') : t('page.mode.managed');
}

/** Number of messages already loaded (across all chats) — never invented. */
export function loadedMessageCount(state: AppState): number {
  let total = 0;
  for (const chat of state.chats) total += state.slices[chat.id]?.messages.length ?? 0;
  return total;
}

/** Online members from the ephemeral presence map. */
export function onlineMemberCount(state: AppState): number {
  return Object.values(state.presence).filter((entry) => entry.status === 'ONLINE').length;
}

/** Conservative extension label for file tiles. */
export function extensionOf(filename: string | null | undefined): string {
  const name = filename ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : 'FILE';
}

/** Short ru date (`12 ноя`) for table rows. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(date);
}

/** `HH:MM` for activity rows. */
export function timeOfDay(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Full long date for the overview eyebrow (`СРЕДА, 18 НОЯБРЯ`). */
export function todayLabel(): string {
  const raw = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Russian plural picker (1 участник / 2 участника / 5 участников). */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(count) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
