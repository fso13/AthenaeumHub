import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { mockDb } from '../../test/server';
import { navigate } from '../../router/router';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

function setOverview(
  overrides: Partial<NonNullable<typeof mockDb.workspaceOverview.override>> = {},
) {
  mockDb.workspaceOverview.override = {
    members: { total: 5, online: 2 },
    chats: 3,
    messages: { total: 42, last_24h: 7 },
    files: { total: 9, used_bytes: 2048, reserved_bytes: 512 },
    dlp: { events_last_24h: 3 },
    storage: { used_bytes: 2048, quota_bytes: 8192 },
    audit_recent: [
      {
        id: 'e0000000-0000-4000-8000-000000000101',
        action: 'workspace.dlp.policy.created',
        actor_id: IDS.anna,
        target_type: 'dlp_policy',
        target_id: null,
        created_at: '2026-11-20T12:00:00.000Z',
      },
      {
        id: 'e0000000-0000-4000-8000-000000000102',
        action: 'workspace.security.updated',
        actor_id: null,
        target_type: 'workspace_security',
        target_id: null,
        created_at: '2026-11-19T10:30:00.000Z',
      },
    ],
    generated_at: '2026-11-20T15:00:00.000Z',
    ...overrides,
  };
}

async function openOverview(): Promise<void> {
  navigate('/?view=overview');
  await screen.findByRole('heading', { level: 1, name: 'Обзор' });
}

describe('#84 workspace overview page', () => {
  it('renders counts, storage, DLP and content-free audit activity from GET overview', async () => {
    setOverview();
    const { user } = renderPasswordApp();
    await login(user);
    await openOverview();

    const metrics = await screen.findByRole('region', { name: 'Метрики пространства' });
    await within(metrics).findByText('42');
    expect(within(metrics).getByText('9')).toBeInTheDocument();
    expect(within(metrics).getByText('5')).toBeInTheDocument();
    expect(within(metrics).getByText('3')).toBeInTheDocument();
    expect(within(metrics).getByText('+7 за 24 ч')).toBeInTheDocument();
    expect(within(metrics).getByText('DLP-событий за 24 ч')).toBeInTheDocument();

    const activity = await screen.findByRole('region', { name: 'Активность' });
    expect(within(activity).getByText('Создано DLP-правило')).toBeInTheDocument();
    expect(within(activity).getByText('Изменены настройки защиты')).toBeInTheDocument();
    expect(within(activity).getByText('Система')).toBeInTheDocument();
    expect(within(activity).getByText('Актор 66666666')).toBeInTheDocument();

    const storage = screen.getByRole('region', { name: 'Хранилище' });
    expect(within(storage).getByText('2 КБ из 8 КБ')).toBeInTheDocument();
    expect(
      within(storage).getByText('9 файлов · 2 КБ занято · 512 Б зарезервировано'),
    ).toBeInTheDocument();

    // The overview response contains no message bodies/envelopes/filenames.
    expect(
      screen.queryByText('Доброе утро! Скинь, пожалуйста, финальную версию сметы.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/metadata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ciphertext/)).not.toBeInTheDocument();
    expect(screen.queryByText(/request_id/)).not.toBeInTheDocument();
    expect(mockDb.workspaceOverview.requests.at(-1)?.workspaceId).toBe(IDS.workspace);
  });

  it('shows a loading state and then the server values', async () => {
    setOverview();
    mockDb.workspaceOverview.delayMs = 200;
    const { user } = renderPasswordApp();
    await login(user);
    navigate('/?view=overview');

    expect(await screen.findByText('Загружаем обзор…')).toBeInTheDocument();
    expect(await screen.findByText('+7 за 24 ч')).toBeInTheDocument();
    expect(screen.queryByText('Загружаем обзор…')).not.toBeInTheDocument();
  });

  it('surfaces an honest error, keeps navigation and retries the read', async () => {
    setOverview();
    mockDb.workspaceOverview.forceError = {
      status: 503,
      code: 'UNAVAILABLE',
      message: 'overview is temporarily unavailable',
    };
    const { user } = renderPasswordApp();
    await login(user);
    await openOverview();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить обзор пространства.')).toBeInTheDocument();
    expect(within(alert).getByText(/HTTP 503 · UNAVAILABLE/)).toBeInTheDocument();
    // Navigation remains available while the aggregate read fails.
    expect(
      within(screen.getByRole('main')).getAllByRole('button', { name: 'Пригласить' }).length,
    ).toBeGreaterThan(0);

    mockDb.workspaceOverview.forceError = null;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('+7 за 24 ч')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('keeps the files navigation working from the dashboard', async () => {
    setOverview();
    const { user } = renderPasswordApp();
    await login(user);
    await openOverview();

    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Файлы' }));
    await waitFor(() => expect(window.location.search).toContain('view=files'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Файлы' })).toBeInTheDocument();
  });

  it('passes axe without serious/critical violations', async () => {
    setOverview();
    const { user } = renderPasswordApp();
    await login(user);
    await openOverview();
    await screen.findByText('+7 за 24 ч');

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
