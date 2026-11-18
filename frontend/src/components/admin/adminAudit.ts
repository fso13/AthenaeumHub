import type { AdminAuditEvent } from '../../api/types';
import type { MessageKey } from '../../i18n/ru';

/**
 * Exact action names the audit filter offers.
 *
 * The contract types `action` as a free string (max 120 chars), so this is a
 * deliberately curated list, not an invented enum: every value here is emitted
 * by the backend audit writer (grep of `AuditRecord` action constants) or
 * documented in `backend/E11-B-REPORT.md`. Events with an action outside this
 * list are still listed in the table; the filter simply cannot select them.
 */
export const KNOWN_AUDIT_ACTIONS = [
  'admin.user.suspended',
  'admin.user.activated',
  'admin.chat.deleted',
  'admin.users.viewed',
  'admin.chats.viewed',
  'admin.storage.viewed',
  'admin.audit.viewed',
  'settings.updated',
  'settings.test_email',
  'setup.completed',
  'user.provisioned',
  'workspace.created',
  'device.list.changed',
  'chat.keys.changed',
  'message.created',
  'message.receipt',
  'session.revoked',
] as const;

export type KnownAuditAction = (typeof KNOWN_AUDIT_ACTIONS)[number];

const ACTION_LABELS: Record<KnownAuditAction, MessageKey> = {
  'admin.user.suspended': 'admin.audit.action.admin.user.suspended',
  'admin.user.activated': 'admin.audit.action.admin.user.activated',
  'admin.chat.deleted': 'admin.audit.action.admin.chat.deleted',
  'admin.users.viewed': 'admin.audit.action.admin.users.viewed',
  'admin.chats.viewed': 'admin.audit.action.admin.chats.viewed',
  'admin.storage.viewed': 'admin.audit.action.admin.storage.viewed',
  'admin.audit.viewed': 'admin.audit.action.admin.audit.viewed',
  'settings.updated': 'admin.audit.action.settings.updated',
  'settings.test_email': 'admin.audit.action.settings.test_email',
  'setup.completed': 'admin.audit.action.setup.completed',
  'user.provisioned': 'admin.audit.action.user.provisioned',
  'workspace.created': 'admin.audit.action.workspace.created',
  'device.list.changed': 'admin.audit.action.device.list.changed',
  'chat.keys.changed': 'admin.audit.action.chat.keys.changed',
  'message.created': 'admin.audit.action.message.created',
  'message.receipt': 'admin.audit.action.message.receipt',
  'session.revoked': 'admin.audit.action.session.revoked',
};

const TARGET_LABELS: Record<string, MessageKey> = {
  user: 'admin.audit.target.user',
  chat: 'admin.audit.target.chat',
  admin_users: 'admin.audit.target.admin_users',
  admin_chats: 'admin.audit.target.admin_chats',
  admin_storage: 'admin.audit.target.admin_storage',
  admin_audit: 'admin.audit.target.admin_audit',
  system_settings: 'admin.audit.target.system_settings',
};

/** Human label key for a known action; `null` keeps the raw server code. */
export function auditActionLabelKey(action: string): MessageKey | null {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, action)
    ? ACTION_LABELS[action as KnownAuditAction]
    : null;
}

/** Human label key for a known target type; `null` keeps the raw server value. */
export function auditTargetLabelKey(targetType: string): MessageKey | null {
  return TARGET_LABELS[targetType] ?? null;
}

/**
 * Actor cell: the contract exposes `actor_email` (the only PII allowed for an
 * admin) and `actor_id`; system events have neither.
 */
export function auditActor(event: AdminAuditEvent): {
  email: string | null;
  id: string | null;
  isSystem: boolean;
} {
  return {
    email: event.actor_email,
    id: event.actor_id,
    isSystem: event.actor_id === null && event.actor_email === null,
  };
}

/** Short UUID for aligned rows; the full value stays in `title`/aria-label. */
export function shortId(value: string | null): string | null {
  return value ? value.slice(0, 8) : null;
}
