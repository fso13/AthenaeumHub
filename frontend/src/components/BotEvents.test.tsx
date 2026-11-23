import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import {
  IDS,
  MOCK_BOT_SIGNING_SECRETS,
  MOCK_DEMO_EMAIL,
  MOCK_DEMO_PASSWORD,
} from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function login(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

async function openBots(user: TestUser): Promise<void> {
  await login(user);
  await user.click(screen.getByRole('button', { name: 'Настройки' }));
  await user.click(await screen.findByRole('button', { name: 'Боты' }));
  await screen.findByRole('heading', { name: 'Боты пространства' });
}

function botRow(name: string): HTMLElement {
  const node = screen.getByText(name).closest('li');
  if (!node) throw new Error(`Bot row is missing: ${name}`);
  return node as HTMLElement;
}

async function openSettings(user: TestUser, name = 'Сова Помощник'): Promise<HTMLElement> {
  await openBots(user);
  await user.click(within(botRow(name)).getByRole('button', { name: 'Настроить' }));
  return screen.findByRole('dialog', { name: 'События и команды' });
}

function activeBot(): (typeof mockDb.bots)[number] {
  const bot = mockDb.bots.find((item) => item.id === IDS.botActive);
  if (!bot) throw new Error('Active mock bot is missing');
  return bot;
}

describe('#98 bot events settings', () => {
  it('saves the https events URL, subscriptions and commands and reveals the secret once', async () => {
    // Start from an unconfigured bot to exercise PATCH activation + one-time secret.
    Object.assign(activeBot(), {
      events_url: null,
      events: [],
      events_enabled: false,
      has_signing_secret: false,
      signing_secret_created_at: null,
      signingSecret: null,
      updated_at: '2026-01-10T09:00:00.000Z',
    });
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    const url = within(dialog).getByLabelText('HTTPS URL событий');
    await user.type(url, 'https://hooks.example.test/new');
    await user.click(within(dialog).getByLabelText('Новые сообщения (message.created)'));
    await user.click(within(dialog).getByLabelText('Упоминания бота (app_mention)'));
    await user.click(within(dialog).getByLabelText('Доставка событий включена'));

    // Remove a seeded command, then add a validated new one.
    await user.click(within(dialog).getByRole('button', { name: 'Удалить команду /status' }));
    await user.type(within(dialog).getByLabelText('Команда'), 'Deploy');
    await user.type(within(dialog).getByLabelText('Описание'), 'Запустить деплой');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить команду' }));
    expect(within(dialog).getByText('/deploy')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Удалить команду /status' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));

    expect(await within(dialog).findByText('Настройки событий сохранены.')).toBeInTheDocument();
    expect(activeBot().events_url).toBe('https://hooks.example.test/new');
    expect(activeBot().events).toEqual(['message.created', 'app_mention']);
    expect(activeBot().events_enabled).toBe(true);
    expect(activeBot().commands).toEqual([
      { command: 'echo', description: 'Повторить текст' },
      { command: 'deploy', description: 'Запустить деплой' },
    ]);
    expect(activeBot().has_signing_secret).toBe(true);

    // The server generated a secret; it is shown once with a copy action.
    const secretInput = within(dialog).getByLabelText('Signing secret') as HTMLInputElement;
    const secret = secretInput.value;
    expect(secret).toMatch(/^sova_whsec_/);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(secret.length).toBeLessThanOrEqual(80);
    expect(activeBot().signingSecret).toBe(secret);

    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      await user.click(within(dialog).getByRole('button', { name: 'Скопировать секрет' }));
      expect(writeText).toHaveBeenCalledWith(secret);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }

    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'События и команды' })).toBeNull(),
    );
    expect(screen.queryByDisplayValue(secret)).toBeNull();
    // Rows never keep the one-time value.
    expect(
      Object.prototype.hasOwnProperty.call(
        mockDb.bots.find((bot) => bot.id === IDS.botActive),
        'signing_secret',
      ),
    ).toBe(false);
  });

  it('rotates the signing secret and never re-shows the previous value', async () => {
    const { user, store } = renderPasswordApp();
    const dialog = await openSettings(user);

    expect(within(dialog).getByText(/Секрет создан/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Ротировать секрет' }));
    await user.click(within(dialog).getByRole('button', { name: 'Ротировать' }));

    const rotated = (within(dialog).getByLabelText('Signing secret') as HTMLInputElement).value;
    expect(rotated).toMatch(/^sova_whsec_/);
    expect(rotated).not.toBe(MOCK_BOT_SIGNING_SECRETS.active);
    expect(activeBot().signingSecret).toBe(rotated);

    await user.click(within(dialog).getByRole('button', { name: 'Скрыть' }));
    expect(within(dialog).queryByLabelText('Signing secret')).toBeNull();

    // Reopening the dialog never reveals a stored value; only rotation can.
    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(store.bots.getSnapshot().workspace.signingSecret).toBeNull());
    await user.click(within(botRow('Сова Помощник')).getByRole('button', { name: 'Настроить' }));
    const reopened = await screen.findByRole('dialog', { name: 'События и команды' });
    expect(within(reopened).queryByLabelText('Signing secret')).toBeNull();
    expect(within(reopened).getByRole('button', { name: 'Ротировать секрет' })).toBeInTheDocument();
    expect(mockDb.botRequests.map((request) => request.action)).toContain('rotateSecret');
  });

  it('lists content-free delivery statuses and queues a signed test event', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    expect(await within(dialog).findByText('Доставлено')).toBeInTheDocument();
    expect(within(dialog).getByText('Ошибка')).toBeInTheDocument();
    expect(within(dialog).getByText('В очереди')).toBeInTheDocument();
    expect(within(dialog).getByText('Сообщение')).toBeInTheDocument();
    expect(within(dialog).getByText('Упоминание')).toBeInTheDocument();
    expect(within(dialog).getByText(/Причина: timeout/)).toBeInTheDocument();

    const before = mockDb.botDeliveries.length;
    await user.click(within(dialog).getByRole('button', { name: 'Отправить тестовое событие' }));
    expect(
      await within(dialog).findByText(/Тестовое событие поставлено в очередь/),
    ).toBeInTheDocument();
    expect(mockDb.botDeliveries).toHaveLength(before + 1);
    const queued = mockDb.botDeliveries.at(-1);
    expect(queued).toMatchObject({
      botId: IDS.botActive,
      event_type: 'test',
      status: 'PENDING',
      attempt_count: 0,
    });
    expect(within(dialog).getAllByText('Тест').length).toBeGreaterThanOrEqual(2);
    expect(mockDb.botRequests.map((request) => request.action)).toContain('testEvent');
    expect(mockDb.botRequests.map((request) => request.action)).toContain('deliveries');
  });

  it('validates the URL/subscriptions locally and explains a server 422', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);

    await user.clear(within(dialog).getByLabelText('HTTPS URL событий'));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      await within(dialog).findByText('Укажите https URL, чтобы включить доставку событий.'),
    ).toBeInTheDocument();
    expect(mockDb.botRequests.filter((request) => request.action === 'update')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('HTTPS URL событий'), 'http://insecure.test/e');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      await within(dialog).findByText(
        'URL должен начинаться с https:// и не содержать логин, query или fragment.',
      ),
    ).toBeInTheDocument();

    mockDb.forceBotUpdateError = {
      status: 422,
      code: 'BOT_EVENTS_URL_INVALID',
      message: 'events_url must be https',
    };
    await user.clear(within(dialog).getByLabelText('HTTPS URL событий'));
    await user.type(within(dialog).getByLabelText('HTTPS URL событий'), 'https://valid.test/e');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));
    expect(await within(dialog).findByText('Проверьте https URL событий.')).toBeInTheDocument();
  });

  it('passes an axe audit with the events dialog open', async () => {
    const { user } = renderPasswordApp();
    const dialog = await openSettings(user);
    expect(within(dialog).getByLabelText('HTTPS URL событий')).toBeInTheDocument();
    expect(await within(dialog).findByText('Доставлено')).toBeInTheDocument();

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
