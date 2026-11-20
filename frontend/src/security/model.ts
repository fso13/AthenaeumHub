import type {
  DlpAction,
  DlpPatternType,
  DlpPolicyCreateRequest,
  DlpPolicyUpdateRequest,
  WorkspaceSecurity,
  WorkspaceSecurityUpdateRequest,
  WorkspaceSession,
} from '../api/types';

/**
 * P0-3 (#81) contract mirrors used by the UI. These constants come from
 * `contracts/openapi.yaml`; the server remains the source of truth.
 */
export const DLP_NAME_MAX = 120;
export const DLP_PATTERN_MAX = 200;
export const DLP_WILDCARD_MAX = 20;
export const DLP_POLICY_LIMIT = 100;
export const SESSION_TIMEOUT_MIN = 15;
export const SESSION_TIMEOUT_MAX = 10_080;
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 3650;
export const DLP_EVENTS_PAGE_SIZE = 30;
export const AUDIT_PAGE_SIZE = 30;
export const SESSIONS_PAGE_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Literal control-character check (no regex, matching the backend guard). */
export function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/** Compact id for a table cell; the full id stays in `title`/`aria-label`. */
export function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

export interface DlpPolicyDraft {
  name: string;
  action: DlpAction;
  patternType: DlpPatternType;
  pattern: string;
  enabled: boolean;
}

export interface DlpPolicyFieldErrors {
  name?: string;
  action?: string;
  patternType?: string;
  pattern?: string;
}

export function emptyDlpDraft(): DlpPolicyDraft {
  return { name: '', action: 'WARN', patternType: 'KEYWORD', pattern: '', enabled: true };
}

export function draftFromPolicy(policy: {
  name: string;
  action: DlpAction;
  pattern_type: DlpPatternType;
  pattern: string;
  enabled: boolean;
}): DlpPolicyDraft {
  return {
    name: policy.name,
    action: policy.action,
    patternType: policy.pattern_type,
    pattern: policy.pattern,
    enabled: policy.enabled,
  };
}

/**
 * Matches the backend envelope: 1..120 name, 1..200 printable pattern, no
 * control characters. PATTERN allows at most 20 `*` wildcards; KEYWORD treats
 * `*` as an ordinary character. No regex is compiled on either side.
 */
export function validateDlpDraft(draft: DlpPolicyDraft): DlpPolicyFieldErrors {
  const errors: DlpPolicyFieldErrors = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'security.validation.nameRequired';
  else if (name.length > DLP_NAME_MAX) errors.name = 'security.validation.nameTooLong';

  if (draft.action !== 'WARN' && draft.action !== 'BLOCK') {
    errors.action = 'security.validation.actionInvalid';
  }
  if (draft.patternType !== 'KEYWORD' && draft.patternType !== 'PATTERN') {
    errors.patternType = 'security.validation.patternTypeInvalid';
  }

  const pattern = draft.pattern;
  if (pattern.length === 0) errors.pattern = 'security.validation.patternRequired';
  else if (pattern.length > DLP_PATTERN_MAX) {
    errors.pattern = 'security.validation.patternTooLong';
  } else if (hasControlCharacters(pattern)) {
    errors.pattern = 'security.validation.patternControl';
  } else if (draft.patternType === 'PATTERN') {
    const wildcards = pattern.match(/\*/g)?.length ?? 0;
    if (wildcards > DLP_WILDCARD_MAX) errors.pattern = 'security.validation.patternWildcards';
  }
  return errors;
}

