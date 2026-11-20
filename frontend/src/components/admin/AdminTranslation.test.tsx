import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
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

async function openPlugins(user: TestUser): Promise<HTMLElement> {
  await login(user);
  navigate('/admin?tab=plugins');
  await screen.findByRole('heading', { name: 'Администрирование' });
  return screen.findByRole('region', { name: 'Переводчик' });
}

describe('#84 translation-provider admin settings', () => {
  it('renders the effective enabled/https URL without any secret field', async () => {
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);

    expect(await within(card).findByText('Провайдер включён')).toBeInTheDocument();
    expect(within(card).getByLabelText('HTTPS URL провайдера')).toHaveValue(
      'https://translate.example.test/v1',
    );
    expect(within(card).getByLabelText('Включить переводчик')).toBeChecked();
    expect(card.querySelector('input[type="password"]')).toBeNull();
    expect(within(card).getByText(/секретов и API-ключей нет/i)).toBeInTheDocument();
    expect(mockDb.translationAdmin.getRequests).toBeGreaterThanOrEqual(1);
  });

  it('rejects non-https/invalid URLs before sending a PATCH', async () => {
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);
    const input = within(card).getByLabelText('HTTPS URL провайдера');

    await user.clear(input);
    await user.type(input, 'http://translate.example.test/v1');
    await user.click(within(card).getByRole('button', { name: 'Сохранить переводчик' }));

    expect(within(card).getByText('URL должен использовать https.')).toBeInTheDocument();
    expect(mockDb.translationAdmin.updates).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'https://translate.example.test/v1?key=secret');
    await user.click(within(card).getByRole('button', { name: 'Сохранить переводчик' }));
    expect(within(card).getByText('URL не должен содержать query string.')).toBeInTheDocument();
    expect(mockDb.translationAdmin.updates).toHaveLength(0);
  });

  it('saves the switch and URL through PATCH and shows the audit state', async () => {
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);
    const input = within(card).getByLabelText('HTTPS URL провайдера');

    await user.clear(input);
    await user.type(input, 'https://translate.internal.example/api');
    await user.click(within(card).getByLabelText('Включить переводчик'));
    await user.click(within(card).getByRole('button', { name: 'Сохранить переводчик' }));

    expect(await within(card).findByText('Настройки переводчика сохранены.')).toBeInTheDocument();
    expect(mockDb.translationAdmin.enabled).toBe(false);
    expect(mockDb.translationAdmin.url).toBe('https://translate.internal.example/api');
    expect(mockDb.translationAdmin.updates.at(-1)).toMatchObject({
      body: { enabled: false, url: 'https://translate.internal.example/api' },
      changed: true,
    });
    expect(within(card).getByText('Провайдер выключен')).toBeInTheDocument();
    expect(within(card).getByText(/url_changed, status и latency/)).toBeInTheDocument();
  });

  it('surfaces the server 422 validation codes honestly', async () => {
    mockDb.translationAdmin.forceUpdateError = {
      status: 422,
      code: 'TRANSLATION_URL_REQUIRED',
      message: 'Translation provider URL is required when the provider is enabled',
    };
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);
    const input = within(card).getByLabelText('HTTPS URL провайдера');

    await user.clear(input);
    await user.type(input, 'https://translate.internal.example/v2');
    await user.click(within(card).getByRole('button', { name: 'Сохранить переводчик' }));

    expect(
      await within(card).findByText(
        'Для включения нужен https URL: сохранённого или из окружения нет.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getAllByText(/TRANSLATION_URL_REQUIRED/).length).toBeGreaterThan(0);
  });

  it('tests the connection and reports status/latency with no provider content', async () => {
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);

    await user.click(within(card).getByRole('button', { name: 'Проверить соединение' }));

    expect(await within(card).findByText('Провайдер доступен · 84 мс.')).toBeInTheDocument();
    expect(mockDb.translationAdmin.testRequests).toBe(1);
    expect(within(card).queryByText(/ping|translated|provider body/i)).not.toBeInTheDocument();
  });

  it('reports DISABLED without a network call and UNAVAILABLE honestly', async () => {
    mockDb.translationAdmin.enabled = false;
    mockDb.translationAdmin.url = '';
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);
    expect(await within(card).findByText('Провайдер выключен')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Проверить соединение' }));
    expect(
      await within(card).findByText('Провайдер выключен — сетевой вызов не выполнялся (0 мс).'),
    ).toBeInTheDocument();

    mockDb.translationAdmin.enabled = true;
    mockDb.translationAdmin.url = 'https://translate.example.test/v1';
    mockDb.translationAdmin.testStatus = 'UNAVAILABLE';
    mockDb.translationAdmin.testLatencyMs = 250;
    await user.click(within(card).getByRole('button', { name: 'Обновить' }));
    await waitFor(() => expect(within(card).getByText('Провайдер включён')).toBeInTheDocument());
    await user.click(within(card).getByRole('button', { name: 'Проверить соединение' }));
    expect(await within(card).findByText('Провайдер недоступен · 250 мс.')).toBeInTheDocument();
  });

  it('links from admin settings to the plugins tab', async () => {
    const { user } = renderPasswordApp();
    await login(user);
    navigate('/admin?tab=settings');
    await screen.findByRole('heading', { name: 'Администрирование' });

    await user.click(await screen.findByRole('button', { name: 'Настроить переводчик' }));

    expect(await screen.findByRole('region', { name: 'Переводчик' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Плагины' })).toHaveAttribute('aria-selected', 'true');
  });

  it('passes axe without serious/critical violations', async () => {
    const { user } = renderPasswordApp();
    const card = await openPlugins(user);
    await within(card).findByText('Провайдер включён');

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(card, { rules: { 'color-contrast': { enabled: false } } });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
