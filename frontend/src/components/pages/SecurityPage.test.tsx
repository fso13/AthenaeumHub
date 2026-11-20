import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { DlpEventRow, WorkspaceAuditEvent } from '../../api/types';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { navigate } from '../../router/router';
import { mockDb } from '../../test/server';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openSecurity(user: TestUser): Promise<void> {
  await login(user);
  navigate('/?view=security');
  await screen.findByRole('heading', { level: 1, name: 'Защита' });
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function tbodyRows(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('tbody tr')];
}

function makeDlpEvents(count: number): DlpEventRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `d1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    policy_id: index % 2 === 0 ? 'c0000000-0000-4000-8000-000000000001' : null,
    policy_name: index % 2 === 0 ? 'Секреты и ключи' : 'Удалённое правило',
    action: index % 3 === 0 ? 'BLOCK' : 'WARN',
    actor_id: index % 2 === 0 ? IDS.anna : IDS.user,
    chat_id: IDS.groupChat,
    created_at: new Date(Date.UTC(2026, 10, 20, 10, 0, index)).toISOString(),
  }));
}

function makeAuditEvents(count: number): WorkspaceAuditEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    action: index % 2 === 0 ? 'workspace.security.updated' : 'workspace.dlp.policy.created',
    actor_id: index % 2 === 0 ? IDS.user : IDS.anna,
    target_type: index % 2 === 0 ? 'workspace_security' : 'dlp_policy',
    target_id: index % 2 === 0 ? IDS.workspace : null,
    created_at: new Date(Date.UTC(2026, 10, 20, 9, 0, index)).toISOString(),
  }));
}

function setWorkspaceMode(mode: 'MANAGED' | 'E2EE'): void {
  mockDb.me.workspaces = mockDb.me.workspaces.map((workspace) => ({
    ...workspace,
    security_mode: mode,
  }));
  mockDb.session.workspace = { ...mockDb.session.workspace, security_mode: 'MANAGED' };
  if (mode === 'E2EE') mockDb.security.settings.dlp_enabled = false;
}

describe('P0-3 workspace security page', () => {
  it('loads DLP, events, audit, sessions and settings for an OWNER', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);

    const policies = await screen.findByRole('region', { name: 'Политики DLP' });
    expect(await within(policies).findByText('Секреты и ключи')).toBeInTheDocument();
    expect(within(policies).getByText('Внешние адреса')).toBeInTheDocument();
    expect(tbodyRows(policies)).toHaveLength(2);

    const events = region('События DLP');
    expect((await within(events).findAllByText('Секреты и ключи')).length).toBeGreaterThan(0);
    expect(tbodyRows(events)).toHaveLength(3);

    const audit = region('Журнал аудита');
    expect(await within(audit).findByText('workspace.security.updated')).toBeInTheDocument();
    expect(tbodyRows(audit)).toHaveLength(4);
    expect(within(audit).getByText('Система')).toBeInTheDocument();

    const sessions = region('Сеансы участников');
    expect(await within(sessions).findByText('krug-web · Chrome')).toBeInTheDocument();
    expect(within(sessions).getByText('Текущая сессия')).toBeInTheDocument();
    expect(within(sessions).getAllByText('Участник')).toHaveLength(2);
    expect(within(sessions).getByText('krug-mobile · Android')).toBeInTheDocument();

    const settings = region('Настройки безопасности');
    expect(within(settings).getByLabelText('Требовать 2FA')).not.toBeChecked();
    expect(within(settings).getByLabelText('Таймаут сессии, минут')).toHaveValue(60);
    expect(within(settings).getByLabelText('Хранение истории, дней')).toHaveValue(30);
    expect(within(settings).getByLabelText('DLP включена')).toBeChecked();

    expect(mockDb.security.policyRequests).toHaveLength(1);
    expect(mockDb.security.eventRequests).toHaveLength(1);
    expect(mockDb.security.auditRequests).toHaveLength(1);
    expect(mockDb.security.sessionRequests).toHaveLength(1);
    expect(mockDb.security.settingsRequests).toBe(1);

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('access_token');
  });

  it('hides manager data from MEMBER and does not call manager endpoints', async () => {
    mockDb.me.workspaces = mockDb.me.workspaces.map((workspace) => ({
      ...workspace,
      role: 'MEMBER' as const,
    }));
    const { user } = renderPasswordApp();
    await openSecurity(user);

    expect(
      await screen.findByText('Управление доступно владельцу и администраторам'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Политики DLP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Журнал аудита' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Сеансы участников' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Настройки безопасности' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Ключи и устройства' })).toBeInTheDocument();

    expect(mockDb.security.policyRequests).toHaveLength(0);
    expect(mockDb.security.eventRequests).toHaveLength(0);
    expect(mockDb.security.auditRequests).toHaveLength(0);
    expect(mockDb.security.sessionRequests).toHaveLength(0);
    expect(mockDb.security.settingsRequests).toBe(0);
  });

  it('validates and creates a DLP rule, then reports a duplicate name', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const policies = await screen.findByRole('region', { name: 'Политики DLP' });

    await user.click(within(policies).getByRole('button', { name: 'Добавить правило' }));
    expect(
      await within(policies).findByRole('heading', { name: 'Новое DLP-правило' }),
    ).toBeInTheDocument();

    await user.click(within(policies).getByRole('button', { name: 'Сохранить' }));
    expect(within(policies).getByText('Укажите название правила.')).toBeInTheDocument();
    expect(within(policies).getByText('Укажите шаблон.')).toBeInTheDocument();

    await user.type(within(policies).getByLabelText('Название'), 'Внутренние адреса');
    await user.selectOptions(within(policies).getByLabelText('Действие при совпадении'), 'BLOCK');
    await user.selectOptions(within(policies).getByLabelText('Тип шаблона'), 'PATTERN');
    await user.type(within(policies).getByLabelText('Шаблон'), 'internal-*');
    await user.click(within(policies).getByRole('button', { name: 'Сохранить' }));

    expect(await within(policies).findByText('Внутренние адреса')).toBeInTheDocument();
    await waitFor(() => expect(tbodyRows(policies)).toHaveLength(3));
    expect(mockDb.security.dlpPolicies.at(-1)).toMatchObject({
      name: 'Внутренние адреса',
      action: 'BLOCK',
      pattern_type: 'PATTERN',
      pattern: 'internal-*',
      enabled: true,
    });
    expect(mockDb.security.policyRequests.at(-1)).toMatchObject({
      action: 'create',
      body: {
        name: 'Внутренние адреса',
        action: 'BLOCK',
        pattern_type: 'PATTERN',
        pattern: 'internal-*',
        enabled: true,
      },
    });

    await user.click(within(policies).getByRole('button', { name: 'Добавить правило' }));
    await user.type(within(policies).getByLabelText('Название'), 'внешние адреса');
    await user.type(within(policies).getByLabelText('Шаблон'), 'external-*');
    await user.click(within(policies).getByRole('button', { name: 'Сохранить' }));
    expect(
      await within(policies).findByText('Правило с таким названием уже существует.'),
    ).toBeInTheDocument();
    // The form stays open on a server error and does not add a row.
    expect(
      within(policies).getByRole('heading', { name: 'Новое DLP-правило' }),
    ).toBeInTheDocument();
  });

  it('edits and deletes a DLP rule; historical events keep the name snapshot', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const policies = await screen.findByRole('region', { name: 'Политики DLP' });

    await user.click(within(policies).getByRole('button', { name: 'Изменить: Секреты и ключи' }));
    const nameInput = within(policies).getByLabelText('Название');
    await user.clear(nameInput);
    await user.type(nameInput, 'Секреты и пароли');
    await user.click(within(policies).getByRole('button', { name: 'Сохранить' }));

    expect(await within(policies).findByText('Секреты и пароли')).toBeInTheDocument();
    expect(mockDb.security.dlpPolicies[0]).toMatchObject({
      name: 'Секреты и пароли',
      action: 'BLOCK',
      pattern_type: 'KEYWORD',
      pattern: 'пароль',
    });
    expect(mockDb.security.policyRequests.at(-1)?.action).toBe('update');

    const events = region('События DLP');
    expect(within(events).getByText('Секреты и ключи')).toBeInTheDocument();

    await user.click(within(policies).getByRole('button', { name: 'Удалить: Секреты и пароли' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить DLP-правило?' });
    expect(within(dialog).getByText(/Секреты и пароли/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить правило' }));

    await waitFor(() => expect(tbodyRows(policies)).toHaveLength(1));
    expect(within(policies).queryByText('Секреты и пароли')).not.toBeInTheDocument();
    expect(within(events).getAllByText('правило удалено')).toHaveLength(2);
    expect(mockDb.security.dlpPolicies).toHaveLength(1);
    // The historical event keeps the snapshot name and loses the live policy id.
    await waitFor(() =>
      expect(mockDb.security.dlpEvents[0]).toMatchObject({
        policy_name: 'Секреты и ключи',
        policy_id: null,
      }),
    );
  });

  it('filters and paginates DLP events with opaque cursors', async () => {
    mockDb.security.dlpEvents = makeDlpEvents(35);
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const events = await screen.findByRole('region', { name: 'События DLP' });

    await waitFor(() => expect(tbodyRows(events)).toHaveLength(30));
    await user.click(within(events).getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(tbodyRows(events)).toHaveLength(35));
    expect(mockDb.security.eventRequests).toHaveLength(2);
    expect(mockDb.security.eventRequests[0]?.cursor).toBeNull();
    expect(mockDb.security.eventRequests[1]?.cursor).toBeTruthy();

    await user.selectOptions(within(events).getByLabelText('Действие'), 'BLOCK');
    await waitFor(() => {
      const actions = [...events.querySelectorAll('tbody .chip')].map((node) => node.textContent);
      expect(actions.length).toBeGreaterThan(0);
      expect(new Set(actions)).toEqual(new Set(['BLOCK']));
    });
    expect(mockDb.security.eventRequests.at(-1)).toMatchObject({
      action: 'BLOCK',
      cursor: null,
    });

    await user.selectOptions(
      within(events).getByLabelText('Правило'),
      'c0000000-0000-4000-8000-000000000001',
    );
    expect(mockDb.security.eventRequests.at(-1)).toMatchObject({
      policyId: 'c0000000-0000-4000-8000-000000000001',
      action: 'BLOCK',
      cursor: null,
    });
  });

  it('filters, paginates and exports the audit log as a real API Blob', async () => {
    mockDb.security.auditEvents = makeAuditEvents(35);
    mockDb.security.auditExportLimit = 2;
    let captured: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      captured = blob;
      return 'blob:audit';
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const { user } = renderPasswordApp();
      await openSecurity(user);
      const audit = await screen.findByRole('region', { name: 'Журнал аудита' });

      await waitFor(() => expect(tbodyRows(audit)).toHaveLength(30));
      await user.click(within(audit).getByRole('button', { name: 'Показать ещё' }));
      await waitFor(() => expect(tbodyRows(audit)).toHaveLength(35));

      await user.type(within(audit).getByLabelText('Действие'), 'workspace.dlp.policy.created');
      await user.click(within(audit).getByRole('button', { name: 'Применить' }));
      await waitFor(() => {
        expect(mockDb.security.auditRequests.at(-1)?.action).toBe('workspace.dlp.policy.created');
      });
      expect(within(audit).getAllByText('workspace.dlp.policy.created').length).toBeGreaterThan(0);

      await user.click(within(audit).getByRole('button', { name: 'Экспорт CSV' }));
      expect(await within(audit).findByText('Экспортировано строк: 2.')).toBeInTheDocument();
      expect(
        within(audit).getByText(/Экспорт обрезан: сервер вернул первые 10 000 строк/),
      ).toBeInTheDocument();
      await waitFor(() => expect(captured).not.toBeNull());
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(mockDb.security.exportRequests.at(-1)).toMatchObject({
        format: 'csv',
        action: 'workspace.dlp.policy.created',
      });
      expect(captured).toBeInstanceOf(Blob);
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(captured as Blob);
      });
      expect(csv.split('\r\n')[0]).toBe('created_at,action,actor_id,target_type,target_id');
      expect(csv).toContain('workspace.dlp.policy.created');

      await user.click(within(audit).getByRole('button', { name: 'Экспорт JSON' }));
      await waitFor(() => expect(mockDb.security.exportRequests.at(-1)?.format).toBe('json'));
      expect(createObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
  });

  it('rejects an invalid audit actor/date range locally without a request', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const audit = await screen.findByRole('region', { name: 'Журнал аудита' });
    await waitFor(() => expect(tbodyRows(audit)).toHaveLength(4));
    const before = mockDb.security.auditRequests.length;

    await user.type(within(audit).getByLabelText('ID участника'), 'not-a-uuid');
    await user.click(within(audit).getByRole('button', { name: 'Применить' }));
    expect(await within(audit).findByText('ID участника должен быть UUID.')).toBeInTheDocument();
    expect(mockDb.security.auditRequests).toHaveLength(before);

    await user.clear(within(audit).getByLabelText('ID участника'));
    fireEvent.change(within(audit).getByLabelText('С (включительно)'), {
      target: { value: '2026-11-20T12:00' },
    });
    fireEvent.change(within(audit).getByLabelText('По (включительно)'), {
      target: { value: '2026-11-19T12:00' },
    });
    await user.click(within(audit).getByRole('button', { name: 'Применить' }));
    expect(await within(audit).findByText('Дата «с» позже даты «по».')).toBeInTheDocument();
    expect(mockDb.security.auditRequests).toHaveLength(before);
  });

  it('groups sessions, labels the current one, revokes one and revokes all', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const sessions = await screen.findByRole('region', { name: 'Сеансы участников' });
    await waitFor(() => expect(tbodyRows(sessions)).toHaveLength(6)); // 2 group rows + 4 sessions
    expect(within(sessions).getByText('Текущая сессия')).toBeInTheDocument();

    await user.click(within(sessions).getByRole('button', { name: 'Отозвать: krug-web · Safari' }));
    const revokeDialog = await screen.findByRole('dialog', { name: 'Отозвать сессию?' });
    await user.click(within(revokeDialog).getByRole('button', { name: 'Отозвать сессию' }));
    await waitFor(() =>
      expect(mockDb.security.sessionRevokeRequests).toContain(
        'f0000000-0000-4000-8000-000000000002',
      ),
    );
    expect(within(sessions).queryByText('krug-web · Safari')).not.toBeInTheDocument();

    // The current session is allowed but carries an explicit extra warning.
    await user.click(within(sessions).getByRole('button', { name: 'Отозвать: krug-web · Chrome' }));
    const currentDialog = await screen.findByRole('dialog', { name: 'Отозвать сессию?' });
    expect(within(currentDialog).getByText(/Это ваша текущая сессия/)).toBeInTheDocument();
    await user.click(within(currentDialog).getByRole('button', { name: 'Отмена' }));

    await user.click(within(sessions).getByRole('button', { name: 'Отозвать все' }));
    const allDialog = await screen.findByRole('dialog', {
      name: 'Отозвать все сеансы участников?',
    });
    await user.click(within(allDialog).getByRole('button', { name: 'Отозвать все' }));
    expect(
      await within(sessions).findByText('Отозвано сессий: 2, затронуто участников: 1.'),
    ).toBeInTheDocument();
    expect(mockDb.security.revokeAllRequests).toBe(1);
    expect(within(sessions).getByText('Текущая сессия')).toBeInTheDocument();
    expect(within(sessions).queryByText('krug-mobile · Android')).not.toBeInTheDocument();
  });

  it('shows the honest Keycloak 503 state and retries', async () => {
    mockDb.security.forceSessionsError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak is unavailable',
      retryAfterSeconds: 7,
    };
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const sessions = await screen.findByRole('region', { name: 'Сеансы участников' });

    expect(
      await within(sessions).findByText('Сервис сессий Keycloak недоступен. Повторите через 7 с.'),
    ).toBeInTheDocument();
    expect(within(sessions).getByText('AUTH_UNAVAILABLE')).toBeInTheDocument();

    mockDb.security.forceSessionsError = null;
    await user.click(within(sessions).getByRole('button', { name: 'Повторить' }));
    expect(await within(sessions).findByText('krug-web · Chrome')).toBeInTheDocument();
  });

  it('saves only changed security settings and validates ranges', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const settings = await screen.findByRole('region', { name: 'Настройки безопасности' });
    await waitFor(() => expect(mockDb.security.settingsRequests).toBe(1));

    await user.click(within(settings).getByRole('button', { name: 'Сохранить настройки' }));
    expect(await within(settings).findByText('Изменений нет.')).toBeInTheDocument();
    expect(mockDb.security.settingsPatches).toHaveLength(0);

    const timeout = within(settings).getByLabelText('Таймаут сессии, минут');
    await user.clear(timeout);
    await user.type(timeout, '120');
    const retention = within(settings).getByLabelText('Хранение истории, дней');
    await user.clear(retention);
    await user.type(retention, '90');
    await user.click(within(settings).getByLabelText('Требовать 2FA'));
    await user.click(within(settings).getByRole('button', { name: 'Сохранить настройки' }));

    expect(await within(settings).findByText('Настройки сохранены.')).toBeInTheDocument();
    expect(mockDb.security.settingsPatches.at(-1)).toEqual({
      require_2fa: true,
      session_timeout_minutes: 120,
      retention_days: 90,
    });
    expect(mockDb.security.settings).toMatchObject({
      require_2fa: true,
      session_timeout_minutes: 120,
      retention_days: 90,
      dlp_enabled: true,
    });
    expect(mockDb.security.settingsPatches.at(-1)).not.toHaveProperty('security_mode');

    await user.clear(timeout);
    await user.type(timeout, '5');
    await user.clear(retention);
    await user.type(retention, '99999');
    await user.click(within(settings).getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      await within(settings).findByText('Укажите целое число от 15 до 10 080.'),
    ).toBeInTheDocument();
    expect(within(settings).getByText('Укажите целое число от 1 до 3650.')).toBeInTheDocument();
    expect(mockDb.security.settingsPatches).toHaveLength(1);
  });

  it('is honest in E2EE: no DLP calls, disabled switch, immutable mode', async () => {
    setWorkspaceMode('E2EE');
    const { user } = renderPasswordApp();
    await openSecurity(user);

    expect(
      await screen.findByText(/Сервер не видит текст сообщений и не хранит ключи/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Политики DLP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Добавить правило' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'События DLP' })).not.toBeInTheDocument();
    expect(mockDb.security.policyRequests).toHaveLength(0);
    expect(mockDb.security.eventRequests).toHaveLength(0);

    const settings = region('Настройки безопасности');
    const dlp = within(settings).getByLabelText('DLP включена');
    expect(dlp).toBeDisabled();
    expect(dlp).not.toBeChecked();
    expect(
      within(settings).getByText('В E2EE DLP недоступна и остаётся выключенной.'),
    ).toBeInTheDocument();
    const modeButton = screen.getByRole('button', { name: 'Изменить' });
    expect(modeButton).toBeDisabled();
    expect(modeButton).toHaveAttribute(
      'title',
      'Режим безопасности неизменяем: переключение недоступно.',
    );
    // Audit/sessions/settings remain real API reads in E2EE.
    expect(mockDb.security.auditRequests).toHaveLength(1);
    expect(mockDb.security.sessionRequests).toHaveLength(1);
    expect(mockDb.security.settingsRequests).toBe(1);
  });

  it('keeps the revoke dialog open when Keycloak is unavailable', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const sessions = await screen.findByRole('region', { name: 'Сеансы участников' });
    await within(sessions).findByText('krug-web · Safari');
    mockDb.security.forceSessionRevokeError = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'Keycloak is unavailable',
      retryAfterSeconds: 3,
    };

    await user.click(within(sessions).getByRole('button', { name: 'Отозвать: krug-web · Safari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отозвать сессию?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отозвать сессию' }));

    expect(
      await within(dialog).findByText('Сервис сессий Keycloak недоступен. Повторите через 3 с.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(within(sessions).getByText('krug-web · Safari')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  });

  it('surfaces an export error and keeps the loaded audit rows', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    const audit = await screen.findByRole('region', { name: 'Журнал аудита' });
    await waitFor(() => expect(tbodyRows(audit)).toHaveLength(4));
    mockDb.security.forceExportError = {
      status: 500,
      code: 'INTERNAL',
      message: 'boom',
    };

    await user.click(within(audit).getByRole('button', { name: 'Экспорт CSV' }));
    expect(
      await within(audit).findByText('Сервер временно недоступен. Повторите позже.'),
    ).toBeInTheDocument();
    expect(within(audit).getByText('INTERNAL')).toBeInTheDocument();
    expect(tbodyRows(audit)).toHaveLength(4);
  });

  it('passes an axe audit with loaded manager data', async () => {
    const { user } = renderPasswordApp();
    await openSecurity(user);
    await screen.findAllByText('Секреты и ключи');
    await waitFor(() => expect(mockDb.security.settingsRequests).toBe(1));

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