export function hasDlpErrors(errors: DlpPolicyFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Create body: trims only the name, the pattern is matched literally. */
export function toCreateDlpBody(draft: DlpPolicyDraft): DlpPolicyCreateRequest {
  return {
    name: draft.name.trim(),
    action: draft.action,
    pattern_type: draft.patternType,
    pattern: draft.pattern,
    enabled: draft.enabled,
  };
}

/** PATCH body: send the full editable rule; the server keeps it idempotent. */
export function toUpdateDlpBody(draft: DlpPolicyDraft): DlpPolicyUpdateRequest {
  return {
    name: draft.name.trim(),
    action: draft.action,
    pattern_type: draft.patternType,
    pattern: draft.pattern,
    enabled: draft.enabled,
  };
}

export interface SecurityDraft {
  require2fa: boolean;
  sessionTimeoutMinutes: string;
  dlpEnabled: boolean;
  retentionDays: string;
}

export interface SecurityFieldErrors {
  sessionTimeoutMinutes?: string;
  retentionDays?: string;
}

export function draftFromSecurity(settings: WorkspaceSecurity): SecurityDraft {
  return {
    require2fa: settings.require_2fa,
    sessionTimeoutMinutes: String(settings.session_timeout_minutes),
    dlpEnabled: settings.dlp_enabled,
    retentionDays: String(settings.retention_days),
  };
}

/** Integer bounds from the contract; strings stay in the inputs (no NaN cast). */
export function validateSecurityDraft(draft: SecurityDraft): SecurityFieldErrors {
  const errors: SecurityFieldErrors = {};
  const timeout = Number(draft.sessionTimeoutMinutes);
  if (
    draft.sessionTimeoutMinutes.trim() === '' ||
    !Number.isInteger(timeout) ||
    timeout < SESSION_TIMEOUT_MIN ||
    timeout > SESSION_TIMEOUT_MAX
  ) {
    errors.sessionTimeoutMinutes = 'security.validation.timeoutRange';
  }
  const retention = Number(draft.retentionDays);
  if (
    draft.retentionDays.trim() === '' ||
    !Number.isInteger(retention) ||
    retention < RETENTION_MIN ||
    retention > RETENTION_MAX
  ) {
    errors.retentionDays = 'security.validation.retentionRange';
  }
  return errors;
}

/**
 * Build the minimal PATCH body: sending only changed fields keeps the backend
 * idempotent (a same-value patch produces no second audit event).
 */
export function securityPatchFromDraft(
  draft: SecurityDraft,
  original: WorkspaceSecurity,
): WorkspaceSecurityUpdateRequest {
  const patch: WorkspaceSecurityUpdateRequest = {};
  if (draft.require2fa !== original.require_2fa) patch.require_2fa = draft.require2fa;
  const timeout = Number(draft.sessionTimeoutMinutes);
  if (Number.isInteger(timeout) && timeout !== original.session_timeout_minutes) {
    patch.session_timeout_minutes = timeout;
  }
  if (draft.dlpEnabled !== original.dlp_enabled) patch.dlp_enabled = draft.dlpEnabled;
  const retention = Number(draft.retentionDays);
  if (Number.isInteger(retention) && retention !== original.retention_days) {
    patch.retention_days = retention;
  }
  return patch;
}

export interface SessionGroup {
  userId: string;
  sessions: WorkspaceSession[];
}

/**
 * Group sessions by user while preserving the server's `last_seen_at DESC`
 * order; devices inside a group keep the same order. The contract has no
 * display name, so the UI shows the user id (never an email/IP).
 */
export function groupSessions(sessions: WorkspaceSession[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byUser = new Map<string, SessionGroup>();
  for (const session of sessions) {
    let group = byUser.get(session.user_id);
    if (!group) {
      group = { userId: session.user_id, sessions: [] };
      byUser.set(session.user_id, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }
  return groups;
}

/** `from > to` is the documented 400; check it before the request. */
export function invalidDateRange(from: string, to: string): boolean {
  if (!from || !to) return false;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return false;
  return fromMs > toMs;
}

/** `datetime-local` value → inclusive ISO instant; empty stays undefined. */
export function datetimeLocalToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function defaultExportFilename(format: 'csv' | 'json'): string {
  const date = new Date().toISOString().slice(0, 10);
  return `workspace-audit-${date}.${format}`;
}
