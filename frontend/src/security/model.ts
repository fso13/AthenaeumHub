import type {
  DlpAction,
  DlpPatternType,
  DlpPolicyCreateRequest,
  DlpPolicyUpdateRequest,
  DlpScope,
  WorkspaceSecurity,
  WorkspaceSecurityUpdateRequest,
  WorkspaceSession,
} from '../api/types';

/**
 * P0-3 (#81) / #101 contract mirrors used by the UI. These constants come from
 * `contracts/openapi.yaml`; the server remains the source of truth.
 */
export const DLP_NAME_MAX = 120;
export const DLP_PATTERN_MAX = 200;
export const DLP_WILDCARD_MAX = 20;
export const DLP_POLICY_LIMIT = 100;
/** #101 `max_file_size_bytes` bounds (1 B … 10 GiB), attachment/ALL rules only. */
export const DLP_MAX_FILE_SIZE_MIN = 1;
export const DLP_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const SESSION_TIMEOUT_MIN = 15;
export const SESSION_TIMEOUT_MAX = 10_080;
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 3650;
export const DLP_EVENTS_PAGE_SIZE = 30;
export const AUDIT_PAGE_SIZE = 30;
export const SESSIONS_PAGE_SIZE = 50;

/** Contract order; used by the select and by draft validation. */
export const DLP_SCOPES: readonly DlpScope[] = ['ALL', 'TEXT', 'ATTACHMENT', 'PLUGIN'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BYTES_RE = /^[0-9]+$/;

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
  /** #101: which managed surface the rule applies to (`ALL` by default). */
  scope: DlpScope;
  /** Input text; empty means "no threshold". Bytes are parsed on submit. */
  maxFileSizeBytes: string;
  /**
   * #101: the stored threshold of the policy being edited. The additive PATCH
   * contract keeps an absent `max_file_size_bytes`, so an existing threshold
   * cannot be cleared. The form uses this to keep TEXT/PLUGIN honest.
   */
  originalMaxFileSizeBytes?: number | null;
  enabled: boolean;
}

export interface DlpPolicyFieldErrors {
  name?: string;
  action?: string;
  patternType?: string;
  pattern?: string;
  scope?: string;
  maxFileSizeBytes?: string;
}

export function emptyDlpDraft(): DlpPolicyDraft {
  return {
    name: '',
    action: 'WARN',
    patternType: 'KEYWORD',
    pattern: '',
    scope: 'ALL',
    maxFileSizeBytes: '',
    originalMaxFileSizeBytes: null,
    enabled: true,
  };
}

export function draftFromPolicy(policy: {
  name: string;
  action: DlpAction;
  pattern_type: DlpPatternType;
  pattern: string;
  scope?: DlpScope;
  max_file_size_bytes?: number | null;
  enabled: boolean;
}): DlpPolicyDraft {
  const size = policy.max_file_size_bytes;
  return {
    name: policy.name,
    action: policy.action,
    patternType: policy.pattern_type,
    pattern: policy.pattern,
    scope: policy.scope ?? 'ALL',
    maxFileSizeBytes: typeof size === 'number' ? String(size) : '',
    originalMaxFileSizeBytes: typeof size === 'number' ? size : null,
    enabled: policy.enabled,
  };
}

/** Size thresholds are meaningful only for attachment/ALL rules (#101). */
export function scopeSupportsFileSize(scope: DlpScope): boolean {
  return scope === 'ALL' || scope === 'ATTACHMENT';
}

/** `true` when an existing stored threshold blocks a switch to TEXT/PLUGIN. */
export function hasUnclearableFileSize(draft: DlpPolicyDraft): boolean {
  return typeof draft.originalMaxFileSizeBytes === 'number';
}

/** Parse the byte input; `null` means "no threshold", `NaN` means invalid. */
export function parseMaxFileSizeBytes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!BYTES_RE.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Matches the backend envelope: 1..120 name, 1..200 printable pattern, no
 * control characters. PATTERN allows at most 20 `*` wildcards; KEYWORD treats
 * `*` as an ordinary character. No regex is compiled on either side. #101 adds
 * the surface and the attachment-only byte threshold.
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
  if (!DLP_SCOPES.includes(draft.scope)) {
    errors.scope = 'security.validation.scopeInvalid';
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

  const size = parseMaxFileSizeBytes(draft.maxFileSizeBytes);
  if (size !== null) {
    if (!scopeSupportsFileSize(draft.scope)) {
      errors.maxFileSizeBytes = 'security.validation.maxFileSizeScope';
    } else if (
      Number.isNaN(size) ||
      size < DLP_MAX_FILE_SIZE_MIN ||
      size > DLP_MAX_FILE_SIZE_BYTES
    ) {
      errors.maxFileSizeBytes = 'security.validation.maxFileSizeRange';
    }
  } else if (hasUnclearableFileSize(draft) && !scopeSupportsFileSize(draft.scope)) {
    // The contract cannot clear a stored threshold (absent = keep), so the
    // server would reject this combination. Keep the reason in the form.
    errors.scope = 'security.validation.scopeLocked';
  }
  return errors;
}

export function hasDlpErrors(errors: DlpPolicyFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

function draftMaxFileSize(draft: DlpPolicyDraft): number | undefined {
  if (!scopeSupportsFileSize(draft.scope)) return undefined;
  const size = parseMaxFileSizeBytes(draft.maxFileSizeBytes);
  return size === null || Number.isNaN(size) ? undefined : size;
}

/** Create body: trims only the name, the pattern is matched literally. */
export function toCreateDlpBody(draft: DlpPolicyDraft): DlpPolicyCreateRequest {
  return {
    name: draft.name.trim(),
    action: draft.action,
    pattern_type: draft.patternType,
    pattern: draft.pattern,
    scope: draft.scope,
    ...(draftMaxFileSize(draft) === undefined
      ? {}
      : { max_file_size_bytes: draftMaxFileSize(draft) }),
    enabled: draft.enabled,
  };
}

/**
 * PATCH body: send the full editable rule; the server keeps it idempotent.
 * An empty size input omits `max_file_size_bytes`, which the additive contract
 * defines as "keep the stored value" (a threshold cannot be cleared).
 */
export function toUpdateDlpBody(draft: DlpPolicyDraft): DlpPolicyUpdateRequest {
  return {
    name: draft.name.trim(),
    action: draft.action,
    pattern_type: draft.patternType,
    pattern: draft.pattern,
    scope: draft.scope,
    ...(draftMaxFileSize(draft) === undefined
      ? {}
      : { max_file_size_bytes: draftMaxFileSize(draft) }),
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
