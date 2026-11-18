import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { AdminAuditEvent } from '../../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { navigate } from '../../router/router';
import { mockDb, server } from '../../test/server';
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
}

async function openAudit(user: TestUser): Promise<void> {
  await login(user);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  navigate('/admin?tab=audit');
  await screen.findByRole('heading', { name: 'Администрирование' });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.admin-rows--audit .admin-row')];
}

describe('E11-F audit tab', () => {
  it('renders time/action/actor/target from the contract fields only', async () => {
    mockDb.adminDirectory.auditEventsOverride = [
      makeEvent(1, {
        action: 'admin.user.suspended',
        target_type: 'user',
        target_id: IDS.anna,
      }),
      makeEvent(2, {
        action: 'setup.completed',
        actor_id: null,
        actor_email: null,
        target_type: 'system_settings',
        target_id: null,
      }),
    ];
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByText('Показано: 2')).toBeInTheDocument();
    expect(mockDb.adminDirectory.auditRequests[0]).toMatchObject({
      action: null,
      cursor: null,
      limit: 25,
    });

    const byAction = (code: string): HTMLElement => {
      const row = rows().find((item) => item.textContent?.includes(code));
      if (!row) throw new Error(`No audit row with ${code}`);
      return row;
    };
    const suspendedRow = byAction('admin.user.suspended');
    const labels = [...suspendedRow.querySelectorAll('dt')].map((term) => term.textContent);
    expect(labels).toEqual(['Время', 'Действие', 'Актор', 'Цель']);
    expect(within(suspendedRow).getByText('Приостановка пользователя')).toBeInTheDocument();
    expect(within(suspendedRow).getByText('admin.user.suspended')).toBeInTheDocument();
    expect(within(suspendedRow).getByText(MOCK_DEMO_EMAIL)).toBeInTheDocument();
    expect(within(suspendedRow).getByText('Пользователь')).toBeInTheDocument();
    // The full target id stays available as a title and to assistive tech.
    const targetCode = suspendedRow.querySelector(`code[title="${IDS.anna}"]`);
    expect(targetCode).not.toBeNull();
    expect(targetCode).toHaveAttribute('aria-label', IDS.anna);

    const systemRow = byAction('setup.completed');
    expect(within(systemRow).getByText('Система')).toBeInTheDocument();
    expect(within(systemRow).getByText('Завершение настройки')).toBeInTheDocument();

    // No metadata/hash/request fields are rendered in the rows.
    for (const row of rows()) {
      expect(row.textContent ?? '').not.toContain('metadata');
      expect(row.textContent ?? '').not.toContain('request_id');
      expect(row.textContent ?? '').not.toContain('prev_hash');
    }
  });

  it('filters by an exact action and resets the cursor chain', async () => {
    mockDb.adminDirectory.auditEventsOverride = [
      makeEvent(1, { action: 'admin.user.suspended', target_type: 'user', target_id: IDS.anna }),
      makeEvent(2, { action: 'admin.chat.deleted', target_type: 'chat', target_id: IDS.groupChat }),
      makeEvent(3, { action: 'admin.user.suspended', target_type: 'user', target_id: IDS.mark }),
    ];
    const { user } = renderPasswordApp();
    await openAudit(user);
    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();

    const filter = screen.getByRole('combobox', { name: 'Действие' });
    await user.selectOptions(filter, 'admin.chat.deleted');

    await waitFor(() => {
      expect(screen.getByText('Показано: 1')).toBeInTheDocument();
    });
    expect(screen.getByText('Удаление чата')).toBeInTheDocument();
    expect(screen.queryByText('Приостановка пользователя')).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.auditRequests.at(-1)).toMatchObject({
      action: 'admin.chat.deleted',
      cursor: null,
    });

    await user.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(await screen.findByText('Показано: 3')).toBeInTheDocument();
    expect(mockDb.adminDirectory.auditRequests.at(-1)?.action).toBeNull();
  });

  it('appends the next cursor page and de-duplicates the boundary row', async () => {
    mockDb.adminDirectory.auditEventsOverride = Array.from({ length: 30 }, (_, index) =>
      makeEvent(index + 1),
    );
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByText('Показано: 25')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));

    expect(await screen.findByText('Показано: 30')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
    expect(mockDb.adminDirectory.auditRequests).toHaveLength(2);
    expect(mockDb.adminDirectory.auditRequests[0]?.cursor).toBeNull();
    expect(mockDb.adminDirectory.auditRequests[1]?.cursor).toBeTruthy();
  });

  it('shows the skeleton while the first page loads', async () => {
    mockDb.adminDirectory.auditEventsOverride = [makeEvent(1)];
    mockDb.adminDirectory.auditDelayMs = 250;
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByText('Загружаем аудит…')).toBeInTheDocument();
    expect(await screen.findByText('Показано: 1')).toBeInTheDocument();
  });

  it('shows distinct empty states for an empty log and for a filter without matches', async () => {
    mockDb.adminDirectory.auditEventsOverride = [];
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByText('Журнал пока пуст')).toBeInTheDocument();
    expect(screen.getByText('В установке ещё нет audit-событий.')).toBeInTheDocument();

    const filter = screen.getByRole('combobox', { name: 'Действие' });
    await user.selectOptions(filter, 'admin.user.suspended');
    expect(await screen.findByText('Событий не найдено')).toBeInTheDocument();
    expect(
      screen.getByText('По выбранному действию записей нет. Сбросьте фильтр.'),
    ).toBeInTheDocument();
  });

  it('surfaces an audit error and retries with the same filter', async () => {
    mockDb.adminDirectory.auditEventsOverride = [makeEvent(1)];
    mockDb.adminDirectory.forceAuditError = { status: 500, code: 'INTERNAL', message: 'boom' };
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить аудит.');
    mockDb.adminDirectory.forceAuditError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Показано: 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps loaded events visible when a refresh fails', async () => {
    mockDb.adminDirectory.auditEventsOverride = [makeEvent(1)];
    const { user } = renderPasswordApp();
    await openAudit(user);
    expect(await screen.findByText('Показано: 1')).toBeInTheDocument();

    mockDb.adminDirectory.forceAuditError = { status: 500, code: 'INTERNAL', message: 'boom' };
    await user.click(screen.getByRole('button', { name: 'Обновить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить аудит.');
    expect(screen.getByText('Показано: 1')).toBeInTheDocument();
  });

  it('replaces the surface with the 403 screen when the server rejects the audit read', async () => {
    server.use(
      http.get('*/api/v1/admin/audit', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Platform admin access is required', request_id: 'req_1' },
          { status: 403 },
        ),
      ),
    );
    const { user } = renderPasswordApp();
    await openAudit(user);

    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Администрирование' })).not.toBeInTheDocument();
  });

  it('switches to the audit tab from the tab list and passes axe', async () => {
    mockDb.adminDirectory.auditEventsOverride = [makeEvent(1)];
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    navigate('/admin');
    await screen.findByRole('heading', { name: 'Администрирование' });

    const tab = screen.getByRole('tab', { name: 'Аудит' });
    await user.click(tab);
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Показано: 1')).toBeInTheDocument();

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
