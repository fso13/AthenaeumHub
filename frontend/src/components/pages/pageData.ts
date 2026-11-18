import type { ApiAttachment, ChatSummary, WorkspaceLimits, WorkspaceRole } from '../../api/types';
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

function chatDisplayName(chat: ChatSummary, state: AppState): string {
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
