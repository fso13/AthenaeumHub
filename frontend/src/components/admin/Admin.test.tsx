import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_EMAIL } from '../../mocks/fixtures';
import { setMockPlatformAdmin, setMockSetupRequired } from '../../mocks/db';
import { navigate } from '../../router/router';
import { mockDb, server } from '../../test/server';
import { renderPasswordApp } from '../../test/renderApp';

const SETUP_HEADING = 'Первичная настройка Pickle';
const ADMIN_HEADING = 'Администрирование';
const INCOMPLETE_HEADING = 'Установка не завершена';
const FORBIDDEN_HEADING = 'Доступ запрещён';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('E8 setup wizard and admin UI', () => {
  it('forces an admin through /setup, tests SMTP, completes setup and opens /admin', async () => {
    setMockSetupRequired(mockDb, true);
    setMockPlatformAdmin(mockDb, true);
    const { user } = renderPasswordApp();
    await login(user);

    expect(await screen.findByRole('heading', { name: SETUP_HEADING })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/setup');

    await user.type(screen.getByLabelText('SMTP-хост'), 'smtp.example.test');
    await user.type(screen.getByLabelText('Порт'), '587');
    await user.type(screen.getByLabelText('Логин SMTP'), 'mailer');
    await user.type(screen.getByLabelText('Пароль SMTP'), 'smtp-secret-2026');
    await user.type(screen.getByLabelText('Адрес отправителя'), 'pickle@example.test');
    await user.clear(screen.getByLabelText('Лимит чатов на пользователя'));
    await user.type(screen.getByLabelText('Лимит чатов на пользователя'), '12');

    await user.click(screen.getByRole('button', { name: 'Сохранить SMTP и отправить тест' }));
    expect(
      await screen.findByText(`Тестовое письмо отправлено на ${MOCK_EMAIL}.`),
    ).toBeInTheDocument();
    expect(mockDb.adminTestEmails).toEqual([MOCK_EMAIL]);
    expect(mockDb.admin.smtpHost).toBe('smtp.example.test');
    expect(mockDb.admin.smtpPasswordStored).toBe(true);
    // The write-only password is cleared after the request; the response has
    // never contained it.
    expect(screen.getByLabelText('Пароль SMTP')).toHaveValue('');
    expect(JSON.stringify(mockDb.adminSettingsPatches)).not.toContain('smtp-secret-2026');

    await user.click(screen.getByRole('button', { name: 'Завершить настройку' }));

    await waitFor(() => expect(window.location.pathname).toBe('/admin'));
    expect(await screen.findByRole('heading', { name: ADMIN_HEADING })).toBeInTheDocument();
    expect(mockDb.admin.setupCompletedAt).not.toBeNull();
    expect(mockDb.admin.maxChatsPerUser).toBe(12);
    // The overview is the landing section; settings live behind their tab.
    const overview = await screen.findByRole('region', { name: 'Обзор установки' });
    expect(within(overview).getByText('Пользователи')).toBeInTheDocument();
    expect(within(overview).getByText('Пространства')).toBeInTheDocument();
    expect(within(overview).getByText('Чаты')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Настройки' }));
    expect(await screen.findByText('SMTP настроен')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль SMTP')).toHaveValue('');
    expect(screen.queryByText('smtp-secret-2026')).not.toBeInTheDocument();
  });

  it('shows the "setup incomplete" screen to a non-admin and never renders /setup', async () => {
    setMockSetupRequired(mockDb, true);
    setMockPlatformAdmin(mockDb, false);
    const { user } = renderPasswordApp();
    await login(user);

    expect(await screen.findByRole('heading', { name: INCOMPLETE_HEADING })).toBeInTheDocument();
    expect(window.location.pathname).not.toBe('/setup');
    expect(screen.queryByRole('heading', { name: SETUP_HEADING })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Завершить настройку' })).not.toBeInTheDocument();
  });

  it('shows a 403 screen for a non-admin deep link to /admin', async () => {
    setMockSetupRequired(mockDb, false);
    setMockPlatformAdmin(mockDb, false);
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    navigate('/admin');

    expect(await screen.findByRole('heading', { name: FORBIDDEN_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: ADMIN_HEADING })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуться в чаты' }));
    expect(await screen.findByRole('heading', { name: 'Команда «Восход»' })).toBeInTheDocument();
  });

  it('lets an admin edit settings, sees the audit hint and tests SMTP from /admin', async () => {
    setMockSetupRequired(mockDb, false);
    setMockPlatformAdmin(mockDb, true);
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    navigate('/admin');
    expect(await screen.findByRole('heading', { name: ADMIN_HEADING })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Обзор установки' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Настройки' }));
    expect(screen.getByText(/записываются в аудит/)).toBeInTheDocument();

    await user.type(await screen.findByLabelText('SMTP-хост'), 'smtp.admin.test');
    await user.type(screen.getByLabelText('Адрес отправителя'), 'admin@example.test');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));

    expect(await screen.findByText('Настройки сохранены.')).toBeInTheDocument();
    expect(mockDb.admin.smtpHost).toBe('smtp.admin.test');
    expect(mockDb.admin.smtpFrom).toBe('admin@example.test');

    await user.clear(screen.getByLabelText('Email для теста'));
    await user.type(screen.getByLabelText('Email для теста'), 'ops@example.test');
    await user.click(screen.getByRole('button', { name: 'Сохранить SMTP и отправить тест' }));
    expect(
      await screen.findByText('Тестовое письмо отправлено на ops@example.test.'),
    ).toBeInTheDocument();
    expect(mockDb.adminTestEmails).toEqual(['ops@example.test']);
  });

  it('surfaces SETUP_ALREADY_COMPLETED and stays on /setup', async () => {
    setMockSetupRequired(mockDb, true);
    setMockPlatformAdmin(mockDb, true);
    server.use(
      http.patch('*/api/v1/admin/settings', () =>
        HttpResponse.json(
          {
            code: 'SETUP_ALREADY_COMPLETED',
            message: 'Setup is already completed',
            request_id: 'req_setup_race',
          },
          { status: 409 },
        ),
      ),
    );
    const { user } = renderPasswordApp();
    await login(user);
    await screen.findByRole('heading', { name: SETUP_HEADING });

    await user.click(screen.getByRole('button', { name: 'Завершить настройку' }));

    expect(
      await screen.findByText('Настройка уже завершена. Обновите страницу.'),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/setup');
  });
});
