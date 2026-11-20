import { describe, expect, it } from 'vitest';
import type { DlpPolicy, WorkspaceSecurity, WorkspaceSession } from '../api/types';
import {
  DLP_WILDCARD_MAX,
  draftFromPolicy,
  datetimeLocalToIso,
  emptyDlpDraft,
  groupSessions,
  hasDlpErrors,
  invalidDateRange,
  isUuid,
  securityPatchFromDraft,
  validateDlpDraft,
  validateSecurityDraft,
} from './model';

const POLICY: DlpPolicy = {
  id: 'c0000000-0000-4000-8000-000000000001',
  name: 'Секреты',
  action: 'BLOCK',
  pattern_type: 'KEYWORD',
  pattern: 'пароль',
  enabled: true,
  created_at: '2026-11-10T09:00:00.000Z',
  updated_at: '2026-11-10T09:00:00.000Z',
};

const SETTINGS: WorkspaceSecurity = {
  require_2fa: false,
  session_timeout_minutes: 60,
  dlp_enabled: true,
  retention_days: 30,
  updated_at: '2026-11-19T12:10:00.000Z',
};

function session(id: string, userId: string, lastSeen: string): WorkspaceSession {
  return {
    id,
    user_id: userId,
    device: id,
    created_at: '2026-11-01T00:00:00.000Z',
    last_seen_at: lastSeen,
    current: false,
  };
}

describe('P0-3 security model', () => {
  it('validates the literal DLP envelope, not a regex', () => {
    expect(hasDlpErrors(validateDlpDraft(emptyDlpDraft()))).toBe(true);

    const keyword = {
      ...draftFromPolicy(POLICY),
      pattern: '(a+)+$',
    };
    // A regex-looking value is ordinary literal text.
    expect(validateDlpDraft(keyword)).toEqual({});

    const longWildcards = {
      ...draftFromPolicy(POLICY),
      patternType: 'PATTERN' as const,
      pattern: '*'.repeat(DLP_WILDCARD_MAX + 1),
    };
    expect(validateDlpDraft(longWildcards).pattern).toBe('security.validation.patternWildcards');

    const control = { ...draftFromPolicy(POLICY), pattern: 'пароль\u0000' };
    expect(validateDlpDraft(control).pattern).toBe('security.validation.patternControl');

    const tooLongName = { ...draftFromPolicy(POLICY), name: 'x'.repeat(121) };
    expect(validateDlpDraft(tooLongName).name).toBe('security.validation.nameTooLong');
  });

  it('groups sessions by user and preserves the server order', () => {
    const groups = groupSessions([
      session('s1', 'u1', '2026-11-19T15:00:00.000Z'),
      session('s2', 'u2', '2026-11-19T14:00:00.000Z'),
      session('s3', 'u1', '2026-11-19T13:00:00.000Z'),
    ]);
    expect(groups.map((group) => group.userId)).toEqual(['u1', 'u2']);
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['s1', 's3']);
  });

  it('sends only changed settings fields and validates their bounds', () => {
    const unchanged = securityPatchFromDraft(
      {
        require2fa: SETTINGS.require_2fa,
        sessionTimeoutMinutes: String(SETTINGS.session_timeout_minutes),
        dlpEnabled: SETTINGS.dlp_enabled,
        retentionDays: String(SETTINGS.retention_days),
      },
      SETTINGS,
    );
    expect(unchanged).toEqual({});

    const changed = securityPatchFromDraft(
      {
        require2fa: true,
        sessionTimeoutMinutes: '120',
        dlpEnabled: true,
        retentionDays: '90',
      },
      SETTINGS,
    );
    expect(changed).toEqual({
      require_2fa: true,
      session_timeout_minutes: 120,
      retention_days: 90,
    });

    expect(
      validateSecurityDraft({
        require2fa: false,
        sessionTimeoutMinutes: '14',
        dlpEnabled: true,
        retentionDays: '3651',
      }),
    ).toEqual({
      sessionTimeoutMinutes: 'security.validation.timeoutRange',
      retentionDays: 'security.validation.retentionRange',
    });
  });

  it('converts datetime-local values and rejects reversed ranges', () => {
    expect(isUuid('c0000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(datetimeLocalToIso('')).toBeUndefined();
    expect(datetimeLocalToIso('2026-11-20T12:30')).toBeTruthy();
    expect(invalidDateRange('2026-11-20T12:00', '2026-11-19T12:00')).toBe(true);
    expect(invalidDateRange('2026-11-19T12:00', '2026-11-20T12:00')).toBe(false);
  });
});
