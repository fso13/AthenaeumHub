import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAuditEvent } from '../../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { navigate } from '../../router/router';
import { mockDb } from '../../test/server';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

function makeEvent(index: number, overrides: Partial<AdminAuditEvent> = {}): AdminAuditEvent {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action: 'admin.users.viewed',
    actor_id: IDS.user,
    actor_email: MOCK_DEMO_EMAIL,
    target_type: 'admin_users',
    target_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString(),
    ...overrides,
  };
}

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openAudit(user: TestUser): Promise<void> {
  await login(user);
  navigate('/admin?tab=audit');
  await screen.findByRole('heading', { name: 'Администрирование' });
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(blob);
  });
}

function captureDownloads(): { blobs: Blob[]; restore: () => void } {
  const blobs: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (
    blob: Blob,
  ) => {
    blobs.push(blob);
    return 'blob:sova-test';
  };
  (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = vi.fn();
  return {
    blobs,
    restore: () => {
      (URL as unknown as { createObjectURL: typeof originalCreate }).createObjectURL =
        originalCreate;
      (URL as unknown as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL =
        originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

describe('#84 admin audit export', () => {
  it('downloads a bounded CSV Blob with RFC 4180 quoting and the truncation notice', async () => {
    const rows = [
      makeEvent(1, { action: 'admin.audit.viewed' }),
      makeEvent(2, { action: 'admin.users.viewed' }),
      makeEvent(3, {
        action: 'settings.updated',
        actor_email: 'quote,"comma"@example.test',
        target_type: 'system_settings',
      }),
    ];
    mockDb.adminDirectory.auditEventsOverride = rows;
    mockDb.adminDirectory.auditExportLimit = 2;
    const downloads = captureDownloads();
    try {
      const { user } = renderPasswordApp();
      await openAudit(user);

      await user.click(await screen.findByRole('button', { name: 'Скачать CSV' }));

      expect(await screen.findByText('Экспортировано строк: 2.')).toBeInTheDocument();
      expect(
        screen.getByText(/совпадений больше 10 000, поэтому выгружены первые 10 000 строк/),
      ).toBeInTheDocument();
      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      const text = await blobText(downloads.blobs[0]!);
      expect(
        text.startsWith('created_at,action,actor_id,actor_email,target_type,target_id\n'),
      ).toBe(true);
      // Internal quotes are doubled and the comma keeps the field quoted.
      expect(text).toContain('"quote,""comma""@example.test"');
      expect(text.split('\n').filter(Boolean)).toHaveLength(3);
      // No metadata/hash/request id column or content is exported.
      expect(text).not.toContain('metadata');
      expect(text).not.toContain('request_id');
      expect(text).not.toContain('prev_hash');
      expect(mockDb.adminDirectory.auditRequests.at(-1)).toMatchObject({
        action: null,
        limit: 0,
      });
    } finally {
      downloads.restore();
    }
  });

  it('downloads the bounded JSON contract with header-derived counters', async () => {
    mockDb.adminDirectory.auditEventsOverride = [
      makeEvent(1, { action: 'settings.updated' }),
      makeEvent(2, { action: 'admin.user.suspended' }),
    ];
    const downloads = captureDownloads();
    try {
      const { user } = renderPasswordApp();
      await openAudit(user);

      await user.click(await screen.findByRole('button', { name: 'Скачать JSON' }));

      expect(await screen.findByText('Экспортировано строк: 2.')).toBeInTheDocument();
      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      const parsed = JSON.parse(await blobText(downloads.blobs[0]!)) as {
        items: AdminAuditEvent[];
        exported_rows: number;
        truncated: boolean;
      };
      expect(parsed.exported_rows).toBe(2);
      expect(parsed.truncated).toBe(false);
      expect(parsed.items.map((item) => item.action)).toEqual([
        'admin.user.suspended',
        'settings.updated',
      ]);
      expect(parsed.items[0]).not.toHaveProperty('metadata');
      expect(parsed.items[0]).not.toHaveProperty('request_id');
    } finally {
      downloads.restore();
    }
  });

  it('surfaces an export failure and retries without losing the audit page', async () => {
    mockDb.adminDirectory.auditEventsOverride = [makeEvent(1)];
    mockDb.adminDirectory.forceExportError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Audit export is unavailable',
    };
    const downloads = captureDownloads();
    try {
      const { user } = renderPasswordApp();
      await openAudit(user);
      expect(await screen.findByText('Показано: 1')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Скачать CSV' }));
      expect(await screen.findByText('Не удалось выполнить экспорт аудита.')).toBeInTheDocument();
      expect(downloads.blobs).toHaveLength(0);

      mockDb.adminDirectory.forceExportError = null;
      await user.click(screen.getByRole('button', { name: 'Повторить экспорт' }));

      expect(await screen.findByText('Экспортировано строк: 1.')).toBeInTheDocument();
      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });
});
