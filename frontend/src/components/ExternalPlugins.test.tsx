import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { seedMockPluginPackage, setMockPlatformAdmin } from '../mocks/db';
import { IDS, MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp, renderPasswordApp } from '../test/renderApp';

type TestUser = ReturnType<typeof renderApp>['user'];

async function waitForChat(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
}

async function openPlugins(user: TestUser): Promise<void> {
  await waitForChat();
  await user.click(screen.getByRole('button', { name: 'Плагины' }));
  await screen.findByRole('heading', { level: 1, name: 'Плагины' });
}

async function loginPassword(user: TestUser): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await waitForChat();
}

describe('D1.2 external plugin cards and sandboxed runner', () => {
  it('shows EXTERNAL metadata from the catalog and opens a sandboxed iframe', async () => {
    seedMockPluginPackage(mockDb, {
      id: 'hello-panel',
      name: 'Hello panel',
      version: '2.1.0',
      author: 'Sova',
      permissions: ['chat.messages.read', 'webhooks.send'],
    });
    const { user } = renderApp();
    await openPlugins(user);

    const externalSection = await screen.findByRole('region', { name: 'Внешние плагины' });
    const card = within(externalSection).getByRole('article', { name: 'Hello panel' });
    expect(within(card).getByText('Внешний пакет')).toBeVisible();
    expect(within(card).getByText('Версия 2.1.0')).toBeVisible();
    expect(within(card).getByText('Автор: Sova')).toBeVisible();
    expect(within(card).getByText('Чтение сообщений')).toBeVisible();
    expect(within(card).getByText('Отправка вебхуков')).toBeVisible();
    expect(within(card).getByText('Управляемый')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: /Открыть плагин «Hello panel»/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Hello panel' });
    const frame = await within(dialog).findByTitle('Плагин «Hello panel»');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame.getAttribute('srcdoc')).toBeTruthy();
    expect(frame.getAttribute('srcdoc')).toContain('Hello panel');
    expect(frame.getAttribute('src')).toBeNull();
    expect(within(dialog).getByText(/Изолированная песочница/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Закрыть плагин' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByTitle('Плагин «Hello panel»')).not.toBeInTheDocument();
  });

  it('closes the runner with Escape and restores focus', async () => {
    seedMockPluginPackage(mockDb);
    const { user } = renderApp();
    await openPlugins(user);
    const openButton = await screen.findByRole('button', {
      name: /Открыть плагин «Hello panel»/,
    });
    openButton.focus();
    await user.click(openButton);
    await screen.findByRole('dialog', { name: 'Hello panel' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(openButton).toHaveFocus();
  });

  it('keeps the iframe sandbox free of same-origin even in an E2EE chat', async () => {
    seedMockPluginPackage(mockDb);
    const group = mockDb.chats[IDS.groupChat];
    if (!group) throw new Error('Mock group chat is missing');
    group.summary.security_mode = 'E2EE';

    const { user } = renderApp();
    await openPlugins(user);
    await user.click(await screen.findByRole('button', { name: /Открыть плагин «Hello panel»/ }));
    const frame = await screen.findByTitle('Плагин «Hello panel»');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('shows the admin management entry only to a platform admin', async () => {
    seedMockPluginPackage(mockDb);
    setMockPlatformAdmin(mockDb, false);
    const { user } = renderPasswordApp();
    await loginPassword(user);
    await openPlugins(user);
    expect(screen.queryByRole('button', { name: 'Управление пакетами' })).not.toBeInTheDocument();

    // The runner is available to every authenticated user; only package
    // management is admin-only.
    expect(
      await screen.findByRole('button', { name: /Открыть плагин «Hello panel»/ }),
    ).toBeInTheDocument();
  });

  it('opens the admin package management tab for a platform admin', async () => {
    seedMockPluginPackage(mockDb);
    setMockPlatformAdmin(mockDb, true);
    const { user } = renderPasswordApp();
    await loginPassword(user);
    await openPlugins(user);

    await user.click(screen.getByRole('button', { name: 'Управление пакетами' }));
    expect(await screen.findByRole('heading', { name: 'Внешние плагины' })).toBeVisible();
    expect(screen.getByLabelText('ZIP-пакет плагина')).toBeInTheDocument();
  });

  it('passes an axe audit with external cards and an open runner', async () => {
    seedMockPluginPackage(mockDb);
    const { user } = renderApp();
    await openPlugins(user);
    await user.click(await screen.findByRole('button', { name: /Открыть плагин «Hello panel»/ }));
    await screen.findByTitle('Плагин «Hello panel»');

    // jsdom cannot implement axe's cross-frame messaging; the iframe contract
    // itself is asserted above (sandbox, title, no same-origin, srcdoc).
    const frame = screen.getByTitle('Плагин «Hello panel»');
    const results = await axe.run(
      { include: [document.body], exclude: [frame] },
      { rules: { 'color-contrast': { enabled: false } } },
    );
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
